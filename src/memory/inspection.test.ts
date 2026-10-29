import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/memory/vector', () => ({ scheduleVectorIndex: vi.fn() }));
import { editLeafFull, editSummary, invalidateSummaryAncestors } from './apply';
import { memory, recomputeDerived } from './store';
import { apiSettings } from '@/api/settings';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('memory source editing', () => {
  it('replays edited clothing and invalidates obsolete ancestors without calling an API', () => {
    vi.useFakeTimers();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const chat = [{ is_user: false, mes: '正文', extra: { bbs_leaf: {
      id: 'leaf', text: '摘要', createdAt: 1, v: 1,
      delta: { location: '图书馆', protagonist: { outfit: '旧穿搭' } },
    } } }];
    const ctx = { chat, chatMetadata: {}, getCurrentChatId: () => 'edit-test', saveChat: vi.fn(), saveMetadataDebounced: vi.fn() };
    vi.stubGlobal('window', { SillyTavern: { getContext: () => ctx } });
    apiSettings.summaryOnlyMode = true;
    memory.summaries = [{ id: 'parent', text: '旧穿搭', level: 1, childIds: ['leaf'], createdAt: 2, auto: true }];
    recomputeDerived();
    expect(memory.protagonist.outfit).toBe('旧穿搭');
    editLeafFull(0, { text: '摘要', timeStart: '', timeEnd: '', delta: { location: '图书馆', protagonist: { outfit: '蓝色外套' } } });
    invalidateSummaryAncestors('leaf');
    expect(memory.protagonist.outfit).toBe('蓝色外套');
    expect(memory.state.location).toBe('图书馆');
    expect(memory.summaries).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
    apiSettings.summaryOnlyMode = false;
  });

  it('editing a summary preserves itself while removing its outdated parent', () => {
    vi.stubGlobal('window', { SillyTavern: { getContext: () => ({ chatMetadata: {}, saveMetadataDebounced() {} }) } });
    memory.summaries = [
      { id: 'one', text: '12块', level: 1, childIds: [], createdAt: 1, auto: true },
      { id: 'two', text: '12块', level: 2, childIds: ['one'], createdAt: 2, auto: true },
    ];
    editSummary('one', '价格未记录');
    for (const parent of memory.summaries.filter(s => s.childIds.includes('one'))) invalidateSummaryAncestors(parent.id);
    expect(memory.summaries.map(s => s.id)).toEqual(['one']);
    expect(memory.summaries[0].text).toBe('价格未记录');
  });
});
