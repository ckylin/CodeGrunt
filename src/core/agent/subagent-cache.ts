// ── Sub-agent Result Cache (v0.7) ────────────────────────────────────────────
// Caches sub-agent results by input hash to avoid redundant executions.
// When the same task is submitted again (e.g., repeated file searches during
// concurrent operations), the cached result is returned immediately.
//
// Cache invalidation:
//   - Time-based TTL (default: 5 minutes)
//   - Memory-pressure eviction (max 100 entries)
//   - Manual clear via clearSubagentCache()

import { createHash } from 'crypto';
import { getLogger } from '../observability/logger.js';

const log = getLogger('subagent:cache');

// ── Configuration ───────────────────────────────────────────────────────────

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_ENTRIES = 100;

// ── Cache Entry ─────────────────────────────────────────────────────────────

interface CacheEntry {
  hash: string;
  result: {
    success: boolean;
    output: string;
    toolCallCount: number;
    iterations: number;
    error?: string;
  };
  cachedAt: number;
  expiresAt: number;
  /** Number of times this cache entry has been accessed */
  accessCount: number;
}

// ── Cache Store ─────────────────────────────────────────────────────────────

class SubagentCache {
  private cache = new Map<string, CacheEntry>();

  /**
   * Generate a hash for a sub-agent task + options combination.
   * Includes: task text, model, systemOverride (if present), cwd
   */
  hashKey(task: string, model: string, systemOverride?: string, cwd?: string): string {
    const input = JSON.stringify({ task, model, systemOverride, cwd });
    return createHash('sha256').update(input).digest('hex').slice(0, 16);
  }

  /**
   * Try to get a cached result. Returns null on miss or expiration.
   */
  get(hash: string): CacheEntry['result'] | null {
    const entry = this.cache.get(hash);
    if (!entry) return null;

    // Check TTL
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(hash);
      log.debug('Cache entry expired', { hash });
      return null;
    }

    entry.accessCount++;
    log.debug('Cache hit', { hash, accessCount: entry.accessCount });
    return entry.result;
  }

  /**
   * Store a result in the cache.
   */
  set(hash: string, result: CacheEntry['result']): void {
    // Evict oldest entries if at capacity
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      this.evictOldest();
    }

    this.cache.set(hash, {
      hash,
      result,
      cachedAt: Date.now(),
      expiresAt: Date.now() + DEFAULT_TTL_MS,
      accessCount: 1,
    });

    log.debug('Cache set', { hash });
  }

  /**
   * Check if a hash exists in the cache and is not expired.
   */
  has(hash: string): boolean {
    const entry = this.cache.get(hash);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(hash);
      return false;
    }
    return true;
  }

  /**
   * Clear all cached entries.
   */
  clear(): void {
    const count = this.cache.size;
    this.cache.clear();
    log.info('Cache cleared', { entriesRemoved: count });
  }

  /**
   * Get cache statistics.
   */
  stats(): { size: number; maxSize: number; ttlMs: number } {
    return {
      size: this.cache.size,
      maxSize: MAX_CACHE_ENTRIES,
      ttlMs: DEFAULT_TTL_MS,
    };
  }

  /**
   * Evict the least-recently-accessed entry (by accessCount, then by cachedAt).
   */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestScore = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      const score = entry.accessCount * 1000 + entry.cachedAt;
      if (score < oldestScore) {
        oldestScore = score;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
      log.debug('Evicted oldest cache entry', { key: oldestKey });
    }
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let defaultCache: SubagentCache | null = null;

export function getSubagentCache(): SubagentCache {
  if (!defaultCache) defaultCache = new SubagentCache();
  return defaultCache;
}

export function clearSubagentCache(): void {
  if (defaultCache) defaultCache.clear();
}

export function getSubagentCacheStats(): { size: number; maxSize: number; ttlMs: number } {
  return getSubagentCache().stats();
}
