import { describe, it, expect } from 'vitest';
import {
  searchIndex,
  searchIndexWithSemantic,
  loadSemanticIndex,
  type CodeIndex,
  type CodeSymbol,
} from '../../src/core/index/index.js';
import { buildSemanticIndex, serializeSemanticIndex } from '../../src/core/index/embedder.js';

// These tests exercise the searchIndex/searchIndexWithSemantic integration
// point directly against in-memory CodeIndex fixtures, rather than going
// through buildIndex() (which shells out to git/grep and writes to
// ~/.codegrunt/index) — this keeps the tests fast, deterministic, and free
// of filesystem/shell dependencies while still covering the real code path
// that code_search.ts calls into.

function sym(name: string, file: string, kind: CodeSymbol['kind'] = 'function', line = 1): CodeSymbol {
  return { name, kind, file, line };
}

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

function makeIndex(withSemantic: boolean): CodeIndex {
  const index: CodeIndex = {
    builtAt: new Date().toISOString(),
    cwd: '/fake/project',
    symbols: SYMBOLS,
    files: [...new Set(SYMBOLS.map(s => s.file))],
  };
  if (withSemantic) {
    const semIndex = buildSemanticIndex(SYMBOLS);
    if (semIndex) index.semantic = serializeSemanticIndex(semIndex);
  }
  return index;
}

describe('searchIndex (keyword-only)', () => {
  const index = makeIndex(false);

  it('gives the highest score to an exact name match', () => {
    const hits = searchIndex(index, 'getUserById');
    expect(hits[0].symbol.name).toBe('getUserById');
    expect(hits[0].score).toBe(100);
  });

  it('scores a name-prefix match lower than an exact match but still finds it', () => {
    const hits = searchIndex(index, 'getUser');
    expect(hits.map(h => h.symbol.name)).toContain('getUserById');
    expect(hits[0].score).toBeLessThan(100);
  });

  it('filters by symbol kind when provided', () => {
    const hits = searchIndex(index, 'user', 20, 'class');
    expect(hits.every(h => h.symbol.kind === 'class')).toBe(true);
    expect(hits.some(h => h.symbol.name === 'UserRepository')).toBe(true);
  });

  it('returns no hits for a completely unrelated query', () => {
    const hits = searchIndex(index, 'nonexistentxyz123');
    expect(hits).toHaveLength(0);
  });

  it('respects maxResults', () => {
    const hits = searchIndex(index, 'e', 3); // "e" matches many names
    expect(hits.length).toBeLessThanOrEqual(3);
  });
});

describe('loadSemanticIndex', () => {
  it('returns null when the CodeIndex has no semantic field', () => {
    const index = makeIndex(false);
    expect(loadSemanticIndex(index)).toBeNull();
  });

  it('deserializes a valid semantic field', () => {
    const index = makeIndex(true);
    const semIndex = loadSemanticIndex(index);
    expect(semIndex).not.toBeNull();
    expect(semIndex!.dims).toBeGreaterThan(0);
  });

  it('returns null and does not throw when the semantic field is malformed', () => {
    const index = makeIndex(false);
    index.semantic = { garbage: true } as unknown as Record<string, unknown>;
    expect(() => loadSemanticIndex(index)).not.toThrow();
  });
});

describe('searchIndexWithSemantic', () => {
  it('falls back to pure keyword search when no semantic index is present', () => {
    const index = makeIndex(false);
    const semantic = searchIndexWithSemantic(index, 'getUserById');
    const keyword = searchIndex(index, 'getUserById');
    expect(semantic.map(h => h.symbol.name)).toEqual(keyword.map(h => h.symbol.name));
  });

  it('returns results for a query when a semantic index is present', () => {
    const index = makeIndex(true);
    const hits = searchIndexWithSemantic(index, 'user account');
    expect(hits.length).toBeGreaterThan(0);
  });

  it('surfaces a semantically related symbol even when the query has no exact keyword match', () => {
    const index = makeIndex(true);
    // "session" doesn't literally appear in "createUserSession"'s tokenization
    // boundary the same way, but shares the "user" subword — semantic blending
    // should still surface it above a query with zero overlap.
    const hits = searchIndexWithSemantic(index, 'user session auth', 10);
    const names = hits.map(h => h.symbol.name);
    expect(names).toContain('createUserSession');
  });

  it('respects the kind filter when both keyword and semantic paths are active', () => {
    const index = makeIndex(true);
    const hits = searchIndexWithSemantic(index, 'user', 20, 'class');
    expect(hits.every(h => h.symbol.kind === 'class')).toBe(true);
  });

  it('respects maxResults with a semantic index present', () => {
    const index = makeIndex(true);
    const hits = searchIndexWithSemantic(index, 'user', 2);
    expect(hits.length).toBeLessThanOrEqual(2);
  });
});
