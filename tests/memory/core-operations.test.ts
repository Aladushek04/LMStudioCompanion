import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openMemoryStore } from '../../packages/memory/src/store.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup.length = 0;
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'companion-core2-store-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  let fail = false,
    hold: (() => Promise<void>) | undefined;
  const store = await openMemoryStore(directory, {
    beforeCommit: async () => {
      await hold?.();
      if (fail) throw Error('synthetic disk failure');
    },
  });
  cleanup.push(() => store.close());
  return {
    directory,
    store,
    setFail: () => {
      fail = true;
    },
    setHold: (fn: () => Promise<void>) => {
      hold = fn;
    },
  };
}
const request = (content = 'Проверочная заметка МАЯК-731') => ({
  action: 'save' as const,
  operationId: randomUUID(),
  expectedStoreRevision: 0,
  content,
  targetId: null,
  targetRevision: null,
});
// Removing atomic operation persistence must fail this test even if the record survives.
it('saves a record and durable receipt atomically; repeat and restart create no extra record', async () => {
  const f = await fixture(),
    input = request(),
    store = f.store as any;
  const first = await store.saveExplicit(input);
  expect(first.state).toBe('saved');
  expect(first.record.content).toBe(input.content);
  expect(first.record.revision).toBe(1);
  expect((await f.store.listMemories()).map(r => r.id)).toEqual([first.record.id]);
  expect(await store.saveExplicit(input)).toEqual(first);
  await f.store.close();
  const next = await openMemoryStore(f.directory);
  cleanup.push(() => next.close());
  expect(await (next as any).getOperation(input.operationId)).toEqual(first);
  expect(await (next as any).saveExplicit(input)).toEqual(first);
  expect(await next.listMemories()).toHaveLength(1);
});
it('reusing operation ID with different content fails and does not overwrite', async () => {
  const f = await fixture(),
    input = request(),
    store = f.store as any;
  await store.saveExplicit(input);
  expect((await store.saveExplicit({ ...input, content: 'Другая запись' })).state).toBe('conflict');
  expect((await f.store.listMemories())[0]?.content).toBe(input.content);
});
it('stale store revision prevents a late save after a manual change', async () => {
  const f = await fixture();
  await f.store.saveMemory({
    identityKey: 'manual.test',
    content: 'Ручная запись',
    scope: 'global',
    projectId: null,
    sessionId: null,
    source: 'user',
  });
  expect((await (f.store as any).saveExplicit(request())).state).toBe('conflict');
  expect(await f.store.listMemories()).toHaveLength(1);
});
it('disk failure leaves neither a record nor a successful receipt', async () => {
  const f = await fixture(),
    before = await readFile(join(f.directory, 'memory.json'), 'utf8'),
    input = request();
  f.setFail();
  expect((await (f.store as any).saveExplicit(input)).state).toBe('failed');
  expect((await (f.store as any).getOperation(input.operationId)).state).toBe('unknown');
  expect(await f.store.listMemories()).toEqual([]);
  expect(await readFile(join(f.directory, 'memory.json'), 'utf8')).toBe(before);
});
it('cancellation at the commit boundary leaves the previous snapshot', async () => {
  const f = await fixture(),
    abort = new AbortController(),
    input = request();
  f.setHold(async () => {
    abort.abort();
  });
  expect((await (f.store as any).saveExplicit(input, abort.signal)).state).toBe('cancelled');
  expect(await f.store.listMemories()).toEqual([]);
});
it('receipt lookup and redelivery never resurrect or report an edited/deleted revision as current', async () => {
  const f = await fixture(),
    input = request(),
    store = f.store as any,
    first = await store.saveExplicit(input);
  await f.store.updateMemory(first.record.id, { content: 'Ручное исправление' }, 1);
  expect((await store.getOperation(input.operationId)).state).toBe('conflict');
  expect((await store.saveExplicit(input)).state).toBe('conflict');
  await f.store.deleteMemory(first.record.id, 2);
  expect((await store.saveExplicit(input)).state).toBe('conflict');
  expect(await f.store.listMemories()).toEqual([]);
});
it('concurrent redelivery is serialized and content duplicates have one active record', async () => {
  const f = await fixture(),
    input = request(),
    store = f.store as any;
  const results = await Promise.all([store.saveExplicit(input), store.saveExplicit(input)]);
  expect(results[0]).toEqual(results[1]);
  const duplicate = await store.saveExplicit({ ...request(), expectedStoreRevision: 1 });
  expect(duplicate.state).toBe('duplicate');
  expect(await f.store.listMemories()).toHaveLength(1);
});
it('first journal upgrade creates an owner-written pre-CORE2 backup exactly once', async () => {
  const f = await fixture(),
    before = await readFile(join(f.directory, 'memory.json'), 'utf8'),
    input = request();
  await f.store.saveExplicit(input);
  const backups = (await readdir(f.directory)).filter(name => name.startsWith('before-core2-'));
  expect(backups).toHaveLength(1);
  expect(await readFile(join(f.directory, backups[0]!), 'utf8')).toBe(before);
  await f.store.saveExplicit({ ...request('Другая учебная заметка'), expectedStoreRevision: 1 });
  expect(
    (await readdir(f.directory)).filter(name => name.startsWith('before-core2-')),
  ).toHaveLength(1);
});
