#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright 2026 AiNxt
//
// Generates THIRD-PARTY-NOTICES for the code this project actually redistributes.
//
// Scope is deliberately the *runtime* dependency closure of the two bundles that ship
// inside the .vsix -- the webpacked extension host and the Vite-built webview -- not the
// whole dev tree. Build and test tooling is not redistributed, so attributing it would
// be noise; conversely a transitive runtime dependency IS redistributed even though npm
// calls it transitive, which is exactly what a hand-maintained list tends to miss.
//
// MIT and BSD require the copyright notice and permission notice to travel with the
// code. Licence texts are therefore emitted verbatim, deduplicated by text so a licence
// shared by forty packages appears once with all forty copyright lines against it.
//
//   node scripts/generate-third-party-notices.mjs            write the file
//   node scripts/generate-third-party-notices.mjs --check    fail if out of date
//
// Run it after changing any runtime dependency. CI enforces --check.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'THIRD-PARTY-NOTICES');

/** Runtime closure of one manifest, resolved against one node_modules tree. */
function closure(nodeModules, manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const seen = new Set();
  const queue = Object.keys(manifest.dependencies || {});
  while (queue.length) {
    const name = queue.pop();
    if (seen.has(name)) { continue; }
    const pj = join(nodeModules, name, 'package.json');
    if (!existsSync(pj)) { continue; }
    seen.add(name);
    const d = JSON.parse(readFileSync(pj, 'utf8'));
    for (const dep of Object.keys(d.dependencies || {})) {
      if (!seen.has(dep)) { queue.push(dep); }
    }
  }
  return [...seen].map((name) => ({ name, dir: join(nodeModules, name) }));
}

const LICENCE_FILES = /^(LICEN[CS]E|COPYING|NOTICE)(\.(md|txt|MD|TXT))?$/;

function licenceText(dir) {
  if (!existsSync(dir)) { return null; }
  const file = readdirSync(dir).find((f) => LICENCE_FILES.test(f));
  if (!file) { return null; }
  try {
    return readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n').trim();
  } catch {
    return null;
  }
}

/** Licence text with copyright lines removed, used only as a dedup key. */
function bodyKey(text) {
  return text
    .split('\n')
    .filter((l) => !/copyright/i.test(l))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

const bundles = [
  {
    label: 'VS Code extension host (webpacked into dist/extension.js)',
    nm: join(ROOT, 'node_modules'),
    manifest: join(ROOT, 'vscode-acp/package.json'),
  },
  {
    label: 'Chat webview (Vite-built into webview-ui/dist)',
    nm: join(ROOT, 'vscode-acp/webview-ui/node_modules'),
    manifest: join(ROOT, 'vscode-acp/webview-ui/package.json'),
  },
];

const packages = new Map();
const perBundle = [];
for (const b of bundles) {
  if (!existsSync(b.nm)) {
    console.error(`error: ${b.nm} is missing. Run npm ci first -- the generator reads`);
    console.error('licence files from the installed tree, not from the lockfile.');
    process.exit(2);
  }
  const list = closure(b.nm, b.manifest);
  perBundle.push({ label: b.label, count: list.length });
  for (const p of list) {
    const d = JSON.parse(readFileSync(join(p.dir, 'package.json'), 'utf8'));
    let lic = d.license || d.licenses || 'SEE LICENCE FILE';
    if (Array.isArray(lic)) { lic = lic.map((x) => x.type || x).join(' OR '); }
    if (lic && typeof lic === 'object') { lic = lic.type || 'SEE LICENCE FILE'; }
    const key = `${p.name}@${d.version}`;
    if (!packages.has(key)) {
      let repo = d.repository;
      if (repo && typeof repo === 'object') { repo = repo.url; }
      repo = String(repo || '')
        .replace(/^git\+/, '')
        .replace(/\.git$/, '')
        .replace(/^git:\/\//, 'https://');
      if (repo && !repo.startsWith('http')) { repo = `https://github.com/${repo}`; }
      packages.set(key, {
        name: p.name,
        version: d.version,
        licence: String(lic),
        text: licenceText(p.dir),
        repo,
      });
    }
  }
}

const all = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));

const groups = new Map();
for (const p of all) {
  const k = p.text ? `${p.licence}::${bodyKey(p.text)}` : `${p.licence}::no-text`;
  if (!groups.has(k)) { groups.set(k, { licence: p.licence, text: p.text, members: [] }); }
  groups.get(k).members.push(p);
}
const ordered = [...groups.values()].sort((a, b) => b.members.length - a.members.length);

const byLic = {};
for (const p of all) { byLic[p.licence] = (byLic[p.licence] || 0) + 1; }

