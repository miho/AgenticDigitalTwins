/**
 * Convert generated SCXML ES module JS files to CommonJS.
 *
 * This runs as a build step after scxml_generate. It:
 * 1. Fixes import paths (./scxml-runtime.js -> ../scxml-runtime.js)
 * 2. Converts import/export to require/module.exports
 *
 * When Electron fully supports ESM, this script becomes unnecessary.
 */

const fs = require('fs');
const path = require('path');

const MODULES_DIR = path.join(__dirname, '..', 'dist', 'state-machines', 'modules');
const RUNTIME_DIR = path.join(__dirname, '..', 'dist', 'state-machines');

/** Retry read + write around Dropbox's transient file lock. Symptom:
 *  `UNKNOWN: unknown error, open …` (errno -4094 / code 'UNKNOWN')
 *  when Dropbox is indexing the file Node is trying to write. A
 *  tight retry with exponential backoff clears it in practice. */
function readFileWithRetry(p, attempts = 6) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return fs.readFileSync(p, 'utf-8'); }
    catch (e) {
      lastErr = e;
      if (e.code !== 'UNKNOWN' && e.code !== 'EBUSY' && e.code !== 'EPERM') throw e;
      const wait = 80 * Math.pow(2, i);  // 80, 160, 320, 640, 1280, 2560 ms
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    }
  }
  throw lastErr;
}

function writeFileWithRetry(p, data, attempts = 6) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { fs.writeFileSync(p, data, 'utf-8'); return; }
    catch (e) {
      lastErr = e;
      if (e.code !== 'UNKNOWN' && e.code !== 'EBUSY' && e.code !== 'EPERM') throw e;
      const wait = 80 * Math.pow(2, i);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    }
  }
  throw lastErr;
}

function convertFile(filePath) {
  let content = readFileWithRetry(filePath);
  const original = content;

  // Fix runtime path in already-CJS files (some src files are authored as CJS
  // with the "same directory" path that only works if runtime is colocated).
  // Do this BEFORE the early-exit so already-converted files still get the
  // path fix.
  content = content.replace(
    /require\('\.\/scxml-runtime\.js'\)/g,
    "require('../scxml-runtime.js')"
  );

  // Already converted? (apart from the path fix above)
  if (content.includes('require(') && content.includes('module.exports')) {
    if (content !== original) {
      writeFileWithRetry(filePath, content);
      return true;
    }
    return false;
  }

  // Fix import path for modules (they reference runtime in parent dir)
  content = content.replace(/from '\.\/scxml-runtime\.js'/g, "from '../scxml-runtime.js'");

  // Convert ES imports to require
  content = content.replace(
    /import \{ (.+?) \} from '(.+?)';/g,
    "const { $1 } = require('$2');"
  );

  // Remove export { ... } blocks
  content = content.replace(/export\s*\{[^}]*\}\s*;?/g, '');

  // Track exported class names before removing export keyword
  const exportedClasses = [];
  content = content.replace(/export class (\w+)/g, (_, name) => {
    exportedClasses.push(name);
    return `class ${name}`;
  });
  content = content.replace(/export function (\w+)/g, (_, name) => {
    exportedClasses.push(name);
    return `function ${name}`;
  });
  content = content.replace(/export const (\w+)/g, (_, name) => {
    exportedClasses.push(name);
    return `const ${name}`;
  });

  // Remove any existing module.exports
  content = content.replace(/module\.exports\s*=\s*\{[^}]*\}\s*;?\s*$/m, '');

  // Find all top-level class declarations for module.exports
  const allClasses = [...new Set([
    ...exportedClasses,
    ...(content.match(/^class\s+(\w+)/gm) || []).map(m => m.replace('class ', ''))
  ])];

  if (allClasses.length > 0) {
    content = content.trimEnd() + '\n\nmodule.exports = { ' + allClasses.join(', ') + ' };\n';
  }

  fs.writeFileSync(filePath, content, 'utf-8');
  return true;
}

// Convert all .js files in modules dir
const files = fs.readdirSync(MODULES_DIR).filter(f => f.endsWith('.js'));
let converted = 0;
for (const file of files) {
  if (convertFile(path.join(MODULES_DIR, file))) {
    console.log(`  Converted: ${file}`);
    converted++;
  }
}

// Also convert the runtime in the parent dir
const runtimePath = path.join(RUNTIME_DIR, 'scxml-runtime.js');
if (fs.existsSync(runtimePath) && convertFile(runtimePath)) {
  console.log('  Converted: scxml-runtime.js');
  converted++;
}

console.log(`Done: ${converted} files converted, ${files.length - converted} already CJS`);
