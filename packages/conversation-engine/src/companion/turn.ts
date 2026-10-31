import type { Chat, LLM, Tool, PredictionLoopHandlerController } from '@lmstudio/sdk';
import { randomUUID } from 'node:crypto';
import { supportedCoreRuntime } from './runtime';
export interface CoreTurn {
    id: string;
    signal: AbortSignal;
    history: Chat;
    source: LLM;
    tools: Tool[];
}
export type CoreTurnResult = {
    state: 'completed';
} | {
    state: 'cancelled';
} | {
    state: 'error';
    code: string;
    message: string;
};
export interface CoreTurnHooks {
    prepare?(turn: CoreTurn): Promise<void>;
    after?(turn: CoreTurn): Promise<void>;
}
export class CoreTurnError extends Error {
    constructor(readonly code: string, message: string) { super(message); this.name = 'CoreTurnError'; }
}
type Session = {
    tools: Tool[];
    [Symbol.dispose](): void;
};
const active = new WeakSet<object>();
function supportedModel(value: unknown): value is LLM {
    if (!value || typeof value !== 'object')
        return false;
    const source = value as Record<string, unknown>;
    return ['countTokens', 'getContextLength', 'applyPromptTemplate', 'respond', 'act'].every(key => typeof source[key] === 'function');
}
// Preparation can finish after Stop. Its late resource must still be released.
export function waitForCoreStep<T>(pending: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const abort = () => { if (settled)
            return; settled = true; signal.removeEventListener('abort', abort); reject(signal.reason ?? new Error('Cancelled')); };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted)
            abort();
        pending.then(value => { if (settled) {
            try {
                late?.(value);
            }
            catch { }
            return;
        } settled = true; signal.removeEventListener('abort', abort); resolve(value); }, error => { if (settled)
            return; settled = true; signal.removeEventListener('abort', abort); reject(error); });
    });
}
function ui(action: () => void) { try {
    action();
}
catch { /* The UI may already be detached by Stop. */ } }
export async function runCompanionTurn(ctl: PredictionLoopHandlerController, runner: (turn: CoreTurn) => Promise<void>, hooks: CoreTurnHooks = {}): Promise<CoreTurnResult> {
    if (active.has(ctl))
        return { state: 'error', code: 'TURN_BUSY', message: 'Этот ход уже выполняется.' };
    if (ctl.abortSignal.aborted)
        return { state: 'cancelled' };
    active.add(ctl);
    let session: Session | undefined;
    let status: ReturnType<PredictionLoopHandlerController['createStatus']> | undefined;
    let result: CoreTurnResult = { state: 'completed' };
    ui(() => { status = ctl.createStatus({ status: 'loading', text: 'Companion Core: подготавливаю ответ…' }); });
    try {
        if (!supportedCoreRuntime(process.version))
            throw new CoreTurnError('RUNTIME_UNSUPPORTED', 'Для Companion Core нужен проверенный Node 24 или 25. Панель использует комплектный Node 24; версия обработчика зависит от LM Studio.');
        const source = await waitForCoreStep(ctl.tokenSource(), ctl.abortSignal);
        if (!supportedModel(source))
            throw new CoreTurnError('MODEL_UNSUPPORTED', 'Выберите локальную модель в верхней панели LM Studio. Другой генератор не может быть источником для Companion Core.');
        const history = await waitForCoreStep(ctl.pullHistory(), ctl.abortSignal);
        try {
            session = await waitForCoreStep(ctl.startToolUseSession() as unknown as Promise<Session>, ctl.abortSignal, value => value[Symbol.dispose]());
        }
        catch (error) {
            ctl.abortSignal.throwIfAborted();
            throw new CoreTurnError('TOOLS_UNAVAILABLE', 'Не удалось подключить инструменты. Ход остановлен; действия не выполнялись. Повторите запрос после проверки подключённых плагинов.');
        }
        if (!Array.isArray(session.tools) || typeof session[Symbol.dispose] !== 'function')
            throw new CoreTurnError('TOOLS_UNAVAILABLE', 'LM Studio вернула неподдержанный сеанс инструментов. Ход остановлен.');
        const turn: CoreTurn = { id: randomUUID(), signal: ctl.abortSignal, source, history, tools: [...session.tools] };
        if (turn.tools.length && source.trainedForToolUse === false)
            throw new CoreTurnError('TOOLS_UNSUPPORTED', 'Выбранная модель не поддерживает вызов подключённых инструментов. Отключите их для обычного диалога или выберите подходящую модель самостоятельно.');
        turn.signal.throwIfAborted();
        await hooks.prepare?.(turn);
        turn.signal.throwIfAborted();
        ui(() => status?.setState({ status: 'loading', text: 'Companion Core: отвечаю…' }));
        await runner(turn);
        turn.signal.throwIfAborted();
        await hooks.after?.(turn);
        turn.signal.throwIfAborted();
    }
    catch (error) {
        result = ctl.abortSignal.aborted ? { state: 'cancelled' } : error instanceof CoreTurnError ? { state: 'error', code: error.code, message: error.message } : { state: 'error', code: 'TURN_FAILED', message: 'Не удалось завершить ответ. Повторите запрос; если ошибка повторится, проверьте доступность модели.' };
    }
    finally {
        try {
            session?.[Symbol.dispose]();
        }
        catch {
            if (result.state !== 'cancelled')
                result = { state: 'error', code: 'SESSION_CLOSE_FAILED', message: 'Не удалось закрыть сеанс инструментов. Ответ мог завершиться; перед повтором проверьте результат действий и перезапустите плагин.' };
        }
        active.delete(ctl);
    }
    if (result.state === 'error') {
        const failure = result;
        ui(() => status?.setState({ status: 'error', text: 'Companion Core: ' + failure.message }));
        ui(() => ctl.createContentBlock({ includeInContext: false, style: { type: 'customLabel', label: 'Companion Core' } }).appendText(failure.message));
    }
    else
        ui(() => status?.setState({ status: 'done', text: result.state === 'cancelled' ? 'Companion Core: ответ остановлен.' : 'Companion Core: ход завершён.' }));
    return result;
}
