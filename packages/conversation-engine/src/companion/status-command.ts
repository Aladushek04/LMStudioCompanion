import type { PredictionLoopHandlerController } from '@lmstudio/sdk';
import type { CoreTurn } from './turn';
import { CORE_ID, CORE_VERSION } from './runtime';
export const isCoreStatusText = (text: string) => /^\/core(?:-status)?\s*$/iu.test(text);
export function showCoreStatus(ctl: PredictionLoopHandlerController, turn: CoreTurn): boolean {
    const last = turn.history.getMessagesArray().at(-1);
    if (last?.getRole() !== 'user' || !isCoreStatusText(last.getText()))
        return false;
    ctl.createContentBlock({ includeInContext: false, style: { type: 'customLabel', label: 'Companion Core' } }).appendText(`Активный обработчик: Companion Core\nПлагин: ${CORE_ID}\nВерсия: ${CORE_VERSION}\nNode обработчика: ${process.version}\nSDK сборки: 1.5.0\nМодель: ${turn.source.identifier}\nПодключено инструментов: ${turn.tools.length}\nПамять и встроенный веб в этот подэтап ещё не включены.`);
    return true;
}
