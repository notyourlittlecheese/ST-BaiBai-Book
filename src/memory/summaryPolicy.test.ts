import { describe, expect, it } from 'vitest';
import { normalizeSummaryPolicy, planAutomaticSummary } from './summaryPolicy';
describe('automatic summary policy', () => {
  it('defaults old chats to strict mode', () => {
    expect(planAutomaticSummary(normalizeSummaryPolicy(undefined), [9], 11).due).toEqual([9]);
  });
  it('waits for the configured number of AI messages', () => {
    const p = normalizeSummaryPolicy({ mode: 'count', count: 3 });
    expect(planAutomaticSummary(p, [7, 9], 11).deferred).toEqual([7, 9]);
    expect(planAutomaticSummary(p, [7, 9, 11], 13).due).toEqual([7, 9, 11]);
  });
  it('uses inclusive ST floor numbers, not AI ordinal numbers', () => {
    const p = normalizeSummaryPolicy({ mode: 'range', start: 7, end: 10 });
    expect(planAutomaticSummary(p, [5, 7, 9], 10)).toEqual({ due: [5], deferred: [7, 9] });
    expect(planAutomaticSummary(p, [7, 9], 11)).toEqual({ due: [7, 9], deferred: [] });
    expect(planAutomaticSummary(p, [11], 13).due).toEqual([11]);
  });
  it('normalizes invalid stored values', () => {
    expect(normalizeSummaryPolicy({ mode: 'count', count: NaN }).count).toBe(8);
    expect(normalizeSummaryPolicy({ mode: 'range', start: 7, end: 2 }).end).toBe(7);
  });
});
