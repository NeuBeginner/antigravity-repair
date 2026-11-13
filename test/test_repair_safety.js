const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const {
  decodeEntries,
  encodeEntries,
  encodeVarint,
  encodeFrame,
} = require("../lib/protobuf");
const {
  transformSummary,
  mergeAnnotations,
  verifyTransformedSummary,
  SafetyCheckError,
  getSource,
  getLastModifiedTime,
} = require("../lib/repair");

function runRepairSafetyTests() {
  console.log("--- Running Repair Safety Tests ---");
  let passed = 0;

  function test(name, fn) {
    try {
      fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      console.error(`  ✗ ${name}`);
      throw err;
    }
  }

  test("unknown fields in CascadeTrajectorySummary are preserved untouched", () => {
    // Construct synthetic summary with unknown fields (e.g., 99, 105, 250)
    // and standard fields: 1 (id), 3 (modTime), 20 (source=17)
    const modTimeVal = encodeEntries([
      { fn: 1, wt: 0, val: 1731400000n },
      { fn: 2, wt: 0, val: 500n },
    ]);

    const unknown99Val = Buffer.from("custom_field_99_payload");
    const unknown105Val = 123456789n;

    const originalEntries = [
      { fn: 1, wt: 2, val: Buffer.from("conv-test-unknown", "utf8") },
      { fn: 3, wt: 2, val: modTimeVal },
      { fn: 20, wt: 0, val: 17n }, // source = 17 (CLI)
      { fn: 99, wt: 2, val: unknown99Val },
      { fn: 105, wt: 0, val: unknown105Val },
    ];

    const rawBuf = encodeEntries(originalEntries);
    const pbtxt = `
      title: "Preserved Conversation"
      archived: false
    `;

    const { transformedBuffer } = transformSummary(rawBuf, pbtxt, "conv-test-unknown");

    const decoded = decodeEntries(transformedBuffer);

    // Source must be rewritten to 0
    assert.strictEqual(getSource(decoded), 0);

    // Unknown field 99 must exist and have exact payload
    const f99 = decoded.find((e) => e.fn === 99);
    assert.ok(f99, "Field 99 must be preserved");
    assert.strictEqual(f99.wt, 2);
    assert.deepStrictEqual(f99.val, unknown99Val);

    // Unknown field 105 must exist and have exact value
    const f105 = decoded.find((e) => e.fn === 105);
    assert.ok(f105, "Field 105 must be preserved");
    assert.strictEqual(f105.wt, 0);
    assert.strictEqual(f105.val, unknown105Val);

    // Field 15 annotations must be added
    const f15 = decoded.find((e) => e.fn === 15);
    assert.ok(f15, "Field 15 annotations must be present");
  });

  test("unknown subfields in ConversationAnnotations are preserved during merge", () => {
    // Existing annotations with field 3 (tags), 6 (starred), 99 (unknown metadata)
    const existingSub = [
      { fn: 1, wt: 2, val: Buffer.from("Old Title", "utf8") },
      { fn: 3, wt: 2, val: Buffer.from("important", "utf8") },
      { fn: 6, wt: 0, val: 1n }, // starred
      { fn: 99, wt: 2, val: Buffer.from("unknown_annotation_data", "utf8") },
    ];
    const existingF15Buf = encodeEntries(existingSub);

    const pbtxt = `
      title: "Updated Title"
      archived: true
    `;

    const modTime = { sec: 1731405000, nano: 0 };
    const mergedBuf = mergeAnnotations(existingF15Buf, pbtxt, modTime, "conv-ann-test");

    const decodedSub = decodeEntries(mergedBuf);

    // Title updated
    const f1 = decodedSub.find((e) => e.fn === 1);
    assert.strictEqual(f1.val.toString("utf8"), "Updated Title");

    // Archived added
    const f4 = decodedSub.find((e) => e.fn === 4);
    assert.strictEqual(Number(f4.val), 1);

    // Unknown subfields preserved!
    const f3 = decodedSub.find((e) => e.fn === 3);
    assert.ok(f3, "Subfield 3 (tags) must be preserved");
    assert.strictEqual(f3.val.toString("utf8"), "important");

    const f6 = decodedSub.find((e) => e.fn === 6);
    assert.ok(f6, "Subfield 6 (starred) must be preserved");
    assert.strictEqual(Number(f6.val), 1);

    const f99 = decodedSub.find((e) => e.fn === 99);
    assert.ok(f99, "Subfield 99 must be preserved");
    assert.strictEqual(f99.val.toString("utf8"), "unknown_annotation_data");
  });

  test("marked_as_unread is respected: does NOT bump view time when true", () => {
    const modTime = { sec: 1731499999, nano: 0 };
    const pbtxt = `
      title: "Unread Conversation"
      marked_as_unread: true
      last_user_view_time {
        seconds: 1731000000
      }
    `;

    const mergedBuf = mergeAnnotations(null, pbtxt, modTime, "conv-unread");
    const decodedSub = decodeEntries(mergedBuf);

    const f8 = decodedSub.find((e) => e.fn === 8);
    assert.ok(f8, "marked_as_unread field 8 must be set");
    assert.strictEqual(Number(f8.val), 1);

    const f7 = decodedSub.find((e) => e.fn === 7);
    assert.ok(f7, "last_user_view_time field 7 must be set");
    const viewEntries = decodeEntries(f7.val);
    const viewSec = Number(viewEntries.find((e) => e.fn === 1).val);

    // View time MUST stay at 1731000000 and NOT be bumped to modTime 1731499999
    assert.strictEqual(viewSec, 1731000000);
  });

  test("view time is aligned with modTime when marked_as_unread is false", () => {
    const modTime = { sec: 1731499999, nano: 123 };
    const pbtxt = `
      title: "Read Conversation"
      marked_as_unread: false
      last_user_view_time {
        seconds: 1731000000
      }
    `;

    const mergedBuf = mergeAnnotations(null, pbtxt, modTime, "conv-read");
    const decodedSub = decodeEntries(mergedBuf);

    const f7 = decodedSub.find((e) => e.fn === 7);
    const viewEntries = decodeEntries(f7.val);
    const viewSec = Number(viewEntries.find((e) => e.fn === 1).val);

    // View time bumped to modTime to ensure it appears as read
    assert.strictEqual(viewSec, 1731499999);
  });

  test("verifyTransformedSummary detects violations", () => {
    // Valid summary
    const validEntries = [
      { fn: 15, wt: 2, val: encodeEntries([{ fn: 1, wt: 2, val: Buffer.from("Valid Title") }, { fn: 4, wt: 0, val: 1n }]) },
      { fn: 20, wt: 0, val: 0n },
    ];
    const validBuf = encodeEntries(validEntries);
    assert.strictEqual(verifyTransformedSummary(validBuf, { title: "Valid Title", archived: true }), true);

    // Violation: source is 17 instead of 0
    const badSrc = encodeEntries([
      { fn: 15, wt: 2, val: encodeEntries([{ fn: 1, wt: 2, val: Buffer.from("Title") }]) },
      { fn: 20, wt: 0, val: 17n },
    ]);
    assert.throws(() => verifyTransformedSummary(badSrc), /expected source 0/);

    // Violation: missing field 15
    const missingF15 = encodeEntries([{ fn: 20, wt: 0, val: 0n }]);
    assert.throws(() => verifyTransformedSummary(missingF15), /missing field 15 annotations/);

    // Violation: expected archived=false, but got true
    assert.throws(
      () => verifyTransformedSummary(validBuf, { archived: false }),
      /expected archived=false, got true/
    );
  });

  test("dry-run CLI test: plans modifications with zero network RPC calls", () => {
    // Create an isolated temporary test directory
    const tempDir = path.join(os.tmpdir(), `ag_test_dryrun_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tempDir, { recursive: true });

    try {
      // Create a synthetic dump binary containing 2 conversations with source=17
      const conv1Id = "conv-dryrun-001";
      const conv2Id = "conv-dryrun-002";

      function makeSyntheticSummary(id) {
        return encodeEntries([
          { fn: 1, wt: 2, val: Buffer.from(id, "utf8") },
          { fn: 3, wt: 2, val: encodeEntries([{ fn: 1, wt: 0, val: 1731400000n }]) },
          { fn: 20, wt: 0, val: 17n }, // source 17
        ]);
      }

      function makeMapEntry(k, v) {
        const sub = encodeEntries([
          { fn: 1, wt: 2, val: Buffer.from(k, "utf8") },
          { fn: 2, wt: 2, val: v },
        ]);
        return { fn: 1, wt: 2, val: sub };
      }

      const mapEntries = [
        makeMapEntry(conv1Id, makeSyntheticSummary(conv1Id)),
        makeMapEntry(conv2Id, makeSyntheticSummary(conv2Id)),
      ];

      const dumpPayload = encodeEntries(mapEntries);
      const dumpFrame = encodeFrame(dumpPayload);
      const dumpFile = path.join(tempDir, "mock_dump.bin");
      fs.writeFileSync(dumpFile, dumpFrame);

      // Execute ls_write_all.js with --dry-run
      const scriptPath = path.resolve(__dirname, "../ls_write_all.js");
      const res = spawnSync(
        process.execPath,
        [scriptPath, "--dry-run"],
        {
          cwd: tempDir,
          env: {
            ...process.env,
            LS_STREAM: dumpFile,
            USERPROFILE: tempDir, // Isolate pbtxt directory lookup
          },
          encoding: "utf8",
        }
      );

      assert.strictEqual(res.status, 0);
      assert.ok(res.stdout.includes("=== DRY-RUN PLAN (2 items) ==="));
      assert.ok(res.stdout.includes(conv1Id));
      assert.ok(res.stdout.includes(conv2Id));
      assert.ok(res.stdout.includes("[DRY-RUN COMPLETE] Planned updates for 2 summaries. Zero write RPC calls performed."));
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (e) {}
    }
  });

  test("empty or comments-only pbtxt throws SafetyCheckError", () => {
    const rawBuf = encodeEntries([
      { fn: 1, wt: 2, val: Buffer.from("conv-empty-pbtxt", "utf8") },
      { fn: 3, wt: 2, val: encodeEntries([{ fn: 1, wt: 0, val: 1731400000n }]) },
      { fn: 20, wt: 0, val: 17n },
    ]);

    assert.throws(
      () => transformSummary(rawBuf, "", "conv-empty-pbtxt"),
      (err) => err instanceof SafetyCheckError && /empty or contains no recognized/.test(err.message)
    );

    assert.throws(
      () => transformSummary(rawBuf, "# only comments\n", "conv-empty-pbtxt"),
      (err) => err instanceof SafetyCheckError && /empty or contains no recognized/.test(err.message)
    );
  });

  test("corrupted pbtxt causes non-zero exit code in ls_write_all.js even when source=0 and field 15 exist", () => {
    const tempDir = path.join(os.tmpdir(), `ag_test_badpbtxt_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    const annDir = path.join(tempDir, ".gemini", "antigravity", "annotations");
    fs.mkdirSync(annDir, { recursive: true });

    try {
      const convId = "conv-corrupt-pbtxt";
      const sumBuf = encodeEntries([
        { fn: 1, wt: 2, val: Buffer.from(convId, "utf8") },
        { fn: 15, wt: 2, val: encodeEntries([{ fn: 1, wt: 2, val: Buffer.from("Ok", "utf8") }]) },
        { fn: 20, wt: 0, val: 0n }, // source = 0, field 15 present
      ]);
      const entry = encodeEntries([
        { fn: 1, wt: 2, val: Buffer.from(convId, "utf8") },
        { fn: 2, wt: 2, val: sumBuf },
      ]);
      const dumpFile = path.join(tempDir, "dump.bin");
      fs.writeFileSync(dumpFile, encodeFrame(encodeEntries([{ fn: 1, wt: 2, val: entry }])));

      // Write malformed pbtxt
      fs.writeFileSync(path.join(annDir, `${convId}.pbtxt`), 'title: "Unterminated', "utf8");

      const scriptPath = path.resolve(__dirname, "../ls_write_all.js");
      const res = spawnSync(process.execPath, [scriptPath, "--dry-run"], {
        cwd: tempDir,
        env: { ...process.env, LS_STREAM: dumpFile, USERPROFILE: tempDir },
        encoding: "utf8",
      });

      assert.notStrictEqual(res.status, 0, "Expected non-zero exit on corrupted pbtxt");
      assert.ok(res.stderr.includes("Invalid or unreadable pbtxt"), "Expected error message in stderr");
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (e) {}
    }
  });

  test("explicitly unread conversations (marked_as_unread: true) are skipped in ls_write_all.js", () => {
    const tempDir = path.join(os.tmpdir(), `ag_test_unread_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    const annDir = path.join(tempDir, ".gemini", "antigravity", "annotations");
    fs.mkdirSync(annDir, { recursive: true });

    try {
      const convId = "conv-skip-unread";
      const sumBuf = encodeEntries([
        { fn: 1, wt: 2, val: Buffer.from(convId, "utf8") },
        { fn: 3, wt: 2, val: encodeEntries([{ fn: 1, wt: 0, val: 1731400000n }]) },
        { fn: 20, wt: 0, val: 17n }, // source = 17
      ]);
      const entry = encodeEntries([
        { fn: 1, wt: 2, val: Buffer.from(convId, "utf8") },
        { fn: 2, wt: 2, val: sumBuf },
      ]);
      const dumpFile = path.join(tempDir, "dump.bin");
      fs.writeFileSync(dumpFile, encodeFrame(encodeEntries([{ fn: 1, wt: 2, val: entry }])));

      fs.writeFileSync(
        path.join(annDir, `${convId}.pbtxt`),
        'title: "Unread"\nmarked_as_unread: true\n',
        "utf8"
      );

      const scriptPath = path.resolve(__dirname, "../ls_write_all.js");
      const res = spawnSync(process.execPath, [scriptPath, "--dry-run"], {
        cwd: tempDir,
        env: { ...process.env, LS_STREAM: dumpFile, USERPROFILE: tempDir },
        encoding: "utf8",
      });

      assert.strictEqual(res.status, 0);
      assert.ok(res.stdout.includes(`[SKIP] ${convId}: explicitly marked as unread`));
      assert.ok(res.stdout.includes("=== DRY-RUN PLAN (0 items) ==="));
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (e) {}
    }
  });

  console.log(`Repair Safety Suite Passed: ${passed} tests.\n`);
  return passed;
}

if (require.main === module) {
  runRepairSafetyTests();
}

module.exports = { runRepairSafetyTests };
