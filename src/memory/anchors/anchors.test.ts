import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/memory/vector', () => ({ scheduleVectorIndex: vi.fn() }));
import { anchors, syncAnchors, receiveAnchors, anchorEntries, settlePending, reviewBeforeGeneration, cancelAnchorReview, parseAnchorProposal, beginAnchorBatch, endAnchorBatch, setEntryPolicy, anchorText, anchorPrompt } from './index';
import { recomputeDerived, memory } from '../store';
import { deleteLeafAt } from '../apply';
import { setFloorOmit, setFloorsOmit, syncHiddenNow, initializeAnchors, handleGenerationIntercept, discardAnchorInitialization, anchorInitialization, stopAnchorInitialization } from '../engine';
import { apiSettings } from '@/api/settings';

function setup() {
  memory.summaries = [];
  const chat: any[] = [{ is_user: true, mes: '我很委屈。' }, { is_user: false, mes: '发生争执', extra: { bbs_leaf: { id: 'leaf1', text: '用户明确委屈', v: 1, createdAt: 1, delta: {} } } }];
  const ctx = { chat, chatMetadata: {} as Record<string, unknown>, getCurrentChatId: () => 'anchor-test', name1: 'U', name2: 'C', characters: [], saveChat: vi.fn(async () => {}), saveMetadataDebounced: vi.fn(), setExtensionPrompt: vi.fn(), generateRaw: vi.fn(async () => '') };
  vi.stubGlobal('window', { SillyTavern: { getContext: () => ctx } });
  Object.assign(apiSettings, { enabled: true, autoSummaryEnabled: true, autoHideEnabled: false, summaryMaxRetries: 0, leafBatchThreshold: 0 });
  apiSettings.channels = []; apiSettings.assignments = { summary: '', resummary: '' }; apiSettings.assignmentPools = { summary: [], resummary: [] };
  syncAnchors(); anchors.data.enabled = true;
  return ctx;
}
const scene = (value = '谈话') => ({ sceneClosed: false, changes: [{ module: 'current_scene', key: 'CurrentActivity', value }] });
const relation = () => ({ changes: [
  { module: 'long_term_timeline', id: 'new1', value: '双方因晚归争执', evidence: '发生争执' },
  { module: 'relationship_status', key: 'UserToChar', value: '委屈', ref: 'new1', evidence: '我很委屈。', evidenceFloor: 0 },
] });
afterEach(() => { cancelAnchorReview(); endAnchorBatch(false); discardAnchorInitialization(); vi.unstubAllGlobals(); });
describe('highlight validation, settlement and real source integration', () => {
  it('AUTO scene writes without pending evidence and deleting summary rolls it back', () => {
    const ctx = setup(); receiveAnchors(scene(), [1]);
    expect(anchorEntries()[0].value).toBe('谈话');
    expect(anchors.pending).toHaveLength(0);
    expect(JSON.stringify(ctx.chatMetadata)).not.toContain('evidence');
    deleteLeafAt(1);
    expect(anchorEntries()).toHaveLength(0);
  });
  it('long-term updates default to SUGGEST and cannot accept a dangling reference', () => {
    setup(); receiveAnchors(relation(), [1]);
    expect(anchorEntries()).toHaveLength(0);
    expect(anchors.pending).toHaveLength(2);
    anchors.pending.find(p => p.event.entry.module === 'long_term_timeline')!.selected = false;
    expect(() => settlePending(true)).toThrow('时间线');
    anchors.pending.forEach(p => p.selected = true); settlePending(true);
    expect(anchorEntries()).toHaveLength(2);
    expect(anchorText()).not.toContain('Ref:');
    expect(anchorEntries().find(e => e.key === 'UserToChar')?.ref).toMatch(/^evt_/);
  });
  it('rejects CHAR evidence pretending to be USER input', () => {
    setup(); const raw = relation(); raw.changes[1].evidenceFloor = 1;
    expect(() => parseAnchorProposal(raw, [1])).toThrow('USER');
    expect(anchorEntries()).toHaveLength(0);
  });
  it('historical initialization can use corrected summaries without claiming user-quote validation', () => {
    setup(); const raw = relation(); raw.changes[1].evidence = '摘要中用户委屈';
    expect(parseAnchorProposal(raw, [1], true)).toHaveLength(2);
  });
  it('locked empty state resists AI refill and source removal', () => {
    setup(); receiveAnchors(scene(), [1]);
    const e = { ...anchorEntries()[0], value: null };
    setEntryPolicy(e, 'LOCKED', true);
    receiveAnchors(scene('吃饭'), [1]);
    expect(anchorEntries()[0].value).toBeNull();
    deleteLeafAt(1);
    expect(anchorEntries()[0].value).toBeNull();
  });
  it('closing a scene clears previous progress even when model omits the old fields', () => {
    setup(); receiveAnchors(scene(), [1]);
    receiveAnchors({ sceneClosed: true, changes: [] }, [1]);
    expect(anchorText()).toBe('');
  });
  it('batch exposes no intermediate state and abort discards queued changes', () => {
    setup(); beginAnchorBatch(); receiveAnchors(scene(), [1]);
    expect(anchorEntries()).toHaveLength(0);
    endAnchorBatch(false); expect(anchorEntries()).toHaveLength(0);
    beginAnchorBatch(); receiveAnchors(scene(), [1]); endAnchorBatch(true);
    expect(anchorEntries()[0].value).toBe('谈话');
  });
  it('one invalid anchor block prevents publishing a partial final scene', () => {
    setup(); beginAnchorBatch(); receiveAnchors(scene('中间阶段'), [1]);
    receiveAnchors({ changes: 'invalid' }, [1]); endAnchorBatch(true);
    expect(anchorEntries()).toHaveLength(0); expect(anchors.error).toContain('提案');
  });
  it('cross-floor temporary references resolve to one stable plugin-generated timeline ID', () => {
    const ctx = setup();
    ctx.chat.push({ is_user: true, mes: '继续' }, { is_user: false, mes: '后来', extra: { bbs_leaf: { id: 'leaf3', text: '冷战', v: 1, createdAt: 2, delta: {} } } });
    beginAnchorBatch(); receiveAnchors({ changes: [relation().changes[0]] }, [1]);
    const prompt = anchorPrompt([3]);
    const id = prompt.match(/evt_[a-f0-9-]+/)?.[0]; expect(id).toBeTruthy();
    receiveAnchors({ changes: [{ module: 'relationship_status', key: 'Stage', value: '冷战', ref: 'new1', evidence: '后来双方冷战' }] }, [3]);
    endAnchorBatch(true);
    expect(anchors.error).toBe(''); expect(anchors.pending).toHaveLength(2);
    expect(anchors.pending.find(p => p.event.entry.key === 'Stage')?.event.entry.ref).toBe(id);
    settlePending(true);
    expect(anchorEntries().find(e => e.key === 'Stage')?.ref).toBe(id);
    expect(anchorText()).not.toContain(id!);
  });
  it('review holds generation until accepted or explicitly skipped', async () => {
    setup(); receiveAnchors(relation(), [1]); let returned = false;
    const wait = reviewBeforeGeneration().then(v => { returned = true; return v; });
    await Promise.resolve(); expect(returned).toBe(false);
    settlePending(false); expect(await wait).toBe(true); expect(anchorEntries()).toHaveLength(0);
  });
  it('cancelling review cancels body permission and preserves proposal for later', async () => {
    setup(); receiveAnchors(relation(), [1]); const wait = reviewBeforeGeneration();
    cancelAnchorReview(); expect(await wait).toBe(false); expect(anchors.pending).toHaveLength(2);
  });
  it('omission removes anchor contribution without hiding original or calling API, restore is reversible', async () => {
    const ctx = setup(); receiveAnchors(scene(), [1]);
    ctx.chat[1].is_system = false;
    await setFloorOmit(1, true);
    expect(ctx.chat[1].is_system).toBe(false); expect(anchorEntries()).toHaveLength(0);
    expect(ctx.generateRaw).not.toHaveBeenCalled();
    await setFloorOmit(1, false);
    expect(ctx.chat[1].is_system).toBe(false); expect(anchorEntries()).toHaveLength(1);
  });
  it('batch omission preserves visible and hidden floors and legacy restore never unhides', async () => {
    const ctx = setup();
    ctx.chat[0].is_system = false; ctx.chat[1].is_system = true;
    expect(await setFloorsOmit([0, 1], true)).toBe(2);
    expect(ctx.chat.map(m => m.is_system)).toEqual([false, true]);
    expect(ctx.chat[0].extra.bbs_omit_hidden).toBeUndefined();
    ctx.chat[1].extra.bbs_omit_hidden = true;
    expect(await setFloorsOmit([0, 1], false)).toBe(2);
    expect(ctx.chat.map(m => m.is_system)).toEqual([false, true]);
    expect(ctx.chat[1].extra.bbs_omit_hidden).toBeUndefined();
    ctx.chat[1].extra.bbs_omit = true; ctx.chat[1].extra.bbs_omit_hidden = true;
    await setFloorOmit(1, false);
    expect(ctx.chat[1].is_system).toBe(true);
    expect(ctx.generateRaw).not.toHaveBeenCalled();
  });
  it('hidden sync never forces an omitted floor hidden even when automatic management is on', async () => {
    const ctx = setup();
    await setFloorOmit(1, true);
    ctx.chat[1].is_system = false; // 用户或 hide 插件重新显示该楼。
    ctx.chat[1].extra.bbs_omit_hidden = true; // 兼容旧版本遗留标记。
    apiSettings.autoHideEnabled = true;
    await syncHiddenNow(true);
    expect(ctx.chat[1].is_system).toBe(false);
    expect(ctx.chat[1].extra.bbs_omit).toBe(true);
  });
  it('disabled automatic management preserves even previously BBS-hidden floors during forced sync', async () => {
    const ctx = setup();
    ctx.chat[0].is_system = true; ctx.chat[0].extra = { bbs_hidden: true };
    ctx.chat[1].is_system = false; ctx.chat[1].extra.bbs_omit = true;
    await syncHiddenNow(true);
    expect(ctx.chat.map(m => m.is_system)).toEqual([true, false]);
  });
  it('source edits invalidate pending evidence before it can be accepted', () => {
    const ctx = setup(); receiveAnchors(relation(), [1]);
    ctx.chat[1].extra.bbs_leaf.text = '纠正：未发生争执'; recomputeDerived();
    expect(anchors.pending).toHaveLength(0);
  });
  it('changing USER input invalidates its attitude without deleting unrelated timeline facts', () => {
    const ctx = setup(); receiveAnchors(relation(), [1]); settlePending(true);
    ctx.chat[0].mes = '我没有委屈。'; recomputeDerived();
    expect(anchorEntries().some(e => e.key === 'UserToChar')).toBe(false);
    expect(anchorEntries().some(e => e.module === 'long_term_timeline')).toBe(true);
  });
  it('initialization stages final proposals without saving intermediate scenes', async () => {
    const ctx = setup(); ctx.generateRaw.mockResolvedValue(JSON.stringify({ anchors: scene() }));
    await initializeAnchors(0, 1);
    expect(ctx.generateRaw).toHaveBeenCalledTimes(1);
    expect(anchorEntries()).toHaveLength(0); expect(anchors.pending).toHaveLength(1);
    settlePending(true); expect(anchorEntries()[0].value).toBe('谈话');
  });
  it('initialization sends the covering summary and tracks it as a rollback dependency', async () => {
    const ctx = setup();
    memory.summaries = [{ id: 'comp1', level: 1, childIds: ['leaf1'], text: '高层总结：谈话结束后离开', auto: true, createdAt: 1 }];
    ctx.generateRaw.mockResolvedValue(JSON.stringify({ anchors: scene('离开') }));
    await initializeAnchors(0, 1);
    const request = JSON.stringify(ctx.generateRaw.mock.calls);
    expect(request).toContain('高层总结：谈话结束后离开');
    expect(request).not.toContain('用户明确委屈');
    settlePending(true);
    expect(anchorEntries()[0].value).toBe('离开');
    memory.summaries[0].text = '修正总结：仍在谈话';
    recomputeDerived();
    expect(anchorEntries()).toHaveLength(0);
  });
  it('initialization failure in a later block leaves all live state untouched', async () => {
    const ctx = setup();
    for (let i = 2; i <= 26; i++) ctx.chat.push({ is_user: false, mes: '正文', extra: { bbs_leaf: { id: 'leaf' + i, text: '摘要' + i + '文'.repeat(1000), v: 1, createdAt: i, delta: {} } } });
    ctx.generateRaw.mockResolvedValueOnce(JSON.stringify({ anchors: scene('中间状态') })).mockResolvedValueOnce('bad json');
    await expect(initializeAnchors(0, 26)).rejects.toThrow();
    expect(anchorEntries()).toHaveLength(0); expect(anchors.pending).toHaveLength(0); expect(anchors.running).toBe(false);
    expect(anchorInitialization.done).toBe(1);
    expect(anchorInitialization.error).toContain('2/3');
    expect(anchorInitialization.raw).toBe('bad json');
    ctx.generateRaw.mockResolvedValue(JSON.stringify({ anchors: scene('最终状态') }));
    await initializeAnchors(0, 26);
    expect(ctx.generateRaw).toHaveBeenCalledTimes(4); // 1 successful + 1 failed + only 2 remaining
    expect(anchors.pending.find(p => p.event.entry.key === 'CurrentActivity')?.event.entry.value).toBe('最终状态');
    expect(anchorInitialization.done).toBe(3);
  });
  it('aborted initialization discards a late host response', async () => {
    const ctx = setup(); let finish!: (text: string) => void;
    ctx.generateRaw.mockImplementation(() => new Promise(r => { finish = r; }));
    const ctrl = new AbortController(); const work = initializeAnchors(0, 1, ctrl.signal);
    await vi.waitFor(() => expect(ctx.generateRaw).toHaveBeenCalledTimes(1));
    ctrl.abort(); finish(JSON.stringify({ anchors: scene() }));
    await expect(work).rejects.toThrow();
    expect(anchorEntries()).toHaveLength(0); expect(anchors.pending).toHaveLength(0);
  });
  it('shared stop control cancels a task even without the original page controller', async () => {
    const ctx = setup(); let finish!: (text: string) => void;
    ctx.generateRaw.mockImplementation(() => new Promise(r => { finish = r; }));
    const work = initializeAnchors(0, 1);
    await vi.waitFor(() => expect(ctx.generateRaw).toHaveBeenCalledTimes(1));
    stopAnchorInitialization();
    await expect(work).rejects.toThrow('已停止');
    expect(anchorInitialization.canResume).toBe(true);
    finish(JSON.stringify({ anchors: scene() }));
    expect(anchors.pending).toHaveLength(0);
  });
  it('resume refuses changed sources before spending another API request', async () => {
    const ctx = setup(); ctx.generateRaw.mockResolvedValue('bad json');
    await expect(initializeAnchors(0, 1)).rejects.toThrow();
    ctx.chat[1].extra.bbs_leaf.text = '修订后的摘要';
    await expect(initializeAnchors(0, 1)).rejects.toThrow('来源摘要');
    expect(ctx.generateRaw).toHaveBeenCalledTimes(1);
  });
  it('malformed optional anchor output does not repeat an otherwise successful summary request', async () => {
    const ctx = setup(); delete ctx.chat[1].extra.bbs_leaf;
    ctx.generateRaw.mockResolvedValue(JSON.stringify({ summary: '正确摘要', anchors: { changes: 'bad' } }));
    expect(await handleGenerationIntercept('normal', vi.fn())).toBe(false);
    expect(ctx.generateRaw).toHaveBeenCalledTimes(1);
    expect(ctx.chat[1].extra.bbs_leaf.text).toBe('正确摘要'); expect(anchors.error).toContain('提案');
  });
});
