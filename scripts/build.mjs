import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const result = spawnSync(
  process.execPath,
  [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'],
  { cwd: root, stdio: 'inherit' },
);
if (result.error || result.status !== 0) process.exit(result.status ?? 1);
await writeFile(
  resolve(root, 'dist/lmstudio-plugin/package.json'),
  JSON.stringify({ type: 'commonjs' }),
);
await build({
  root: resolve(root, 'packages/control-panel'),
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: { outDir: resolve(root, 'dist/panel'), emptyOutDir: true },
  base: '/',
});
