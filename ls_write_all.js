// Batch-write all summaries back to LS/hub with source=0 (UNSPECIFIED)
// and properly encoded ConversationAnnotations from annotations/*.pbtxt.
const http2 = require("http2");
const fs = require("fs");
const path = require("path");

const port = process.env.LS_PORT;
const csrf = process.env.LS_CSRF || "";
const binPath = process.env.LS_STREAM;
const limit = parseInt(process.env.LS_LIMIT || "0", 10);

function readVarint(b, i) {
  let s = 0, v = 0;
  for (;;) { const x = b[i++]; v |= (x & 0x7f) << s; if (!(x & 0x80)) return [v, i]; s += 7; }
}
function varintBuf(n) { const o = []; while (n > 127) { o.push((n & 127) | 128); n >>>= 7; } o.push(n); return Buffer.from(o); }

function entries(buf) {
  const out = []; let i = 0;
  while (i < buf.length) {
    const start = i;
    const [key, ni] = readVarint(buf, i);
    const fn = key >> 3, wt = key & 7; i = ni;
    let val = null;
    if (wt === 0) { const [v, ni2] = readVarint(buf, i); val = v; i = ni2; }
    else if (wt === 2) { const [ln, ni2] = readVarint(buf, i); i = ni2; val = buf.slice(i, i + ln); i += ln; }
    else if (wt === 1) { val = buf.slice(i, i + 8); i += 8; }
    else if (wt === 5) { val = buf.slice(i, i + 4); i += 4; }
    else throw new Error("wt " + wt);
    out.push({ fn, wt, tag: buf.slice(start, ni), val });
  }
  return out;
}

function frames(path) {
  const b = fs.readFileSync(path); const out = []; let i = 0;
  while (i + 5 <= b.length) {
    const ln = b.readUInt32BE(i + 1);
    if (i + 5 + ln > b.length) break;
    out.push(b.slice(i + 5, i + 5 + ln)); i += 5 + ln;
  }
  return out;
}

function collect(path) {
  const map = new Map();
  for (const payload of frames(path)) {
    for (const e of entries(payload)) {
      if (e.fn !== 1 || e.wt !== 2) continue;
      const sub = entries(e.val);
      const k = sub.find((x) => x.fn === 1 && x.wt === 2);
      const v = sub.find((x) => x.fn === 2 && x.wt === 2);
      if (k && v) map.set(k.val.toString("utf8"), v.val);
    }
  }
  return map;
}

function getModTime(summary) {
  for (const e of entries(summary)) {
    if (e.fn === 3 && e.wt === 2) { // 3: last_modified_time
      let sec = 0, nano = 0;
      for (const se of entries(e.val)) {
        if (se.fn === 1 && se.wt === 0) sec = se.val;
        if (se.fn === 2 && se.wt === 0) nano = se.val;
      }
      return { sec, nano };
    }
  }
  return { sec: 0, nano: 0 };
}

function buildAnnotationFromPbtxt(content, modSec, modNano) {
  let title = "";
  let archived = false;
  let viewSec = 0;
  let viewNano = 0;
  let archSec = 0;
  let archNano = 0;
  let markedUnread = false;

  const titleMatch = content.match(/title:\s*"([^"]*)"/);
  if (titleMatch) title = titleMatch[1];
  if (/archived:\s*true/.test(content)) archived = true;
  if (/marked_as_unread:\s*true/.test(content)) markedUnread = true;

  const archMatch = content.match(/archival_status_timestamp:\s*\{seconds:\s*(\d+)(?:\s+nanos:\s*(\d+))?\}/);
  if (archMatch) {
    archSec = parseInt(archMatch[1], 10);
    archNano = archMatch[2] ? parseInt(archMatch[2], 10) : 0;
  }

  const viewMatch = content.match(/last_user_view_time:\s*\{seconds:\s*(\d+)(?:\s+nanos:\s*(\d+))?\}/);
  if (viewMatch) {
    viewSec = parseInt(viewMatch[1], 10);
    viewNano = viewMatch[2] ? parseInt(viewMatch[2], 10) : 0;
  }

  // If not explicitly marked as unread, make sure view time is at least modified time
  if (!markedUnread && modSec > 0) {
    if (viewSec < modSec) {
      viewSec = modSec;
      viewNano = modNano || 0;
    }
  }

  const parts = [];
  // 1: title
  if (title) {
    const tb = Buffer.from(title, "utf8");
    parts.push(Buffer.from([0x0a]), varintBuf(tb.length), tb);
  }
  // 4: archived (varint)
  if (archived) {
    parts.push(Buffer.from([0x20, 0x01]));
  }
  // 5: archival_status_timestamp
  if (archSec > 0) {
    const tsParts = [Buffer.from([0x08]), varintBuf(archSec)];
    if (archNano > 0) tsParts.push(Buffer.from([0x10]), varintBuf(archNano));
    const tsBuf = Buffer.concat(tsParts);
    parts.push(Buffer.from([0x2a]), varintBuf(tsBuf.length), tsBuf);
  }
  // 7: last_user_view_time
  if (viewSec > 0) {
    const tsParts = [Buffer.from([0x08]), varintBuf(viewSec)];
    if (viewNano > 0) tsParts.push(Buffer.from([0x10]), varintBuf(viewNano));
    const tsBuf = Buffer.concat(tsParts);
    parts.push(Buffer.from([0x3a]), varintBuf(tsBuf.length), tsBuf);
  }
  // 8: marked_as_unread
  if (markedUnread) {
    parts.push(Buffer.from([0x40, 0x01]));
  }

  return parts.length > 0 ? Buffer.concat(parts) : null;
}

