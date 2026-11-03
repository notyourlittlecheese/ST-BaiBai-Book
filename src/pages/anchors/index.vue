<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { anchors, syncAnchors, saveAnchors, anchorEntries, anchorText, newEntry, manualEntry, setEntryPolicy, policy, sources, activeSources, orphanedManual, MODULES, LABELS, FIELDS, ENUMS, render, type Entry, type Module, type Control } from '@/memory/anchors';
import { derivedMeta } from '@/memory/store';
import { initializeAnchors, engineState } from '@/memory/engine';
import { refreshInjection } from '@/memory/inject';
syncAnchors();
const error = ref('');
const start = ref(0); const end = ref(Math.max(0, ...sources().map(s => s.floor)));
const edit = ref<Entry | null>(null);
const insertion = ref('__keep');
const linked = ref<Entry | null>(null);
const keep = ref<string[]>([]);
const deleteTarget = ref<Entry | null>(null);
const selectedModule = ref<Module>('long_term_timeline');
const selectedKey = ref('Stage');
const busy = computed(() => engineState.running || anchors.running);
const entries = computed(() => { void derivedMeta.rev; return anchorEntries(); });
const parts = computed(() => { void derivedMeta.rev; return render(anchors.data, activeSources()); });
const orphaned = computed(() => { void derivedMeta.rev; void anchors.data.revision; return orphanedManual(); });
const total = computed(() => { void derivedMeta.rev; return anchorText(); });
const estimate = (s: string) => Math.ceil([...s].reduce((n, c) => n + (/[^\x00-\x7F]/.test(c) ? 1 : 0.25), 0));
const fixedKeys = computed(() => selectedModule.value === 'current_scene' ? ['Meeting', 'Start', 'Progress', 'CurrentActivity', 'OpenIssue'] : ['Date', 'Stage', 'UserToChar', 'CharToUser', 'TrustUserToChar', 'TrustCharToUser', 'Boundary']);
const linkedEntries = computed(() => entries.value.filter(e => e.ref === linked.value?.id));
let controller: AbortController | undefined;
onUnmounted(() => controller?.abort());
watch(() => anchors.chatId, () => { controller?.abort(); edit.value = null; linked.value = null; deleteTarget.value = null; });
watch(selectedModule, () => { selectedKey.value = fixedKeys.value[0]; });
function save() { saveAnchors(); refreshInjection(); }
function setting(e: Entry, control: Control, visible: boolean) { setEntryPolicy(e, control, visible); refreshInjection(); }
function display(e: Entry, checked: boolean) {
  if (!checked && e.module === 'long_term_timeline' && entries.value.some(x => x.ref === e.id)) {
    linked.value = e; keep.value = entries.value.filter(x => x.ref === e.id && policy(anchors.data, x).visible).map(x => x.id); return;
  }
  setting(e, policy(anchors.data, e).control, checked);
}
function applyLinked() {
  if (!linked.value) return;
  for (const e of linkedEntries.value) setting(e, policy(anchors.data, e).control, keep.value.includes(e.id));
  setting(linked.value, policy(anchors.data, linked.value).control, false); linked.value = null;
}
function add() { const e = newEntry(selectedModule.value, selectedKey.value); edit.value = { ...(entries.value.find(x => x.id === e.id) ?? e) }; insertion.value = '__end'; }
function commit() {
  if (!edit.value) return;
  if (edit.value.ref && !entries.value.some(e => e.id === edit.value!.ref && e.module === 'long_term_timeline')) { error.value = '引用的时间线不存在'; return; }
  const e = edit.value;
  manualEntry(e);
  if (e.module === 'long_term_timeline' && insertion.value !== '__keep') {
    const ids = ordered(e.module).map(x => x.id).filter(id => id !== e.id);
    const at = insertion.value === '__start' ? 0 : insertion.value === '__end' ? ids.length : ids.indexOf(insertion.value) + 1;
    ids.splice(at, 0, e.id); anchors.data.sequence = { ...anchors.data.sequence, [e.module]: ids };
  }
  edit.value = null; save();
}
function remove() {
  if (!deleteTarget.value) return;
  const target = deleteTarget.value;
  for (const e of entries.value.filter(x => x.ref === target.id)) manualEntry({ ...e, ref: undefined });
  manualEntry(target, true); deleteTarget.value = null; save();
}
function move(entry: Entry, offset: number) {
  const list = entries.value.filter(e => e.module === entry.module);
  const index = list.findIndex(e => e.id === entry.id), other = list[index + offset];
  if (!other) return;
  // Reorder insertion without changing event replay: explicit order is a display-only setting.
  const ids = list.map(e => e.id); [ids[index], ids[index + offset]] = [ids[index + offset], ids[index]];
  anchors.data.sequence = { ...anchors.data.sequence, [entry.module]: ids }; save();
}
function ordered(module: Module) {
  const order = anchors.data.sequence?.[module] ?? [];
  return entries.value.filter(e => e.module === module).sort((a,b) => (order.includes(a.id) ? order.indexOf(a.id) : order.length) - (order.includes(b.id) ? order.indexOf(b.id) : order.length));
}
async function initialize() {
  error.value = '';
  if (!Number.isInteger(start.value) || !Number.isInteger(end.value) || start.value < 0 || end.value < start.value) { error.value = '请填写有效的起止楼号'; return; }
  controller = new AbortController();
  try { await initializeAnchors(start.value, end.value, controller.signal); }
  catch (e) { error.value = e instanceof Error ? e.message : String(e); }
  finally { controller = undefined; }
}
</script>
<template>
  <section class="anchors-page">
    <h2>重点提示</h2>
    <p>独立于普通摘要和向量召回。勾选＝启用／向正文显示；取消显示不会删除记录。</p>
    <fieldset :disabled="busy">
      <label><input v-model="anchors.data.enabled" type="checkbox" @change="save">启用重点提示</label>
      <label><input v-model="anchors.data.display" type="checkbox" @change="save">向正文发送重点提示</label>
      <label><input v-model="anchors.data.updating" type="checkbox" @change="save">随摘要更新重点提示</label>
      <label v-for="m in MODULES" :key="m"><input v-model="anchors.data.modules[m]" type="checkbox" @change="save">向正文显示{{ LABELS[m] }}</label>
    </fieldset>
    <p>实际准备发送：{{ total.length }} 字符 · 估算 {{ estimate(total) }} tokens（不含酒馆模板，模型分词可能不同）</p>
    <p v-if="error || anchors.error" role="alert">{{ error || anchors.error }}</p>
    <button v-if="anchors.pending.length" type="button" @click="anchors.reviewOpen = true">审核 {{ anchors.pending.length }} 项更新</button>
    <details><summary>从已校对摘要初始化／补充</summary>
      <p>使用摘要副 API 渠道池；每批一次独立请求，会产生费用。全部完成后统一审核，中途停止不写入半成品。证据只保留到本次审核结束，刷新页面后待审核提案不会保留。</p>
      <label>起始楼 <input v-model.number="start" type="number" min="0" :disabled="busy"></label>
      <label>结束楼 <input v-model.number="end" type="number" min="0" :disabled="busy"></label>
      <button type="button" :disabled="busy || !anchors.data.enabled" @click="initialize">调用 API 补充重点</button>
      <button v-if="anchors.running" type="button" @click="controller?.abort()">停止</button><p>{{ anchors.progress }}</p>
    </details>
    <fieldset :disabled="busy"><legend>手动添加／修改字段</legend>
      <select v-model="selectedModule"><option v-for="m in MODULES" :key="m" :value="m">{{ LABELS[m] }}</option></select>
      <select v-if="selectedModule === 'relationship_status' || selectedModule === 'current_scene'" v-model="selectedKey"><option v-for="k in fixedKeys" :key="k" :value="k">{{ FIELDS[k] }}</option></select>
      <button type="button" @click="add">填写</button>
    </fieldset>
    <fieldset v-if="edit" :disabled="busy"><legend>编辑（空值不发送；权限保持不变）</legend>
      <label>剧情日期 <input v-model="edit.date"></label>
      <label v-if="edit.module === 'long_term_timeline'">插入位置 <select v-model="insertion"><option value="__keep">保持当前位置</option><option value="__start">最前</option><option value="__end">最后</option><option v-for="e in ordered('long_term_timeline').filter(x => x.id !== edit?.id)" :key="e.id" :value="e.id">在 {{ e.date }} {{ e.value }} 之后</option></select></label>
      <select v-if="ENUMS[edit.key] && edit.value !== null" v-model="edit.value"><option v-for="v in ENUMS[edit.key]" :key="v">{{ v }}</option></select>
      <textarea v-else-if="edit.value !== null" v-model="edit.value" rows="4" aria-label="重点内容" />
      <p v-else>空值</p>
      <label>来源时间线 <select v-model="edit.ref"><option :value="undefined">未建立引用</option><option v-for="e in entries.filter(x => x.module === 'long_term_timeline')" :key="e.id" :value="e.id">{{ e.date }} {{ e.value }}</option></select></label>
      <button type="button" @click="edit.value = edit.value === null ? '' : null">{{ edit.value === null ? '填写内容' : '清空' }}</button>
      <button type="button" @click="commit">保存</button><button type="button" @click="edit = null">取消</button>
    </fieldset>
    <fieldset v-if="linked" :disabled="busy"><legend>选择仍要向正文显示的关联状态</legend>
      <p>将隐藏：{{ linked.value }}。以下未勾选项也会隐藏，来源仍保留。</p>
      <label v-for="e in linkedEntries" :key="e.id"><input v-model="keep" type="checkbox" :value="e.id">向正文显示 {{ FIELDS[e.key] || e.key }}：{{ e.value }}</label>
      <button type="button" @click="applyLinked">确认显示选择</button><button type="button" @click="linked = null">取消</button>
    </fieldset>
    <fieldset v-if="deleteTarget" :disabled="busy"><legend>删除重点记录？</legend><p>{{ deleteTarget.value }}。普通摘要不变；引用它的状态值保留，引用解除。</p><button type="button" @click="remove">确认删除</button><button type="button" @click="deleteTarget = null">取消</button></fieldset>
    <section v-for="m in MODULES" :key="m">
      <h3>{{ LABELS[m] }} · 估算 {{ estimate(parts[m]) }} tokens</h3>
      <p v-if="!ordered(m).length">暂无记录</p>
      <article v-for="e in ordered(m)" :key="e.id">
        <strong>{{ FIELDS[e.key] || e.id }}</strong><small>{{ e.date }}</small><p>{{ e.value ?? '空（不发送）' }}</p>
        <fieldset :disabled="busy">
          <label><input type="checkbox" :checked="policy(anchors.data, e).visible" @change="display(e, ($event.target as HTMLInputElement).checked)">向正文显示</label>
          <select :value="policy(anchors.data, e).control" aria-label="修改权限" @change="setting(e, ($event.target as HTMLSelectElement).value as Control, policy(anchors.data, e).visible)"><option value="SUGGEST">SUGGEST · 审核后更新</option><option value="AUTO">AUTO · 自动更新</option><option value="LOCKED">LOCKED · 仅手动修改</option></select>
          <button type="button" @click="edit = { ...e }; insertion = '__keep'">编辑／清空</button><button type="button" @click="deleteTarget = e">删除</button>
          <template v-if="m === 'long_term_timeline'"><button type="button" @click="move(e, -1)">上移</button><button type="button" @click="move(e, 1)">下移</button></template>
        </fieldset>
        <details><summary>来源与引用</summary><p>引用：{{ e.ref || '无' }}{{ e.ref && !entries.some(x => x.id === e.ref) ? '（来源已失效）' : '' }}</p><p v-for="s in anchors.data.events.filter(x => x.entry.id === e.id).at(-1)?.sources ?? []" :key="s.id">{{ s.id.startsWith('input:') ? '用户原文' : '摘要' }}来源 #{{ s.floor }} · {{ s.id }}</p></details>
      </article>
    </section>
    <details v-if="orphaned.length"><summary>{{ orphaned.length }} 项手工／锁定记录的来源已变化</summary><p>这些记录未自动撤销。请检查当前内容；不需要时手动删除。</p><p v-for="e in orphaned" :key="e.id">{{ FIELDS[e.entry.key] || e.entry.id }}：{{ e.entry.value }}</p></details>
    <details><summary>本次重点注入预览</summary><pre>{{ total || '未注入' }}</pre></details>
  </section>
</template>
<style scoped>
.anchors-page { padding:16px; } fieldset { border:1px solid var(--bbs-line); border-radius:10px; padding:12px; margin:12px 0; display:flex; flex-wrap:wrap; gap:10px; min-width:0; } label { display:flex; align-items:center; gap:6px; flex-wrap:wrap; } article { border-top:1px solid var(--bbs-line); padding:12px 0; overflow-wrap:anywhere; } p,pre { white-space:pre-wrap; overflow-wrap:anywhere; } textarea { width:100%; box-sizing:border-box; } select,input { max-width:100%; } button { padding:6px 10px; } small { margin-left:8px; } input[type=number] { width:90px; }
button,select,textarea,input:not([type=checkbox]) { background:var(--bbs-surface-2); color:var(--bbs-ink); border:1px solid var(--bbs-line); border-radius:6px; padding:7px; }
</style>
