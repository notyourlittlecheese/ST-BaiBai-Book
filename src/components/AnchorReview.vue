<script setup lang="ts">
import ModalMask from './ModalMask.vue';
import { anchors, settlePending, cancelAnchorReview, FIELDS, LABELS } from '@/memory/anchors';
import { refreshInjection } from '@/memory/inject';
import { ref } from 'vue';
const error = ref('');
function finish(accept: boolean) {
  try { settlePending(accept); error.value = ''; refreshInjection(); }
  catch (e) { error.value = e instanceof Error ? e.message : String(e); }
}
</script>
<template>
  <ModalMask :open="anchors.reviewOpen" @close="cancelAnchorReview">
    <section class="anchor-review" role="dialog" aria-modal="true" aria-label="重点更新审核">
      <h3>重点更新审核</h3>
      <p>勾选表示采纳。未勾选保留原值；选择“清空”才会移除原值。依据仅在本次审核使用。</p>
      <p v-if="error" role="alert">{{ error }}</p>
      <article v-for="p in anchors.pending" :key="p.event.id">
        <label><input v-model="p.selected" type="checkbox">采纳 {{ LABELS[p.event.entry.module] }} · {{ FIELDS[p.event.entry.key] || p.event.entry.id }}</label>
        <p>原值：{{ p.before || '空' }}</p>
        <textarea v-if="p.event.entry.value !== null" v-model="p.event.entry.value" aria-label="更新后的内容" rows="3" />
        <p v-else>新值：空（不发送）</p>
        <button type="button" @click="p.event.entry.value = p.event.entry.value === null ? '' : null">{{ p.event.entry.value === null ? '填写内容' : '清空' }}</button>
        <p v-if="p.event.entry.ref">引用：{{ p.event.entry.ref }}</p>
        <details><summary>依据与来源：{{ p.event.sources.map(s => '#' + s.floor).join('、') }}</summary><p>{{ p.evidence || '当前场景更新' }}</p></details>
      </article>
      <footer>
        <button type="button" @click="finish(true)">确认选中更新并继续</button>
        <button type="button" @click="finish(false)">沿用原状态并继续</button>
        <button type="button" @click="cancelAnchorReview">稍后审核／取消本次生成</button>
      </footer>
    </section>
  </ModalMask>
</template>
<style scoped>
.anchor-review { width:min(680px,94vw); max-height:85dvh; overflow-y:auto; overscroll-behavior:contain; background:var(--bbs-surface); color:var(--bbs-ink); border:1px solid var(--bbs-line); border-radius:16px; padding:20px; box-sizing:border-box; }
article { border-top:1px solid var(--bbs-line); padding:14px 0; overflow-wrap:anywhere; } textarea { width:100%; box-sizing:border-box; background:var(--bbs-surface-2); color:var(--bbs-ink); border:1px solid var(--bbs-line); border-radius:6px; padding:8px; } footer { display:flex; gap:8px; flex-wrap:wrap; } button { padding:8px; background:var(--bbs-surface-2); color:var(--bbs-ink); border:1px solid var(--bbs-line); border-radius:6px; } p { white-space:pre-wrap; }
</style>
