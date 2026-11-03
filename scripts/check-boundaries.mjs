import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findViolations } from './lib/boundaries.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const packages = resolve(root, 'packages');
const files = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'tests')
        continue;
      await walk(full);
      continue;
    }
    if (
      !/\.(ts|tsx)$/.test(entry.name) ||
      /\.d\.ts$/.test(entry.name) ||
      /\.test\.ts$/.test(entry.name)
    ) {
      continue;
    }
    files.push(full);
  }
}

await walk(packages);
const sources = await Promise.all(
  files.map(async file => ({
    path: relative(root, file).replaceAll('\\', '/'),
    source: await readFile(file, 'utf8'),
  })),
);
const violations = findViolations(sources);

if (violations.length === 0) {
  console.log(`Boundary check passed: ${files.length} files.`);
  process.exit(0);
}

for (const violation of violations) {
  console.error(
    `${violation.path}:${violation.line} ${violation.specifier} (${violation.from} -> ${violation.to})`,
  );
}
console.error(`Boundary check failed: ${violations.length} violation(s).`);
process.exit(1);
