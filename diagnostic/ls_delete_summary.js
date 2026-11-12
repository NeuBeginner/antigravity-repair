// DANGEROUS DIAGNOSTIC UTILITY: Permanently delete conversation summaries from Language Server.
// WARNING: This causes irreversible data loss of the target trajectory metadata.
// Requires explicit flag: --dangerous-allow-delete

const http2 = require("http2");

const args = process.argv.slice(2);
const allowDelete = args.includes("--dangerous-allow-delete");
const ids = args.filter((a) => !a.startsWith("--"));

const port = process.env.LS_PORT;
const csrf = process.env.LS_CSRF || "";

if (!allowDelete) {
  console.error("================================================================================");
  console.error("[CRITICAL SAFETY GUARD] Refusing execution.");
  console.error("Deleting summaries causes irreversible loss of conversation metadata in Antigravity.");
  console.error("To execute this diagnostic utility intentionally, you MUST pass:");
  console.error("  --dangerous-allow-delete");
  console.error("================================================================================");
  process.exit(1);
}

if (!port || ids.length === 0) {
  console.log("usage: LS_PORT=.. LS_CSRF=.. node diagnostic/ls_delete_summary.js --dangerous-allow-delete <cascadeId> [...]");
  process.exit(2);
}

function varintBuf(n) {
  const o = [];
  while (n > 127) { o.push((n & 127) | 128); n >>>= 7; }
  o.push(n);
  return Buffer.from(o);
}

function makeReq(id) {
  const body = Buffer.concat([
    Buffer.from([0x0a]), varintBuf(Buffer.byteLength(id, "utf8")), Buffer.from(id, "utf8"),
  ]);
  const frame = Buffer.alloc(5 + body.length);
  frame[0] = 0;
  frame.writeUInt32BE(body.length, 1);
  body.copy(frame, 5);
  return frame;
}

const client = http2.connect(`https://127.0.0.1:${port}`, { rejectUnauthorized: false });
client.on("error", (e) => { console.log("CLIENT ERROR:", e.message); process.exit(1); });

function del(id) {
  return new Promise((resolve) => {
    const r = client.request({
      ":method": "POST",
      ":path": "/exa.language_server_pb.LanguageServerService/JetboxDeleteSummary",
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
    let body = "";
    r.on("trailers", (t) => { status = t["grpc-status"]; });
    r.on("data", (d) => { body += d.toString("hex"); });
    r.on("error", (e) => { status = "ERR:" + e.message; });
    r.on("close", () => resolve({ id, status, body }));
    r.end(makeReq(id));
  });
}

(async () => {
  for (const id of ids) {
    const res = await del(id);
    console.log(`${res.id} -> grpc-status=${res.status} body=${res.body.slice(0, 64)}`);
  }
  client.close();
  process.exit(0);
})();
