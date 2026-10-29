<script setup lang="ts">
import { computed } from 'vue';
import Icon from './Icon.vue';
const props = withDefaults(defineProps<{ value: unknown; path?: (string | number)[]; editable?: boolean }>(), { path: () => [], editable: false });
const emit = defineEmits<{ edit: [path: (string | number)[]]; remove: [path: (string | number)[]] }>();
const entries = computed(() => props.value && typeof props.value === 'object' ? Object.entries(props.value) : []);
const childPath = (key: string) => [...props.path, Array.isArray(props.value) ? Number(key) : key];
const labels: Record<string, string> = {
  protagonist: '主角', outfit: '穿搭', condition: '状态', location: '地点', locationPath: '地点路径',
  sceneFocus: '眼下局势', lifeDetails: '生活细节', items: '物品', plans: '计划', scenes: '场景',
  npcs: '人物', varOps: '变量操作', add: '新增', update: '更新', remove: '移除', time: '时间',
  text: '内容', desc: '描述', name: '名字', qty: '数量', appearance: '外貌', identity: '身份',
};
</script>
<template>
  <dl v-if="entries.length" class="bbs-memory-tree">
    <div v-for="[key, child] in entries" :key="key" class="bbs-memory-entry">
      <dt>
        <span>{{ labels[key] ?? key }}</span>
        <button v-if="editable && (path.length === 0 || (Array.isArray(value) && !['plans.add', 'lifeDetails.add'].includes(path.join('.'))))" class="bbs-summary-act" type="button" title="删除这条来源记录" aria-label="删除这条来源记录" @click="emit('remove', childPath(key))"><Icon name="trash" /></button>
        <button v-if="editable && child !== null && typeof child !== 'object' && !['id','op','kind'].includes(key)" class="bbs-summary-act" type="button" title="修改来源字段" aria-label="修改来源字段" @click="emit('edit', childPath(key))"><Icon name="edit" /></button>
      </dt>
      <dd>
        <MemoryTree v-if="child !== null && typeof child === 'object'" :value="child" :path="childPath(key)" :editable="editable" @edit="emit('edit', $event)" @remove="emit('remove', $event)" />
        <span v-else>{{ child === null ? '（清空）' : child }}</span>
      </dd>
    </div>
  </dl>
  <span v-else>{{ JSON.stringify(value) }}</span>
</template>
<style scoped>
.bbs-memory-tree { margin: 0; min-width: 0; }
.bbs-memory-entry { border-top: 1px solid var(--bbs-line); padding: 7px 0; }
dt { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--bbs-ink-muted); overflow-wrap: anywhere; }
dd { margin: 3px 0 0 10px; font-size: 13px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; }
dt .bbs-summary-act { flex: 0 0 28px; width: 28px; height: 28px; opacity: 1; }
</style>
