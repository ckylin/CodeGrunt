import { readdirSync } from 'fs';
import { resolve, dirname, basename, isAbsolute } from 'path';
import { homedir } from 'os';
import type { Skill } from '../skills.js';
import type { DropdownItem } from './types.js';
import { BUILTIN_COMMANDS } from '../commands.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__', 'coverage']);

// Derived from BUILTIN_COMMANDS (the canonical command list in commands.ts)
// rather than a separate hardcoded array — otherwise new slash commands
// registered there (e.g. /branch, /cache) silently never show up in the
// autocomplete dropdown.
export const SLASH_COMMANDS = BUILTIN_COMMANDS.map(c => ({ name: '/' + c.name, desc: c.desc }));

export function listFilesSync(partial: string, cwd: string): string[] {
  try {
    const norm = partial.replace(/\\/g, '/');
    const expanded = norm.startsWith('~')
      ? norm.replace(/^~/, homedir().replace(/\\/g, '/'))
      : norm;

    const endsWithSlash = expanded.endsWith('/');
    const abs = isAbsolute(expanded);
    const hasDir = expanded.includes('/');

    let listDir: string;
    let prefix: string;
    let displayBase: string;

    if (abs) {
      listDir = endsWithSlash ? expanded : (dirname(expanded) || expanded);
      prefix  = endsWithSlash ? '' : basename(expanded);
      const origDir = endsWithSlash ? norm : dirname(norm);
      // Avoid double slash when origDir already ends with '/' (e.g. @/$Recycle.Bin/)
      displayBase = origDir === '.' ? '' : (origDir.endsWith('/') ? origDir : origDir + '/');
    } else if (hasDir) {
      listDir = resolve(cwd, endsWithSlash ? expanded : dirname(expanded));
      prefix  = endsWithSlash ? '' : basename(expanded);
      displayBase = (endsWithSlash ? norm : dirname(norm) + '/');
    } else {
      listDir = cwd;
      prefix  = norm;
      displayBase = '';
    }

    const entries = readdirSync(listDir, { withFileTypes: true });
    return entries
      .filter(e => !SKIP_DIRS.has(e.name) && e.name.startsWith(prefix))
      .slice(0, 12)
      .map(e => displayBase + e.name + (e.isDirectory() ? '/' : ''));
  } catch {
    return [];
  }
}

export interface AtTokenMatch {
  token: string; // e.g. "@src/fo" — includes the leading '@'
  start: number; // index into the input string where the token begins
  end: number;   // index just past the token (next whitespace or end of string)
}

// Finds the whitespace-delimited word containing the cursor and returns it
// if it starts with '@'. Lets '@' file references work anywhere in the
// message (not just at input start), and lets multiple '@' tokens coexist.
export function findAtTokenAtCursor(input: string, cursor: number): AtTokenMatch | null {
  let start = cursor;
  while (start > 0 && !/\s/.test(input[start - 1] ?? '')) start--;
  let end = cursor;
  while (end < input.length && !/\s/.test(input[end] ?? '')) end++;
  const token = input.slice(start, end);
  if (!token.startsWith('@')) return null;
  return { token, start, end };
}

export function getAutocompleteItems(
  input: string,
  cursor: number,
  cwd: string,
  skills: Skill[],
): DropdownItem[] {
  if (input.startsWith('/')) {
    const query = input.toLowerCase();
    const builtins: DropdownItem[] = SLASH_COMMANDS
      .filter(c => c.name.startsWith(query) || c.name.includes(query.slice(1)))
      .slice(0, 8)
      .map(c => ({ value: c.name, label: c.name, desc: c.desc, kind: 'builtin' as const }));

    const skillItems: DropdownItem[] = skills
      .filter(s => ('/' + s.name).startsWith(query))
      .slice(0, Math.max(0, 8 - builtins.length))
      .map(s => ({ value: '/' + s.name, label: '/' + s.name, desc: s.description ?? '', kind: 'skill' as const }));

    return [...builtins, ...skillItems];
  }

  const atMatch = findAtTokenAtCursor(input, cursor);
  if (atMatch) {
    const partial = atMatch.token.slice(1);
    return listFilesSync(partial, cwd)
      .slice(0, 8)
      .map(f => ({ value: '@' + f, label: '@' + f, kind: 'file' as const }));
  }

  return [];
}
