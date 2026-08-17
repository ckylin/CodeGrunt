import { describe, it, expect } from 'vitest';
import {
  buildSemanticIndex,
  semanticSearch,
  combinedSearch,
  serializeSemanticIndex,
  deserializeSemanticIndex,
} from '../../src/core/index/embedder.js';
import type { CodeSymbol } from '../../src/core/index/index.js';

function sym(name: string, file: string, kind: CodeSymbol['kind'] = 'function', line = 1): CodeSymbol {
  return { name, kind, file, line };
}

// A small but varied symbol set — enough to exceed the 5-symbol minimum and
// give the vocabulary filter (freq > 1 && freq < 80% of docs) something to
// actually filter on.
const SYMBOLS: CodeSymbol[] = [
  sym('getUserById', 'src/services/user_service.ts'),
  sym('fetchUserProfile', 'src/services/user_service.ts', 'function', 10),
  sym('createUserSession', 'src/services/auth_service.ts'),
  sym('deleteUserAccount', 'src/services/user_service.ts', 'function', 20),
  sym('UserRepository', 'src/repositories/user_repository.ts', 'class'),
  sym('calculateInvoiceTotal', 'src/billing/invoice.ts'),
  sym('formatCurrency', 'src/billing/format.ts'),
  sym('parseConfigFile', 'src/config/loader.ts'),
];

