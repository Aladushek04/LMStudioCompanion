import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const advisor = JSON.parse(await readFile(join(root, 'reference/advisor-manifest.json'), 'utf8'));
for (const [name, sha256] of Object.entries(advisor.files)) assert.equal(digest(await readFile(join(root, 'packages/advisor', name))), sha256, `advisor: ${name}`);
const web = JSON.parse(await readFile(join(root, 'reference/baseline-manifest.json'), 'utf8'));
for (const item of web.files) assert.equal(digest(await readFile(join(root, 'packages/web-tools', item.path))), item.sha256, `web: ${item.path}`);
const names = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/))].sort();
const selected = names.filter(name => /^(docs\/|scripts\/|tests\/foundation\/|packages\/(core|host|lmstudio-plugin|control-panel)\/)/.test(name) || /^(README\.md|AGENTS\.md|package.*\.json|tsconfig.*\.json|vitest\.config\.ts|.*\.cmd|\.gitignore|\.gitattributes|LICENSE)$/.test(name));
const files = {}; let documents = 0; let links = 0;
for (const name of selected) {
  const bytes = await readFile(join(root, name)); files[name] = digest(bytes);
  if (!(name.startsWith('docs/') || name === 'README.md') || !name.endsWith('.md')) continue;
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); documents++;
  for (const match of source.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].replace(/^<|>$/g, '').split('#')[0]; if (!target || /^[a-z]+:/i.test(target)) continue;
    await access(resolve(dirname(join(root, name)), decodeURIComponent(target))); links++;
  }
}
const manifestPath = join(root, 'reference/stage00-manifest.json');
if (process.argv.includes('--capture')) await writeFile(manifestPath, JSON.stringify({ capturedAt: new Date().toISOString(), files }, null, 2) + '\n');
else {
  const recorded = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.deepEqual(files, recorded.files, 'Stage00 snapshot changed; capture only after verification');
}
console.log(JSON.stringify({ advisor: Object.keys(advisor.files).length, web: web.files.length, documents, links, stage00Files: selected.length, ok: true }));
