import { describe, it, expect, vi } from 'vitest';
import { Chat, type PredictionLoopHandlerController } from '@lmstudio/sdk';
import { runCompanionTurn } from '../../src/companion/turn';
import { supportedCoreRuntime } from '../../src/companion/runtime';
function fixture() {
    const controller = new AbortController(), states: {
        status: string;
        text: string;
    }[] = [], blocks: string[] = [];
    const dispose = vi.fn(), source = { identifier: 'fixture', trainedForToolUse: true, countTokens: async () => 1, getContextLength: async () => 32000, applyPromptTemplate: async () => '', respond: vi.fn(), act: vi.fn() };
    const history = Chat.from([{ role: 'user', content: 'Синтетический вопрос' }]);
    const ctl = { abortSignal: controller.signal, tokenSource: vi.fn(async () => source), pullHistory: vi.fn(async () => history), startToolUseSession: vi.fn(async () => ({ tools: [], [Symbol.dispose]: dispose })), createStatus: (s: {
            status: string;
            text: string;
        }) => { states.push(s); return { setState: (v: {
                status: string;
                text: string;
            }) => states.push(v) }; }, createContentBlock: vi.fn(() => ({ appendText: (text: string) => blocks.push(text) })), debug: vi.fn() };
    return { controller, states, blocks, dispose, source, history, ctl: ctl as unknown as PredictionLoopHandlerController, raw: ctl };
}
describe('Companion turn lifecycle', () => {
    it('owns one history/source/session and preserves the same SDK message objects', async () => {
        const f = fixture(), runner = vi.fn(async (turn) => { expect(turn.history).toBe(f.history); expect(turn.source).toBe(f.source); expect(turn.signal).toBe(f.controller.signal); expect(turn.id).toMatch(/^[a-f0-9-]{36}$/); });
        expect(await runCompanionTurn(f.ctl, runner)).toEqual({ state: 'completed' });
        expect(runner).toHaveBeenCalledOnce();
        expect(f.dispose).toHaveBeenCalledOnce();
        expect(f.raw.pullHistory).toHaveBeenCalledOnce();
        expect(f.raw.tokenSource).toHaveBeenCalledOnce();
        expect(f.states.at(-1)).toMatchObject({ status: 'done', text: expect.stringContaining('завершён') });
    });
    it('fails closed when the tool session is unavailable; no text-only fallback', async () => {
        const f = fixture();
        f.raw.startToolUseSession.mockRejectedValue(Error('fixture fail'));
        const runner = vi.fn();
        expect(await runCompanionTurn(f.ctl, runner)).toMatchObject({ state: 'error', code: 'TOOLS_UNAVAILABLE' });
        expect(runner).not.toHaveBeenCalled();
        expect(f.blocks.join('')).toContain('инструмент');
        expect(f.states.at(-1)?.status).toBe('error');
    });
    it('rejects generator token sources instead of running nested respond', async () => {
        const f = fixture();
        f.raw.tokenSource.mockResolvedValue({ respond: vi.fn() } as never);
        const runner = vi.fn();
        expect(await runCompanionTurn(f.ctl, runner)).toMatchObject({ state: 'error', code: 'MODEL_UNSUPPORTED' });
        expect(runner).not.toHaveBeenCalled();
        expect(f.raw.startToolUseSession).not.toHaveBeenCalled();
    });
    it('closes the session after a runner failure without echoing arbitrary errors', async () => {
        const f = fixture();
        expect(await runCompanionTurn(f.ctl, async () => { throw Error('PRIVATE fixture token'); })).toMatchObject({ state: 'error' });
        expect(f.dispose).toHaveBeenCalledOnce();
        expect(f.blocks.join('')).not.toContain('PRIVATE');
        expect(f.states.at(-1)?.status).toBe('error');
    });
    it('cancels a cooperative runner and still closes the session', async () => {
        const f = fixture();
        const run = runCompanionTurn(f.ctl, async (turn) => { f.controller.abort(); turn.signal.throwIfAborted(); });
        expect(await run).toEqual({ state: 'cancelled' });
        expect(f.dispose).toHaveBeenCalledOnce();
        expect(f.states.at(-1)?.text).toContain('остановлен');
        expect(f.blocks).toEqual([]);
    });
    it('does not start anything when already cancelled', async () => {
        const f = fixture();
        f.controller.abort();
        expect(await runCompanionTurn(f.ctl, vi.fn())).toEqual({ state: 'cancelled' });
        expect(f.raw.tokenSource).not.toHaveBeenCalled();
    });
    it('closes a late session arriving after cancellation', async () => {
        const f = fixture();
        let release!: (v: any) => void;
        let started!: () => void;
        const began = new Promise<void>(r => started = r);
        f.raw.startToolUseSession.mockImplementation(() => { started(); return new Promise(r => release = r); });
        const runner = vi.fn();
        const pending = runCompanionTurn(f.ctl, runner);
        await began;
        f.controller.abort();
        expect(await pending).toEqual({ state: 'cancelled' });
        release({ tools: [], [Symbol.dispose]: f.dispose });
        await Promise.resolve();
        await Promise.resolve();
        expect(f.dispose).toHaveBeenCalledOnce();
        expect(runner).not.toHaveBeenCalled();
    });
    it('provides ordered internal hooks and cleans up when preparation fails', async () => {
        const f = fixture(), calls: string[] = [];
        const hooks = { prepare: async () => { calls.push('prepare'); }, after: async () => { calls.push('after'); } };
        await runCompanionTurn(f.ctl, async () => { calls.push('run'); }, hooks);
        expect(calls).toEqual(['prepare', 'run', 'after']);
        const g = fixture(), runner = vi.fn();
        await runCompanionTurn(g.ctl, runner, { prepare: async () => { throw Error('fail'); } });
        expect(runner).not.toHaveBeenCalled();
        expect(g.dispose).toHaveBeenCalledOnce();
    });
    it('a failed turn does not prevent a following turn', async () => {
        const f = fixture();
        await runCompanionTurn(f.ctl, async () => { throw Error('fail'); });
        expect(await runCompanionTurn(f.ctl, async () => { })).toEqual({ state: 'completed' });
        expect(f.dispose).toHaveBeenCalledTimes(2);
    });
    it('does not run the same controller twice concurrently', async () => {
        const f = fixture();
        let release!: () => void, started!: () => void;
        const began = new Promise<void>(r => started = r);
        const first = runCompanionTurn(f.ctl, async () => { started(); await new Promise<void>(r => release = r); });
        await began;
        const second = vi.fn();
        expect(await runCompanionTurn(f.ctl, second)).toMatchObject({ state: 'error', code: 'TURN_BUSY' });
        expect(second).not.toHaveBeenCalled();
        release();
        await first;
        expect(f.dispose).toHaveBeenCalledOnce();
    });
    it('does not silently drop external tools on a model without tool support', async () => {
        const f = fixture();
        f.source.trainedForToolUse = false;
        f.raw.startToolUseSession.mockResolvedValue({ tools: [{ name: 'fixture' }], [Symbol.dispose]: f.dispose } as never);
        const runner = vi.fn();
        expect(await runCompanionTurn(f.ctl, runner)).toMatchObject({ state: 'error', code: 'TOOLS_UNSUPPORTED' });
        expect(runner).not.toHaveBeenCalled();
        expect(f.dispose).toHaveBeenCalledOnce();
    });
    it('reports a failed close rather than claiming that resources were released', async () => {
        const f = fixture();
        f.dispose.mockImplementation(() => { throw Error('close'); });
        expect(await runCompanionTurn(f.ctl, async () => { })).toMatchObject({ state: 'error', code: 'SESSION_CLOSE_FAILED' });
        expect(f.dispose).toHaveBeenCalledOnce();
    });
    it('releases resources after an after-hook failure', async () => {
        const f = fixture();
        expect(await runCompanionTurn(f.ctl, async () => { }, { after: async () => { throw Error('after'); } })).toMatchObject({ state: 'error' });
        expect(f.dispose).toHaveBeenCalledOnce();
    });
    it('supports the separately tested panel and plugin runner majors', () => {
        expect(supportedCoreRuntime('v24.22.2')).toBe(true);
        expect(supportedCoreRuntime('v25.5.0')).toBe(true);
        expect(supportedCoreRuntime('v22.21.1')).toBe(false);
        expect(supportedCoreRuntime('v26.0.0')).toBe(false);
        expect(supportedCoreRuntime('bad')).toBe(false);
    });
});
