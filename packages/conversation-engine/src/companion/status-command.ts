import type { PredictionLoopHandlerController } from '@lmstudio/sdk';
import type { CoreTurn } from './turn';
import { CORE_ID, CORE_VERSION } from './runtime';
import {configSchematics} from '../config';
export const isCoreStatusText = (text: string) => /^\/core(?:-status)?\s*$/iu.test(text);
export function showCoreStatus(ctl: PredictionLoopHandlerController, turn: CoreTurn): boolean {
    const last = turn.history.getMessagesArray().at(-1);
    if (last?.getRole() !== 'user' || !isCoreStatusText(last.getText()))
        return false;
    const enabled=ctl.getPluginConfig(configSchematics).get('memoryEnabled');
    ctl.createContentBlock({ includeInContext: false, style: { type: 'customLabel', label: 'Companion Core' } }).appendText(`Активный обработчик: Companion Core\nПлагин: ${CORE_ID}\nВерсия: ${CORE_VERSION}\nNode обработчика: ${process.version}\nSDK сборки: 1.5.0\nМодель: ${turn.source.identifier}\nПодключено инструментов: ${turn.tools.length}\nЗапоминание по просьбе: ${enabled?'включено в этом чате; соединение проверяется при обращении':'выключено'}.\nТолько новые общие факты/заметки. Встроенный веб ещё не подключён.`);
    return true;
}
