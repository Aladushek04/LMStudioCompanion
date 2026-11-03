# Vibecoding Stage 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить единый прогон проверок, линтер/форматтер, карту зависимостей, CI и версионную гигиену, не меняя поведение Companion.

**Architecture:** Инженерные страховки вокруг существующего кода: `scripts/verify.mjs` последовательно запускает типы, тесты, границы, стиль и сборку; `scripts/check-boundaries.mjs` проверяет матрицу импортов; Biome форматирует код Companion, кроме `conversation-engine`; GitHub Actions повторяет всё на Windows с Node 24.

**Tech Stack:** Node 24.22.2, TypeScript 5.9.3, Vitest 3.2.7, Biome 2.x, GitHub Actions, Python 3.12, Playwright/Edge.

**Spec:** `docs/superpowers/specs/2026-11-03-vibecoding-stage-0-design.md`

## Global Constraints

- Node 24.22.2 — основной runtime; Node 25 разрешён; Node 26 и ниже 24 блокируются.
- CI использует Node 24.22.2.
- Не менять схему памяти, чаты, настройки LM Studio, `data/`, `backups/`.
- Не менять `packages/conversation-engine` форматированием; только импорты, необходимые для границ.
- Сохранять лицензию/авторство `conversation-engine`.
- Новых runtime-зависимостей нет; добавляется только dev-зависимость Biome.
- Пользовательские тексты — на русском.
- Каждый коммит — отдельный логический шаг; форматирование не смешивать с логикой.
- CORE-3 и D4/D5 не начинать.

## Review Focus

- **Node 26:** `npm ci` и `npm run verify` должны падать с понятным сообщением, а не запускать тесты Core в неподдержанном runtime. Тест: `tests/tooling/node-version.test.mjs`.
- **Новый обратный импорт:** `host -> lmstudio-plugin` или `conversation-engine -> lmstudio-plugin` должен валить `check:boundaries`. Тест: `tests/tooling/boundaries.test.mjs`.
- **Форматирование без логики:** после форматирования все существующие 254 общих теста и 424 Core-теста проходят; diff форматирования отделён. Проверка: `npm run verify` после коммита форматирования.
- **CI без живой модели:** workflow не должен требовать LM Studio, токены или сеть, кроме npm/pip. Проверка: зелёный Windows-run.
- **Релизный ZIP:** футер показывает `0.1.5`, ссылки ведут на `main`, а не на удалённую ветку. Проверка: `npm run build` + `npm run test:panel` + `grep` по бандлу.

---

### Task 1: Node pin, unified verification, timeout fix

**Files:**
- Create: `.nvmrc`
- Create: `.npmrc`
- Create: `scripts/lib/node-version.mjs`
- Create: `scripts/check-node.mjs`
- Create: `scripts/verify.mjs`
- Create: `tests/tooling/node-version.test.mjs`
- Modify: `package.json`
- Modify: `vitest.config.ts`

**Interfaces:**
- Produces: `isSupportedNode(version: string): boolean`, `supportedNodeMessage(version: string): string` from `scripts/lib/node-version.mjs`.
- Produces: `npm run verify`, `npm run verify:full`, `npm run test:core`, `npm run check:node`.
- Produces: `scripts/verify.mjs --full` runs Python and panel E2E after the fast steps.

- [ ] **Step 1: Write the failing Node-version test**

```js
// tests/tooling/node-version.test.mjs
import { expect, it } from 'vitest';
import { isSupportedNode, supportedNodeMessage } from '../../scripts/lib/node-version.mjs';

it('accepts the two verified majors', () => {
  expect(isSupportedNode('v24.22.2')).toBe(true);
  expect(isSupportedNode('v25.5.0')).toBe(true);
});

it('rejects Node 22 and 26', () => {
  expect(isSupportedNode('v22.21.1')).toBe(false);
  expect(isSupportedNode('v26.13.0')).toBe(false);
});

it('explains the supported runtime', () => {
  expect(supportedNodeMessage('v26.13.0')).toContain('24.22.2');
  expect(supportedNodeMessage('v26.13.0')).toContain('.nvmrc');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run tests/tooling/node-version.test.mjs`  
Expected: FAIL because `scripts/lib/node-version.mjs` does not exist.

