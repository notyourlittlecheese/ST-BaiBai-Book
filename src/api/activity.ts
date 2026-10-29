import { reactive } from 'vue';
import { getContext } from '@/st/context';

export interface ApiActivity {
  id: number;
  chatId: string;
  task: string;
  channel: string;
  model: string;
  responseModel?: string;
  at: number;
  duration: number;
  status: '进行中' | '成功' | '失败' | '已取消';
}

export const apiActivity = reactive<ApiActivity[]>([]);
let sequence = 0;

/** Session-only records intentionally contain no prompts, keys or endpoint URLs. */
export async function traceApi<T>(task: string, channel: string, model: string, run: (record: ApiActivity) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const record = reactive<ApiActivity>({
    id: ++sequence, chatId: getContext()?.getCurrentChatId?.() ?? '',
    task, channel, model, at: Date.now(), duration: 0, status: '进行中',
  });
  apiActivity.unshift(record);
  if (apiActivity.length > 100) apiActivity.splice(100);
  try {
    const result = await run(record);
    record.status = signal?.aborted ? '已取消' : result instanceof Response && !result.ok ? '失败' : '成功';
    return result;
  } catch (error) {
    record.status = signal?.aborted ? '已取消' : '失败';
    throw error;
  } finally {
    record.duration = Date.now() - record.at;
  }
}

export async function mainApiIdentity(): Promise<{ channel: string; model: string }> {
  const ctx = getContext() as ReturnType<typeof getContext> & { mainApi?: string };
  if (ctx?.mainApi === 'openai') {
    try {
      const path = '/scripts/openai.js';
      const mod = await import(/* @vite-ignore */ path);
      const settings = mod.oai_settings ?? {};
      const source = String(settings.chat_completion_source ?? 'openai');
      const model = typeof mod.getChatCompletionModel === 'function' ? mod.getChatCompletionModel() : settings[source + '_model'];
      return { channel: '酒馆主 API · ' + source, model: typeof model === 'string' && model ? model : '酒馆未提供模型名称' };
    } catch { /* Older hosts may not expose the model module. */ }
  }
  return { channel: '酒馆主 API' + (ctx?.mainApi ? ' · ' + ctx.mainApi : ''), model: '酒馆未提供模型名称' };
}
