<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Icon from '@/components/Icon.vue';
import FloorPanel from '@/components/FloorPanel.vue';
import MemoryTree from '@/components/MemoryTree.vue';
import ModalMask from '@/components/ModalMask.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import { memory, derivedMeta } from '@/memory/store';
import { getLeaf, editLeafFull, editSummary, invalidateSummaryAncestors } from '@/memory/apply';
import { engineState } from '@/memory/engine';
import { refreshInjection } from '@/memory/inject';
import { injectionSnapshot } from '@/memory/inspection';
import { apiActivity } from '@/api/activity';
import { getContext } from '@/st/context';
import { toast } from '@/st/toast';

const tab = ref('records');
const query = ref('');
const page = ref(0);
const chatId = computed(() => { void derivedMeta.rev; return getContext()?.getCurrentChatId?.() ?? ''; });
const tabs = [{ id: 'records', label: '来源记录' }, { id: 'state', label: '当前档案' }, { id: 'injection', label: '上次注入' }, { id: 'calls', label: '调用记录' }];
const records = computed(() => {
  void derivedMeta.rev;
  const chat = getContext()?.chat ?? [];
  const leaves = derivedMeta.leaves.map(l => ({
    key: l.id, floor: l.msgIndex, text: l.text, delta: getLeaf(chat[l.msgIndex])?.delta ?? {}, body: chat[l.msgIndex]?.mes ?? '',
    label: '#' + l.msgIndex + (l.omitted ? ' · 不计入记忆' : l.stale ? ' · 已失效' : ''),
    summary: false,
  }));
  const summaries = memory.summaries.map(s => ({
    key: s.id, floor: -1, text: s.text, delta: {}, body: '', label: 'L' + s.level + ' 总结 · ' + s.id, summary: true,
  }));
  const q = query.value.trim().toLowerCase();
  return [...leaves, ...summaries].filter(r => !q || JSON.stringify(r).toLowerCase().includes(q));
});
const shown = computed(() => records.value.slice(page.value * 15, (page.value + 1) * 15));
const current = computed(() => ({
  state: memory.state, protagonist: memory.protagonist, lifeDetails: memory.lifeDetails,
  npcs: memory.npcs, items: memory.items, itemLog: memory.itemLog, plans: memory.plans,
  scenes: memory.scenes, vars: memory.vars, varTemplates: memory.varTemplates,
}));
const calls = computed(() => apiActivity.filter(r => r.chatId === chatId.value));
const snapshot = computed(() => injectionSnapshot.chatId === chatId.value && injectionSnapshot.at ? injectionSnapshot : null);
type Change = { floor: number; id: string; path: (string | number)[]; remove: boolean; value: string; original: string; chatId: string; summary: boolean };
const change = ref<Change | null>(null);
watch([chatId, query, tab], () => { page.value = 0; change.value = null; });
function begin(floor: number, id: string, path: (string | number)[], remove = false, summary = false) {
  if (engineState.running) return toast('请先停止摘要再编辑记录', 'info');
  const source = summary ? memory.summaries.find(s => s.id === id) : getLeaf(getContext()?.chat?.[floor]);
  if (!source) return;
  let value: any = summary ? source.text : (source as ReturnType<typeof getLeaf>)?.delta;
  for (const key of path) value = value?.[key];
  change.value = { floor, id, path, remove, value: typeof value === 'string' ? value : JSON.stringify(value), original: JSON.stringify(source), chatId: chatId.value, summary };
}
function save() {
  const c = change.value;
  if (!c || engineState.running) return;
  const leaf = getLeaf(getContext()?.chat?.[c.floor]);
  const source = c.summary ? memory.summaries.find(s => s.id === c.id) : leaf;
  if (chatId.value !== c.chatId || !source || JSON.stringify(source) !== c.original) {
    change.value = null;
    return toast('来源已变化，请重新打开编辑', 'error');
  }
  try {
    if (c.summary) {
      if (!c.value.trim()) throw new Error('总结内容不能为空');
      editSummary(c.id, c.value);
      for (const parent of memory.summaries.filter(s => s.childIds.includes(c.id))) invalidateSummaryAncestors(parent.id);
    } else if (leaf) {
      const delta = JSON.parse(JSON.stringify(leaf.delta));
      let parent = delta;
      for (const key of c.path.slice(0, -1)) parent = parent[key];
      const key = c.path[c.path.length - 1];
      if (c.remove) {
        if (Array.isArray(parent)) parent.splice(Number(key), 1);
        else delete parent[key];
      } else {
        const previous = parent[key];
        const value = typeof previous === 'string' ? c.value : JSON.parse(c.value);
        if (typeof value !== typeof previous || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('请保持原字段的数据类型');
        parent[key] = value;
      }
      const editsTime = c.path[0] === 'time';
      editLeafFull(c.floor, {
        text: leaf.text, timeStart: editsTime && c.remove ? '' : leaf.timeStart ?? '',
        timeEnd: editsTime ? delta.time ?? '' : leaf.timeEnd ?? '', delta,
      });
      invalidateSummaryAncestors(leaf.id);
    }
    refreshInjection();
    change.value = null;
    toast('已更新来源并重算记忆', 'success');
  } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); }
}
</script>
<template>
  <section class="bbs-page bbs-inspection">
    <h2 class="bbs-title">记忆检查</h2>
    <div class="bbs-inspection-tabs" role="tablist">
      <button v-for="t in tabs" :key="t.id" type="button" role="tab" :aria-selected="tab === t.id" :class="{ active: tab === t.id }" @click="tab = t.id">{{ t.label }}</button>
    </div>
    <template v-if="tab === 'records'">
      <input v-model="query" class="bbs-input" type="search" aria-label="搜索所有来源记录" placeholder="搜索价格、穿搭、楼层…" />
      <p class="bbs-field-hint">{{ records.length }} 条来源记录</p>
      <article v-for="r in shown" :key="r.key" class="bbs-inspection-record">
        <div class="bbs-inspection-row"><strong>{{ r.label }}</strong>
          <button v-if="r.summary" class="bbs-summary-act" title="编辑总结" aria-label="编辑总结" @click="begin(-1, r.key, [], false, true)"><Icon name="edit" /></button>
        </div>
        <p v-if="r.summary" class="bbs-inspection-text">{{ r.text }}</p>
        <template v-else>
          <FloorPanel :floor="r.floor" :sig="{ tick: derivedMeta.rev }" inspect />
          <details><summary>完整状态记录</summary>
            <MemoryTree :value="r.delta" :editable="!engineState.running" @edit="begin(r.floor, r.key, $event)" @remove="begin(r.floor, r.key, $event, true)" />
          </details>
          <details><summary>原楼正文（只读）</summary><pre>{{ r.body }}</pre></details>
        </template>
      </article>
      <div class="bbs-inspection-row">
        <button class="bbs-btn" :disabled="page === 0" @click="page--">上一页</button>
        <span>{{ page + 1 }} / {{ Math.max(1, Math.ceil(records.length / 15)) }}</span>
        <button class="bbs-btn" :disabled="(page + 1) * 15 >= records.length" @click="page++">下一页</button>
      </div>
    </template>
    <MemoryTree v-else-if="tab === 'state'" :value="current" />
    <template v-else-if="tab === 'injection'">
      <p class="bbs-field-hint">柏宝书生成前注入快照，不含其他插件、角色卡和酒馆最终裁剪。仅本次会话保存。</p>
      <template v-if="snapshot">
        <p>{{ new Date(snapshot.at).toLocaleString() }}</p>
        <details v-for="part in (['state', 'history', 'recall', 'timePrompt'] as const)" :key="part" open>
          <summary>{{ { state: '状态', history: '历史摘要', recall: '向量召回', timePrompt: '时间规则' }[part] }}</summary>
          <pre>{{ snapshot[part] || '（未注入）' }}</pre>
        </details>
      </template>
      <p v-else>尚无本聊天的注入快照。</p>
    </template>
    <template v-else>
      <p class="bbs-field-hint">最近 100 次插件请求；模型为请求名称。成功表示收到响应，摘要是否可用仍以解析结果为准。仅本次会话保存。</p>
      <article v-for="call in calls" :key="call.id" class="bbs-inspection-record">
        <strong>{{ call.task }} · {{ call.status }}</strong>
        <div>{{ call.channel }} · {{ call.model }}</div>
        <div v-if="call.responseModel">接口返回模型：{{ call.responseModel }}</div>
        <small>{{ new Date(call.at).toLocaleTimeString() }} · {{ (call.duration / 1000).toFixed(1) }} 秒</small>
      </article>
      <p v-if="!calls.length">尚无调用记录。</p>
    </template>
    <ModalMask :open="!!change && !change.remove" @close="change = null">
      <div v-if="change" class="bbs-modal" role="dialog" aria-modal="true" aria-label="修改来源记录">
        <h3 class="bbs-modal-title">修改来源记录 · {{ change.path.join(' / ') || '总结' }}</h3>
        <textarea v-model="change.value" class="bbs-input" rows="8" aria-label="字段内容"></textarea>
        <div class="bbs-inspection-row"><button class="bbs-btn" @click="change = null">取消</button><button class="bbs-btn" :disabled="engineState.running" @click="save">保存</button></div>
      </div>
    </ModalMask>
    <ConfirmDialog :open="!!change?.remove" title="删除来源记录" confirm-text="删除" @confirm="save" @cancel="change = null">
      删除 {{ change?.path.join(' / ') }}，并使包含此楼的上层总结失效？其他楼层中的同类记录仍会保留。
    </ConfirmDialog>
  </section>
</template>
<style scoped>
.bbs-inspection-tabs { display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid var(--bbs-line); margin-bottom: 14px; }
.bbs-inspection-tabs button { flex: 1; min-width: 64px; padding: 9px 4px; background: transparent; border: 0; color: var(--bbs-ink-soft); cursor: pointer; }
.bbs-inspection-tabs .active { color: var(--bbs-accent); border-bottom: 2px solid var(--bbs-accent); }
.bbs-inspection-record { padding: 14px 0; border-bottom: 1px solid var(--bbs-line); overflow-wrap: anywhere; }
.bbs-inspection-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 10px 0; flex-wrap: wrap; }
.bbs-inspection-text, pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; line-height: 1.6; }
details { margin: 12px 0; min-width: 0; }
summary { cursor: pointer; color: var(--bbs-ink-soft); padding: 6px 0; }
.bbs-modal { max-height: 80dvh; overflow-y: auto; }
</style>
