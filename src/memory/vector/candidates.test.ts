import { describe, expect, it, vi } from 'vitest';
import type { VecHit } from '@/api/baibaoku';
import { mergeQueryCandidates, searchQueryCandidates, type QueryPool } from './candidates';

function hit(id: string, score: number, scope = 'self'): VecHit {
  return { leafId: id, similarity: score, scope, queryIndex: 0, document: id, mesFull: null, storyTime: null, msgIndex: 1 };
}
const pool = (queryIndex: number, hits: VecHit[]): QueryPool => ({ queryIndex, hits, status: hits.length ? 'results' : 'empty' });
const merge = (pools: QueryPool[], budget = 20) => mergeQueryCandidates(pools, budget, ['self', 'archive']);

describe('query coverage before reranking', () => {
  it('preserves a rare Q3 top hit that global max Top20 would lose', () => {
    const dominant = Array.from({ length: 20 }, (_, i) => hit('common-' + i, 0.99 - i * 0.005));
    const rare = hit('称呼老公', 0.78);
    const pools = [pool(0, dominant), pool(1, dominant), pool(2, [rare])];
    expect([...dominant, rare].sort((a, b) => b.similarity - a.similarity).slice(0, 20)).not.toContain(rare);
    const r = merge(pools);
    expect(r.results).toHaveLength(20);
    expect(r.candidates.find(c => c.hit.leafId === rare.leafId)).toMatchObject({
      reason: 'reserve', reservedByQueryIndex: 2, matchedQueryIndices: [2], hit: { queryIndex: 2 },
    });
    expect(r.candidates.some(c => c.reason === 'excluded')).toBe(true);
  });
  it('deduplicates reserved hits without topping up exclusive query quotas', () => {
    const shared = [hit('a', 0.99), hit('b', 0.98), hit('c', 0.97)];
    const r = merge([pool(0, [...shared, hit('q0-fourth', 0.3)]), pool(1, [...shared, hit('q1-fourth', 0.8)])], 8);
    expect(r.candidates.filter(c => c.reason === 'reserve')).toHaveLength(3);
    expect(r.candidates.find(c => c.hit.leafId === 'q1-fourth')?.reason).toBe('global');
    expect(new Set(r.results.map(h => h.leafId)).size).toBe(r.results.length);
  });
  it('distinguishes best-score query from reservation query', () => {
    const target = hit('target', 0.8);
    const r = merge([
      pool(0, [hit('a', 0.99), hit('b', 0.98), hit('c', 0.97), target]),
      pool(2, [hit('target', 0.6)]),
    ]);
    expect(r.candidates.find(c => c.hit.leafId === 'target')).toMatchObject({
      hit: { queryIndex: 0, similarity: 0.8 }, reservedByQueryIndex: 2, matchedQueryIndices: [0, 2],
    });
  });
  it('does not allocate quotas to failed or empty queries', () => {
    const r = merge([pool(0, []), { queryIndex: 1, hits: [], status: 'failed' }, pool(2, [hit('x', 0.1)])], 2);
    expect(r.reservePerQuery).toBe(2);
    expect(r.results.map(h => h.leafId)).toEqual(['x']);
    expect(r.pools.map(p => p.status)).toEqual(['empty', 'failed', 'results']);
  });
  it('keeps low similarities eligible and filters invalid/excluded content', () => {
    const r = mergeQueryCandidates([pool(0, [
      hit('low', -0.2), hit('excluded', 1), { ...hit('empty', 1), document: ' ' },
      hit('nan', NaN), hit('out-of-scope', 1, 'other'),
    ])], 20, ['self'], ['excluded']);
    expect(r.results.map(h => h.leafId)).toEqual(['low']);
  });
  it('flags insufficient budget and selects by rounds in original query order', () => {
    const r = merge([pool(2, [hit('c', 0.99)]), pool(0, [hit('a', 0.4)]), pool(1, [hit('b', 0.5)])], 2);
    expect(r.budgetLimited).toBe(true);
    expect(r.results.map(h => h.leafId).sort()).toEqual(['a', 'b']);
  });
  it('preserves cross-scope deduplication and current-scope tie preference', () => {
    const r = merge([pool(0, [hit('x', 0.8, 'archive')]), pool(1, [hit('x', 0.8, 'self')])]);
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toMatchObject({ scope: 'self', queryIndex: 1 });
    expect(r.candidates[0].matchedQueryIndices).toEqual([0, 1]);
  });
  it('produces deterministic ties and descending-score rerank fallback input', () => {
    const a = pool(0, [hit('b', 0.8), hit('a', 0.8), hit('c', 0.9)]);
    const b = pool(1, [hit('d', 0.7)]);
    expect(merge([a, b], 3)).toEqual(merge([b, { ...a, hits: [...a.hits].reverse() }], 3));
    expect(merge([a, b], 3).results.map(h => h.similarity)).toEqual([0.9, 0.8, 0.7]);
  });
});

describe('single-query dispatch', () => {
  it('binds original indices despite reversed completion, uses TopN and bounds concurrency', async () => {
    let running = 0;
    let maximum = 0;
    const search = vi.fn(async (vector: string, topK: number) => {
      running++; maximum = Math.max(maximum, running);
      await new Promise(r => setTimeout(r, vector === 'q0' ? 20 : 1));
      running--;
      expect(topK).toBe(20);
      return { results: [hit(vector, 0.8)] }; // backend reports Q0 on every single-Q call
    });
    const r = await searchQueryCandidates(['q0', 'q1', 'q2', 'q3'], 20, ['self'], [], search);
    expect(maximum).toBe(2);
    expect(search).toHaveBeenCalledTimes(4);
    expect(r.pools.map(p => [p.queryIndex, p.hits[0].queryIndex, p.hits[0].leafId]))
      .toEqual([[0, 0, 'q0'], [1, 1, 'q1'], [2, 2, 'q2'], [3, 3, 'q3']]);
  });
  it('distinguishes empty and failed Qs while keeping healthy results', async () => {
    const r = await searchQueryCandidates(['empty', 'bad', 'ok'], 20, ['self'], [], async vector => {
      if (vector === 'bad') throw new Error('offline');
      return { results: vector === 'empty' ? [] : [hit('x', 0.8)] };
    });
    expect(r.pools.map(p => p.status)).toEqual(['empty', 'failed', 'results']);
    expect(r.results[0].queryIndex).toBe(2);
  });
  it('does not dispatch queries after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const search = vi.fn();
    await expect(searchQueryCandidates(['a', 'b'], 20, ['self'], [], search, controller.signal)).rejects.toBeDefined();
    expect(search).not.toHaveBeenCalled();
  });
  it('handles an empty query list without querying storage', async () => {
    const search = vi.fn();
    const r = await searchQueryCandidates([], 20, ['self'], [], search);
    expect(r.results).toEqual([]);
    expect(r.reservePerQuery).toBe(0);
    expect(search).not.toHaveBeenCalled();
  });
});
