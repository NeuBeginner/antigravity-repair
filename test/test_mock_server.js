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

function runCli(scriptPath, cliArgs, cwd, env) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [scriptPath, ...cliArgs], { cwd, env });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

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
    const summaryStore = new Map();
    const staleWriteIds = new Set();

    // Create loopback TLS HTTP/2 server
    const server = http2.createSecureServer({ key, cert });

    server.on("stream", (stream, headers) => {
      const chunks = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("end", () => {
        const fullBuf = Buffer.concat(chunks);
        const reqPath = headers[":path"];

        if (reqPath === "/exa.language_server_pb.LanguageServerService/JetboxWriteSummary") {
          try {
            const frames = decodeFrames(fullBuf);
            if (frames.length > 0) {
              const entries = decodeEntries(frames[0].payload);
              const idEntry = entries.find((e) => e.fn === 1 && e.wt === 2);
              const sumEntry = entries.find((e) => e.fn === 2 && e.wt === 2);
              const id = idEntry ? idEntry.val.toString("utf8") : "unknown";
              const sumBuf = sumEntry ? Buffer.from(sumEntry.val) : null;
              receivedWrites.push({ id, summaryBuffer: sumBuf, headers });
              if (sumBuf && !staleWriteIds.has(id)) {
                summaryStore.set(id, sumBuf);
              }
            }
          } catch (e) {
            console.error("Mock server error decoding write request:", e.message);
          }

          stream.on("wantTrailers", () => {
            stream.sendTrailers({ "grpc-status": "0" });
          });
          stream.respond(
            { ":status": 200, "content-type": "application/grpc+proto" },
            { waitForTrailers: true }
          );
          stream.end();
        } else if (reqPath === "/exa.language_server_pb.LanguageServerService/JetboxSubscribeToSummaries") {
          const mapEntries = [];
          for (const [k, v] of summaryStore) {
            const sub = encodeEntries([
              { fn: 1, wt: 2, val: Buffer.from(k, "utf8") },
              { fn: 2, wt: 2, val: v },
            ]);
            mapEntries.push({ fn: 1, wt: 2, val: sub });
          }
          const payload = encodeEntries(mapEntries);
          const frame = encodeFrame(payload, 0);

          stream.on("wantTrailers", () => {
            stream.sendTrailers({ "grpc-status": "0" });
          });
          stream.respond(
            { ":status": 200, "content-type": "application/grpc+proto" },
            { waitForTrailers: true }
          );
          stream.end(frame);
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
        const conv1 = "mock-conv-001";
        const conv2 = "mock-conv-002";

        function makeSummary(id, src = 17n) {
          return encodeEntries([
            { fn: 1, wt: 2, val: Buffer.from(id, "utf8") },
            { fn: 3, wt: 2, val: encodeEntries([{ fn: 1, wt: 0, val: 1731400000n }]) },
            { fn: 20, wt: 0, val: src },
          ]);
        }

        function makeMapEntry(k, v) {
          const sub = encodeEntries([
            { fn: 1, wt: 2, val: Buffer.from(k, "utf8") },
            { fn: 2, wt: 2, val: v },
          ]);
          return { fn: 1, wt: 2, val: sub };
        }

        const sum1 = makeSummary(conv1, 17n);
        const sum2 = makeSummary(conv2, 17n);
        summaryStore.set(conv1, sum1);
        summaryStore.set(conv2, sum2);

        const dumpPayload = encodeEntries([
          makeMapEntry(conv1, sum1),
          makeMapEntry(conv2, sum2),
        ]);
        const dumpFrame = encodeFrame(dumpPayload);
        const dumpFile = path.join(tempDir, "mock_dump.bin");
        fs.writeFileSync(dumpFile, dumpFrame);

        // 1. Run ls_write_all.js with read-after-write verification against mock server
        console.log("  Testing ls_write_all.js (write + read-after-write verify) against mock server...");
        const writeRes = await runCli(
          path.resolve(__dirname, "../ls_write_all.js"),
          ["--backup-dir", backupDir, "--verify"],
          tempDir,
          {
            ...process.env,
            LS_PORT: String(port),
            LS_CSRF: "test-mock-token-xyz",
            LS_STREAM: dumpFile,
            USERPROFILE: tempDir,
          }
        );
        assert.strictEqual(
          writeRes.code,
          0,
          `ls_write_all failed (${writeRes.code}):\n${writeRes.stdout}\n${writeRes.stderr}`
        );
        assert.ok(writeRes.stdout.includes("[VERIFY] Read-after-write check finished (OK: 2, Failed: 0)"));

        assert.strictEqual(receivedWrites.length, 2);
        assert.ok(receivedWrites.some((w) => w.id === conv1));
        assert.ok(receivedWrites.some((w) => w.id === conv2));

        for (const w of receivedWrites) {
          const entries = decodeEntries(w.summaryBuffer);
          assert.strictEqual(getSource(entries), 0, `Written summary for ${w.id} must have source 0`);
          assert.strictEqual(w.headers["x-codeium-csrf-token"], "test-mock-token-xyz");
        }

        const sessionDirs = fs.readdirSync(backupDir).map((d) => path.join(backupDir, d));
        assert.strictEqual(sessionDirs.length, 1);
        const manifest = JSON.parse(fs.readFileSync(path.join(sessionDirs[0], "manifest.json"), "utf8"));
        assert.ok(manifest.items[conv1]);
        assert.ok(manifest.items[conv2]);
        console.log("  ✓ ls_write_all wrote both summaries and verified source=0 via read-back");

        // 2. Run ls_restore.js against mock server
        console.log("  Testing ls_restore.js rollback against mock server...");
        receivedWrites.length = 0;

        const restoreRes = await runCli(
          path.resolve(__dirname, "../ls_restore.js"),
          ["--backup", sessionDirs[0]],
          tempDir,
          {
            ...process.env,
            LS_PORT: String(port),
            LS_CSRF: "test-mock-token-xyz",
          }
        );
        assert.strictEqual(
          restoreRes.code,
          0,
          `ls_restore failed (${restoreRes.code}):\n${restoreRes.stdout}\n${restoreRes.stderr}`
        );
        assert.strictEqual(receivedWrites.length, 2);
        for (const w of receivedWrites) {
          const entries = decodeEntries(w.summaryBuffer);
          assert.strictEqual(getSource(entries), 17, `Restored summary for ${w.id} must restore original source 17`);
        }
        console.log("  ✓ ls_restore successfully restored original binary bytes");

        // 3. Test read-after-write mismatch detection
        console.log("  Testing read-after-write mismatch detection...");
        const convMismatch = "mock-conv-mismatch";
        const mismatchOrig = makeSummary(convMismatch, 17n);
        summaryStore.clear();
        summaryStore.set(convMismatch, mismatchOrig);
        staleWriteIds.add(convMismatch); // Write RPC returns OK, but server still holds source=17!

        const mismatchDump = path.join(tempDir, "mismatch_dump.bin");
        fs.writeFileSync(
          mismatchDump,
          encodeFrame(encodeEntries([makeMapEntry(convMismatch, mismatchOrig)]))
        );

        const mismatchBackupDir = path.join(tempDir, "backups_mismatch");
        const mismatchRes = await runCli(
          path.resolve(__dirname, "../ls_write_all.js"),
          ["--backup-dir", mismatchBackupDir, "--verify"],
          tempDir,
          {
            ...process.env,
            LS_PORT: String(port),
            LS_CSRF: "test-mock-token-xyz",
            LS_STREAM: mismatchDump,
            USERPROFILE: tempDir,
          }
        );
        assert.strictEqual(mismatchRes.code, 3, "Expected exit code 3 on read-after-write mismatch");
        assert.ok(mismatchRes.stderr.includes("[VERIFY FAIL]"), "Expected [VERIFY FAIL] in stderr");
        assert.ok(mismatchRes.stderr.includes("ls_restore.js --backup"), "Expected restore instructions in stderr");
        console.log("  ✓ read-after-write detected stale server state and exited with code 3 + restore command");

        // 4. Test ls_stream.js success & error handling
        console.log("  Testing ls_stream.js against mock server...");
        const streamOutFile = path.join(tempDir, "stream_capture.bin");
        const streamRes = await runCli(
          path.resolve(__dirname, "../ls_stream.js"),
          ["1", "0"],
          tempDir,
          {
            ...process.env,
            LS_PORT: String(port),
            LS_CSRF: "test-mock-token-xyz",
            LS_OUT: streamOutFile,
          }
        );
        assert.strictEqual(streamRes.code, 0, `ls_stream failed:\n${streamRes.stdout}\n${streamRes.stderr}`);
        assert.ok(fs.existsSync(streamOutFile) && fs.statSync(streamOutFile).size > 0);

        const badStreamRes = await runCli(
          path.resolve(__dirname, "../ls_stream.js"),
          ["1", "0"],
          tempDir,
          {
            ...process.env,
            LS_PORT: String(port),
            LS_CSRF: "test-mock-token-xyz",
            LS_OUT: path.join(tempDir, "nonexistent_dir", "fail.bin"),
          }
        );
        assert.notStrictEqual(badStreamRes.code, 0, "Expected ls_stream to exit non-zero when save fails");
        console.log("  ✓ ls_stream collected frames and propagated non-zero exit on write failure");

        server.close();
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (e) {}

        console.log("Mock Server Suite Passed: 4 end-to-end integration tests.\n");
        resolve(4);
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
