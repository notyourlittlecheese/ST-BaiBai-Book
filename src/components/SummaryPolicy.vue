<script setup lang="ts">
import { reactive, watch } from 'vue';
import { getContext } from '@/st/context';
import { getSummaryPolicy, saveSummaryPolicy } from '@/memory/schedule';
import { derivedMeta } from '@/memory/store';
import { engineState } from '@/memory/engine';
import { refreshInjection } from '@/memory/inject';
import { toast } from '@/st/toast';
import Icon from './Icon.vue';

const draft = reactive(getSummaryPolicy());
watch(() => { void derivedMeta.rev; return getContext()?.getCurrentChatId?.(); }, () => Object.assign(draft, getSummaryPolicy()));
function save() {
  if (engineState.running) return;
  if (draft.mode === 'count' && (!Number.isSafeInteger(draft.count) || draft.count < 1)) return toast('请输入正整数条数', 'error');
  if (draft.mode === 'range' && (![draft.start, draft.end].every(n => Number.isSafeInteger(n) && n >= 0) || draft.start > draft.end)) return toast('楼层范围须为非负整数，结束楼层不能小于开始楼层', 'error');
  try {
    saveSummaryPolicy({ ...draft });
    refreshInjection();
    toast('已保存本聊天的摘要模式', 'success');
  } catch (e) { toast(String(e), 'error'); }
}
</script>

<template>
  <fieldset class="bbs-policy" :disabled="engineState.running">
    <legend>本聊天摘要时机</legend>
    <label class="bbs-num-row">
      <span class="bbs-field-label">模式</span>
      <select v-model="draft.mode" class="bbs-input">
        <option value="strict">逐楼 · 摘要成功后生成正文</option>
        <option value="count">批量 · 按 AI 回复条数</option>
        <option value="range">批量 · 按酒馆楼层范围</option>
      </select>
    </label>
    <label v-if="draft.mode === 'count'" class="bbs-num-row">
      <span class="bbs-field-label">累计 AI 回复</span>
      <input v-model.number="draft.count" type="number" min="1" step="1" class="bbs-input bbs-num" />
    </label>
    <div v-if="draft.mode === 'range'" class="bbs-policy-range">
      <label>开始楼层<input v-model.number="draft.start" type="number" min="0" step="1" class="bbs-input" /></label>
      <label>结束楼层（含）<input v-model.number="draft.end" type="number" :min="draft.start" step="1" class="bbs-input" /></label>
    </div>
    <button type="button" class="bbs-btn" title="保存摘要模式" @click="save"><Icon name="check" /> 保存</button>
  </fieldset>
</template>

<style scoped>
.bbs-policy { border: 0; border-bottom: 1px solid var(--bbs-line); margin: 12px 0; padding: 0 0 14px; min-width: 0; }
.bbs-policy legend { color: var(--bbs-ink-soft); font-size: 13px; margin-bottom: 8px; }
.bbs-policy select { min-width: 0; flex: 1; width: 100%; }
.bbs-policy-range { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 10px 0; }
.bbs-policy-range label { min-width: 0; font-size: 12px; }
.bbs-policy .bbs-btn { display: inline-flex; align-items: center; gap: 6px; margin-top: 8px; }
</style>
