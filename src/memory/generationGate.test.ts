import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { normalizeSummaryPolicy, planAutomaticSummary } from './summaryPolicy';

const source = ts.createSourceFile('engine.ts', readFileSync(new URL('./engine.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const functions = source.statements.filter(n => ts.isFunctionDeclaration(n) && ['handleGenerationIntercept', 'cancelCurrentSummary'].includes(n.name?.text ?? ''))
  .map(n => n.getText(source).replace(/^export /, '')).join('\n');
const compiled = ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function setup(mode: 'strict' | 'count' | 'range' = 'strict') {
  const state = {
    chat: [{ mes: '在家' }, { mes: '在图书馆' }],
    pending: [1], policy: normalizeSummaryPolicy({ mode, count: 2, start: 0, end: 1 }),
    work: vi.fn(async () => { state.pending = []; }),
    batch: vi.fn(async () => { state.pending = []; }),
    refresh: vi.fn(), ctx: null as any,
  };
  state.ctx = { chat: state.chat, getCurrentChatId: () => 'chat' };
  const h = new Function('state', 'planAutomaticSummary', `
    let generationGate = null, busy = false, currentRun = null, currentRunAbort = null;
    let singleRunBusyOwner = null, floorBackfillOwnerRunId = null;
    const engineState = { running: false, cancelling: false, lastError: '' };
    const floorBackfillState = { running: false, floor: null, chatId: '' };
    const engineActiveHere = () => true, apiSettings = { autoSummaryEnabled: true };
    const getContext = () => state.ctx;
    const normalizeBacklogNotices = () => {}, toast = () => {};
    const shouldSkipLastAiForGeneration = (_, type) => type === 'regenerate' || type === 'swipe';
    const prevAiFloor = (_, skip) => skip ? 0 : 1;
    const pendingAiFloors = () => state.pending;
    const manuallyHiddenAi = () => false;
    const getSummaryPolicy = () => state.policy;
    const refreshInjection = state.refresh;
    const resolveSender = () => ({ send() {} });
    const summarizeFloorWork = (...args) => state.work(...args);
    const summarizeBatchWork = (...args) => state.batch(...args);
    const planBatches = (_, floors) => [floors];
    const leafValid = message => !state.pending.includes(state.chat.indexOf(message));
    const checkResummary = async () => {};
    const afterSummaryHideAndInject = async () => state.refresh();
    ${compiled}
    return { handleGenerationIntercept, cancelCurrentSummary, engineState };
  `)(state, planAutomaticSummary);
  return { state, ...h };
}

describe('正文生成前摘要闸门', () => {
  it('does not turn an old backlog into many paid automatic requests', async () => {
    const h = setup();
    h.state.pending = [0, 1];
    const abort = vi.fn();
    expect(await h.handleGenerationIntercept('normal', abort)).toBe(true);
    expect(h.state.work).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalled();
  });
  it('waits for summary success before allowing generation', async () => {
    const h = setup();
    let finish!: () => void;
    h.state.work.mockImplementation(() => new Promise<void>(r => { finish = () => { h.state.pending = []; r(); }; }));
    const abort = vi.fn();
    let completed = false;
    const p = h.handleGenerationIntercept('normal', abort).then((x: boolean) => { completed = true; return x; });
    await Promise.resolve();
    expect(completed).toBe(false);
    finish();
    expect(await p).toBe(false);
    expect(abort).not.toHaveBeenCalled();
    expect(h.state.refresh).toHaveBeenCalled();
  });
  it('blocks on API failure without letting the caller generate', async () => {
    const h = setup();
    h.state.work.mockRejectedValue(new Error('API 503'));
    const abort = vi.fn();
    expect(await h.handleGenerationIntercept('normal', abort)).toBe(true);
    expect(abort).toHaveBeenCalledWith(true);
    expect(h.state.refresh).not.toHaveBeenCalled();
  });
  it('stop releases the gate even when a host API ignores cancellation', async () => {
    const h = setup();
    h.state.work.mockImplementation(() => new Promise<void>(() => {}));
    const abort = vi.fn();
    const pending = h.handleGenerationIntercept('normal', abort);
    h.cancelCurrentSummary();
    expect(await pending).toBe(true);
    expect(abort).toHaveBeenCalledWith(true);
    expect(h.engineState.running).toBe(false);
  });
  it('blocks when the chat changes during the request', async () => {
    const h = setup();
    h.state.work.mockImplementation(async () => { h.state.pending = []; h.state.ctx = { chat: [], getCurrentChatId: () => 'other' }; });
    const abort = vi.fn();
    expect(await h.handleGenerationIntercept('normal', abort)).toBe(true);
    expect(abort).toHaveBeenCalled();
  });
  it('defers count mode without spending an API call', async () => {
    const h = setup('count');
    expect(await h.handleGenerationIntercept('normal', vi.fn())).toBe(false);
    expect(h.state.work).not.toHaveBeenCalled();
    expect(h.state.batch).not.toHaveBeenCalled();
  });
  it('batch failure does not fall back to costly single-floor requests', async () => {
    const h = setup('count');
    h.state.pending = [0, 1];
    h.state.batch.mockRejectedValue(new Error('bad JSON'));
    const abort = vi.fn();
    expect(await h.handleGenerationIntercept('normal', abort)).toBe(true);
    expect(h.state.work).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledWith(true);
  });
  it('regeneration excludes the response being replaced', async () => {
    const h = setup();
    expect(await h.handleGenerationIntercept('regenerate', vi.fn())).toBe(false);
    expect(h.state.work).not.toHaveBeenCalled();
  });
});
