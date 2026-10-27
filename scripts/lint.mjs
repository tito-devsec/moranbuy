import { readdirSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';

// A small repository linter: no secrets, no CRLF, no tabs in JS, no multi-line comment blocks longer than one line in JS.
const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage', 'LICENSE']);
// Files written for the Moran AI tree follow Moran's own comment conventions, so the comment rule is not applied there.
const MORAN_STYLE = /integrations\/moran-backend\//;
const SECRET_PATTERNS = [/sk-[A-Za-z0-9]{20,}/, /AKIA[0-9A-Z]{16}/, /-----BEGIN (RSA |EC )?PRIVATE KEY-----/, /xox[baprs]-[A-Za-z0-9-]{10,}/];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const problems = [];
for (const f of walk(process.cwd())) {
  if (/\.(png|jpg|ico|ttf|woff2?|lock)$/.test(f) || f.endsWith('package-lock.json')) continue;
  const text = readFileSync(f, 'utf8');
  if (text.includes('\r\n')) problems.push(`${f}: CRLF line endings`);
  for (const re of SECRET_PATTERNS) if (re.test(text)) problems.push(`${f}: looks like it contains a secret`);
  if (/\.(m?js)$/.test(f) && !MORAN_STYLE.test(f)) {
    if (/^\t/m.test(text)) problems.push(`${f}: tab indentation`);
    const lines = text.split('\n');
    let run = 0;
    lines.forEach((line, i) => {
      run = /^\s*(\/\/|\*|\/\*)/.test(line) ? run + 1 : 0;
      if (run === 3) problems.push(`${f}:${i + 1}: comment longer than one line, keep comments to a single line`);
    });
  }
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log('Lint passed');
