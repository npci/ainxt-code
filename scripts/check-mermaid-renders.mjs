#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright 2026 AiNxt
//
// Renders every mermaid block in every tracked markdown file and fails if any of them
// does not produce a diagram.
//
// Why rendering rather than parsing: mermaid.parse() only checks the grammar. Layout
// runs in render(), which is where dagre failures, version-specific syntax and empty
// output actually appear -- and rendering is what a reader gets on GitHub. A diagram can
// parse cleanly and still show an error box.
//
// mermaid and puppeteer are deliberately NOT dependencies of this repository. They are
// heavy, and adding them would put them in the installed tree for every contributor and
// in the licence inventory for no runtime benefit. CI installs them into a scratch
// directory and points this script at them.
//
//   node scripts/check-mermaid-renders.mjs --mermaid <path/to/mermaid.min.js>
//
// The script carries two deliberately broken diagrams as positive controls. If those do
// not fail, the harness cannot detect breakage and the run aborts rather than reporting
// a meaningless pass.

import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const argIdx = process.argv.indexOf('--mermaid');
const mermaidPath = argIdx > -1 ? process.argv[argIdx + 1] : process.env.MERMAID_DIST;
if (!mermaidPath || !existsSync(mermaidPath)) {
  console.error('error: pass --mermaid <path to mermaid.min.js> (or set MERMAID_DIST).');
  console.error('CI installs mermaid and puppeteer into a scratch directory; they are');
  console.error('intentionally not dependencies of this repository.');
  process.exit(2);
}

// Node's ESM resolver ignores NODE_PATH, so resolve puppeteer out of the same
// node_modules that mermaid came from. createRequire does the real resolution, which
// keeps this working across puppeteer layouts rather than guessing an entry path.
let puppeteer;
{
  const nm = mermaidPath.replace(/[/\\]mermaid[/\\]dist[/\\][^/\\]+$/, '');
  const scratch = dirname(nm);
  try {
    const req = createRequire(pathToFileURL(join(scratch, 'package.json')));
    puppeteer = (await import(pathToFileURL(req.resolve('puppeteer')).href)).default;
  } catch {
    try { puppeteer = (await import('puppeteer')).default; } catch { /* reported below */ }
  }
  if (!puppeteer) {
    console.error('error: puppeteer is not resolvable from the directory mermaid was');
    console.error(`found in (${scratch}). Install mermaid and puppeteer together:`);
    console.error('  npm i mermaid puppeteer');
    process.exit(2);
  }
}

const files = execSync('git ls-files "*.md"', { cwd: REPO, encoding: 'utf8' }).trim().split('\n');
const blocks = [];
for (const f of files) {
  const src = readFileSync(join(REPO, f), 'utf8');
  let i = 0;
  for (const m of src.matchAll(/```mermaid\n([\s\S]*?)```/g)) {
    i += 1;
    blocks.push({
      file: f,
      index: i,
      code: m[1],
      kind: (m[1].trim().split('\n')[0] || '?').slice(0, 30),
    });
  }
}

const CONTROLS = [
  { file: '[control] dangling edge', index: 0, kind: 'control', code: 'flowchart TD\n  A --> ' },
  { file: '[control] unknown diagram type', index: 0, kind: 'control', code: 'notADiagramType\n  A --> B' },
];

const lib = readFileSync(mermaidPath, 'utf8');
const version = (() => {
  try {
    return JSON.parse(readFileSync(join(mermaidPath, '../../package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
})();

const page404 = `<!doctype html><html><head><meta charset="utf-8"><script>${lib}</script></head>
<body><div id="sink"></div></body></html>`;
const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(page404);
});
await new Promise((r) => server.listen(7901, r));

const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(String(e.message).slice(0, 200)));
page.on('console', (m) => {
  if (m.type() === 'error') { consoleErrors.push(m.text().slice(0, 200)); }
});
await page.goto('http://localhost:7901/', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => window.mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' }));

async function render(b) {
  return page.evaluate(async (code, id) => {
    try {
      const { svg } = await window.mermaid.render(`g${id}`, code);
      if (!svg || svg.length < 80) { return { ok: false, err: 'render produced an empty or trivial SVG' }; }
      if (/aria-roledescription="error"|class="error-icon"|Syntax error/i.test(svg)) {
        return { ok: false, err: 'mermaid produced its error diagram' };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, err: String((e && e.message) || e).split('\n').slice(0, 2).join(' | ') };
    }
  }, b.code, `${b.file.replace(/[^a-z0-9]/gi, '')}${b.index}`);
}

let controlsCaught = 0;
for (const c of CONTROLS) {
  const r = await render(c);
  if (!r.ok) { controlsCaught += 1; }
  else { console.error(`control did not fail: ${c.file}`); }
}
if (controlsCaught !== CONTROLS.length) {
  console.error(`\nHARNESS UNRELIABLE: ${controlsCaught}/${CONTROLS.length} controls failed as expected.`);
  console.error('Refusing to report a pass from a check that cannot detect breakage.');
  await browser.close(); server.close();
  process.exit(3);
}

const failures = [];
let rendered = 0;
for (const b of blocks) {
  const r = await render(b);
  if (r.ok) { rendered += 1; } else { failures.push({ ...b, err: r.err }); }
}

await browser.close();
server.close();

console.log(`mermaid ${version}: controls ${controlsCaught}/${CONTROLS.length} rejected, rendered ${rendered}/${blocks.length}`);
if (failures.length) {
  console.error(`\n${failures.length} diagram(s) failed to render:`);
  for (const f of failures) {
    console.error(`  ${f.file} [block ${f.index}] (${f.kind})`);
    console.error(`     ${f.err}`);
  }
  process.exit(1);
}
const real = consoleErrors.filter((e) => !/favicon/i.test(e));
if (real.length) {
  console.error(`\n${real.length} console error(s) while rendering:`);
  real.slice(0, 8).forEach((e) => console.error(`  ${e}`));
  process.exit(1);
}
console.log('every mermaid diagram renders, with no console errors.');
