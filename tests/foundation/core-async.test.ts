import { expect, it } from 'vitest';
import { abortable } from '../../packages/core/src/async.js';

it('resolves when work resolves', async () => {
  const controller = new AbortController();
  await expect(abortable(Promise.resolve(42), controller.signal)).resolves.toBe(42);
});

it('rejects with the abort reason when the signal aborts', async () => {
  const controller = new AbortController();
  let resolve!: (value: string) => void;
  const pending = new Promise<string>(done => {
    resolve = done;
  });
  const work = abortable(pending, controller.signal);
  controller.abort(new Error('stop'));
  await expect(work).rejects.toThrow('stop');
  resolve('late');
});

it('rejects immediately when the signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort(new Error('already stopped'));
  await expect(abortable(Promise.resolve(1), controller.signal)).rejects.toThrow('already stopped');
});

it('ignores an abort after the work already resolved', async () => {
  const controller = new AbortController();
  await expect(abortable(Promise.resolve('ok'), controller.signal)).resolves.toBe('ok');
  controller.abort(new Error('late'));
  expect(controller.signal.aborted).toBe(true);
});

it('removes its abort listener after work resolves', async () => {
  const listeners = new Set<() => void>();
  const signal = {
    aborted: false,
    throwIfAborted() {},
    addEventListener(_event: string, listener: () => void) {
      listeners.add(listener);
    },
    removeEventListener(_event: string, listener: () => void) {
      listeners.delete(listener);
    },
  } as unknown as AbortSignal;

  await expect(abortable(Promise.resolve('ok'), signal)).resolves.toBe('ok');
  expect(listeners.size).toBe(0);
});
