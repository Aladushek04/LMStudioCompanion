import { it, expect, vi } from 'vitest';
import { Chat, ChatMessage, type PredictionLoopHandlerController } from '@lmstudio/sdk';
import { predictionLoopHandler } from '../../src/handler';
import { ChunkCache } from '../../src/cache';
// No user's persisted cache is read or written by these tests.
vi.spyOn(ChunkCache, 'load').mockImplementation(async () => new ChunkCache());
let sequence = 0;
function fixture(tools: any[] = [], command = 'Синтетический вопрос') {
    const abort = new AbortController(), texts: string[] = [], statuses: {
        status: string;
        text: string;
    }[] = [], toolStates: any[] = [];
    const history = Chat.from([{ role: 'user', content: command }]), dispose = vi.fn(), configs: Record<string, unknown> = { autoCompact: false, thresholdPercent: 75, compactFloorPercent: 55, reservedOutputTokens: 2000, thresholdTokensOverride: 0, keepRecentTokens: 6000, chunkTokens: 16000, roundsPerPass: 0, maxChunksPerPass: 0, maxToolResultTokens: 4000, maxTotalToolResultTokens: 20000, attachmentMemory: false, summaryBudgetTokens: 12000, summarizerMaxTokens: 1500, summarizerPromptMode: 'auto', showStats: false, meterDisplay: 'off' };
    const source = { identifier: 'handler-fixture-' + (++sequence), trainedForToolUse: true, getContextLength: async () => 32000, countTokens: async (text: string) => Math.ceil(text.length / 4), applyPromptTemplate: vi.fn(async (chat: Chat) => chat.getMessagesArray().map(m => m.getText()).join('\n')), respond: vi.fn(), act: vi.fn(async (_chat: any, _tools: any, opts: any) => {
            opts.onRoundStart(0);
            opts.onPredictionFragment({ content: 'Учебный ответ', reasoningType: 'none', tokensCount: 2 });
            opts.onMessage(ChatMessage.create('assistant', 'Учебный ответ'));
            opts.onRoundEnd(0);
        }) };
    const ctl = { abortSignal: abort.signal, client: {}, tokenSource: async () => source, pullHistory: async () => history, getPluginConfig: () => ({ get: (key: string) => configs[key] }), startToolUseSession: async () => ({ tools, [Symbol.dispose]: dispose }), requestConfirmToolCall: vi.fn(async () => ({ type: 'allow' } as any)), createStatus: (s: any) => { statuses.push(s); return { setState: (v: any) => statuses.push(v) }; }, createContentBlock: vi.fn(() => ({ appendText: (text: string) => texts.push(text), appendToolRequest: vi.fn(), appendToolResult: (result: any) => texts.push('RESULT:' + result.callId + ':' + result.content), pipeFrom: async (prediction: any) => { const result = await prediction; texts.push(result.content); return result; } })), createToolStatus: (_id: number, initial: any) => { toolStates.push(initial); return { setCustomStatusText: vi.fn(), addWarning: vi.fn(), setStatus: (v: any) => toolStates.push(v) }; }, setSenderName: vi.fn(), onAborted: (callback: () => void) => abort.signal.addEventListener('abort', callback, { once: true }), debug: vi.fn() };
    return { source, ctl: ctl as unknown as PredictionLoopHandlerController, raw: ctl, abort, history, dispose, texts, statuses, toolStates };
}
it('entry handler produces an answer through the owned cycle', async () => {
    const f = fixture();
    await predictionLoopHandler(f.ctl);
    expect(f.texts.join('')).toContain('Учебный ответ');
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(f.statuses.at(-1)?.text).toContain('Companion Core');
    expect(f.source.act).toHaveBeenCalledOnce();
});
it('/core identifies the running handler without generating text', async () => {
    const f = fixture([], '/core');
    await predictionLoopHandler(f.ctl);
    expect(f.texts.join('')).toContain('aladushek04/companion-core');
    expect(f.texts.join('')).toContain(process.version);
    expect(f.source.act).not.toHaveBeenCalled();
    expect(f.source.respond).not.toHaveBeenCalled();
    expect(f.dispose).toHaveBeenCalledOnce();
});
it('previous diagnostic commands are excluded from later model prompts', async () => {
    const f = fixture();
    f.raw.pullHistory = async () => Chat.from([{ role: 'user', content: '/core' }, { role: 'user', content: 'Учебный вопрос' }]);
    f.source.act.mockImplementation(async (view: Chat, _tools: any, opts: any) => { expect(view.getMessagesArray().map(m => m.getText()).join('\n')).not.toContain('/core'); opts.onPredictionFragment({ content: 'Ответ', reasoningType: 'none' }); });
    await predictionLoopHandler(f.ctl);
    expect(f.texts).toContain('Ответ');
});
it('a model without tool training can answer when no external tools are selected', async () => {
    const f = fixture();
    f.source.trainedForToolUse = false;
    f.source.respond.mockImplementation(() => Object.assign(Promise.resolve({ content: 'Прямой ответ', reasoningContent: '' }), { cancel: async () => { } }));
    await predictionLoopHandler(f.ctl);
    expect(f.texts).toContain('Прямой ответ');
    expect(f.source.act).not.toHaveBeenCalled();
    expect(f.dispose).toHaveBeenCalledOnce();
});
it('external tools keep call correlation and the model continues after their result', async () => {
    const tool = { name: 'fixture_echo', description: 'Echo fixed data', implementation: vi.fn(async () => ({ answer: 731 })) };
    const f = fixture([tool]);
    f.source.act.mockImplementation(async (_view: any, tools: any[], opts: any) => {
        opts.onRoundStart(0);
        opts.onToolCallRequestFinalized(0, 17, { toolCallRequest: { name: 'fixture_echo', arguments: {} } });
        const result = await tools.find(t => t.name === 'fixture_echo').implementation({}, { callId: 17, signal: opts.signal, status: () => { }, warn: () => { } });
        expect(result).toEqual({ answer: 731 });
        opts.onPredictionFragment({ content: 'Получено 731', reasoningType: 'none' });
        opts.onMessage(ChatMessage.create('assistant', 'Получено 731'));
        opts.onRoundEnd(0);
    });
    await predictionLoopHandler(f.ctl);
    expect(tool.implementation).toHaveBeenCalledOnce();
    expect(f.texts.join('')).toContain('RESULT:17:{"answer":731}');
    expect(f.texts.join('')).toContain('Получено 731');
    expect(f.toolStates.at(-1)?.type).toBe('toolCallSucceeded');
    expect(f.dispose).toHaveBeenCalledOnce();
});
it('tool failure remains a failure result, with a successful next turn', async () => {
    const f = fixture([{ name: 'fixture_fail', description: 'Failure', implementation: async () => { throw Error('Учебный отказ'); } }]);
    f.source.act.mockImplementation(async (_view: any, tools: any[], opts: any) => {
        opts.onRoundStart(0);
        const result = await tools.find(t => t.name === 'fixture_fail').implementation({}, { callId: 23, signal: opts.signal, status: () => { }, warn: () => { } });
        expect(result).toContain('Tool execution failed:');
        opts.onPredictionFragment({ content: 'Инструмент вернул отказ', reasoningType: 'none' });
        opts.onMessage(ChatMessage.create('assistant', 'Инструмент вернул отказ'));
        opts.onRoundEnd(0);
    });
    await predictionLoopHandler(f.ctl);
    expect(f.toolStates.at(-1)?.type).toBe('toolCallFailed');
    expect(f.dispose).toHaveBeenCalledOnce();
    const next = fixture();
    await predictionLoopHandler(next.ctl);
    expect(next.texts).toContain('Учебный ответ');
});
it('entry handler stops with the user and releases the external session', async () => {
    const f = fixture();
    f.source.act.mockImplementation(async (_view: any, _tools: any, opts: any) => { f.abort.abort(); opts.signal.throwIfAborted(); });
    await predictionLoopHandler(f.ctl);
    expect(f.statuses.at(-1)?.text).toContain('остановлен');
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(f.texts).toEqual([]);
});
it('does not promote unfinished reasoning into an answer when act resolves after Stop', async () => {
    const f = fixture();
    f.source.act.mockImplementation(async (_view: any, _tools: any, opts: any) => {
        opts.onPredictionFragment({ content: 'I should compute 2+2, so the answer is 4.', reasoningType: 'reasoning' });
        f.abort.abort();
    });
    await predictionLoopHandler(f.ctl);
    expect(f.texts.filter(text => text.includes('I should'))).toHaveLength(1);
    expect(f.statuses.at(-1)?.text).toContain('остановлен');
});
it('retries a transient failure on the same selected source without acquiring another model', async () => {
    vi.useFakeTimers();
    try {
        const f = fixture(), source = vi.spyOn(f.raw, 'tokenSource');
        f.source.act.mockRejectedValueOnce(Error('fetch failed'));
        const pending = predictionLoopHandler(f.ctl);
        await vi.runAllTimersAsync();
        await pending;
        expect(f.source.act).toHaveBeenCalledTimes(2);
        expect(source).toHaveBeenCalledOnce();
        expect(f.dispose).toHaveBeenCalledOnce();
    }
    finally {
        vi.useRealTimers();
    }
});
it('Stop interrupts retry backoff without starting another prediction', async () => {
    vi.useFakeTimers();
    try {
        const f = fixture();
        f.source.act.mockRejectedValue(Error('fetch failed'));
        const pending = predictionLoopHandler(f.ctl);
        await vi.advanceTimersByTimeAsync(0);
        f.abort.abort();
        await vi.advanceTimersByTimeAsync(1000);
        await pending;
        expect(f.source.act).toHaveBeenCalledOnce();
        expect(f.statuses.at(-1)?.text).toContain('остановлен');
        expect(f.dispose).toHaveBeenCalledOnce();
    }
    finally {
        vi.useRealTimers();
    }
});
it('never retries after publishing a tool request, even if no side effect ran yet', async () => {
    const f = fixture([{ name: 'fixture_echo', description: 'Fixture', implementation: vi.fn() }]);
    f.source.act.mockImplementation(async (_view: any, _tools: any, opts: any) => { opts.onToolCallRequestFinalized(0, 31, { toolCallRequest: { name: 'fixture_echo', arguments: {} } }); throw Error('fetch failed'); });
    vi.useFakeTimers();
    try {
        const pending = predictionLoopHandler(f.ctl);
        await vi.runAllTimersAsync();
        await pending;
        expect(f.source.act).toHaveBeenCalledOnce();
        expect(f.statuses.at(-1)?.status).toBe('error');
        expect(f.dispose).toHaveBeenCalledOnce();
    }
    finally {
        vi.useRealTimers();
    }
});
it('remote tool UI is confirming while permission is pending and executing only after allow', async () => {
    const tool = { type: 'remoteTool', pluginIdentifier: 'fixture/tools', name: 'fixture_remote', description: 'Fixture', checkParameters: vi.fn(), implementation: vi.fn(async () => 731) };
    const f = fixture([tool]);
    f.raw.requestConfirmToolCall.mockImplementation(async () => { expect(f.toolStates.at(-1)?.type).toBe('confirmingToolCall'); expect(tool.implementation).not.toHaveBeenCalled(); return { type: 'allow' }; });
    tool.implementation.mockImplementation(async () => { expect(f.toolStates.at(-1)?.type).toBe('callingTool'); return 731; });
    f.source.act.mockImplementation(async (_view: any, tools: any[], opts: any) => { opts.onToolCallRequestFinalized(0, 27, { toolCallRequest: { name: 'fixture_remote', arguments: {} } }); const block = f.raw.createContentBlock.mock.results.find(r => r.value.appendToolRequest.mock.calls.length)?.value; expect(block?.appendToolRequest).toHaveBeenCalledWith(expect.objectContaining({ pluginIdentifier: 'fixture/tools', callId: 27 })); await tools.find(t => t.name === 'fixture_remote').implementation({}, { callId: 27, signal: opts.signal, status: () => { }, warn: () => { } }); opts.onPredictionFragment({ content: 'Готово', reasoningType: 'none' }); });
    await predictionLoopHandler(f.ctl);
    expect(tool.implementation).toHaveBeenCalledOnce();
    expect(f.raw.requestConfirmToolCall).toHaveBeenCalledOnce();
    expect(f.toolStates.at(-1)?.type).toBe('toolCallSucceeded');
});
it('native denial does not execute a remote tool and remains a failure result', async () => {
    const tool = { type: 'remoteTool', pluginIdentifier: 'fixture/tools', name: 'fixture_remote', description: 'Fixture', checkParameters: vi.fn(), implementation: vi.fn() };
    const f = fixture([tool]);
    f.raw.requestConfirmToolCall.mockResolvedValue({ type: 'deny' });
    f.source.act.mockImplementation(async (_view: any, tools: any[], opts: any) => { const result = await tools.find(t => t.name === 'fixture_remote').implementation({}, { callId: 28, signal: opts.signal, status: () => { }, warn: () => { } }); expect(result).toContain('не выполнен'); opts.onPredictionFragment({ content: 'Отказ учтён', reasoningType: 'none' }); });
    await predictionLoopHandler(f.ctl);
    expect(tool.implementation).not.toHaveBeenCalled();
    expect(f.toolStates.at(-1)?.type).toBe('toolCallFailed');
    expect(f.dispose).toHaveBeenCalledOnce();
});
it('the original SDK message including attachment access is preserved in the model view', async () => {
    const f = fixture();
    const history = Chat.empty();
    history.append(ChatMessage.from({ role: 'user', content: [{ type: 'text', text: 'Синтетическое изображение' }, { type: 'file', name: 'synthetic.png', identifier: 'synthetic-image', sizeBytes: 12, fileType: 'image' }] }));
    f.raw.pullHistory = async () => history;
    f.source.act.mockImplementation(async (view: Chat, _tools: any, opts: any) => { const message = view.getMessagesArray().find(m => m.hasFiles()); expect(message).toBeDefined(); expect(message!.getFiles(f.raw.client as never)[0]?.name).toBe('synthetic.png'); opts.onRoundStart(0); opts.onPredictionFragment({ content: 'Вложение сохранено', reasoningType: 'none' }); opts.onMessage(ChatMessage.create('assistant', 'Вложение сохранено')); opts.onRoundEnd(0); });
    await predictionLoopHandler(f.ctl);
    expect(f.texts.join('')).toContain('Вложение сохранено');
    expect(f.dispose).toHaveBeenCalledOnce();
});
