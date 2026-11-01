import type { VecHit } from '@/api/baibaoku';

export const CANDIDATE_STRATEGY_VERSION = 'per-query-reserve-v1';
export type SelectionReason = 'reserve' | 'global' | 'excluded';
export interface QueryPool {
  queryIndex: number;
  status: 'results' | 'empty' | 'failed';
  hits: VecHit[];
}
export interface CandidateDecision {
  hit: VecHit;
  matchedQueryIndices: number[];
  reason: SelectionReason;
  reservedByQueryIndex?: number;
}
export interface CandidateSelection {
  results: VecHit[];
  pools: QueryPool[];
  candidates: CandidateDecision[];
  reservePerQuery: number;
  budgetLimited: boolean;
}
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const byScore = (a: VecHit, b: VecHit) =>
  b.similarity - a.similarity || compareText(a.leafId, b.leafId) || compareText(a.scope, b.scope) || a.queryIndex - b.queryIndex;
const budgetOf = (n: number) => Number.isSafeInteger(n) && n > 0 ? n : 20;

function preferred(a: VecHit, b: VecHit, scopes: string[]): VecHit {
  if (a.similarity !== b.similarity) return a.similarity > b.similarity ? a : b;
  // Preserve the existing cross-scope identity rule: leafId, current scope wins ties.
  if ((a.scope === scopes[0]) !== (b.scope === scopes[0])) return a.scope === scopes[0] ? a : b;
  return (compareText(a.scope, b.scope) || a.queryIndex - b.queryIndex) <= 0 ? a : b;
}

/** No similarity threshold here: eligibility and final injection are separate stages. */
export function mergeQueryCandidates(input: QueryPool[], topK: number, scopes: string[], excludeLeafIds: string[] = []): CandidateSelection {
  const budget = budgetOf(topK);
  const excluded = new Set(excludeLeafIds);
  const pools = [...input].sort((a, b) => a.queryIndex - b.queryIndex).map(pool => {
    if (pool.status === 'failed') return { ...pool, hits: [] };
    const unique = new Map<string, VecHit>();
    for (const raw of pool.hits) {
      if (!raw || typeof raw.leafId !== 'string' || !raw.leafId || excluded.has(raw.leafId)
        || !scopes.includes(raw.scope) || !Number.isFinite(raw.similarity)
        || !((typeof raw.document === 'string' && raw.document.trim()) || (typeof raw.mesFull === 'string' && raw.mesFull.trim()))) continue;
      const hit = { ...raw, queryIndex: pool.queryIndex };
      const previous = unique.get(hit.leafId);
      unique.set(hit.leafId, previous ? preferred(previous, hit, scopes) : hit);
    }
    const hits = [...unique.values()].sort(byScore).slice(0, budget);
    return { queryIndex: pool.queryIndex, status: hits.length ? 'results' as const : 'empty' as const, hits };
  });
  const active = pools.filter(p => p.hits.length);
  const reservePerQuery = active.length ? Math.min(3, Math.max(1, Math.floor(budget / active.length))) : 0;
  const merged = new Map<string, CandidateDecision>();
  for (const pool of pools) {
    for (const hit of pool.hits) {
      const old = merged.get(hit.leafId);
      if (old) {
        old.hit = preferred(old.hit, hit, scopes);
        old.matchedQueryIndices.push(pool.queryIndex);
      } else {
        merged.set(hit.leafId, { hit, matchedQueryIndices: [pool.queryIndex], reason: 'excluded' });
      }
    }
  }
  let selected = 0;
  for (let round = 0; round < reservePerQuery; round++) {
    for (const pool of active) {
      const hit = pool.hits[round];
      if (!hit || selected >= budget) continue;
      const candidate = merged.get(hit.leafId)!;
      if (candidate.reason !== 'excluded') continue;
      candidate.reason = 'reserve';
      candidate.reservedByQueryIndex = pool.queryIndex;
      selected++;
    }
  }
  const candidates = [...merged.values()].sort((a, b) => byScore(a.hit, b.hit));
  for (const c of candidates) {
    if (selected >= budget) break;
    if (c.reason !== 'excluded') continue;
    c.reason = 'global';
    selected++;
  }
  // Keep descending similarity order for the existing rerank-failure fallback.
  return {
    results: candidates.filter(c => c.reason !== 'excluded').map(c => c.hit),
    pools, candidates, reservePerQuery, budgetLimited: active.length > budget,
  };
}

/** Both storage implementations use the same bounded fan-out and merge. */
export async function searchQueryCandidates(
  vectors: string[], topK: number, scopes: string[], excluded: string[],
  search: (vector: string, topK: number) => Promise<{ results: VecHit[] }>,
  signal?: AbortSignal,
): Promise<CandidateSelection> {
  const pools: QueryPool[] = new Array(vectors.length);
  const budget = budgetOf(topK);
  let next = 0;
  async function worker() {
    while (next < vectors.length) {
      signal?.throwIfAborted();
      const queryIndex = next++;
      try {
        const response = await search(vectors[queryIndex], budget);
        signal?.throwIfAborted();
        if (!Array.isArray(response.results)) throw new Error('Invalid vector search response');
        pools[queryIndex] = { queryIndex, status: 'results', hits: response.results };
      } catch (error) {
        if (signal?.aborted) throw error;
        pools[queryIndex] = { queryIndex, status: 'failed', hits: [] };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, vectors.length) }, () => worker()));
  signal?.throwIfAborted();
  return mergeQueryCandidates(pools, budget, scopes, excluded);
}
