/**
 * Batch-write summaries back to Language Server with source=0 (LOCAL)
 * and hardened protobuf annotations.
 *
 * Supports:
 *   --dry-run                Plan changes without calling any write RPC
 *   --verify / --no-verify   Read-after-write verification via Language Server stream (default: enabled)
 *   --readback-timeout <ms>  Timeout for read-after-write stream collection (default: 3000)
 *   --backup-dir <dir>       Custom directory for binary backups
 *   --limit <n>              Process at most N summaries
 */

const http2 = require("http2");
const fs = require("fs");
const path = require("path");

const { decodeFrames, decodeEntries, encodeFrame, encodeVarint } = require("./lib/protobuf");
const { parsePbtxt, extractAnnotations } = require("./lib/pbtxt");
const { createBackupSession, backupSummary } = require("./lib/backup");
const {
  getSource,
  isArchivedInAnnotations,
  isMarkedAsUnread,
  transformSummary,
  verifyTransformedSummary,
} = require("./lib/repair");

// CLI Flags
const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const verifyEnabled = args.includes("--no-verify") ? false : true;
const readbackTimeoutIdx = args.indexOf("--readback-timeout");
const readbackTimeoutMs =
  readbackTimeoutIdx !== -1 ? parseInt(args[readbackTimeoutIdx + 1], 10) : 3000;
const limitIndex = args.indexOf("--limit");
const limit =
  limitIndex !== -1
    ? parseInt(args[limitIndex + 1], 10)
    : parseInt(process.env.LS_LIMIT || "0", 10);
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
  --dry-run                Simulate changes and print plan without writing to Language Server
  --verify                 Enable read-after-write verification (default)
  --no-verify              Disable read-after-write verification
  --readback-timeout <ms>  Timeout in ms for read-after-write check (default: 3000)
  --limit <n>              Process at most <n> summaries
  --backup-dir <dir>       Store exact original binary backups in <dir>
`);
}

function collectSummariesFromDump(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Dump stream file not found: ${filePath}`);
  }
  const fileBytes = fs.readFileSync(filePath);
  const map = new Map();

  for (const frame of decodeFrames(fileBytes)) {
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
  return encodeFrame(reqBody, 0);
}

/**
 * Performs real read-after-write verification by subscribing to JetboxSubscribeToSummaries
 * on the Language Server and collecting the latest summaries for targetIds.
 */
