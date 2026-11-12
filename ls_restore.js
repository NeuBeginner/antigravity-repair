/**
 * Verifiable restore utility from backups.
 * Restores exact original binary bytes of summaries back to Language Server.
 *
 * Usage:
 *   LS_PORT=<port> LS_CSRF=<token> node ls_restore.js [--backup <dir> | --latest] [--dry-run]
 */

const http2 = require("http2");
const fs = require("fs");
const path = require("path");

const { readBackupSummary, getLatestBackupSession } = require("./lib/backup");
const { encodeVarint } = require("./lib/protobuf");

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const backupDirIndex = args.indexOf("--backup");
let backupDir = backupDirIndex !== -1 ? args[backupDirIndex + 1] : null;

if (args.includes("--latest") || !backupDir) {
  backupDir = getLatestBackupSession(path.join(process.cwd(), "backups"));
}

const port = process.env.LS_PORT;
const csrf = process.env.LS_CSRF || "";

function makeWriteRequest(id, summaryBuffer) {
  const idBuf = Buffer.from(id, "utf8");
  const idKey = encodeVarint((1n << 3n) | 2n);
  const idLen = encodeVarint(idBuf.length);

  const sumKey = encodeVarint((2n << 3n) | 2n);
  const sumLen = encodeVarint(summaryBuffer.length);

  const reqBody = Buffer.concat([idKey, idLen, idBuf, sumKey, sumLen, summaryBuffer]);
  const frame = Buffer.alloc(5 + reqBody.length);
  frame[0] = 0;
  frame.writeUInt32BE(reqBody.length, 1);
  reqBody.copy(frame, 5);
  return frame;
}

async function main() {
  if (!backupDir || !fs.existsSync(backupDir)) {
    console.error(`ERROR: Backup directory not found: ${backupDir || "none specified"}`);
    process.exit(1);
  }

  const manifestFile = path.join(backupDir, "manifest.json");
  if (!fs.existsSync(manifestFile)) {
    console.error(`ERROR: Backup manifest missing at: ${manifestFile}`);
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const ids = Object.keys(manifest.items || {});

  console.log(`[RESTORE] Target backup session: ${backupDir}`);
  console.log(`[RESTORE] Total summaries to restore: ${ids.length}`);

  if (isDryRun) {
    console.log(`\n=== DRY-RUN RESTORE PLAN (${ids.length} items) ===`);
    for (const id of ids) {
      console.log(`  - Would restore: ${id} (${manifest.items[id].size} bytes, sha256: ${manifest.items[id].sha256.slice(0, 12)}...)`);
    }
    console.log(`\n[DRY-RUN COMPLETE] Zero write operations performed.`);
    process.exit(0);
  }

  if (!port || !csrf) {
    console.error("ERROR: LS_PORT and LS_CSRF environment variables are required to restore.");
    process.exit(2);
  }

  const client = http2.connect(`https://127.0.0.1:${port}`, { rejectUnauthorized: false });
  client.on("error", (err) => {
    console.error(`[FATAL] HTTP/2 client error: ${err.message}`);
    process.exit(1);
  });

  function doWriteRpc(id, rawBytes) {
    return new Promise((resolve) => {
      const req = client.request({
        ":method": "POST",
        ":path": "/exa.language_server_pb.LanguageServerService/JetboxWriteSummary",
        "content-type": "application/grpc+proto",
        "te": "trailers",
        "grpc-accept-encoding": "identity",
        "user-agent": "grpc-node-js/1.0",
        "accept-encoding": "identity",
        "origin": `https://127.0.0.1:${port}`,
        "referer": `https://127.0.0.1:${port}/`,
        "x-codeium-csrf-token": csrf,
      });

      let status = null;
      req.on("trailers", (t) => {
        status = t["grpc-status"];
      });
      req.on("error", (err) => {
        status = `ERR: ${err.message}`;
      });
      req.on("close", () => resolve(status));
      req.on("data", () => {});
      req.end(makeWriteRequest(id, rawBytes));
    });
  }

  let ok = 0;
  let fail = 0;

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    try {
      const rawBytes = readBackupSummary(backupDir, id);
      const rpcStatus = await doWriteRpc(id, rawBytes);
      if (rpcStatus === "0" || rpcStatus === 0) {
        ok++;
      } else {
        fail++;
        console.error(`[FAIL] ${id} restore failed with RPC status: ${rpcStatus}`);
      }
    } catch (err) {
      fail++;
      console.error(`[ERROR] Failed to restore ${id}: ${err.message}`);
    }

    if ((i + 1) % 50 === 0 || i + 1 === ids.length) {
      console.log(`[PROGRESS] Restored ${i + 1}/${ids.length} (OK: ${ok}, Failed: ${fail})`);
    }
  }

  client.close();
  console.log(`\n[RESTORE COMPLETE] OK: ${ok}, Failed: ${fail}`);
  process.exit(fail > 0 ? 3 : 0);
}

main().catch((err) => {
  console.error(`[FATAL] Restore failed: ${err.stack || err.message}`);
  process.exit(1);
});
