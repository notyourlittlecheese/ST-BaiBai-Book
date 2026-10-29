import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/memory/vector', () => ({ scheduleVectorIndex: vi.fn() }));
import { handleGenerationIntercept, cancelCurrentSummary } from './engine';
import { apiSettings } from '@/api/settings';
import { memory, recomputeDerived } from './store';
import { getLeaf } from './apply';
import { apiActivity } from '@/api/activity';

function setup(mode = 'strict') {
  const chat: any[] = [
    { is_user: false, mes: '我在家。', extra: { bbs_leaf: { id: 'old', text: '在家', delta: { location: '家' }, createdAt: 1, v: 1 } } },
    { is_user: true, mes: '去图书馆。' },
    { is_user: false, mes: '抵达图书馆，换上蓝色外套。' },
    { is_user: true, mes: '继续。' },
  ];
  const ctx = {
    chat, chatMetadata: { bbs_summary_policy: { mode, count: 2, start: 1, end: 2 } },
    getCurrentChatId: () => 'pipeline', name1: '主角', name2: '角色', characters: [],
    saveChat: vi.fn(async () => {}), saveMetadataDebounced: vi.fn(), setExtensionPrompt: vi.fn(),
    generateRaw: vi.fn(async () => JSON.stringify({ summary: '抵达图书馆。', location: '图书馆', protagonist: { outfit: '蓝色外套' } })),
  };
  vi.stubGlobal('window', { SillyTavern: { getContext: () => ctx } });
  Object.assign(apiSettings, { enabled: true, autoSummaryEnabled: true, autoHideEnabled: false, summaryOnlyMode: true, summaryMaxRetries: 0, leafBatchThreshold: 0 });
  apiSettings.channels = [];
  apiSettings.assignmentPools = { summary: [], resummary: [] };
  apiSettings.assignments = { summary: '', resummary: '' };
  apiSettings.vector.enabled = false;
  memory.summaries = [];
  recomputeDerived();
  return ctx;
}
afterEach(() => { cancelCurrentSummary(); vi.unstubAllGlobals(); });

describe('real automatic summary pipeline', () => {
  it('updates the latest location before returning permission for body generation', async () => {
    const ctx = setup();
    const abort = vi.fn();
    expect(await handleGenerationIntercept('normal', abort)).toBe(false);
    expect(abort).not.toHaveBeenCalled();
    expect(ctx.generateRaw).toHaveBeenCalledTimes(1);
    expect(memory.state.location).toBe('图书馆');
    expect(memory.protagonist.outfit).toBe('蓝色外套');
    expect(getLeaf(ctx.chat[2])?.text).toBe('抵达图书馆。');
  });
  it('invalid JSON blocks generation and leaves the floor pending', async () => {
    const ctx = setup();
    ctx.generateRaw.mockResolvedValue('not JSON');
    const abort = vi.fn();
    expect(await handleGenerationIntercept('normal', abort)).toBe(true);
    expect(abort).toHaveBeenCalledWith(true);
    expect(getLeaf(ctx.chat[2])).toBeUndefined();
    expect(ctx.generateRaw).toHaveBeenCalledTimes(1);
  });
  it('range batch writes full per-floor states in one request', async () => {
    const ctx = setup('range');
    ctx.generateRaw.mockResolvedValue(JSON.stringify({ floors: [{ summary: '已到图书馆', location: '图书馆', protagonist: { outfit: '蓝色外套' } }] }));
    expect(await handleGenerationIntercept('normal', vi.fn())).toBe(false);
    expect(ctx.generateRaw).toHaveBeenCalledTimes(1);
    expect(memory.state.location).toBe('图书馆');
    expect(memory.protagonist.outfit).toBe('蓝色外套');
    expect(apiActivity[0].task).toBe('摘要');
  });
  it('late host responses after stop cannot write a leaf', async () => {
    const ctx = setup();
    let finish!: (text: string) => void;
    ctx.generateRaw.mockImplementation(() => new Promise<string>(r => { finish = r; }));
    const abort = vi.fn();
    const pending = handleGenerationIntercept('normal', abort);
    await vi.waitFor(() => expect(ctx.generateRaw).toHaveBeenCalledTimes(1));
    cancelCurrentSummary();
    expect(await pending).toBe(true);
    finish(JSON.stringify({ summary: '不应保存', location: '旧地点' }));
    await new Promise(r => setTimeout(r, 10));
    expect(getLeaf(ctx.chat[2])).toBeUndefined();
    expect(abort).toHaveBeenCalled();
  });
});