- [ ] **Step 3: Implement the Node-version helper**

`scripts/lib/node-version.mjs`:

```js
export const SUPPORTED_MAJORS = [24, 25];
export function isSupportedNode(version) {
  const major = Number(/^v?(\d+)\./.exec(version)?.[1]);
  return SUPPORTED_MAJORS.includes(major);
}
export function supportedNodeMessage(version) {
  return `Node ${version} не поддерживается. Нужен Node 24.22.2 (см. .nvmrc; Node 25 тоже проверен).`;
}
```

`scripts/check-node.mjs` prints `supportedNodeMessage(process.version)` and exits `1` when unsupported; otherwise prints `Node ${process.version} — OK`.

- [ ] **Step 4: Add the pin and scripts**

`.nvmrc`:

```text
24.22.2
```

`.npmrc`:

```text
engine-strict=true
```

`package.json`:

```json
"engines": { "node": ">=24 <26" },
"scripts": {
  "verify": "node scripts/verify.mjs",
  "verify:full": "node scripts/verify.mjs --full",
  "test:core": "node node_modules/vitest/vitest.mjs run --config packages/conversation-engine/vitest.config.mts --maxWorkers=1 --no-file-parallelism",
  "check:node": "node scripts/check-node.mjs"
}
```

- [ ] **Step 5: Implement `scripts/verify.mjs`**

The script runs these steps in order with `spawnSync`, `stdio: 'inherit'`, `cwd` = repo root, and stops on the first non-zero exit:

1. `scripts/check-node.mjs`
2. `node node_modules/typescript/bin/tsc --noEmit`
3. `node node_modules/typescript/bin/tsc -p packages/conversation-engine/tsconfig.json`
4. `node node_modules/vitest/vitest.mjs run`
5. `node node_modules/vitest/vitest.mjs run --config packages/conversation-engine/vitest.config.mts --maxWorkers=1 --no-file-parallelism`
6. `node scripts/check-boundaries.mjs` (added in Task 3; until then, this step is omitted)
7. `npm run check` (added in Task 2; until then, this step is omitted)
8. `node scripts/build.mjs`

With `--full`, after step 8 run:

9. `node scripts/check-panel.mjs`

Task 4 inserts the Python verifier before the panel step.

Each step prints `[n/total] <label> — OK`. The script prints `VERIFY PASSED` or `VERIFY:FULL PASSED` at the end.

