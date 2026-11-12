const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http2 = require("http2");
const { spawn } = require("child_process");

const {
  encodeEntries,
  encodeFrame,
  decodeFrames,
  decodeEntries,
} = require("../lib/protobuf");
const { getSource } = require("../lib/repair");

function runMockServerTests() {
  return new Promise((resolve, reject) => {
    console.log("--- Running Mock gRPC Server End-to-End Tests ---");

    const keyPath = path.join(__dirname, "fixtures", "test_key.pem");
    const certPath = path.join(__dirname, "fixtures", "test_cert.pem");

    if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
      throw new Error("Test certificates missing in test/fixtures");
    }

    const key = fs.readFileSync(keyPath);
    const cert = fs.readFileSync(certPath);

    const receivedWrites = [];

    // Create loopback TLS HTTP/2 server
    const server = http2.createSecureServer({ key, cert });

    server.on("stream", (stream, headers) => {
      const chunks = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("end", () => {
        const fullBuf = Buffer.concat(chunks);
        if (headers[":path"] === "/exa.language_server_pb.LanguageServerService/JetboxWriteSummary") {
          try {
            const frames = decodeFrames(fullBuf);
            if (frames.length > 0) {
              const entries = decodeEntries(frames[0].payload);
              const idEntry = entries.find((e) => e.fn === 1 && e.wt === 2);
              const sumEntry = entries.find((e) => e.fn === 2 && e.wt === 2);
              receivedWrites.push({
                id: idEntry ? idEntry.val.toString("utf8") : "unknown",
                summaryBuffer: sumEntry ? sumEntry.val : null,
                headers,
              });
            }
          } catch (e) {
            console.error("Mock server error decoding request:", e.message);
          }

          stream.on("wantTrailers", () => {
            stream.sendTrailers({
              "grpc-status": "0",
            });
          });
          stream.respond(
            {
              ":status": 200,
              "content-type": "application/grpc+proto",
            },
            { waitForTrailers: true }
          );
          stream.end();
        } else {
          stream.respond({ ":status": 404 });
          stream.end();
        }
      });
    });

    server.listen(0, "127.0.0.1", async () => {
      const port = server.address().port;
      console.log(`  Mock Language Server listening on 127.0.0.1:${port}`);

      const tempDir = path.join(os.tmpdir(), `ag_test_e2e_${Date.now()}_${Math.random().toString(36).slice(2)}`);
      const backupDir = path.join(tempDir, "backups");
      fs.mkdirSync(tempDir, { recursive: true });

      try {
        // Create synthetic dump file with 2 items having source=17
        const conv1 = "mock-conv-001";
        const conv2 = "mock-conv-002";

        function makeSummary(id) {
          return encodeEntries([
            { fn: 1, wt: 2, val: Buffer.from(id, "utf8") },
            { fn: 3, wt: 2, val: encodeEntries([{ fn: 1, wt: 0, val: 1731400000n }]) },
            { fn: 20, wt: 0, val: 17n }, // source = 17
          ]);
        }

        function makeMapEntry(k, v) {
          const sub = encodeEntries([
            { fn: 1, wt: 2, val: Buffer.from(k, "utf8") },
            { fn: 2, wt: 2, val: v },
          ]);
          return { fn: 1, wt: 2, val: sub };
        }

        const dumpPayload = encodeEntries([
          makeMapEntry(conv1, makeSummary(conv1)),
          makeMapEntry(conv2, makeSummary(conv2)),
        ]);
        const dumpFrame = encodeFrame(dumpPayload);
        const dumpFile = path.join(tempDir, "mock_dump.bin");
        fs.writeFileSync(dumpFile, dumpFrame);

        // 1. Run ls_write_all.js against mock server
        console.log("  Testing ls_write_all.js against mock server...");
        await new Promise((res, rej) => {
          const proc = spawn(
            process.execPath,
            [
              path.resolve(__dirname, "../ls_write_all.js"),
              "--backup-dir",
              backupDir,
            ],
            {
              cwd: tempDir,
              env: {
                ...process.env,
                LS_PORT: String(port),
                LS_CSRF: "test-mock-token-xyz",
                LS_STREAM: dumpFile,
                USERPROFILE: tempDir,
              },
            }
          );

          let stdout = "";
          let stderr = "";
          proc.stdout.on("data", (d) => (stdout += d));
          proc.stderr.on("data", (d) => (stderr += d));

          proc.on("close", (code) => {
            if (code !== 0) {
              return rej(new Error(`ls_write_all exited with code ${code}\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`));
            }
            res();
          });
        });

        assert.strictEqual(receivedWrites.length, 2);
        assert.ok(receivedWrites.some((w) => w.id === conv1));
        assert.ok(receivedWrites.some((w) => w.id === conv2));

        // Verify written summaries have source = 0
        for (const w of receivedWrites) {
          const entries = decodeEntries(w.summaryBuffer);
          assert.strictEqual(getSource(entries), 0, `Written summary for ${w.id} must have source 0`);
          assert.strictEqual(w.headers["x-codeium-csrf-token"], "test-mock-token-xyz");
        }

        // Verify backup files exist
        const sessionDirs = fs.readdirSync(backupDir).map((d) => path.join(backupDir, d));
        assert.strictEqual(sessionDirs.length, 1);
        const manifestPath = path.join(sessionDirs[0], "manifest.json");
        assert.ok(fs.existsSync(manifestPath));
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        assert.ok(manifest.items[conv1]);
        assert.ok(manifest.items[conv2]);
        console.log("  ✓ ls_write_all wrote both summaries and verified source=0");

        // 2. Run ls_restore.js against mock server
        console.log("  Testing ls_restore.js rollback against mock server...");
        receivedWrites.length = 0; // Clear received writes

        await new Promise((res, rej) => {
          const proc = spawn(
            process.execPath,
            [
              path.resolve(__dirname, "../ls_restore.js"),
              "--backup",
              sessionDirs[0],
            ],
            {
              cwd: tempDir,
              env: {
                ...process.env,
                LS_PORT: String(port),
                LS_CSRF: "test-mock-token-xyz",
              },
            }
          );

          let stdout = "";
          let stderr = "";
          proc.stdout.on("data", (d) => (stdout += d));
          proc.stderr.on("data", (d) => (stderr += d));

          proc.on("close", (code) => {
            if (code !== 0) {
              return rej(new Error(`ls_restore exited with code ${code}\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`));
            }
            res();
          });
        });

        assert.strictEqual(receivedWrites.length, 2);
        // Verify restored payloads have original source = 17
        for (const w of receivedWrites) {
          const entries = decodeEntries(w.summaryBuffer);
          assert.strictEqual(getSource(entries), 17, `Restored summary for ${w.id} must restore original source 17`);
        }
        console.log("  ✓ ls_restore successfully restored original binary bytes");

        server.close();
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (e) {}

        console.log("Mock Server Suite Passed: 2 end-to-end integration tests.\n");
        resolve(2);
      } catch (err) {
        server.close();
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (e) {}
        reject(err);
      }
    });
  });
}

if (require.main === module) {
  runMockServerTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { runMockServerTests };