// Part II (the IntelliJ/JetBrains plugin section) is maintained by hand, not by this
// script -- it documents Gradle/Kotlin/JetBrains-Platform dependencies this script has
// no visibility into. Read it from whatever is on disk today so it can be preserved
// verbatim below rather than regenerated or discarded, and so this script can never
// silently delete hand-written legal content.
//
// Line endings are normalised to LF for reading/matching/comparison regardless of what
// is on disk, and the file is written back out in LF, so a CRLF checkout (e.g. Windows
// with core.autocrlf) can never hide Part II from the marker search or make --check
// flag a line-ending difference as a content difference.
const PART_II_MARKER = '='.repeat(79) + '\nPART II';
const existingFull = (existsSync(OUT) ? readFileSync(OUT, 'utf8') : '').replace(/\r\n/g, '\n');
const partIIStart = existingFull.indexOf(PART_II_MARKER);
const partII = partIIStart === -1 ? '' : existingFull.slice(partIIStart);
const intellijCount = partII
  ? (partII.match(/^ {2}\|(?!-)(?!\s*Dependency\s*\|).+\|$/gm) || []).length
  : 0;

const L = [];
L.push('THIRD-PARTY NOTICES');
L.push('===================');
L.push('');
L.push('AiNxt Code redistributes the third-party software listed below inside the');
L.push('published extension package (.vsix) and the IntelliJ/PyCharm plugin (.zip).');
L.push('This file records their licences and copyright notices, which those licences');
L.push('require to travel with the code.');
L.push('');
L.push('It is generated by scripts/generate-third-party-notices.mjs from the runtime');
L.push('dependency closure of the two bundles that actually ship, so it stays in step');
L.push('with what is redistributed rather than with what is installed in order to build');
L.push('it. Build and test tooling is not redistributed and is deliberately absent here;');
L.push('the full installed inventory (including build/test tooling) can be regenerated as');
L.push('compliance/sbom.cdx.json and compliance/sbom.spdx.json by running this project\'s');
L.push('internal OSS-compliance tooling (`python3 -m ossaudit release --repo .`) against a');
L.push('built tree. That tool and its output are not part of this repository — compliance/');
L.push('is deliberately gitignored (see .gitignore) because it is a local review artefact,');
L.push('not a distributed file — so a plain clone will not contain those two files.');
L.push('');
L.push('The IntelliJ section (Part II below) is maintained by hand and covers the Kotlin,');
L.push('Gradle, and JetBrains Platform dependencies that ship inside the plugin ZIP.');
L.push('');
L.push('This file supplements, and does not replace, NOTICE.');
L.push('');
for (const b of perBundle) { L.push(`  ${b.label}: ${b.count} packages`); }
if (partII) { L.push(`  IntelliJ plugin (Kotlin + JetBrains Platform): ${intellijCount} components`); }
L.push(`  distinct packages redistributed: ${all.length}`);
L.push(`  licences: ${Object.entries(byLic).sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} (${n})`).join(', ')}`);
L.push('');
L.push('-'.repeat(79));
L.push('INVENTORY');
L.push('-'.repeat(79));
L.push('');
for (const p of all) { L.push(`  ${p.name}@${p.version}  --  ${p.licence}`); }
L.push('');
for (const g of ordered) {
  L.push('');
  L.push('='.repeat(79));
  L.push(`${g.licence} -- applies to ${g.members.length} package${g.members.length === 1 ? '' : 's'}`);
  L.push('='.repeat(79));
  L.push('');
  if (g.text) {
    for (const m of g.members) { L.push(`  ${m.name}@${m.version}`); }
    L.push('');
    L.push(g.text);
  } else {
    L.push('These packages declare their licence in package.json but publish no licence');
    L.push('file in the npm tarball, so no copyright line or notice text is available from');
    L.push('the distributed package itself. None is invented here. The upstream repository');
    L.push('is given so a recipient can obtain the notice at source.');
    L.push('');
    for (const m of g.members) {
      L.push(`  ${m.name}@${m.version}`);
      L.push(`      ${m.repo || 'repository not stated in package.json'}`);
    }
  }
  L.push('');
}
const generated = L.join('\n').replace(/\n{4,}/g, '\n\n\n') + '\n';
const output = partII ? `${generated}\n${partII}` : generated;

if (process.argv.includes('--check')) {
  if (existingFull !== output) {
    console.error('THIRD-PARTY-NOTICES is out of date. Regenerate with:');
    console.error('  node scripts/generate-third-party-notices.mjs');
    process.exit(1);
  }
  console.log(`THIRD-PARTY-NOTICES is up to date (${all.length} redistributed packages).`);
  process.exit(0);
}

writeFileSync(OUT, output);
console.log(`Wrote THIRD-PARTY-NOTICES: ${all.length} redistributed packages, ${ordered.length} distinct licence texts.`);
if (!partII) {
  console.warn('warning: no "PART II" section found on disk -- the hand-maintained IntelliJ');
  console.warn('section was not preserved because it was not present to preserve. If this is');
  console.warn('unexpected, restore it from version control before committing this output.');
}
