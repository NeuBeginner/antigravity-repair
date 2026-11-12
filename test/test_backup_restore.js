const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const {
  createBackupSession,
  backupSummary,
  readBackupSummary,
  getLatestBackupSession,
} = require("../lib/backup");

function runBackupRestoreTests() {
  console.log("--- Running Backup & Restore Tests ---");
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

  // Create isolated temp workspace for this test run
  const testRoot = path.join(os.tmpdir(), `ag_test_backup_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(testRoot, { recursive: true });

  try {
    test("createBackupSession initializes directory and valid manifest", () => {
      const sessionDir = createBackupSession(testRoot);
      assert.ok(fs.existsSync(sessionDir));

      const manifestPath = path.join(sessionDir, "manifest.json");
      assert.ok(fs.existsSync(manifestPath));

      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      assert.strictEqual(manifest.version, 1);
      assert.strictEqual(manifest.sessionDir, sessionDir);
      assert.deepStrictEqual(manifest.items, {});
    });

    test("backupSummary writes exact bytes and updates manifest with sha256", () => {
      const sessionDir = createBackupSession(testRoot);
      const conversationId = "conv-12345-abcde";
      const sampleBytes = Buffer.from("mock_raw_protobuf_summary_content_binary\x00\x01\x02\xff");

      const expectedSha256 = crypto.createHash("sha256").update(sampleBytes).digest("hex");

      const res = backupSummary(sessionDir, conversationId, sampleBytes, {
        reasons: ["source=17 (CLI -> LOCAL)"],
      });

      assert.strictEqual(res.hash, expectedSha256);
      assert.strictEqual(res.size, sampleBytes.length);
      assert.ok(fs.existsSync(res.file));

      // Read manifest
      const manifest = JSON.parse(fs.readFileSync(path.join(sessionDir, "manifest.json"), "utf8"));
      const item = manifest.items[conversationId];
      assert.ok(item);
      assert.strictEqual(item.file, `${conversationId}.bin`);
      assert.strictEqual(item.size, sampleBytes.length);
      assert.strictEqual(item.sha256, expectedSha256);
      assert.deepStrictEqual(item.reasons, ["source=17 (CLI -> LOCAL)"]);
    });

    test("readBackupSummary reads back exact bytes when SHA256 matches", () => {
      const sessionDir = createBackupSession(testRoot);
      const conversationId = "conv-verify-ok";
      const sampleBytes = crypto.randomBytes(256);

      backupSummary(sessionDir, conversationId, sampleBytes);

      const restoredBytes = readBackupSummary(sessionDir, conversationId);
      assert.deepStrictEqual(restoredBytes, sampleBytes);
    });

    test("readBackupSummary detects file tampering and throws integrity error", () => {
      const sessionDir = createBackupSession(testRoot);
      const conversationId = "conv-tampered";
      const sampleBytes = Buffer.from("authentic_data");

      backupSummary(sessionDir, conversationId, sampleBytes);

      // Tamper with the file on disk
      const binFile = path.join(sessionDir, `${conversationId}.bin`);
      fs.writeFileSync(binFile, Buffer.from("tampered_corrupted_data"));

      assert.throws(
        () => readBackupSummary(sessionDir, conversationId),
        (err) => /Backup integrity error/.test(err.message)
      );
    });

    test("readBackupSummary throws on non-existent conversation", () => {
      const sessionDir = createBackupSession(testRoot);
      assert.throws(
        () => readBackupSummary(sessionDir, "non-existent-id"),
        /Backup file not found/
      );
    });

    test("getLatestBackupSession returns the newest session", () => {
      const latestTestDir = path.join(testRoot, "latest_check");
      fs.mkdirSync(latestTestDir, { recursive: true });

      const dirA = path.join(latestTestDir, "backup-20261112-100000-aaa");
      const dirB = path.join(latestTestDir, "backup-20261112-100500-bbb");
      const dirC = path.join(latestTestDir, "backup-20261112-101000-ccc");

      fs.mkdirSync(dirA, { recursive: true });
      fs.mkdirSync(dirB, { recursive: true });
      fs.mkdirSync(dirC, { recursive: true });

      const latest = getLatestBackupSession(latestTestDir);
      assert.strictEqual(latest, dirC);
    });
  } finally {
    // Clean up temporary workspace
    try {
      fs.rmSync(testRoot, { recursive: true, force: true });
    } catch (e) {}
  }

  console.log(`Backup & Restore Suite Passed: ${passed} tests.\n`);
  return passed;
}

if (require.main === module) {
  runBackupRestoreTests();
}

module.exports = { runBackupRestoreTests };
