import { resolve } from 'node:path';
import { installRelease, previewInstall, readInstallState, restoreInstall, uninstallRelease } from './install.js';

try {
  const [command, ...args] = process.argv.slice(2);
  const get = (flag: string) => { const i = args.indexOf(flag); if (i < 0 || !args[i + 1]) throw new Error(`Нужен параметр ${flag}.`); return resolve(args[i + 1]!); };
  if (command === 'preview') console.log(JSON.stringify(await previewInstall(get('--source'), get('--target')), null, 2));
  else if (command === 'install') console.log(JSON.stringify(await installRelease(get('--source'), get('--target')), null, 2));
  else if (command === 'rollback') {
    const root = get('--target'); const state = await readInstallState(root);
    if (!state?.lastBackup) throw new Error('Резервная копия для отката не найдена.');
    const result = await restoreInstall(state.lastBackup); if (!result.ok) throw new Error(result.message);
    console.log('Предыдущая версия восстановлена. Данные сохранены.');
  } else if (command === 'uninstall') console.log(JSON.stringify(await uninstallRelease(get('--target'))));
  else throw new Error('Неизвестная команда установщика.');
} catch (error) { console.error(error instanceof Error ? error.message : 'Операция не выполнена.'); process.exitCode = 1; }
