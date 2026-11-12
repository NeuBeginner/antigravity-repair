const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/**
 * Creates a new timestamped backup session directory.
 */
function createBackupSession(baseDir) {
  const root = baseDir || path.join(process.cwd(), "backups");
  fs.mkdirSync(root, { recursive: true });

  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const randomSuffix = crypto.randomBytes(3).toString("hex");
  const sessionDir = path.join(root, `backup-${stamp}-${randomSuffix}`);

  fs.mkdirSync(sessionDir, { recursive: true });

  const manifest = {
    version: 1,
    createdAt: now.toISOString(),
    sessionDir,
    items: {},
  };
  fs.writeFileSync(path.join(sessionDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  return sessionDir;
}

/**
 * Saves exact original binary bytes for a conversation before modification.
 */
function backupSummary(sessionDir, conversationId, rawBytes, metadata = {}) {
  if (!sessionDir || !fs.existsSync(sessionDir)) {
    throw new Error(`Backup directory does not exist: ${sessionDir}`);
  }
  if (!Buffer.isBuffer(rawBytes)) {
    throw new TypeError("Expected rawBytes to be a Buffer");
  }

  const hash = crypto.createHash("sha256").update(rawBytes).digest("hex");
  const binFile = path.join(sessionDir, `${conversationId}.bin`);
  fs.writeFileSync(binFile, rawBytes);

  const manifestPath = path.join(sessionDir, "manifest.json");
  let manifest = { items: {} };
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (err) {}

  manifest.items[conversationId] = {
    file: `${conversationId}.bin`,
    size: rawBytes.length,
    sha256: hash,
    backedUpAt: new Date().toISOString(),
    ...metadata,
  };

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return { file: binFile, hash, size: rawBytes.length };
}

/**
 * Verifies and reads back raw summary bytes from a backup session.
 */
function readBackupSummary(sessionDir, conversationId) {
  const binFile = path.join(sessionDir, `${conversationId}.bin`);
  if (!fs.existsSync(binFile)) {
    throw new Error(`Backup file not found for ${conversationId} at ${binFile}`);
  }
  const bytes = fs.readFileSync(binFile);

  const manifestPath = path.join(sessionDir, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const meta = manifest.items?.[conversationId];
      if (meta?.sha256) {
        const actualHash = crypto.createHash("sha256").update(bytes).digest("hex");
        if (actualHash !== meta.sha256) {
          throw new Error(
            `Backup integrity error for ${conversationId}: expected SHA256 ${meta.sha256}, got ${actualHash}`
          );
        }
      }
    } catch (e) {
      if (e.message.startsWith("Backup integrity error")) throw e;
    }
  }

  return bytes;
}

/**
 * Returns latest backup session directory in baseDir.
 */
function getLatestBackupSession(baseDir) {
  const root = baseDir || path.join(process.cwd(), "backups");
  if (!fs.existsSync(root)) return null;

  const entries = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("backup-"))
    .map((d) => path.join(root, d.name))
    .sort()
    .reverse();

  return entries.length > 0 ? entries[0] : null;
}

module.exports = {
  createBackupSession,
  backupSummary,
  readBackupSummary,
  getLatestBackupSession,
};
