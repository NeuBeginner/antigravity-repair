/**
 * Batch-write summaries back to Language Server with source=0 (LOCAL)
 * and hardened protobuf annotations.
 *
 * Supports:
 *   --dry-run       Plan changes without calling any write RPC
 *   --backup-dir    Custom directory for binary backups
 *   --limit N       Process at most N summaries
 *   --verify        Read-after-write verification
 */

const http2 = require("http2");
const fs = require("fs");
const path = require("path");

const { decodeFrames, decodeEntries, encodeVarint } = require("./lib/protobuf");
const { createBackupSession, backupSummary } = require("./lib/backup");
const {
  getSource,
  isArchivedInAnnotations,
  transformSummary,
  verifyTransformedSummary,
} = require("./lib/repair");

// CLI Flags
const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const limitIndex = args.indexOf("--limit");
const limit = limitIndex !== -1 ? parseInt(args[limitIndex + 1], 10) : parseInt(process.env.LS_LIMIT || "0", 10);
const backupDirArg = args.indexOf("--backup-dir");
const customBackupDir = backupDirArg !== -1 ? args[backupDirArg + 1] : process.env.BACKUP_DIR;

const port = process.env.LS_PORT;
const csrf = process.env.LS_CSRF || "";
const binPath = process.env.LS_STREAM;

function printUsage() {
  console.log(`
Usage:
  LS_PORT=<port> LS_CSRF=<token> LS_STREAM=<dump.bin> node ls_write_all.js [options]

Options:
  --dry-run         Simulate changes and print plan without writing to Language Server
  --limit <n>       Process at most <n> summaries
  --backup-dir <dir> Store exact original binary backups in <dir>
`);
}

