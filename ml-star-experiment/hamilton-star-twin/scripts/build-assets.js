/**
 * Copy renderer static assets to dist/ with Dropbox-lock retries.
 * Replaces the inline `node -e` form that used copyFileSync
 * without retry. Same reason as build-sm.js.
 */
const fs = require('fs');
const path = require('path');

const ASSETS = ['index.html', 'style.css', 'protocol-editor.html', '3d.html', '3d.js'];
// Subdirectories to mirror (every file inside is copied recursively).
const ASSET_DIRS = ['3d/models'];
const SRC = path.join(__dirname, '..', 'src', 'renderer');
const DST = path.join(__dirname, '..', 'dist', 'renderer');

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function copyWithRetry(src, dst, attempts = 6) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { fs.copyFileSync(src, dst); return; }
    catch (e) {
      lastErr = e;
      if (e.code !== 'UNKNOWN' && e.code !== 'EBUSY' && e.code !== 'EPERM') throw e;
      sleepSync(80 * Math.pow(2, i));
    }
  }
  throw lastErr;
}

function copyDirRecursive(srcDir, dstDir) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(dstDir, entry.name);
    if (entry.isDirectory()) copyDirRecursive(srcPath, dstPath);
    else if (entry.isFile()) copyWithRetry(srcPath, dstPath);
  }
}

fs.mkdirSync(DST, { recursive: true });
for (const f of ASSETS) {
  copyWithRetry(path.join(SRC, f), path.join(DST, f));
}
for (const d of ASSET_DIRS) {
  copyDirRecursive(path.join(SRC, d), path.join(DST, d));
}
