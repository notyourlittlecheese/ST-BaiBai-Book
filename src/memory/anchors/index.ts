import { reactive } from 'vue';
import { getContext } from '@/st/context';
import { getLeaf, leafValid } from '../apply';
import { emptyData, replay, render, policy, validSource, signature, sourceRef, MODULES, FIELDS, ENUMS, type Data, type Entry, type Event, type Module, type Proposal, type Source } from './model';
export * from './model';
const KEY = 'bbs_highlight_anchors_v1';
export const anchors = reactive({ chatId: '', data: emptyData(), pending: [] as Proposal[], error: '', reviewOpen: false, running: false, progress: '' });
let metadata: unknown;
let batch: { chatId: string; items: { proposals: Proposal[]; historical: boolean }[]; draft: Data; error: string; aliases: Record<string, string> } | undefined;
let deferSave = false;
export function beginAnchorBatch(): void {
  syncAnchors();
  const draft: Data = JSON.parse(JSON.stringify(anchors.data));
  draft.events.push(...anchors.pending.map(p => p.event));
  batch = { chatId: anchors.chatId, items: [], draft, error: '', aliases: {} };
}
export function endAnchorBatch(success: boolean): void {
  const current = batch; batch = undefined;
  if (success && current && current.chatId === getContext()?.getCurrentChatId?.() && current.items.length) {
    if (current.error) { anchors.error = current.error; return; }
    if (current.items.some(item => item.proposals.some(p => p.event.sources.some(s => !validSource(s, activeSources()))))) { anchors.error = '批次来源已变化，重点更新未保存'; return; }
    deferSave = true;
    try {
      for (const item of current.items) applyProposals(item.proposals, item.historical);
    } finally { deferSave = false; saveAnchors(); }
    if (anchors.pending.length) anchors.reviewOpen = true;
  }
  if (success && current?.error) anchors.error = current.error;
}
let reviewResolve: ((proceed: boolean) => void) | undefined;
export function cancelAnchorReview(): void { anchors.reviewOpen = false; reviewResolve?.(false); reviewResolve = undefined; }
export async function reviewBeforeGeneration(): Promise<boolean> {
  syncAnchors();
  if (!anchors.data.enabled || !anchors.pending.length) return true;
  if (reviewResolve) return false;
  anchors.reviewOpen = true;
  return new Promise(resolve => { reviewResolve = resolve; });
}
export function sources(): Source[] {
  const chat = getContext()?.chat ?? [];
  return chat.flatMap((m, floor) => {
    const leaf = getLeaf(m);
    return !m.extra?.bbs_omit && leaf && leafValid(m) ? [{ id: leaf.id, floor, text: leaf.text }] : [];
  });
}
export function activeSources(): Source[] {
  return [...sources(), ...(getContext()?.chat ?? []).flatMap((m, floor) => m.is_user && !m.extra?.bbs_omit ? [{ id: `input:${floor}`, floor, text: m.mes }] : [])];
}
export function syncAnchors(): void {
  const ctx = getContext();
  const chatId = ctx?.getCurrentChatId?.() ?? '';
  if (chatId !== anchors.chatId || metadata !== ctx?.chatMetadata) {
    cancelAnchorReview();
    metadata = ctx?.chatMetadata;
    anchors.chatId = chatId;
    const stored = ctx?.chatMetadata?.[KEY] as Data | undefined;
    anchors.data = stored?.version === 1 ? JSON.parse(JSON.stringify(stored)) : emptyData();
    anchors.pending = []; anchors.error = ''; anchors.reviewOpen = false;
  }
  const active = activeSources();
  const valid = anchors.pending.filter(p => p.event.sources.every(s => validSource(s, active)));
  if (valid.length !== anchors.pending.length) anchors.pending = valid;
}
export function saveAnchors(): void {
  if (deferSave) return;
  const ctx = getContext();
  if (!ctx?.chatMetadata || ctx.getCurrentChatId?.() !== anchors.chatId) return;
  anchors.data.revision++;
  ctx.chatMetadata[KEY] = JSON.parse(JSON.stringify(anchors.data));
  ctx.saveMetadataDebounced?.();
}
export function anchorEntries(): Entry[] { syncAnchors(); return [...replay(anchors.data, activeSources()).values()]; }
export function anchorText(): string {
  syncAnchors();
  const text = Object.values(render(anchors.data, activeSources())).filter(Boolean).join('\n\n');
  return text ? `以下为重点提示，只作剧情参考，不要复述格式。USER=${getContext()?.name1 ?? 'USER'}；CHAR=${getContext()?.name2 ?? 'CHAR'}。历史事实不等于当前活动。\n${text}` : '';
}
export function orphanedManual(): Event[] {
  const active = activeSources();
  return anchors.data.events.filter(e => e.manual && e.sources.some(s => !validSource(s, active)));
}
let idSequence = 0;
// Mobile ST is often served over plain HTTP, where randomUUID may not exist.
const uid = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}_${++idSequence}_${Math.random().toString(36).slice(2)}`;
export function manualEntry(entry: Entry, remove = false): void {
  const last = [...anchors.data.events].reverse().find(e => e.entry.id === entry.id);
  anchors.data.events.push({ id: uid(), entry: { ...entry }, sources: last?.sources ?? [], manual: true, remove, order: nextOrder(), position: (getContext()?.chat?.length ?? 0) - 0.5 });
  if (remove && last) anchors.data.dismissed.push(signature(last));
  // A manual edit is an explicit version change; old proposals must be reviewed again.
  anchors.pending = anchors.pending.filter(p => p.event.entry.id !== entry.id);
  saveAnchors();
}
function nextOrder(): number { return Math.max(0, ...anchors.data.events.map(e => e.order)) + 1; }
export function newEntry(module: Module, key = ''): Entry {
  const fixed = module === 'relationship_status' || module === 'current_scene';
  return { id: fixed ? `${module}:${key}` : `${module === 'long_term_timeline' ? 'evt' : 'fact'}_${uid()}`, module, key: fixed ? key : '', value: '', date: '' };
}
export function setEntryPolicy(entry: Entry, control: 'AUTO' | 'SUGGEST' | 'LOCKED', visible: boolean): void {
  const old = policy(anchors.data, entry);
  // Locking preserves the current value even if its source summary is later deleted.
  if (control === 'LOCKED' && old.control !== 'LOCKED') manualEntry(entry);
  anchors.data.policies[entry.id] = { control, visible };
  if (control === 'LOCKED') anchors.pending = anchors.pending.filter(p => p.event.entry.id !== entry.id);
  saveAnchors();
}

export const ANCHOR_RULES = `你同时维护四层重点提示，普通摘要仍必须正常生成。返回 JSON 增加 anchors 对象：
{"sceneClosed":false,"changes":[{"module":"current_scene","key":"CurrentActivity","value":"当前活动","date":"剧情时间","ref":"已有事件ID或本次临时ID","id":"修改时的已有ID；新增长期条目用临时ID","sourceFloors":[实际楼层号],"evidence":"依据原文","evidenceFloor":用户消息实际楼号}]}
只返回真正变化的字段；省略=不更新，value:null=清空。module仅限relationship_status/current_scene/long_term_timeline/relation_facts。
relationship_status字段：Date、Stage、UserToChar、CharToUser、TrustUserToChar、TrustCharToUser、Boundary。
current_scene字段：Meeting、Start、Progress、CurrentActivity、OpenIssue；保留4–6个重要已完成阶段，必要时合并，禁止微动作流水账。
双向态度最多两项，用“ / ”分隔；允许未知、无。信任与边界按提供枚举。USER心理只能依据USER明确输入，原始USER输入优先于已校对历史摘要。禁止根据CHAR判断、旁白、身体反应脑补。难受不等于委屈，更不自动等于越界。无证据沿用原值。初始化仅有摘要时可引用摘要，但不得声称验证了USER原话。
CHAR态度可根据明确心理、台词与稳定选择，禁止把一时反应当长期变化。
场景进行中主要更新current_scene；确凿且不随后续反转的客观事实可提案。收束后再提出长期变化；每场新增0–2条时间线，单条50–100中文字，只记影响未来的重要事实和意义变化。
长期变化必须有evidence，关系状态（Date除外）须ref到已有或本次新增时间线。关系事实不强制ref，不写心理。LOCKED不可修改，SUGGEST只提案，AUTO由插件决定应用。不要请求删除任何条目。
sceneClosed=true时current_scene是收束之后的新场景最终状态，没有新场景则各字段置null，不能留下已结束场景。多楼任务逐楼承接；最终状态对应最后一楼，不是中间态。
sourceFloors仅填写本次提供的实际摘要来源楼号，跨楼事实列出所有必要来源；不能引用番外楼。evidence只用于审核，不是记忆正文。`;

export function anchorPrompt(floors: number[], historical = false, draft?: Data): string {
  syncAnchors();
  if (!anchors.data.enabled || !anchors.data.updating) return '';
  const data: Data = draft ?? JSON.parse(JSON.stringify(batch?.draft ?? anchors.data));
  if (!draft) {
    for (const p of anchors.pending) data.events.push(p.event);
  }
  const before = historical ? activeSources() : activeSources().filter(s => s.floor < Math.min(...floors));
  if (!historical) data.events = data.events.filter(e => (e.position ?? Math.max(-1, ...e.sources.map(s => s.floor))) < Math.min(...floors));
  return '\n\n' + ANCHOR_RULES + '\n当前任务实际来源楼号：' + JSON.stringify(floors)
    + (historical ? '\n本次仅有用户校对摘要，允许以摘要为证据。' : '\n本次USER心理变化必须提供evidenceFloor及该用户楼原文片段。')
    + '\n枚举：' + JSON.stringify(ENUMS) + '\n现有重点记录与权限（其中待审核记录仅供保持提案连贯，不代表已经生效）：' + JSON.stringify([...replay(data, before).values()].map(e => ({ ...e, ...policy(data, e) })));
}

/** Validate independently of summary parsing: malformed optional anchors never repeat a paid summary. */
export function parseAnchorProposal(raw: unknown, floors: number[], historical = false, draft?: Data): Proposal[] {
  const data = draft ?? anchors.data;
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as any).changes)) throw new Error('本次摘要未返回有效重点提案；摘要已保留，可手动补充重点');
  const existing = replay(data, activeSources());
  // Tentative timeline references may be proposed in earlier floors of the same batch.
  if (!draft) for (const p of anchors.pending) if (p.event.entry.module === 'long_term_timeline') existing.set(p.event.entry.id, p.event.entry);
  const changes = [...(raw as any).changes] as any[];
  if ((raw as any).sceneClosed === true) {
    for (const key of ['Meeting', 'Start', 'Progress', 'CurrentActivity', 'OpenIssue']) {
      if (!changes.some(c => c?.module === 'current_scene' && c.key === key)) changes.push({ module: 'current_scene', key, value: null, sourceFloors: floors });
    }
  }
  if (changes.length > 60) throw new Error('重点提案过多，未应用');
  if (!historical && changes.filter(c => c?.module === 'long_term_timeline' && !existing.has(c.id)).length > 2) throw new Error('单次收束最多新增两条长期时间线');
  const ids = new Map<string, string>();
  for (const c of changes) if (c?.module === 'long_term_timeline' && typeof c.id === 'string' && !existing.has(c.id)) ids.set(c.id, `evt_${uid()}`);
  const results: Proposal[] = [];
  for (const c of changes) {
    if (!c || !MODULES.includes(c.module) || (c.value !== null && typeof c.value !== 'string') || c.remove) throw new Error('重点提案字段格式不合法');
    const module = c.module as Module;
    const key = typeof c.key === 'string' ? c.key : '';
    const fixed = module === 'relationship_status' || module === 'current_scene';
    if (!fixed && (typeof c.id !== 'string' || !c.id.trim())) throw new Error('长期条目缺少临时标识');
    if (fixed && !(module === 'current_scene' ? ['Meeting', 'Start', 'Progress', 'CurrentActivity', 'OpenIssue'] : ['Date', 'Stage', 'UserToChar', 'CharToUser', 'TrustUserToChar', 'TrustCharToUser', 'Boundary']).includes(key)) throw new Error('未知重点状态字段');
    if (c.value && ENUMS[key] && !ENUMS[key].includes(c.value)) throw new Error('重点状态不符合枚举：' + key);
    if (typeof c.value === 'string' && c.value.length > 800) throw new Error('重点条目过长');
    const id = fixed ? `${module}:${key}` : existing.has(c.id) ? c.id : ids.get(c.id) ?? `fact_${uid()}`;
    if (results.some(p => p.event.entry.id === id)) throw new Error('同一提案中字段重复');
    if (existing.has(id) && existing.get(id)!.module !== module) throw new Error('提案不能改变条目类型');
    const old = existing.get(id);
    const entry: Entry = { id, module, key, value: c.value, date: typeof c.date === 'string' ? c.date.slice(0, 80) : '', ref: ids.get(c.ref) ?? (existing.get(c.ref)?.module === 'long_term_timeline' ? c.ref : undefined) };
    if (policy(data, entry).control === 'LOCKED') continue;
    if (old && old.value === entry.value && old.ref === entry.ref && old.date === entry.date) continue;
    const requested = Array.isArray(c.sourceFloors) && c.sourceFloors.length ? c.sourceFloors : floors;
    if (requested.some((n: number) => !floors.includes(n))) throw new Error('提案来源超出本次范围');
    const source = sources().filter(s => requested.includes(s.floor));
    if (!source.length || new Set(requested).size !== source.length) throw new Error('提案来源摘要已失效');
    const evidence = typeof c.evidence === 'string' ? c.evidence.trim() : '';
    if (module !== 'current_scene' && key !== 'Date' && !evidence) throw new Error('长期更新缺少审核依据');
    if (!historical && ['UserToChar', 'TrustUserToChar'].includes(key)) {
      const msg = getContext()?.chat?.[c.evidenceFloor];
      const first = Math.min(...floors);
      let start = first;
      const chat = getContext()?.chat ?? [];
      while (start > 0 && chat[start - 1]?.is_user) start--;
      if (!Number.isInteger(c.evidenceFloor) || c.evidenceFloor < start || c.evidenceFloor > Math.max(...floors) || !msg?.is_user || msg.extra?.bbs_omit || !evidence || !msg.mes.includes(evidence)) throw new Error('USER态度更新缺少本次用户原话依据');
      source.push({ id: `input:${c.evidenceFloor}`, floor: c.evidenceFloor, text: msg.mes });
    }
    if (module === 'relationship_status' && key !== 'Date' && entry.value !== null && !entry.ref) throw new Error('长期关系变化缺少时间线引用');
    const event: Event = { id: uid(), entry, sources: source.map(sourceRef), manual: false, order: nextOrder() + results.length };
    if (!data.dismissed.includes(signature(event))) results.push({ event, evidence, before: old?.value ?? null, proposed: entry.value, selected: true });
  }
  return results;
}

export function receiveAnchors(raw: unknown, floors: number[], historical = false): void {
  if (!anchors.data.enabled || !anchors.data.updating) return;
  try {
    const input = batch && raw && typeof raw === 'object' && Array.isArray((raw as any).changes)
      ? { ...raw, changes: (raw as any).changes.map((c: any) => c && ({ ...c, id: batch!.aliases[c.id] ?? c.id, ref: batch!.aliases[c.ref] ?? c.ref })) } : raw;
    const proposals = parseAnchorProposal(input, floors, historical, batch?.draft);
    if (batch) {
      for (const c of (raw as any)?.changes ?? []) if (c?.module === 'long_term_timeline') {
        const p = proposals.find(p => p.event.entry.module === 'long_term_timeline' && p.event.entry.value === c.value);
        if (p) batch.aliases[c.id] = p.event.entry.id;
      }
      batch.items.push({ proposals, historical });
      for (const p of proposals) batch.draft.events.push({ ...p.event, order: batch.draft.events.length + Date.now() });
      return;
    }
    applyProposals(proposals, historical);
    saveAnchors();
    if (anchors.pending.length) anchors.reviewOpen = true;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    if (batch) batch.error = error;
    anchors.error = error;
  }
}
function applyProposals(proposals: Proposal[], historical: boolean): void {
    const applied = new Set(anchorEntries().filter(e => e.module === 'long_term_timeline').map(e => e.id));
    proposals.sort((a, b) => Number(b.event.entry.module === 'long_term_timeline') - Number(a.event.entry.module === 'long_term_timeline'));
    for (const p of proposals) {
      const e = p.event.entry;
      if (!historical && policy(anchors.data, e).control === 'AUTO' && (!e.ref || applied.has(e.ref))) {
        anchors.data.events.push({ ...p.event, order: nextOrder() }); applied.add(e.id);
      } else {
        // Only the latest pending value for a state field survives; old scenes cannot overwrite new scenes.
        p.before = anchorEntries().find(x => x.id === e.id)?.value ?? null;
        anchors.pending = anchors.pending.filter(x => x.event.entry.id !== e.id);
        anchors.pending.push(p);
      }
    }
    anchors.error = '';
}
export function settlePending(accept: boolean): void {
  syncAnchors();
  const chosen = accept ? anchors.pending.filter(p => p.selected) : [];
  const available = new Set(anchorEntries().filter(e => e.module === 'long_term_timeline').map(e => e.id));
  chosen.filter(p => p.event.entry.module === 'long_term_timeline').forEach(p => available.add(p.event.entry.id));
  for (const p of chosen) {
    if (policy(anchors.data, p.event.entry).control === 'LOCKED') throw new Error('条目已锁定，请重新检查提案');
    if (p.event.entry.value !== null && p.event.entry.ref && !available.has(p.event.entry.ref)) throw new Error('请同时采纳引用的时间线，或清空该状态');
    const now = anchorEntries().find(e => e.id === p.event.entry.id)?.value ?? null;
    if (now !== p.before) throw new Error('当前状态已变化，请重新生成提案');
  }
  for (const p of anchors.pending) {
    if (chosen.includes(p)) {
      const edited = p.event.entry.value !== p.proposed;
      anchors.data.events.push({ ...p.event, manual: edited, position: edited ? (getContext()?.chat?.length ?? 0) - 0.5 : undefined, order: nextOrder() });
    }
    else anchors.data.dismissed.push(signature(p.event));
  }
  anchors.data.dismissed = anchors.data.dismissed.slice(-200);
  anchors.pending = []; anchors.reviewOpen = false; saveAnchors();
  reviewResolve?.(true); reviewResolve = undefined;
}
