import { getContext } from '@/st/context';
import { normalizeSummaryPolicy, type SummaryPolicy } from './summaryPolicy';

const KEY = 'bbs_summary_policy';

export function getSummaryPolicy(): SummaryPolicy {
  return normalizeSummaryPolicy(getContext()?.chatMetadata?.[KEY] as Partial<SummaryPolicy> | undefined);
}

export function saveSummaryPolicy(value: SummaryPolicy): void {
  const ctx = getContext();
  if (!ctx?.getCurrentChatId?.()) throw new Error('请先打开聊天');
  ctx.chatMetadata[KEY] = normalizeSummaryPolicy(value);
  ctx.saveMetadataDebounced();
}