- [ ] **Step 6: Fix the install-test timeout**

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'tests/foundation/**/*.test.ts',
      'tests/web/**/*.test.ts',
      'tests/memory/**/*.test.ts',
      'tests/documents/**/*.test.{ts,mjs}',
      'tests/smoke/**/*.test.ts',
      'tests/tooling/**/*.test.mjs',
    ],
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
```

- [ ] **Step 7: Verify the fast pipeline**

Run:

```powershell
npm run check:node
npm test
npm run typecheck
npm run test:core
```

Expected: Node check passes on Node 24; the existing 254 tests pass (baseline had one 5-second timeout) plus the new tooling tests; Core reports 424/424 on Node 24.

- [ ] **Step 8: Commit**

```powershell
git add .nvmrc .npmrc package.json vitest.config.ts scripts/lib/node-version.mjs scripts/check-node.mjs scripts/verify.mjs tests/tooling/node-version.test.mjs
git commit -m "chore(verify): pin Node 24 and add unified verification"
```

---

### Task 2: Biome and formatting of Companion code

**Files:**
- Create: `biome.json`
- Modify: `package.json`
- Modify: `scripts/verify.mjs`
- Format: `packages/core`, `packages/memory`, `packages/documents`, `packages/host`, `packages/control-panel`, `packages/lmstudio-plugin`, `tests`, `scripts`
- Exclude: `packages/conversation-engine/**`, `packages/lmstudio-plugin/.lmstudio/**`

**Interfaces:**
- Produces: `npm run lint`, `npm run format`, `npm run format:check`, `npm run check`.
- Biome config is the single source of style for JS/TS/MJS.

- [ ] **Step 1: Install Biome**

Run:

```powershell
npm view @biomejs/biome version
npm install --save-dev --save-exact @biomejs/biome@<version-from-previous-command>
```

- [ ] **Step 2: Create `biome.json`**

Use `npx biome init` for a schema-valid starting point, then apply:

- `files.includes`: `packages/**`, `tests/**`, `scripts/**`.
- `files.ignore`: `packages/conversation-engine/**`, `packages/lmstudio-plugin/.lmstudio/**`, `dist/**`, `.tools/**`, `data/**`, `backups/**`, `releases/**`, `reference/**`, `node_modules/**`.
- Formatter: 2 spaces, line width 100, single quotes, semicolons, trailing commas.
- Linter: recommended `false`; enable `correctness/noUnusedImports`, `suspicious/noDoubleEquals`, `suspicious/noDebugger`.
- Assist: organize imports on save/check.

- [ ] **Step 3: Add scripts**

```json
"lint": "biome lint .",
"format": "biome format --write .",
"format:check": "biome format .",
"check": "biome check ."
```

Insert `npm run check` as step 7 in `scripts/verify.mjs` (between boundaries and build).

- [ ] **Step 4: Format only the Companion-owned code**

Run:

```powershell
npx biome format --write packages/core packages/memory packages/documents packages/host packages/control-panel packages/lmstudio-plugin tests scripts
npm run lint
```

Expected: formatting succeeds; `lint` reports no errors. If `lint` reports a small number of correctness issues, fix them without changing behavior and include them in this commit.

- [ ] **Step 5: Prove no behavior change**

Run:

```powershell
npm run typecheck
npm test
npm run test:core
npm run build
```

Expected: same test results as Task 1; build succeeds.

- [ ] **Step 6: Commit**

```powershell
git add biome.json package.json package-lock.json packages tests scripts
git commit -m "style(format): apply Biome to Companion-owned code"
```

---

### Task 3: Neutral boundaries, CODEMAP, import checker

**Files:**
- Create: `packages/core/src/async.ts`
- Create: `packages/core/src/integration.ts`
- Create: `packages/memory/src/channel-client.ts`
- Create: `scripts/lib/boundaries.mjs`
- Create: `scripts/check-boundaries.mjs`
- Create: `tests/tooling/boundaries.test.mjs`
- Create: `tests/foundation/core-async.test.ts`
- Create: `docs/CODEMAP.md`
- Modify: `packages/lmstudio-plugin/src/integration.ts`
- Modify: `packages/lmstudio-plugin/src/memory/client.ts`
- Modify: `packages/host/src/server.ts`
- Modify: `packages/host/src/diagnose.ts`
- Modify: `packages/conversation-engine/src/companion/memory-turn.ts`
- Modify: `packages/conversation-engine/src/companion/memory-tools.ts`
- Modify: `package.json`
- Modify: `scripts/verify.mjs`

**Interfaces:**
- Produces: `abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T>` from `packages/core/src/async.ts`.
- Produces: `selectIntegration(report: CapabilityReport, currentHandler: string | null): OperationResult<IntegrationMode>` from `packages/core/src/integration.ts`.
- Produces: `memoryRequest(file: string, input: z.infer<typeof requestSchema>, signal: AbortSignal): Promise<unknown>` and `recallReply` from `packages/memory/src/channel-client.ts`.
- Produces: `findViolations(files: Array<{ path: string; source: string }>): Array<{ from: string; to: string; specifier: string; line: number }>` from `scripts/lib/boundaries.mjs`.
- Produces: `npm run check:boundaries`.

- [ ] **Step 1: Write the failing boundary tests**

`tests/tooling/boundaries.test.mjs` covers:

```js
const allow = (from, specifier, source = `import '${specifier}';`) =>
  findViolations([{ path: from, source }]);
```

Assertions:

- `packages/host/src/a.ts` + `../../memory/src/store.js` → no violations.
- `packages/host/src/a.ts` + `../../lmstudio-plugin/src/integration.js` → violation `host -> lmstudio-plugin`.
- `packages/conversation-engine/src/a.ts` + `../../../lmstudio-plugin/src/memory/client.js` → violation `conversation-engine -> lmstudio-plugin`.
- `packages/control-panel/src/a.tsx` + `import type { MemoryRecord } from '../../memory/src/types.js';` → no violation.
- `packages/control-panel/src/a.tsx` + `import { openMemoryStore } from '../../memory/src/store.js';` → violation `control-panel -> memory` (runtime import).
- `packages/core/src/a.ts` + `../../memory/src/store.js` → violation `core -> memory`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run tests/tooling/boundaries.test.mjs`  
Expected: FAIL because `scripts/lib/boundaries.mjs` does not exist.

- [ ] **Step 3: Implement the boundary library**

Use the TypeScript compiler API (`typescript`) to parse imports, not regex:

```js
import ts from 'typescript';
export function parseImports(source, fileName) { /* ImportDeclaration, ExportDeclaration, import() */ }
export function findViolations(files) { /* resolve relative specifiers to packages/<name>; apply RULES */ }
```

Rules matrix:

| From | May import |
|---|---|
| `core` | only external packages |
| `memory` | `core` |
| `documents` | `core` |
| `host` | `core`, `memory`, `documents` |
| `control-panel` | `core`; `memory`/`documents` only with `import type` |
| `lmstudio-plugin` | `core`, `memory` |
| `conversation-engine` | `core`, `memory` |
| `advisor`, `web-tools` | not scanned (not TS packages) |

`check-boundaries.mjs` scans `packages/**/*.ts` and `packages/**/*.tsx`, excludes `**/*.test.ts`, `**/tests/**`, `**/*.d.ts`, and `packages/conversation-engine/tests/**`. It prints each violation as `path:line specifier (from -> to)` and exits `1` if any.

- [ ] **Step 4: Run the boundary tests**

Run: `node node_modules/vitest/vitest.mjs run tests/tooling/boundaries.test.mjs`  
Expected: PASS.

- [ ] **Step 5: Move the neutral functions**

`packages/core/src/async.ts`:

```ts
export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let stop!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    stop = () => reject(signal.reason ?? new Error('Отменено'));
    signal.addEventListener('abort', stop, { once: true });
  });
  try { return await Promise.race([work, cancelled]); }
  finally { signal.removeEventListener('abort', stop); }
}
```

`packages/core/src/integration.ts`: move `selectIntegration` verbatim from `packages/lmstudio-plugin/src/integration.ts`, changing the import to `./contracts.js`.

`packages/memory/src/channel-client.ts`: move `memoryRequest` and `recallReply` verbatim from `packages/lmstudio-plugin/src/memory/client.ts`; change protocol imports to `./channel-protocol.js` and `abortable` to `../../core/src/async.js`.

`packages/lmstudio-plugin/src/integration.ts` becomes:

```ts
export { selectIntegration } from '../../core/src/integration.js';
```

`packages/lmstudio-plugin/src/memory/client.ts` becomes:

```ts
export { memoryRequest, recallReply } from '../../../memory/src/channel-client.js';
```

Update production imports:

- `packages/host/src/server.ts` and `diagnose.ts` import `selectIntegration` from `../../core/src/integration.js`.
- `packages/conversation-engine/src/companion/memory-turn.ts` and `memory-tools.ts` import `memoryRequest` from `../../../memory/src/channel-client.js`.
- Tests may keep using the plugin re-exports.

- [ ] **Step 6: Add the abortable test**

`tests/foundation/core-async.test.ts`:

```ts
import { expect, it } from 'vitest';
import { abortable } from '../../packages/core/src/async';

it('resolves when work resolves', async () => { /* ... */ });
it('rejects when the signal aborts', async () => { /* ... */ });
it('does not reject after the work already resolved', async () => { /* ... */ });
```

- [ ] **Step 7: Add CODEMAP**

`docs/CODEMAP.md` must contain:

- entry points: panel `main.tsx`; host `main.ts`, `diagnose.ts`, `install-cli.ts`; plugin `index.ts`; Core `index.ts`; Python `server.py`, `companion_bridge.py`; scripts;
- data flow diagram (panel → host → memory/documents; chat → plugin/Core);
- ownership table (who writes memory, who owns generation);
- allowed import matrix from Step 3;
- module format rules: root ESM; `lmstudio-plugin` CJS because its nearest `package.json` lacks `"type": "module"`; Core CommonJS; do not add `"type": "module"` to plugin/Core without updating the build;
- live-data rules: never edit `data/`, `backups/`, live `memory.db`, user chats; use fixtures;
- “where to add a feature” recipes for host route, panel screen, memory operation, Core tool;
- verification commands.

- [ ] **Step 8: Wire boundaries into verify**

Add `check:boundaries` to `package.json` and insert `node scripts/check-boundaries.mjs` as step 6 in `scripts/verify.mjs`.

- [ ] **Step 9: Verify**

Run:

```powershell
npm run check:boundaries
npm run typecheck
npm test
npm run test:core
npm run build
```

Expected: boundaries pass; all tests pass; build succeeds. If a legitimate import is flagged, fix the import or extend the matrix in the same commit, not by suppressing the violation.

- [ ] **Step 10: Commit**

```powershell
git add packages/core/src/async.ts packages/core/src/integration.ts packages/memory/src/channel-client.ts packages/lmstudio-plugin/src/integration.ts packages/lmstudio-plugin/src/memory/client.ts packages/host/src/server.ts packages/host/src/diagnose.ts packages/conversation-engine/src/companion/memory-turn.ts packages/conversation-engine/src/companion/memory-tools.ts scripts/lib/boundaries.mjs scripts/check-boundaries.mjs scripts/verify.mjs tests/tooling/boundaries.test.mjs tests/foundation/core-async.test.ts docs/CODEMAP.md package.json
git commit -m "refactor(boundaries): move neutral integration and memory client"
```

---

### Task 4: Windows CI

**Files:**
- Create: `.github/workflows/verify.yml`
- Create: `scripts/verify-python.mjs`
- Modify: `scripts/verify.mjs`

**Interfaces:**
- Produces: GitHub Actions workflow `Verify`.
- Produces: `node scripts/verify-python.mjs` runs `pytest` and `ruff` with the first working interpreter from `COMPANION_PYTHON`, `.tools/web-venv/Scripts/python.exe`, `python`.

- [ ] **Step 1: Create the Python verifier**

`scripts/verify-python.mjs`:

- Resolve the interpreter from the three candidates; run `--version` to validate.
- If none works, print a clear message and exit `1`.
- Run `-m pytest packages/web-tools/tests -q`.
- Run `-m ruff check --config packages/web-tools/pyproject.toml packages/web-tools`.
- Print `Python checks — OK`.

- [ ] **Step 2: Wire Python into `verify:full`**

In `scripts/verify.mjs`, insert `node scripts/verify-python.mjs` before `node scripts/check-panel.mjs` when `--full` is set.

- [ ] **Step 3: Create the workflow**

`.github/workflows/verify.yml`:

```yaml
name: Verify
on:
  push:
  pull_request:
