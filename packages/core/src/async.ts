/** Stop awaiting non-cooperative work; late completion cannot resume the caller. */
export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let stop!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    stop = () => reject(signal.reason ?? new Error('Отменено'));
    signal.addEventListener('abort', stop, { once: true });
  });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    signal.removeEventListener('abort', stop);
  }
}