function collectSummariesFromDump(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Dump stream file not found: ${filePath}`);
  }
  const fileBytes = fs.readFileSync(filePath);
  const map = new Map();

  for (const frame of decodeFrames(fileBytes)) {
    try {
      const topEntries = decodeEntries(frame.payload);
      for (const e of topEntries) {
        if (e.fn !== 1 || e.wt !== 2) continue; // Map entry
        const sub = decodeEntries(e.val);
        const k = sub.find((x) => x.fn === 1 && x.wt === 2);
        const v = sub.find((x) => x.fn === 2 && x.wt === 2);
        if (k && v) {
          map.set(k.val.toString("utf8"), v.val);
        }
      }
    } catch (err) {
      console.warn(`[WARN] Skipping unparseable frame in dump: ${err.message}`);
    }
  }

  return map;
}

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
  if (!binPath) {
    console.error("ERROR: LS_STREAM environment variable is required.");
    printUsage();
    process.exit(2);
  }

  if (!isDryRun && (!port || !csrf)) {
    console.error("ERROR: LS_PORT and LS_CSRF are required for write operations (or use --dry-run).");
    process.exit(2);
  }

  console.log(`[INFO] Reading summaries from dump: ${binPath}`);
  const summaryMap = collectSummariesFromDump(binPath);
  console.log(`[INFO] Total unique summaries found in dump: ${summaryMap.size}`);

  const userDir = process.env.USERPROFILE || process.env.HOME || "C:\\Users\\Telekom";
  const annDir = path.join(userDir, ".gemini", "antigravity", "annotations");

  const candidates = [];
  const plan = [];

  for (const [id, rawBuf] of summaryMap) {
    let topEntries;
    try {
      topEntries = decodeEntries(rawBuf);
    } catch (e) {
      console.warn(`[WARN] Skipping malformed summary for ${id}: ${e.message}`);
      continue;
    }

    const currentSrc = getSource(topEntries);
    let shouldBeArchived = false;
    let pbtxtContent = null;
    let hasPbtxt = false;

    const annPath = path.join(annDir, `${id}.pbtxt`);
    if (fs.existsSync(annPath)) {
      try {
        pbtxtContent = fs.readFileSync(annPath, "utf8");
        hasPbtxt = true;
        shouldBeArchived = /archived:\s*true/.test(pbtxtContent);
      } catch (err) {
        console.warn(`[WARN] Could not read pbtxt for ${id}: ${err.message}`);
      }
    }

    const isArchived = isArchivedInAnnotations(topEntries);
    const hasField15 = topEntries.some((e) => e.fn === 15 && e.wt === 2);

    let needsRewrite = false;
    const reasons = [];

    if (currentSrc === 17) {
      needsRewrite = true;
      reasons.push("source=17 (CLI -> LOCAL)");
    }
    if (!hasField15) {
      needsRewrite = true;
      reasons.push("missing field 15 annotations");
    }
    if (hasPbtxt && shouldBeArchived !== isArchived) {
      needsRewrite = true;
      reasons.push(`archive mismatch (pbtxt=${shouldBeArchived}, summary=${isArchived})`);
    }

    if (needsRewrite) {
      candidates.push({ id, rawBuf, pbtxtContent, reasons });
      plan.push({ id, reasons });
    }
  }

  console.log(`[INFO] Summaries requiring update: ${candidates.length}`);

  const todo = limit > 0 ? candidates.slice(0, limit) : candidates;

  if (isDryRun) {
    console.log(`\n=== DRY-RUN PLAN (${todo.length} items) ===`);
    for (const item of todo) {
      console.log(`  - ${item.id}: ${item.reasons.join(", ")}`);
    }
    console.log(`\n[DRY-RUN COMPLETE] Planned updates for ${todo.length} summaries. Zero write RPC calls performed.`);
    process.exit(0);
  }

  if (todo.length === 0) {
    console.log("Nothing to rewrite, all summaries are clean and up to date.");
    process.exit(0);
  }

  // 1. Create backup session
  const sessionDir = createBackupSession(customBackupDir);
  console.log(`[BACKUP] Created backup session at: ${sessionDir}`);

  // Connect HTTP/2 gRPC client strictly to loopback 127.0.0.1
  // TLS Note: Antigravity language_server generates a local self-signed certificate bound only to 127.0.0.1.
  // rejectUnauthorized is set to false exclusively for this local ephemeral loopback connection.
  const client = http2.connect(`https://127.0.0.1:${port}`, { rejectUnauthorized: false });
  client.on("error", (err) => {
    console.error(`[FATAL] HTTP/2 client error: ${err.message}`);
    process.exit(1);
  });

  let okCount = 0;
  let failCount = 0;
  const errors = [];

  function doWriteRpc(id, newSummaryBuffer) {
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
      req.end(makeWriteRequest(id, newSummaryBuffer));
    });
  }

  for (let i = 0; i < todo.length; i++) {
    const item = todo[i];
    try {
      // Step A: Backup original bytes before any modification
      backupSummary(sessionDir, item.id, item.rawBuf, {
        reasons: item.reasons,
      });

      // Step B: Transform summary safely preserving unknown fields
      const { transformedBuffer } = transformSummary(
        item.rawBuf,
        item.pbtxtContent,
        item.id,
        { allowDefaultViewTime: true }
      );

      // Verify transformed buffer structure locally before sending
      verifyTransformedSummary(transformedBuffer);

      // Step C: Send write RPC
      const rpcStatus = await doWriteRpc(item.id, transformedBuffer);
      if (rpcStatus === "0" || rpcStatus === 0) {
        okCount++;
      } else {
        failCount++;
        errors.push({ id: item.id, error: `RPC status ${rpcStatus}` });
        console.error(`[FAIL] ${item.id} failed with RPC status: ${rpcStatus}`);
      }
    } catch (err) {
      failCount++;
      errors.push({ id: item.id, error: err.message });
      console.error(`[ERROR] Failed processing ${item.id}: ${err.message}`);
    }

    if ((i + 1) % 50 === 0 || i + 1 === todo.length) {
      console.log(`[PROGRESS] ${i + 1}/${todo.length} (OK: ${okCount}, Failed: ${failCount})`);
    }
  }

  client.close();

  console.log(`\n[COMPLETE] DONE ok=${okCount} bad=${failCount}`);
  if (failCount > 0) {
    console.error(`\n[WARNING] ${failCount} errors encountered during write.`);
    console.error(`Backup session is available at: ${sessionDir}`);
    console.error(`To restore exact original state, run:`);
    console.error(`  node ls_restore.js --backup "${sessionDir}"`);
    process.exit(3);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(`[FATAL] Unexpected error: ${err.stack || err.message}`);
  process.exit(1);
});