function readBackSummaries(client, targetIds, timeoutMs) {
  return new Promise((resolve, reject) => {
    const targetSet = new Set(targetIds);
    const resultMap = new Map();
    let settled = false;
    let buf = Buffer.alloc(0);
    let httpStatus = null;
    let grpcStatus = null;

    const req = client.request({
      ":method": "POST",
      ":path": "/exa.language_server_pb.LanguageServerService/JetboxSubscribeToSummaries",
      "content-type": "application/grpc+proto",
      "te": "trailers",
      "grpc-accept-encoding": "identity",
      "user-agent": "grpc-node-js/1.0",
      "accept-encoding": "identity",
      "origin": `https://127.0.0.1:${port}`,
      "referer": `https://127.0.0.1:${port}/`,
      "x-codeium-csrf-token": csrf,
    });

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        req.close();
      } catch (e) {}
      if (err) return reject(err);
      if (httpStatus !== null && httpStatus !== 200) {
        return reject(new Error(`Read-back HTTP status ${httpStatus}`));
      }
      if (grpcStatus !== null && grpcStatus !== "0" && grpcStatus !== 0) {
        return reject(new Error(`Read-back gRPC status ${grpcStatus}`));
      }
      resolve(resultMap);
    };

    const timer = setTimeout(() => {
      finish(null);
    }, timeoutMs);

    req.on("response", (headers) => {
      httpStatus = headers[":status"];
    });

    req.on("trailers", (trailers) => {
      grpcStatus = trailers["grpc-status"];
    });

    req.on("error", (err) => {
      finish(err);
    });

    req.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        while (buf.length >= 5) {
          const len = buf.readUInt32BE(1);
          if (buf.length < 5 + len) break;
          const payload = buf.subarray(5, 5 + len);
          buf = buf.subarray(5 + len);

          const topEntries = decodeEntries(payload);
          for (const e of topEntries) {
            if (e.fn !== 1 || e.wt !== 2) continue;
            const sub = decodeEntries(e.val);
            const k = sub.find((x) => x.fn === 1 && x.wt === 2);
            const v = sub.find((x) => x.fn === 2 && x.wt === 2);
            if (!k || !v) continue;
            const id = k.val.toString("utf8");
            if (targetSet.has(id)) {
              resultMap.set(id, Buffer.from(v.val));
            }
          }
        }
        if (resultMap.size >= targetSet.size) {
          finish(null);
        }
      } catch (err) {
        finish(err);
      }
    });

    req.on("end", () => {
      finish(null);
    });

    req.on("close", () => {
      finish(null);
    });

    const reqFrame = encodeFrame(Buffer.from([0x28, 0x00]), 0);
    req.end(reqFrame);
  });
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
  const precheckErrors = [];

  for (const [id, rawBuf] of summaryMap) {
    let topEntries;
    try {
      topEntries = decodeEntries(rawBuf);
    } catch (e) {
      const msg = `Malformed summary for ${id}: ${e.message}`;
      precheckErrors.push({ id, error: msg });
      console.error(`[ERROR] ${msg}`);
      continue;
    }

    const currentSrc = getSource(topEntries);
    let pbtxtContent = null;
    let pbtxtAnn = null;
    let hasPbtxt = false;

    const annPath = path.join(annDir, `${id}.pbtxt`);
    if (fs.existsSync(annPath)) {
      try {
        pbtxtContent = fs.readFileSync(annPath, "utf8");
        if (pbtxtContent.trim().length === 0) {
          throw new Error("pbtxt file is empty");
        }
        const parsed = parsePbtxt(pbtxtContent);
        pbtxtAnn = extractAnnotations(parsed);
        const hasRecognized =
          pbtxtAnn.title !== undefined ||
          pbtxtAnn.archived !== undefined ||
          pbtxtAnn.marked_as_unread !== undefined ||
          pbtxtAnn.last_user_view_time !== undefined ||
          pbtxtAnn.archival_status_timestamp !== undefined;
        if (!hasRecognized) {
          throw new Error("pbtxt contains no recognized annotation fields");
        }
        hasPbtxt = true;
      } catch (err) {
        const msg = `Invalid or unreadable pbtxt for ${id}: ${err.message}`;
        precheckErrors.push({ id, error: msg });
        console.error(`[ERROR] ${msg}`);
        continue;
      }
    }

    // Never modify conversations explicitly marked as unread
    const explicitlyUnread =
      isMarkedAsUnread(topEntries) || (pbtxtAnn && pbtxtAnn.marked_as_unread === true);
    if (explicitlyUnread) {
      console.log(`[SKIP] ${id}: explicitly marked as unread`);
      continue;
    }

    const isArchived = isArchivedInAnnotations(topEntries);
    const shouldBeArchived = hasPbtxt && pbtxtAnn.archived !== undefined ? pbtxtAnn.archived : isArchived;
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
    if (precheckErrors.length > 0) {
      console.error(`[ERROR] ${precheckErrors.length} pre-check error(s) encountered during dry-run.`);
      process.exit(3);
    }
    process.exit(0);
  }

  if (todo.length === 0) {
    if (precheckErrors.length > 0) {
      console.error(`[ERROR] ${precheckErrors.length} pre-check error(s) encountered; aborting with non-zero status.`);
      process.exit(3);
    }
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
  let failCount = precheckErrors.length;
  const errors = [...precheckErrors];
  const writtenItems = [];

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
      const { transformedBuffer, expectedState } = transformSummary(
        item.rawBuf,
        item.pbtxtContent,
        item.id,
        { allowDefaultViewTime: true, skipUnread: true }
      );

      // Local pre-flight check before sending over RPC
      verifyTransformedSummary(transformedBuffer, expectedState);

      // Step C: Send write RPC
      const rpcStatus = await doWriteRpc(item.id, transformedBuffer);
      if (rpcStatus === "0" || rpcStatus === 0) {
        okCount++;
        writtenItems.push({ id: item.id, expectedState });
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

  // Step D: Real read-after-write verification against Language Server
  if (verifyEnabled && writtenItems.length > 0) {
    console.log(`[VERIFY] Reading back ${writtenItems.length} written summaries from Language Server...`);
    try {
      const readBackMap = await readBackSummaries(
        client,
        writtenItems.map((w) => w.id),
        readbackTimeoutMs
      );

      for (const written of writtenItems) {
        const readBackBuf = readBackMap.get(written.id);
        if (!readBackBuf) {
          okCount--;
          failCount++;
          const msg = `Read-after-write missing summary for ${written.id}`;
          errors.push({ id: written.id, error: msg });
          console.error(`[VERIFY FAIL] ${msg}`);
          continue;
        }
        try {
          verifyTransformedSummary(readBackBuf, written.expectedState);
        } catch (err) {
          okCount--;
          failCount++;
          errors.push({ id: written.id, error: `Read-after-write mismatch: ${err.message}` });
          console.error(`[VERIFY FAIL] Read-after-write verification failed for ${written.id}: ${err.message}`);
        }
      }
      console.log(`[VERIFY] Read-after-write check finished (OK: ${okCount}, Failed: ${failCount})`);
    } catch (err) {
      failCount += writtenItems.length;
      okCount = 0;
      errors.push({ id: "*", error: `Read-after-write stream failed: ${err.message}` });
      console.error(`[VERIFY FAIL] Read-after-write stream failed: ${err.message}`);
    }
  }

  client.close();

  console.log(`\n[COMPLETE] DONE ok=${okCount} bad=${failCount}`);
  if (failCount > 0) {
    console.error(`\n[WARNING] ${failCount} errors encountered during write/verification.`);
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