permissions:
  contents: read
concurrency:
  group: verify-${{ github.ref }}
  cancel-in-progress: true
jobs:
  verify:
    runs-on: windows-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npm run verify
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
          cache: pip
      - run: pip install -r packages/web-tools/requirements-dev.txt
      - run: python -m pytest packages/web-tools/tests -q
      - run: python -m ruff check --config packages/web-tools/pyproject.toml packages/web-tools
      - run: npm run test:panel
```

`test:panel` uses Edge at the standard `windows-latest` path; if Edge is absent, fail with the existing clear message.

- [ ] **Step 4: Validate locally what can be validated**

Run:

```powershell
npm run verify:full
```

Expected: fast steps, Python checks, and panel E2E all pass locally (Edge installed).

- [ ] **Step 5: Commit and push**

```powershell
git add .github/workflows/verify.yml scripts/verify-python.mjs scripts/verify.mjs
git commit -m "ci: verify on Windows with Node 24"
git push -u origin vibecoding-stage-0
```

After the push, open the Actions run and confirm all steps are green. Record the URL for the final report.

---

### Task 5: Version and release hygiene

**Files:**
- Create: `packages/control-panel/src/version.ts`
- Modify: `scripts/build.mjs`
- Modify: `packages/control-panel/src/App.tsx`
- Modify: `scripts/package.mjs`
- Modify: `README.md`
- Modify: `docs/STATUS.md`

**Interfaces:**
- Produces: `appVersion: string` from `packages/control-panel/src/version.ts`.
- Produces: Vite define `__APP_VERSION__` from root `package.json`.
- Produces: packaged USER-GUIDE links to `main`.

- [ ] **Step 1: Inject the version**

`packages/control-panel/src/version.ts`:

```ts
declare const __APP_VERSION__: string;
export const appVersion = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
```

In `scripts/build.mjs`, read `package.json` and pass:

```js
define: { __APP_VERSION__: JSON.stringify(pkg.version) }
```

to the Vite `build` call.

- [ ] **Step 2: Show the version**

In `App.tsx`, replace the footer `Companion · 0.1` with `Companion · {appVersion}` and import `appVersion` from `./version.js`.

- [ ] **Step 3: Fix the release links**

In `scripts/package.mjs`, replace `feat/foundation-panel` with `main` in the USER-GUIDE link rewrite. Add a comment: switch to the release tag if the tag exists at packaging time.

- [ ] **Step 4: Update docs**

`README.md`: add a “Проверка” section with Node 24.22.2, `npm run verify`, `npm run verify:full`, `npm run test:core`.

`docs/STATUS.md`: add a short line that Stage 0 adds engineering checks and does not change product behavior.

- [ ] **Step 5: Verify**

Run:

```powershell
npm run build
npm run test:panel
Select-String -Path dist/panel/assets/*.js -Pattern '0\.1\.5'
```

Expected: build succeeds; panel E2E passes; the bundle contains `0.1.5`. Manually open the panel and confirm `Companion · 0.1.5`.

- [ ] **Step 6: Commit**

```powershell
git add packages/control-panel/src/version.ts packages/control-panel/src/App.tsx scripts/build.mjs scripts/package.mjs README.md docs/STATUS.md
git commit -m "chore(release): align versions and fix packaged doc links"
```

---

### Task 6: Final verification, dependency audit, report

**Files:**
- Create: `docs/research/vibecoding-stage-0-check.md`
- Modify: `docs/STATUS.md` if the report adds a new verification result.

**Interfaces:**
- Produces: a reproducible report with commands, counts, CI URL, limitations, and dependency audit findings.

- [ ] **Step 1: Run the full local matrix**

```powershell
npm run verify
npm run verify:full
npm run test:core
npm run lint
npm run format:check
npm run check:boundaries
npm run build
```

Record exact results. Expected: `VERIFY PASSED`, `VERIFY:FULL PASSED`, 424/424 Core, no lint/format/boundary errors.

- [ ] **Step 2: Audit dependencies**

```powershell
npm audit --json
npm audit --omit=dev --json
```

Record the five advisories found at the start of Stage 0:

- `vitest`/`tinypool` — critical, dev-only; fix requires Vitest 5.x.
- `@vitest/mocker` — moderate, dev-only; fix requires Vitest 5.x.
- `zod` — high, production; fix requires Zod 4.x.
- `@lmstudio/sdk` — high via Zod; fix requires a compatible SDK/Zod combination.

Do not upgrade in Stage 0. Add a “Deferred” section with the recommended separate task: compatibility check for Zod 4 and Vitest 5, then upgrade with full tests.

- [ ] **Step 3: Verify the worktree is clean of data changes**

```powershell
git status --short
git diff --stat main...HEAD
```

Expected: only intended source/docs changes; no `data/`, `backups/`, `releases/`, or personal files.

- [ ] **Step 4: Write the report**

`docs/research/vibecoding-stage-0-check.md` must include:

- date, branch, Node version;
- baseline: 253/254, one install-test timeout;
- final: all tests, exact counts;
- Core 424/424 on Node 24; Node 26 blocked by design;
- formatting scope and why Core was excluded;
- boundary moves and checker result;
- CI URL and workflow result;
- dependency audit table and deferred work;
- limitations: `verify:full` needs Edge and Python; CI covers both;
- user verification commands.

- [ ] **Step 5: Commit**

```powershell
git add docs/research/vibecoding-stage-0-check.md docs/STATUS.md
git commit -m "docs: record Stage 0 verification"
```

- [ ] **Step 6: Final handoff**

Report to the user:

- worktree path;
- branch name;
- commit list;
- exact commands to verify;
- CI URL;
- known limitations and deferred security work;
- confirmation that memory, chats, LM Studio settings, and `data/` were not touched.
