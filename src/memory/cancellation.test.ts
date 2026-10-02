import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Exercise the actual request lifecycle without loading the SillyTavern host.
const source = ts.createSourceFile('engine.ts', readFileSync(new URL('./engine.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const names = new Set(['runSummary', 'cancelCurrentSummary', 'sendAndParse']);
const functions = source.statements.filter(n => ts.isFunctionDeclaration(n) && n.name && names.has(n.name.text))
  .map(n => n.getText(source).replace(/^export /, '')).join('\n');
const compiled = ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function harness() {
  return new Function(`
    let busy = false, currentRun = null, currentRunAbort = null;
    let singleRunBusyOwner = null, floorBackfillOwnerRunId = null, summaryRunSeq = 0;
    const engineState = { running: false, cancelling: false, lastError: '' };
    const floorBackfillState = { running: false, floor: null, chatId: '' };
    const apiSettings = { summaryMaxRetries: 2 };
    const getContext = () => ({ getCurrentChatId: () => 'test' });
    const requests = [];
    function runSummaryInner(floor, options) {
      busy = true;
      engineState.running = true;
      return new Promise(resolve => requests.push({ floor, signal: options.signal, resolve }));
    }
    ${compiled}
    return { runSummary, cancelCurrentSummary, sendAndParse, requests, floorBackfillState, engineState };
  `)();
}

describe('summary cancellation', () => {
  it('a duplicate trigger cannot replace the active abort controller', async () => {
    const h = harness();
    const first = h.runSummary(50);
    await h.runSummary(51);
    expect(h.requests).toHaveLength(1);
    h.cancelCurrentSummary();
    expect(h.requests[0].signal.aborted).toBe(true);
    expect(h.floorBackfillState.running).toBe(false);
    h.requests[0].resolve();
    await first;
  });

  it('a cancelled request finishing late does not clear the next request state', async () => {
    const h = harness();
    const first = h.runSummary(50);
    h.cancelCurrentSummary();
    const second = h.runSummary(52);
    h.requests[0].resolve();
    await first;
    expect(h.floorBackfillState.floor).toBe(52);
    expect(h.floorBackfillState.running).toBe(true);
    h.cancelCurrentSummary();
    expect(h.requests[1].signal.aborted).toBe(true);
    h.requests[1].resolve();
    await second;
  });

  it('ignores late responses after abort without parsing or retrying', async () => {
    const h = harness();
    const controller = new AbortController();
    let resolve!: (text: string) => void;
    let sends = 0;
    let parses = 0;
    const pending = h.sendAndParse(() => {
      sends++;
      return new Promise<string>(r => { resolve = r; });
    }, [], () => { parses++; }, controller.signal);
    controller.abort();
    resolve('late response');
    await expect(pending).rejects.toThrow('摘要已停止');
    expect(sends).toBe(1);
    expect(parses).toBe(0);
  });
});