function rebuild(id, summary, newSource) {
  const mod = getModTime(summary);
  const parts = [];
  for (const e of entries(summary)) {
    if (e.fn === 20 || e.fn === 15) continue; // strip old source & old annotations
    if (e.wt === 0) parts.push(Buffer.concat([e.tag, varintBuf(e.val)]));
    else if (e.wt === 2) parts.push(Buffer.concat([e.tag, varintBuf(e.val.length), e.val]));
    else parts.push(Buffer.concat([e.tag, e.val]));
  }

  // Field 20: source (newSource = 0)
  parts.push(Buffer.concat([Buffer.from([0xa0, 0x01]), varintBuf(newSource)]));

  // Field 15: annotations
  if (id) {
    const userDir = process.env.USERPROFILE || "C:\\Users\\Telekom";
    const annPath = path.join(userDir, ".gemini", "antigravity", "annotations", `${id}.pbtxt`);
    if (fs.existsSync(annPath)) {
      try {
        const annContent = fs.readFileSync(annPath, "utf8");
        const annBuf = buildAnnotationFromPbtxt(annContent, mod.sec, mod.nano);
        if (annBuf) {
          parts.push(Buffer.concat([Buffer.from([0x7a]), varintBuf(annBuf.length), annBuf]));
        }
      } catch (err) {}
    } else if (mod.sec > 0) {
      // No pbtxt file, create default view time = mod time so it's not unread
      const tsParts = [Buffer.from([0x08]), varintBuf(mod.sec)];
      if (mod.nano > 0) tsParts.push(Buffer.from([0x10]), varintBuf(mod.nano));
      const tsBuf = Buffer.concat(tsParts);
      const annBuf = Buffer.concat([Buffer.from([0x3a]), varintBuf(tsBuf.length), tsBuf]);
      parts.push(Buffer.concat([Buffer.from([0x7a]), varintBuf(annBuf.length), annBuf]));
    }
  }

  return Buffer.concat(parts);
}

function currentSource(summary) {
  for (const e of entries(summary)) if (e.fn === 20) return e.val;
  return null;
}

function hasArchivedInAnnotations(summary) {
  for (const e of entries(summary)) {
    if (e.fn === 15 && e.wt === 2) {
      for (const se of entries(e.val)) {
        if (se.fn === 4 && se.wt === 0 && se.val === 1) return true;
      }
    }
  }
  return false;
}

function makeReq(id, summary) {
  const req = Buffer.concat([
    Buffer.from([0x0a]), varintBuf(Buffer.byteLength(id, "utf8")), Buffer.from(id, "utf8"),
    Buffer.from([0x12]), varintBuf(summary.length), summary,
  ]);
  const frame = Buffer.alloc(5 + req.length);
  frame[0] = 0; frame.writeUInt32BE(req.length, 1); req.copy(frame, 5);
  return frame;
}

function main() {
  const map = collect(binPath);
  const userDir = process.env.USERPROFILE || "C:\\Users\\Telekom";
  const annDir = path.join(userDir, ".gemini", "antigravity", "annotations");
  const jobs = [];

  for (const [id, sum] of map) {
    const s = currentSource(sum);
    // Needs rewrite if:
    // 1) source is 17 (CLI)
    // 2) or pbtxt says archived but summary doesn't have field 4
    // 3) or summary has no field 15
    let needsRewrite = (s === 17);
    if (!needsRewrite) {
      const annPath = path.join(annDir, `${id}.pbtxt`);
      if (fs.existsSync(annPath)) {
        const content = fs.readFileSync(annPath, "utf8");
        const shouldBeArchived = /archived:\s*true/.test(content);
        const isArchived = hasArchivedInAnnotations(sum);
        if (shouldBeArchived !== isArchived) {
          needsRewrite = true;
        }
      }
    }
    if (needsRewrite) jobs.push(id);
  }
  console.log("total in dump:", map.size, "| to rewrite:", jobs.length);
  const todo = limit > 0 ? jobs.slice(0, limit) : jobs;

  if (todo.length === 0) {
    console.log("Nothing to rewrite, all good.");
    process.exit(0);
  }

  const client = http2.connect(`https://127.0.0.1:${port}`, { rejectUnauthorized: false });
  client.on("error", (e) => { console.log("CLIENT ERROR:", e.message); process.exit(1); });

  let ok = 0, bad = 0; const errs = {};
  const results = [];

  function doWrite(id) {
    return new Promise((resolve) => {
      const summary = rebuild(id, map.get(id), 0);
      const r = client.request({
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
      r.on("trailers", (t) => { status = t["grpc-status"]; });
      r.on("error", (e) => { status = "ERR:" + e.message; });
      r.on("close", () => resolve(status));
      r.on("data", () => {});
      r.end(makeReq(id, summary));
    });
  }

  (async () => {
    for (let i = 0; i < todo.length; i++) {
      const st = await doWrite(todo[i]);
      if (st === "0" || st === 0) { ok++; }
      else { bad++; errs[st] = (errs[st] || 0) + 1; if (results.length < 10) results.push([todo[i], st]); }
      if ((i + 1) % 50 === 0) console.log(`  progress ${i + 1}/${todo.length} ok=${ok} bad=${bad}`);
    }
    console.log("DONE ok=", ok, "bad=", bad, "errs=", JSON.stringify(errs));
    if (results.length) console.log("first errors:", JSON.stringify(results));
    client.close();
    process.exit(bad ? 3 : 0);
  })();
}
main();
