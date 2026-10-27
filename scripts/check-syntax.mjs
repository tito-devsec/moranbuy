import { readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Walks the repository and runs `node --check` on every JavaScript file outside node_modules.
const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage']);
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(m?js)$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(process.cwd());
let failed = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (err) { failed += 1; console.error(`${f}\n${err.stderr}`); }
}
console.log(`Syntax checked ${files.length} files, ${failed} failed`);
process.exit(failed ? 1 : 0);
