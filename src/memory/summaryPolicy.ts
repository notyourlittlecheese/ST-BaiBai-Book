export interface SummaryPolicy {
  mode: 'strict' | 'count' | 'range';
  count: number;
  start: number;
  end: number;
}

export const DEFAULT_SUMMARY_POLICY: SummaryPolicy = { mode: 'strict', count: 8, start: 0, end: 0 };

export function normalizeSummaryPolicy(raw: Partial<SummaryPolicy> | null | undefined): SummaryPolicy {
  const integer = (n: unknown, fallback: number) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : fallback;
  const start = integer(raw?.start, 0);
  return {
    mode: raw?.mode === 'count' || raw?.mode === 'range' ? raw.mode : 'strict',
    count: Math.max(1, integer(raw?.count, 8)),
    start,
    end: Math.max(start, integer(raw?.end, start)),
  };
}

/** Floor indices use ST's zero-based message numbers, including user messages. */
export function planAutomaticSummary(policy: SummaryPolicy, pending: number[], nextFloor: number) {
  const sorted = [...pending].sort((a, b) => a - b);
  if (policy.mode === 'strict') return { due: sorted, deferred: [] as number[] };
  if (policy.mode === 'count') {
    return sorted.length >= policy.count
      ? { due: sorted, deferred: [] as number[] }
      : { due: [] as number[], deferred: sorted };
  }
  const deferred = nextFloor <= policy.end ? sorted.filter(f => f >= policy.start && f <= policy.end) : [];
  const held = new Set(deferred);
  return { due: sorted.filter(f => !held.has(f)), deferred };
}
