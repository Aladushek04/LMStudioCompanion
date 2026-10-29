import { createServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const busy = () => new Error('Панель уже запущена. Используйте открытое окно браузера. Для перезапуска закройте прежнее окно Companion через Ctrl+C.');

/** Windows IPC ownership belongs to this Node process and is released by the OS
 * even on a crash. The metadata file alone never proves a new host is alive.
 * The pipe carries no commands, session tokens or user data.
 */
export async function acquireSettingsOwnership(settingsDir: string): Promise<() => Promise<void>> {
  const directory = await realpath(settingsDir); const lockPath = join(directory, '.host-lock');
  if (process.platform !== 'win32') {
    const lock = await open(lockPath, 'wx', 0o600).catch(() => { throw busy(); });
    try { await lock.writeFile(String(process.pid)); }
    catch (error) { await lock.close(); await rm(lockPath, { force: true }); throw error; }
    let released = false;
    return async () => { if (!released) { released = true; await lock.close(); await rm(lockPath, { force: true }); } };
  }
  const digest = createHash('sha256').update(directory.toLowerCase()).digest('hex');
  const pipeName = `\\\\.\\pipe\\LMStudioCompanion-owner-${digest}`;
  const guard = createServer(socket => socket.destroy());
  const close = () => new Promise<void>((resolve, reject) => guard.close(error => error ? reject(error) : resolve()));
  await new Promise<void>((resolve, reject) => {
    guard.once('error', () => reject(busy())); guard.listen(pipeName, resolve);
  });
  const temporary = `${lockPath}.${randomUUID()}.tmp`;
  try {
    let previous: string | null = null;
    try {
      const stat = await lstat(lockPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error('Файл блокировки должен быть обычным файлом без ссылок.');
      previous = (await readFile(lockPath, 'utf8')).trim();
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (previous !== null) {
      if (/^[1-9]\d*$/.test(previous)) {
        // Migration from the old PID-only launcher: never displace a process
        // that may still own the directory. A missing PID AND our IPC lease
        // permit recovery; PID reuse stays conservative.
        try { process.kill(Number(previous), 0); throw busy(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw busy(); }
      } else {
        let old: unknown; try { old = JSON.parse(previous); } catch { /* leave unknown files alone */ }
        if (!old || typeof old !== 'object' || !('kind' in old) || old.kind !== 'companion-host-pipe-v1' || !('pipe' in old) || old.pipe !== pipeName) {
          throw new Error('Файл блокировки повреждён или принадлежит другой версии. Закройте Companion и проверьте инструкцию восстановления в docs/USER-GUIDE.md.');
        }
      }
    }
    await writeFile(temporary, JSON.stringify({ kind: 'companion-host-pipe-v1', pid: process.pid, pipe: pipeName }), { flag: 'wx', mode: 0o600 });
    await rename(temporary, lockPath);
  } catch (error) { await rm(temporary, { force: true }); await close(); throw error; }
  let released = false;
  return async () => {
    if (released) return; released = true;
    // Remove metadata while still owning the pipe; a successor cannot race it.
    try { await rm(lockPath, { force: true }); } finally { await close(); }
  };
}
