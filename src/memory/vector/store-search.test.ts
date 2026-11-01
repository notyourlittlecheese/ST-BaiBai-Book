import { describe, expect, it, vi } from 'vitest';
import type { VecHit } from '@/api/baibaoku';
const backend = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock('@/api/baibaoku', () => ({
  isBaiBaoKuAvailable: async () => true,
  vecSearch: backend.search, vecUpsert: vi.fn(), vecUpdatePayload: vi.fn(),
  vecReconcile: vi.fn(), vecClearScope: vi.fn(), vecStats: vi.fn(),
}));
import { vecSearch } from './store';

describe('shared storage search entry', () => {
  it('sends one existing vector per backend call and preserves scope/exclusion/budget', async () => {
    backend.search.mockImplementation(async (_db: string, _scopes: string[], vectors: string[]) => ({
      results: [{ leafId: vectors[0], scope: 'self', queryIndex: 0, similarity: 0.8,
        document: vectors[0], mesFull: null, storyTime: null, msgIndex: 1 } satisfies VecHit],
    }));
    const result = await vecSearch('db', ['self', 'old'], ['v1', 'v2', 'v3'], { topK: 20, excludeLeafIds: ['hidden'] });
    expect(backend.search).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 3; i++) {
      expect(backend.search).toHaveBeenNthCalledWith(i + 1, 'db', ['self', 'old'], ['v' + (i + 1)], {
        topK: 20, excludeLeafIds: ['hidden'],
      });
    }
    expect(result.results.map(h => h.queryIndex)).toEqual([0, 1, 2]);
    expect(result.pools.map(p => p.status)).toEqual(['results', 'results', 'results']);
  });
});
