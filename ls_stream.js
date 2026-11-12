// Read the LS summaries stream and report the `source` distribution.
// usage: LS_PORT=49976 LS_CSRF=... node ls_stream.js [seconds] [reqVariant]
const http2 = require("http2");

const port = process.env.LS_PORT;
const csrf = process.env.LS_CSRF || "";
const seconds = parseInt(process.argv[2] || "20", 10);
const variant = parseInt(process.argv[3] || "0", 10);
if (!port) { console.log("LS_PORT required"); process.exit(2); }

function readVarint(b, i) {
  let s = 0, v = 0;
  for (;;) {
    const x = b[i++];
    v |= (x & 0x7f) << s;
    if (!(x & 0x80)) return [v >>> 0, i];
    s += 7;
    if (s > 35) throw new Error("varint");
  }
}
function varintBuf(n) {
  const o = [];
  while (n > 127) { o.push((n & 127) | 128); n >>>= 7; }
  o.push(n);
  return Buffer.from(o);
}
function entries(buf) {
  const out = []; let i = 0;
  while (i < buf.length) {
    const [key, ni] = readVarint(buf, i);
    const fn = key >>> 3, wt = key & 7;
    i = ni;
    let val = null;
    if (wt === 0) { const [v, n2] = readVarint(buf, i); val = v; i = n2; }
    else if (wt === 2) { const [ln, n2] = readVarint(buf, i); i = n2; val = buf.slice(i, i + ln); i += ln; }
    else if (wt === 1) { val = buf.slice(i, i + 8); i += 8; }
    else if (wt === 5) { val = buf.slice(i, i + 4); i += 4; }
    else throw new Error("wt " + wt);
    out.push({ fn, wt, val });
  }
  return out;
}
function summarySource(sum) {
  for (const e of entries(sum)) if (e.fn === 20) return e.val;
  return null; // absent => proto3 default 0 (local)
}
function summaryTitle(sum) {
  for (const e of entries(sum)) if (e.fn === 1 && e.wt === 2) return e.val.toString("utf8");
  return "";
}

const client = http2.connect(`https://127.0.0.1:${port}`, { rejectUnauthorized: false });
client.on("error", (e) => { console.log("CLIENT ERROR:", e.message); process.exit(1); });

// JetboxSubscribeToSummariesRequest: field 5 = backend (varint)
const body = variant === 0
  ? Buffer.from([0x28, 0x00])
  : variant === 1
    ? Buffer.from([])
    : Buffer.from([0x28, 0x01]);
const frame = Buffer.alloc(5 + body.length);
frame[0] = 0;
frame.writeUInt32BE(body.length, 1);
body.copy(frame, 5);

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

let grpcStatus = null;
let buf = Buffer.alloc(0);
const seen = new Map();     // key -> source
const titles = new Map();
let frames = 0, updates = 0;
const outPath = process.env.LS_OUT || "";
let outBuf = Buffer.alloc(0);

req.on("response", (h) => { console.log("http-status:", h[":status"]); });
req.on("trailers", (t) => { grpcStatus = t["grpc-status"]; });
req.on("error", (e) => { console.log("REQ ERROR:", e.message); });
req.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 5) {
    const len = buf.readUInt32BE(1);
    if (buf.length < 5 + len) break;
    const frameBuf = buf.slice(0, 5 + len);
    const payload = buf.slice(5, 5 + len);
    buf = buf.slice(5 + len);
    frames++;
    if (outPath) outBuf = Buffer.concat([outBuf, frameBuf]);
    try {
      for (const e of entries(payload)) {
        if (e.fn !== 1 || e.wt !== 2) continue;
        const sub = entries(e.val);
        const k = sub.find((x) => x.fn === 1 && x.wt === 2);
        const v = sub.find((x) => x.fn === 2 && x.wt === 2);
        if (!k || !v) continue;
        updates++;
        const key = k.val.toString("utf8");
        seen.set(key, summarySource(v.val));
        if (!titles.has(key)) titles.set(key, summaryTitle(v.val));
      }
    } catch (e) { console.log("parse error:", e.message); }
  }
});
req.end(frame);

setTimeout(() => {
  if (outPath) {
    try { require("fs").writeFileSync(outPath, outBuf); console.log("saved", outPath, outBuf.length, "bytes"); }
    catch (e) { console.log("save error:", e.message); }
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
      for (const [k, v] of seen) if (v === 17 && i++ < 10) console.log(`   17 key=${k} title=${titles.get(k)}`);
    }
  }
  client.close();
  process.exit(0);
}, seconds * 1000);
