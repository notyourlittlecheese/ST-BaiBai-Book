import type { MemSummary } from '../types';
import type { Source } from './model';

export const DEFAULT_HISTORY_CHARS = 12000;
export interface HistoryPart {
  id: string; level: number; text: string; sources: Source[]; summarySource?: Source;
}
export function historyPayload(parts: HistoryPart[]): string {
  return JSON.stringify(parts.map(p => ({ id: p.id, level: p.level, sourceFloors: p.sources.map(s => s.floor), text: p.text })));
}
/** Prefer complete highest summaries, without overlapping leaves, omitted children or out-of-range history. */
export function planAnchorHistory(leaves: Source[], summaries: MemSummary[], start: number, end: number, maxChars = DEFAULT_HISTORY_CHARS): HistoryPart[][] {
  if (!Number.isInteger(maxChars) || maxChars < 1000 || maxChars > 60000) throw new Error('每批历史文本上限须为1000–60000字符');
  const byLeaf = new Map(leaves.map(s => [s.id, s]));
  const bySummary = new Map(summaries.filter(s => !s.imported).map(s => [s.id, s]));
  const descend = (id: string, seen = new Set<string>()): Source[] | null => {
    const leaf = byLeaf.get(id);
    if (leaf) return leaf.floor >= start && leaf.floor <= end ? [leaf] : null;
    const node = bySummary.get(id);
    if (!node?.childIds?.length || seen.has(id)) return null;
    const next = new Set(seen).add(id), result: Source[] = [];
    for (const child of node.childIds) {
      const found = descend(child, next);
      if (!found) return null;
      result.push(...found);
    }
    return [...new Map(result.map(s => [s.id, s])).values()].sort((a,b) => a.floor - b.floor);
  };
  const chosen: HistoryPart[] = [], covered = new Set<string>();
  for (const sum of [...bySummary.values()].sort((a,b) => b.level - a.level || a.id.localeCompare(b.id))) {
    const sources = descend(sum.id);
    if (!sum.text.trim() || !sources?.length || sources.some(s => covered.has(s.id))) continue;
    const part: HistoryPart = { id: sum.id, level: sum.level, text: sum.text, sources, summarySource: { id: `summary:${sum.id}`, floor: Math.max(...sources.map(s => s.floor)), text: sum.text } };
    if (historyPayload([part]).length > maxChars) continue; // Try smaller child summaries/leaves instead.
    chosen.push(part); sources.forEach(s => covered.add(s.id));
  }
  for (const source of leaves) if (source.floor >= start && source.floor <= end && !covered.has(source.id)) {
    chosen.push({ id: source.id, level: 0, text: source.text, sources: [source] });
  }
  chosen.sort((a,b) => a.sources[0].floor - b.sources[0].floor);
  const blocks: HistoryPart[][] = []; let block: HistoryPart[] = [];
  for (const part of chosen) {
    if (historyPayload([part]).length > maxChars) throw new Error(`来源 #${part.sources[0].floor} 单条文本超过每批上限，请提高上限或缩短该摘要`);
    if (block.length && historyPayload([...block, part]).length > maxChars) { blocks.push(block); block = []; }
    block.push(part);
  }
  if (block.length) blocks.push(block);
  return blocks;
}
