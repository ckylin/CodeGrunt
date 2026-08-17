import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { findAtTokenAtCursor, getAutocompleteItems, listFilesSync, fuzzyScore } from '../../src/cli/ink/useAutocomplete.js';

describe('findAtTokenAtCursor', () => {
  it('returns null when there is no @ token under the cursor', () => {
    expect(findAtTokenAtCursor('hello world', 5)).toBeNull();
  });

  it('finds an @ token at the start of the input', () => {
    const match = findAtTokenAtCursor('@src/foo.ts', 5);
    expect(match).toEqual({ token: '@src/foo.ts', start: 0, end: 11 });
  });

  it('finds an @ token in the middle of the input (not just at index 0)', () => {
    const input = 'fix the bug in @src/foo.ts please';
    const cursor = input.indexOf('@src') + 3; // cursor inside the token
    const match = findAtTokenAtCursor(input, cursor);
    expect(match?.token).toBe('@src/foo.ts');
  });

  it('supports multiple @ tokens, resolving whichever one the cursor sits in', () => {
    const input = '@a.ts and @b.ts';
    const first = findAtTokenAtCursor(input, 2);
    const second = findAtTokenAtCursor(input, 12);
    expect(first?.token).toBe('@a.ts');
    expect(second?.token).toBe('@b.ts');
  });

  it('does not match a plain word without a leading @', () => {
    const input = 'no at-sign here';
    expect(findAtTokenAtCursor(input, 5)).toBeNull();
  });
});

describe('fuzzyScore', () => {
  it('matches an empty query against anything with score 0', () => {
    expect(fuzzyScore('', 'config')).toBe(0);
  });

  it('returns null when a query character is missing from the target', () => {
    expect(fuzzyScore('xyz', 'config')).toBeNull();
  });

  it('matches scattered characters in order (subsequence match)', () => {
    expect(fuzzyScore('cfg', 'config')).not.toBeNull();
    expect(fuzzyScore('ssn', 'sessions')).not.toBeNull();
  });

  it('rejects a query whose characters are out of order', () => {
    // 'gfc' would need c-f-g reversed — not a valid subsequence of "config".
    expect(fuzzyScore('gfc', 'config')).toBeNull();
  });

  it('ranks a prefix match above a substring match above a scattered match', () => {
    const prefixScore = fuzzyScore('con', 'config');       // prefix
    const substringScore = fuzzyScore('nfi', 'config');    // contiguous substring, not prefix
    const scatteredScore = fuzzyScore('cnf', 'config');    // scattered subsequence
    expect(prefixScore).not.toBeNull();
    expect(substringScore).not.toBeNull();
    expect(scatteredScore).not.toBeNull();
    expect(prefixScore! > substringScore!).toBe(true);
    expect(substringScore! > scatteredScore!).toBe(true);
  });

  it('ranks consecutive scattered matches above equally-scattered non-consecutive ones', () => {
    // "od" is consecutive inside "model" (m-o-d-e-l), "ml" is not.
    const consecutive = fuzzyScore('od', 'model');
    const nonConsecutive = fuzzyScore('ml', 'model');
    expect(consecutive).not.toBeNull();
    expect(nonConsecutive).not.toBeNull();
    expect(consecutive! > nonConsecutive!).toBe(true);
  });
});

describe('getAutocompleteItems', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `codegrunt-autocomplete-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'foo.ts'), '');
    writeFileSync(join(dir, 'bar.ts'), '');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns slash command items when input starts with /', () => {
    const items = getAutocompleteItems('/mod', 4, dir, []);
    expect(items.some(i => i.value === '/model')).toBe(true);
  });

  it('returns file items for an @ token at the start of input', () => {
    const items = getAutocompleteItems('@foo', 4, dir, []);
    expect(items.some(i => i.value === '@foo.ts')).toBe(true);
  });

  it('returns file items for an @ token in the middle of the input (regression: was only start-of-input before)', () => {
    const input = 'please check @foo and summarize';
    const cursor = input.indexOf('@foo') + 4;
    const items = getAutocompleteItems(input, cursor, dir, []);
    expect(items.some(i => i.value === '@foo.ts')).toBe(true);
  });

  it('does not confuse a second @ token later in the input with the first', () => {
    const input = '@foo.ts and @bar';
    const cursor = input.length; // cursor at end, inside "@bar"
    const items = getAutocompleteItems(input, cursor, dir, []);
    expect(items.some(i => i.value === '@bar.ts')).toBe(true);
  });

  it('returns no items when cursor is outside any @ token or slash command', () => {
    const items = getAutocompleteItems('just plain text', 5, dir, []);
    expect(items).toEqual([]);
  });

  it('fuzzy-matches a slash command from non-contiguous characters (regression: prefix-only matching missed this)', () => {
    const items = getAutocompleteItems('/cfg', 4, dir, []);
    expect(items.some(i => i.value === '/config')).toBe(true);
  });

  it('ranks a prefix match ahead of a fuzzy subsequence match for the same query', () => {
    // "/co" is a prefix of "/config" and "/compact" (both start with "co"),
    // and also a scattered subsequence of other commands — prefix hits
    // must still sort first.
    const items = getAutocompleteItems('/co', 3, dir, []);
    const names = items.map(i => i.value);
    expect(names[0]).toMatch(/^\/co/);
  });

  it('includes skills in fuzzy matching alongside builtins', () => {
    const skills = [{ name: 'deploy-checklist', description: 'Pre-deploy checklist' } as import('../../src/cli/skills.js').Skill];
    const items = getAutocompleteItems('/dchk', 5, dir, skills);
    expect(items.some(i => i.value === '/deploy-checklist')).toBe(true);
  });

  it('returns no slash items when the query matches nothing at all', () => {
    const items = getAutocompleteItems('/zzzzqqqq', 9, dir, []);
    expect(items).toEqual([]);
  });

  it('caps slash command results at 8 items', () => {
    const items = getAutocompleteItems('/', 1, dir, []);
    expect(items.length).toBeLessThanOrEqual(8);
  });
});

describe('listFilesSync', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `codegrunt-listfiles-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'alpha.ts'), '');
    writeFileSync(join(dir, 'beta.ts'), '');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists files matching a prefix in cwd', () => {
    const results = listFilesSync('al', dir);
    expect(results).toContain('alpha.ts');
  });

  it('returns empty array for a nonexistent directory', () => {
    const results = listFilesSync('x', join(dir, 'does-not-exist'));
    expect(results).toEqual([]);
  });
});
