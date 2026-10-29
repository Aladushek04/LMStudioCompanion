import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { settingsSchema, defaultSettings, type Settings } from '../../core/src/settings.js';

/** Состояние только Companion. Доступ процесса-владельца защищён lock-файлом сервера. */
export class SettingsStore {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly directory: string) {}
  async readSettings(): Promise<Settings> {
    await this.queue;
    try { return settingsSchema.parse(JSON.parse(await readFile(join(this.directory, 'settings.json'), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...defaultSettings }; throw error; }
  }
  async writeSettings(next: Settings, signal?: AbortSignal): Promise<void> {
    const validated = settingsSchema.parse(next);
    const operation = this.queue.then(async () => {
      signal?.throwIfAborted(); await mkdir(this.directory, { recursive: true });
      const target = join(this.directory, 'settings.json'); const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(validated, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600, ...(signal ? { signal } : {}) });
        signal?.throwIfAborted(); await rename(temporary, target);
      } finally { await rm(temporary, { force: true }); }
    });
    this.queue = operation.catch(() => undefined); await operation;
  }
}
