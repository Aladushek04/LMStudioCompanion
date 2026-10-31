import type { PredictionLoopHandlerController } from '@lmstudio/sdk';
import type { ToolCallCtx } from '../toolStatus';
import { CoreTurnError, waitForCoreStep } from './turn';
import { toolErrorResult } from '../toolWrap';
export interface ConfirmableTool {
    type?: string;
    name: string;
    pluginIdentifier?: string;
    checkParameters?: (params: Record<string, unknown>) => void;
}
export async function runConfirmedTool(ctl: PredictionLoopHandlerController, tool: ConfirmableTool, params: Record<string, unknown>, ctx: ToolCallCtx, run: (params: Record<string, unknown>) => Promise<unknown>): Promise<unknown> {
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, ctl.abortSignal]) : ctl.abortSignal;
    signal.throwIfAborted();
    let checked = params;
    if (tool.type === 'remoteTool') {
        if (!tool.pluginIdentifier || ctx.callId === undefined || typeof ctl.requestConfirmToolCall !== 'function' || !tool.checkParameters)
            throw new CoreTurnError('CONFIRMATION_UNAVAILABLE', 'Не удалось проверить разрешение на вызов инструмента. Действие не выполнено.');
        const deadline = AbortSignal.timeout(120000), approvalSignal = AbortSignal.any([signal, deadline]);
        const approval = await waitForCoreStep(ctl.requestConfirmToolCall({ callId: ctx.callId, pluginIdentifier: tool.pluginIdentifier, name: tool.name, parameters: params }), approvalSignal).catch(error => { if (deadline.aborted && !signal.aborted)
            throw new CoreTurnError('CONFIRMATION_TIMEOUT', 'Подтверждение инструмента не получено за две минуты. Действие не выполнено.'); throw error; });
        signal.throwIfAborted();
        if (approval.type === 'deny')
            return toolErrorResult('Вызов не выполнен: пользователь отклонил действие. Не повторяй его без новой просьбы.');
        checked = approval.toolArgsOverride ?? params;
        tool.checkParameters(checked);
    }
    signal.throwIfAborted();
    return run(checked);
}
