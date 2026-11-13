// Read the LS summaries stream and report the `source` distribution.
// usage: LS_PORT=49976 LS_CSRF=... node ls_stream.js [seconds] [reqVariant]
const http2 = require("http2");
const fs = require("fs");
const { decodeEntries, encodeFrame } = require("./lib/protobuf");

const port = process.env.LS_PORT;
const csrf = process.env.LS_CSRF || "";
const seconds = parseInt(process.argv[2] || "20", 10);
const variant = parseInt(process.argv[3] || "0", 10);
if (!port) {
  console.error("LS_PORT required");
  process.exit(2);
}
if (!Number.isFinite(seconds) || seconds < 0) {
  console.error("Invalid seconds argument");
  process.exit(2);
}

function summarySource(sum) {
  for (const e of decodeEntries(sum)) {
    if (e.fn === 20 && e.wt === 0) return Number(e.val);
  }
  return null; // absent => proto3 default 0 (local)
}

function summaryTitle(sum) {
  for (const e of decodeEntries(sum)) {
    if (e.fn === 1 && e.wt === 2) return e.val.toString("utf8");
  }
  return "";
}

// TLS Note: Antigravity language_server uses a local self-signed certificate bound strictly to 127.0.0.1.
const client = http2.connect(`https://127.0.0.1:${port}`, { rejectUnauthorized: false });
client.on("error", (e) => {
  console.error("CLIENT ERROR:", e.message);
  process.exit(1);
});

// JetboxSubscribeToSummariesRequest: field 5 = backend (varint)
const body =
  variant === 0
    ? Buffer.from([0x28, 0x00])
    : variant === 1
      ? Buffer.from([])
      : Buffer.from([0x28, 0x01]);
const frame = encodeFrame(body, 0);

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

let httpStatus = null;
let grpcStatus = null;
let reqError = null;
let parseErrors = 0;
let saveError = null;
let buf = Buffer.alloc(0);
const seen = new Map(); // key -> source
const titles = new Map();
let frames = 0;
let updates = 0;
const outPath = process.env.LS_OUT || "";
let outBuf = Buffer.alloc(0);

req.on("response", (h) => {
  httpStatus = h[":status"];
  console.log("http-status:", httpStatus);
});
req.on("trailers", (t) => {
  grpcStatus = t["grpc-status"];
});
req.on("error", (e) => {
  reqError = e.message;
  console.error("REQ ERROR:", e.message);
});
req.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 5) {
    const len = buf.readUInt32BE(1);
    if (buf.length < 5 + len) break;
    const frameBuf = buf.subarray(0, 5 + len);
    const payload = buf.subarray(5, 5 + len);
    buf = buf.subarray(5 + len);
    frames++;
    if (outPath) outBuf = Buffer.concat([outBuf, frameBuf]);
    try {
      for (const e of decodeEntries(payload)) {
        if (e.fn !== 1 || e.wt !== 2) continue;
        const sub = decodeEntries(e.val);
        const k = sub.find((x) => x.fn === 1 && x.wt === 2);
        const v = sub.find((x) => x.fn === 2 && x.wt === 2);
        if (!k || !v) continue;
        updates++;
        const key = k.val.toString("utf8");
        seen.set(key, summarySource(v.val));
        if (!titles.has(key)) titles.set(key, summaryTitle(v.val));
      }
    } catch (e) {
      parseErrors++;
      console.error("parse error:", e.message);
    }
  }
});
req.end(frame);

setTimeout(() => {
  if (buf.length > 0) {
    parseErrors++;
    console.error(`trailing incomplete gRPC frame bytes: ${buf.length}`);
  }
  if (outPath) {
    try {
      fs.writeFileSync(outPath, outBuf);
      console.log("saved", outPath, outBuf.length, "bytes");
    } catch (e) {
      saveError = e.message;
      console.error("save error:", e.message);
    }
  }
  const dist = new Map();
  let absent = 0;
  for (const [, s] of seen) {
    if (s === null) absent++;
    else dist.set(s, (dist.get(s) || 0) + 1);
  }
  console.log(`frames=${frames} updates=${updates} unique=${seen.size} grpc-status=${grpcStatus}`);
  console.log(`source=ABSENT(local) : ${absent}`);
  for (const [s, n] of [...dist.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`source=${s} : ${n}`);
    if (s === 17) {
      let i = 0;
      for (const [k, v] of seen) {
        if (v === 17 && i++ < 10) console.log(`   17 key=${k} title=${titles.get(k)}`);
      }
    }
  }
  client.close();
  const hasFailure =
    reqError !== null ||
    saveError !== null ||
    parseErrors > 0 ||
    (httpStatus !== null && httpStatus !== 200) ||
    (grpcStatus !== null && grpcStatus !== "0" && grpcStatus !== 0);
  process.exit(hasFailure ? 1 : 0);
}, seconds * 1000);