describe('embedder (TF-IDF semantic index)', () => {
  describe('buildSemanticIndex', () => {
    it('returns null when fewer than 5 symbols are provided', () => {
      expect(buildSemanticIndex(SYMBOLS.slice(0, 4))).toBeNull();
    });

    it('builds a non-null index with positive dimensions for >=5 symbols', () => {
      const index = buildSemanticIndex(SYMBOLS);
      expect(index).not.toBeNull();
      expect(index!.dims).toBeGreaterThan(0);
      expect(index!.docCount).toBe(SYMBOLS.length);
      expect(index!.entries).toHaveLength(SYMBOLS.length);
    });

    it('assigns each entry a symbolIndex matching its position in the input array', () => {
      const index = buildSemanticIndex(SYMBOLS)!;
      const indices = index.entries.map(e => e.symbolIndex).sort((a, b) => a - b);
      expect(indices).toEqual(SYMBOLS.map((_, i) => i));
    });

    it('gives every entry a positive L2 norm', () => {
      const index = buildSemanticIndex(SYMBOLS)!;
      for (const entry of index.entries) {
        expect(entry.norm).toBeGreaterThan(0);
      }
    });
  });

  describe('semanticSearch', () => {
    it('ranks symbols sharing subword tokens (camelCase "user") above unrelated symbols', () => {
      const index = buildSemanticIndex(SYMBOLS)!;
      const hits = semanticSearch(index, 'user account', 10);
      expect(hits.length).toBeGreaterThan(0);

      const hitNames = hits.map(h => SYMBOLS[h.symbolIndex].name);
      // The "user"-token symbols should surface; unrelated billing/config
      // symbols should not dominate the top of the ranking.
      const topName = hitNames[0];
      expect(['getUserById', 'fetchUserProfile', 'deleteUserAccount', 'UserRepository', 'createUserSession'])
        .toContain(topName);
    });

    it('respects the maxResults cap', () => {
      const index = buildSemanticIndex(SYMBOLS)!;
      const hits = semanticSearch(index, 'user', 2);
      expect(hits.length).toBeLessThanOrEqual(2);
    });

    it('returns hits sorted by descending similarity score', () => {
      const index = buildSemanticIndex(SYMBOLS)!;
      const hits = semanticSearch(index, 'user profile session', 10);
      for (let i = 1; i < hits.length; i++) {
        expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
      }
    });

    it('returns no hits for a query with zero vocabulary overlap', () => {
      const index = buildSemanticIndex(SYMBOLS)!;
      // Token that shares no subword/n-gram with any indexed symbol.
      const hits = semanticSearch(index, 'zzqxwv', 10);
      expect(hits).toHaveLength(0);
    });

    it('every returned score is a valid cosine similarity in (0, 1]', () => {
      const index = buildSemanticIndex(SYMBOLS)!;
      const hits = semanticSearch(index, 'invoice currency format', 10);
      for (const hit of hits) {
        expect(hit.score).toBeGreaterThan(0);
        expect(hit.score).toBeLessThanOrEqual(1.0001); // float slop
      }
    });
  });

  describe('combinedSearch', () => {
    it('keeps keyword-only hits that have no semantic match', () => {
      const keywordHits = [{ symbol: SYMBOLS[5], score: 100 }]; // calculateInvoiceTotal
      const merged = combinedSearch(keywordHits, [], SYMBOLS, 10);
      expect(merged).toHaveLength(1);
      expect(merged[0].symbol.name).toBe('calculateInvoiceTotal');
    });

    it('boosts a symbol that has both a keyword and a semantic hit above a keyword-only hit', () => {
      const keywordHits = [
        { symbol: SYMBOLS[0], score: 30 },  // getUserById — weaker keyword match
        { symbol: SYMBOLS[5], score: 100 }, // calculateInvoiceTotal — exact keyword match
      ];
      const semanticHits = [{ symbolIndex: 0, score: 0.9 }]; // strong semantic match on getUserById

      const merged = combinedSearch(keywordHits, semanticHits, SYMBOLS, 10);
      const byName = new Map(merged.map(m => [m.symbol.name, m.score]));

      // getUserById's combined score (weak keyword + strong semantic boost)
      // should overtake calculateInvoiceTotal's keyword-only score.
      expect(byName.get('getUserById')!).toBeGreaterThan(byName.get('calculateInvoiceTotal')!);
    });

    it('respects maxResults and sorts descending by combined score', () => {
      const keywordHits = SYMBOLS.map((s, i) => ({ symbol: s, score: 10 + i }));
      const merged = combinedSearch(keywordHits, [], SYMBOLS, 3);
      expect(merged).toHaveLength(3);
      for (let i = 1; i < merged.length; i++) {
        expect(merged[i - 1].score).toBeGreaterThanOrEqual(merged[i].score);
      }
    });

    it('returns an empty array when there are no hits of any kind', () => {
      expect(combinedSearch([], [], SYMBOLS, 10)).toEqual([]);
    });
  });

  describe('serialize / deserialize round-trip', () => {
    it('preserves vocab, idf, entries, dims, and docCount exactly', () => {
      const index = buildSemanticIndex(SYMBOLS)!;
      const serialized = serializeSemanticIndex(index);
      const restored = deserializeSemanticIndex(serialized);

      expect(restored.dims).toBe(index.dims);
      expect(restored.docCount).toBe(index.docCount);
      expect([...restored.vocab.entries()]).toEqual([...index.vocab.entries()]);
      expect(Array.from(restored.idf)).toEqual(Array.from(index.idf));
      expect(restored.entries).toHaveLength(index.entries.length);
      for (let i = 0; i < index.entries.length; i++) {
        expect(restored.entries[i].symbolIndex).toBe(index.entries[i].symbolIndex);
        expect(restored.entries[i].norm).toBeCloseTo(index.entries[i].norm, 5);
        expect(Array.from(restored.entries[i].vector)).toEqual(Array.from(index.entries[i].vector));
      }
    });

    it('produces a JSON-serializable object (round-trips through JSON.stringify/parse)', () => {
      const index = buildSemanticIndex(SYMBOLS)!;
      const serialized = serializeSemanticIndex(index);
      const viaJson = JSON.parse(JSON.stringify(serialized));
      const restored = deserializeSemanticIndex(viaJson);
      expect(restored.dims).toBe(index.dims);
      expect(restored.entries).toHaveLength(index.entries.length);
    });

    it('produces search results identical to the original index after a round-trip', () => {
      const index = buildSemanticIndex(SYMBOLS)!;
      const restored = deserializeSemanticIndex(serializeSemanticIndex(index));

      const before = semanticSearch(index, 'user profile', 10);
      const after = semanticSearch(restored, 'user profile', 10);

      expect(after.map(h => h.symbolIndex)).toEqual(before.map(h => h.symbolIndex));
      for (let i = 0; i < before.length; i++) {
        expect(after[i].score).toBeCloseTo(before[i].score, 5);
      }
    });
  });

  describe('CJK support', () => {
    const CJK_SYMBOLS: CodeSymbol[] = [
      sym('获取用户信息', 'src/用户/服务.ts'),
      sym('创建用户会话', 'src/用户/认证.ts'),
      sym('删除用户账户', 'src/用户/服务.ts', 'function', 5),
      sym('计算发票总额', 'src/账单/发票.ts'),
      sym('格式化货币', 'src/账单/格式.ts'),
      sym('解析配置文件', 'src/配置/加载器.ts'),
    ];

    it('builds a non-null index for symbol names containing only CJK characters', () => {
      const index = buildSemanticIndex(CJK_SYMBOLS);
      expect(index).not.toBeNull();
      expect(index!.dims).toBeGreaterThan(0);
    });

    it('finds CJK symbols sharing a bigram with the query', () => {
      const index = buildSemanticIndex(CJK_SYMBOLS)!;
      const hits = semanticSearch(index, '用户账户', 10);
      expect(hits.length).toBeGreaterThan(0);
      const names = hits.map(h => CJK_SYMBOLS[h.symbolIndex].name);
      expect(names.some(n => n.includes('用户'))).toBe(true);
    });
  });
});
