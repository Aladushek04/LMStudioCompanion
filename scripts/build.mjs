import { spawnSync } from 'node:child_process';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const result = spawnSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' });
if (result.error || result.status !== 0) process.exit(result.status ?? 1);
await build({ root: resolve(root, 'packages/control-panel'), build: { outDir: resolve(root, 'dist/panel'), emptyOutDir: true }, base: '/' });
