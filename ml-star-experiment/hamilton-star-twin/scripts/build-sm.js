/**
 * Copy SCXML runtime + generated modules from src/ to dist/ with
 * Dropbox-lock retries. Replaces the inline `node -e ...` in
 * package.json's `build:sm` — that inline form ran `copyFileSync`
 * without any retry and failed every few runs because the Dropbox
 * daemon was indexing the just-generated JS files (Windows errno
 * -4094 / UNKNOWN on the next writer).
 */
const fs = require('fs');
const path = require('path');

const SRC_MOD_DIR = path.join(__dirname, '..', 'src', 'state-machines', 'modules');
const DST_MOD_DIR = path.join(__dirname, '..', 'dist', 'state-machines', 'modules');
const RUNTIME_SRC = path.join(__dirname, '..', 'src', 'state-machines', 'scxml-runtime.js');
const RUNTIME_DST = path.join(__dirname, '..', 'dist', 'state-machines', 'scxml-runtime.js');

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
      sleepSync(80 * Math.pow(2, i));   // 80, 160, 320, 640, 1280, 2560 ms
    }
  }
  throw lastErr;
}

fs.mkdirSync(DST_MOD_DIR, { recursive: true });
copyWithRetry(RUNTIME_SRC, RUNTIME_DST);
for (const f of fs.readdirSync(SRC_MOD_DIR).filter(x => x.endsWith('.js'))) {
  copyWithRetry(path.join(SRC_MOD_DIR, f), path.join(DST_MOD_DIR, f));
}
