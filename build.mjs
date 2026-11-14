// Builds dist/mousehunt-super.user.js from src/. No dependencies: it concatenates files in a fixed order.
//
//   src/meta.txt        userscript header (version comes from package.json)
//   src/core/*.js       framework, in filename order, sharing one scope
//   src/modules/*.js    features, in filename order; each file is wrapped in its own block scope
//   src/core/90-boot.js runs last (it is in core/ but must come after the modules, so it is appended explicitly)
//
// Usage: node build.mjs          write dist/
//        node build.mjs --check  fail if dist/ is out of date or the output doesn't parse
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(root, ...p), 'utf8');
const list = (dir) => readdirSync(join(root, dir)).filter((f) => f.endsWith('.js')).sort();
const version = JSON.parse(read('package.json')).version;

const BOOT = '90-boot.js';
const core = list('src/core').filter((f) => f !== BOOT).map((f) => ({ f: `core/${f}`, code: read('src/core', f) }));
const modules = list('src/modules').map((f) => ({ f: `modules/${f}`, code: `{\n${read('src/modules', f)}\n}` }));
const boot = { f: `core/${BOOT}`, code: read('src/core', BOOT) };

const body = [...core, ...modules, boot].map(({ f, code }) => `// ---- ${f} ----\n${code.trimEnd()}\n`).join('\n');
const out = `${read('src/meta.txt').replaceAll('__VERSION__', version).trimEnd()}\n\n(function () {\n'use strict';\n\n${body.replaceAll('__VERSION__', version)}\n})();\n`;

const target = join(root, 'dist', 'mousehunt-super.user.js');
try { new vm.Script(out, { filename: 'mousehunt-super.user.js' }); } catch (e) { console.error(`Build output doesn't parse: ${e.message}`); process.exit(1); }

if (process.argv.includes('--check')) {
  let current = '';
  try { current = readFileSync(target, 'utf8'); } catch {}
  if (current !== out) { console.error('dist/mousehunt-super.user.js is out of date. Run: npm run build'); process.exit(1); }
  console.log('dist is up to date and parses.');
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, out);
  console.log(`Wrote ${target} (${out.length} bytes, v${version})`);
}
