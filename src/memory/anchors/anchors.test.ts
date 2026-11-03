import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/memory/vector', () => ({ scheduleVectorIndex: vi.fn() }));
import { anchors, syncAnchors, receiveAnchors, anchorEntries, settlePending, reviewBeforeGeneration, cancelAnchorReview, parseAnchorProposal, beginAnchorBatch, endAnchorBatch, setEntryPolicy, anchorText, anchorPrompt } from './index';
import { recomputeDerived } from '../store';
import { deleteLeafAt } from '../apply';
import { setFloorOmit, initializeAnchors, handleGenerationIntercept } from '../engine';
import { apiSettings } from '@/api/settings';

function setup() {
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
afterEach(() => { cancelAnchorReview(); endAnchorBatch(false); vi.unstubAllGlobals(); });
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
    expect(anchorText()).toContain('Ref:evt_');
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
    settlePending(true); expect(anchorText()).toContain('Ref:' + id);
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
  it('omission hides original and removes anchor contribution without API calls, restore is reversible', async () => {
    const ctx = setup(); receiveAnchors(scene(), [1]);
    await setFloorOmit(1, true);
    expect(ctx.chat[1].is_system).toBe(true); expect(anchorEntries()).toHaveLength(0);
    expect(ctx.generateRaw).not.toHaveBeenCalled();
    await setFloorOmit(1, false);
    expect(ctx.chat[1].is_system).toBe(false); expect(anchorEntries()).toHaveLength(1);
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
  it('initialization failure in a later block leaves all live state untouched', async () => {
    const ctx = setup();
    for (let i = 2; i <= 26; i++) ctx.chat.push({ is_user: false, mes: '正文', extra: { bbs_leaf: { id: 'leaf' + i, text: '摘要' + i, v: 1, createdAt: i, delta: {} } } });
    ctx.generateRaw.mockResolvedValueOnce(JSON.stringify({ anchors: scene('中间状态') })).mockResolvedValueOnce('bad json');
    await expect(initializeAnchors(0, 26)).rejects.toThrow();
    expect(anchorEntries()).toHaveLength(0); expect(anchors.pending).toHaveLength(0); expect(anchors.running).toBe(false);
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
  it('malformed optional anchor output does not repeat an otherwise successful summary request', async () => {
    const ctx = setup(); delete ctx.chat[1].extra.bbs_leaf;
    ctx.generateRaw.mockResolvedValue(JSON.stringify({ summary: '正确摘要', anchors: { changes: 'bad' } }));
    expect(await handleGenerationIntercept('normal', vi.fn())).toBe(false);
    expect(ctx.generateRaw).toHaveBeenCalledTimes(1);
    expect(ctx.chat[1].extra.bbs_leaf.text).toBe('正确摘要'); expect(anchors.error).toContain('提案');
  });
});
