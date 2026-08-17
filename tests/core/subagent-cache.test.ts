import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { getSubagentCache, clearSubagentCache, getSubagentCacheStats } from '../../src/core/agent/subagent-cache.js';

describe('subagent-cache', () => {
  beforeEach(() => {
    clearSubagentCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearSubagentCache();
  });

  describe('hashKey', () => {
    it('produces the same hash for identical inputs', () => {
      const cache = getSubagentCache();
      const a = cache.hashKey('find the auth code', 'deepseek-v4-flash', undefined, '/repo');
      const b = cache.hashKey('find the auth code', 'deepseek-v4-flash', undefined, '/repo');
      expect(a).toBe(b);
    });

    it('produces different hashes when the task text differs', () => {
      const cache = getSubagentCache();
      const a = cache.hashKey('task A', 'deepseek-v4-flash', undefined, '/repo');
      const b = cache.hashKey('task B', 'deepseek-v4-flash', undefined, '/repo');
      expect(a).not.toBe(b);
    });

    it('produces different hashes when the model differs', () => {
      const cache = getSubagentCache();
      const a = cache.hashKey('same task', 'deepseek-v4-flash', undefined, '/repo');
      const b = cache.hashKey('same task', 'deepseek-v4-pro', undefined, '/repo');
      expect(a).not.toBe(b);
    });

    it('produces different hashes when systemOverride differs', () => {
      const cache = getSubagentCache();
      const a = cache.hashKey('same task', 'deepseek-v4-flash', 'system A', '/repo');
      const b = cache.hashKey('same task', 'deepseek-v4-flash', 'system B', '/repo');
      expect(a).not.toBe(b);
    });

    it('produces different hashes when cwd differs', () => {
      const cache = getSubagentCache();
      const a = cache.hashKey('same task', 'deepseek-v4-flash', undefined, '/repo-a');
      const b = cache.hashKey('same task', 'deepseek-v4-flash', undefined, '/repo-b');
      expect(a).not.toBe(b);
    });
  });

  describe('get/set', () => {
    it('returns null on a cache miss', () => {
      const cache = getSubagentCache();
      expect(cache.get('nonexistent-hash')).toBeNull();
    });

    it('returns the stored result on a cache hit', () => {
      const cache = getSubagentCache();
      const hash = cache.hashKey('task', 'model', undefined, '/cwd');
      const result = { success: true, output: 'the answer', toolCallCount: 2, iterations: 1 };
      cache.set(hash, result);
      expect(cache.get(hash)).toEqual(result);
    });

    it('has() returns true only for a live, unexpired entry', () => {
      const cache = getSubagentCache();
      const hash = cache.hashKey('task', 'model', undefined, '/cwd');
      expect(cache.has(hash)).toBe(false);
      cache.set(hash, { success: true, output: 'x', toolCallCount: 0, iterations: 0 });
      expect(cache.has(hash)).toBe(true);
    });
  });

  describe('TTL expiration', () => {
    it('expires entries after the default TTL (5 minutes)', () => {
      vi.useFakeTimers();
      const cache = getSubagentCache();
      const hash = cache.hashKey('task', 'model', undefined, '/cwd');
      cache.set(hash, { success: true, output: 'fresh', toolCallCount: 0, iterations: 0 });

      // Just under TTL — still cached
      vi.advanceTimersByTime(5 * 60 * 1000 - 1000);
      expect(cache.get(hash)).not.toBeNull();

      // Past TTL — expired
      vi.advanceTimersByTime(2000);
      expect(cache.get(hash)).toBeNull();
      expect(cache.has(hash)).toBe(false);
    });
  });

  describe('eviction at capacity', () => {
    it('evicts an entry once the cache reaches max size (100) so it never grows unbounded', () => {
      const cache = getSubagentCache();
      for (let i = 0; i < 100; i++) {
        cache.set(`hash-${i}`, { success: true, output: `output-${i}`, toolCallCount: 0, iterations: 0 });
      }
      expect(cache.stats().size).toBe(100);

      // Inserting one more should trigger eviction, keeping size at the cap.
      cache.set('hash-100', { success: true, output: 'newest', toolCallCount: 0, iterations: 0 });
      expect(cache.stats().size).toBe(100);
      // The newest entry must survive the eviction pass.
      expect(cache.get('hash-100')).not.toBeNull();
    });

    it('prefers evicting the least-accessed entry over one that has been read repeatedly', () => {
      const cache = getSubagentCache();
      for (let i = 0; i < 100; i++) {
        cache.set(`hash-${i}`, { success: true, output: `output-${i}`, toolCallCount: 0, iterations: 0 });
      }
      // Access hash-0 many times so its accessCount is high, making it the
      // least likely candidate for eviction (evictOldest scores by accessCount first).
      for (let i = 0; i < 10; i++) cache.get('hash-0');

      cache.set('hash-100', { success: true, output: 'newest', toolCallCount: 0, iterations: 0 });
      expect(cache.get('hash-0')).not.toBeNull();
    });
  });

  describe('clear', () => {
    it('removes all entries', () => {
      const cache = getSubagentCache();
      cache.set('a', { success: true, output: '1', toolCallCount: 0, iterations: 0 });
      cache.set('b', { success: true, output: '2', toolCallCount: 0, iterations: 0 });
      expect(cache.stats().size).toBe(2);

      clearSubagentCache();
      expect(cache.stats().size).toBe(0);
      expect(cache.get('a')).toBeNull();
    });
  });

  describe('stats', () => {
    it('reports size, maxSize, and ttlMs', () => {
      const stats = getSubagentCacheStats();
      expect(stats).toEqual({ size: 0, maxSize: 100, ttlMs: 5 * 60 * 1000 });
    });
  });
});
