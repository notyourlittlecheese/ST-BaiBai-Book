/** Pure event replay: removing a source never restores an obsolete whole-chat snapshot. */
export const MODULES = ['relationship_status', 'current_scene', 'long_term_timeline', 'relation_facts'] as const;
export type Module = typeof MODULES[number];
export type Control = 'AUTO' | 'SUGGEST' | 'LOCKED';
export const LABELS: Record<Module, string> = { relationship_status: '当前关系', current_scene: '当前场景', long_term_timeline: '长期时间线', relation_facts: '关系事实' };
export const FIELDS: Record<string, string> = {
  Date: '剧情日期', Stage: '关系阶段', UserToChar: 'USER 对 CHAR 的态度', CharToUser: 'CHAR 对 USER 的态度',
  TrustUserToChar: 'USER 对 CHAR 的信任', TrustCharToUser: 'CHAR 对 USER 的信任', Boundary: '互动边界',
  Meeting: '见面情况', Start: '场景开始时间', Progress: '已完成的重要阶段', CurrentActivity: '当前活动', OpenIssue: '未完成事项',
};
export const ENUMS: Record<string, string[]> = {
  Stage: ['未知', '陌生', '试探', '暧昧', '热恋', '稳定', '摩擦', '关系受损', '冷战', '修复中', '破裂', '复合'],
  TrustUserToChar: ['未知', '未建立', '低', '一般', '高', '动摇', '受损', '修复中'],
  TrustCharToUser: ['未知', '未建立', '低', '一般', '高', '动摇', '受损', '修复中'],
  Boundary: ['未知', '未建立', '稳定', '试探中', '出现越界', '受损', '重新协商', '已重建'],
};
export interface Source { id: string; floor: number; text: string; fingerprint?: string }
export function fingerprint(text: string): string {
  let a = 2166136261, b = 5381;
  for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ text.charCodeAt(i); }
  return `${text.length}:${a >>> 0}:${b >>> 0}`;
}
export function sourceRef(s: Source): Source { return { id: s.id, floor: s.floor, text: '', fingerprint: s.fingerprint ?? fingerprint(s.text) }; }
export interface Entry { id: string; module: Module; key: string; value: string | null; date: string; ref?: string }
export interface Event { id: string; entry: Entry; sources: Source[]; manual: boolean; remove?: boolean; order: number; position?: number }
export interface Policy { control: Control; visible: boolean }
export interface Data {
  version: 1; enabled: boolean; display: boolean; updating: boolean; modules: Record<Module, boolean>;
  policies: Record<string, Policy>; events: Event[]; dismissed: string[]; revision: number;
  sequence?: Partial<Record<Module, string[]>>;
}
export interface Proposal { event: Event; evidence: string; selected: boolean; before: string | null; proposed?: string | null; warning?: string }
export function emptyData(): Data {
  return { version: 1, enabled: false, display: true, updating: true, modules: Object.fromEntries(MODULES.map(m => [m, true])) as Record<Module, boolean>, policies: {}, events: [], dismissed: [], revision: 0 };
}
export function policy(data: Data, entry: Entry): Policy {
  return data.policies[entry.id] ?? { control: entry.module === 'current_scene' || entry.key === 'Date' ? 'AUTO' : 'SUGGEST', visible: true };
}
export function validSource(source: Source, sources: Source[]): boolean {
  return sources.some(s => s.id === source.id && (source.fingerprint ? source.fingerprint === fingerprint(s.text) : s.text === source.text));
}
export function replay(data: Data, sources: Source[]): Map<string, Entry> {
  const result = new Map<string, Entry>();
  for (const event of [...data.events].sort((a, b) => (a.position ?? Math.max(-1, ...a.sources.map(s => s.floor))) - (b.position ?? Math.max(-1, ...b.sources.map(s => s.floor))) || a.order - b.order)) {
    if (!event.manual && !event.sources.every(s => validSource(s, sources))) continue;
    if (event.remove) result.delete(event.entry.id);
    else result.set(event.entry.id, { ...event.entry });
  }
  return result;
}
export function render(data: Data, sources: Source[]): Record<Module, string> {
  const entries = [...replay(data, sources).values()];
  const visible = entries.filter(e => e.value && data.modules[e.module] && policy(data, e).visible);
  return Object.fromEntries(MODULES.map(module => {
    const order = data.sequence?.[module] ?? [];
    const rows = visible.filter(e => e.module === module).sort((a,b) => (order.includes(a.id) ? order.indexOf(a.id) : order.length) - (order.includes(b.id) ? order.indexOf(b.id) : order.length)).map(e => {
      // Database identifiers and references remain available to governance/extraction,
      // but add no useful prose context to the body-writing model.
      const heading = module === 'long_term_timeline' || module === 'relation_facts' ? '' : e.key;
      return `[${[heading, e.date, e.value].filter(Boolean).join(' | ')}]`;
    });
    return [module, data.enabled && data.display && rows.length ? `<${module}>\n${rows.join('\n')}\n</${module}>` : ''];
  })) as Record<Module, string>;
}
export function signature(event: Event): string {
  return JSON.stringify([event.sources.map(s => [s.id, s.fingerprint ?? fingerprint(s.text)]), event.entry.module, event.entry.key, event.entry.value, event.entry.date, !!event.remove]);
}
