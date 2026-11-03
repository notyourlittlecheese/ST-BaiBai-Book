import { describe, expect, it } from 'vitest';
import { planAnchorHistory, historyPayload } from './history';
import type { MemSummary } from '../types';
const leaves = Array.from({ length: 30 }, (_, floor) => ({ id: `leaf${floor}`, floor, text: '摘'.repeat(200) }));
const summary = (id: string, childIds: string[], level = 1, text = '总结'): MemSummary => ({ id, childIds, level, text, createdAt: 1, auto: true });
describe('text-budget initialization history', () => {
  it('fits thirty short leaves in a single request rather than three fixed-size batches', () => {
    expect(planAnchorHistory(leaves, [], 0, 29)).toHaveLength(1);
  });
  it('prefers the highest complete summary and sends uncovered leaves once', () => {
    const sums = [summary('l1', ['leaf0', 'leaf1']), summary('l2', ['l1', 'leaf2'], 2)];
    const parts = planAnchorHistory(leaves, sums, 0, 4).flat();
    expect(parts.map(p => p.id)).toEqual(['l2', 'leaf3', 'leaf4']);
    expect(parts[0].sources.map(s => s.floor)).toEqual([0, 1, 2]);
  });
  it('splits summaries crossing range boundaries and omits missing/omitted children', () => {
    const sums = [summary('l1', ['leaf0', 'leaf1']), summary('l2', ['l1', 'leaf2'], 2)];
    expect(planAnchorHistory(leaves, sums, 1, 2).flat().map(p => p.id)).toEqual(['leaf1', 'leaf2']);
    expect(planAnchorHistory(leaves.filter(l => l.floor !== 1), sums, 0, 2).flat().map(p => p.id)).toEqual(['leaf0', 'leaf2']);
  });
  it('enforces the serialized history budget and falls back below an oversized summary', () => {
    const blocks = planAnchorHistory(leaves, [summary('huge', ['leaf0', 'leaf1'], 1, '字'.repeat(2000))], 0, 29, 1000);
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.every(b => historyPayload(b).length <= 1000)).toBe(true);
    expect(blocks.flat().some(p => p.id === 'huge')).toBe(false);
    expect(blocks.flat()).toHaveLength(30);
  });
  it('fails before payment if a single leaf cannot fit and survives cyclic summaries', () => {
    expect(() => planAnchorHistory([{ id: 'a', floor: 0, text: '文'.repeat(2000) }], [], 0, 1, 1000)).toThrow('单条文本');
    expect(planAnchorHistory(leaves, [summary('a', ['b']), summary('b', ['a'])], 0, 1).flat()).toHaveLength(2);
  });
});
