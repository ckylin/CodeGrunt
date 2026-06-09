import { readdirSync } from 'fs';
import { resolve, dirname, basename, isAbsolute } from 'path';
import { homedir } from 'os';
import type { Skill } from '../skills.js';
import type { DropdownItem } from './types.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__', 'coverage']);

export const SLASH_COMMANDS = [
  { name: '/init',    desc: 'Analyze codebase and generate CODEGRUNT.md' },
  { name: '/model',   desc: 'Switch model' },
  { name: '/config',  desc: 'View or change config (temperature, reasoning, etc.)' },
  { name: '/skills',  desc: 'List and manage skills' },
  { name: '/compact', desc: 'Compress conversation history' },
  { name: '/review',  desc: 'Review session changes for logic issues' },
  { name: '/clear',   desc: 'Clear conversation context' },
  { name: '/balance', desc: 'Show account balance & usage' },
  { name: '/cost',    desc: 'Show session token usage and cost' },
  { name: '/help',    desc: 'Show help' },
];

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
      displayBase = origDir === '.' ? '' : origDir + '/';
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

export function getAutocompleteItems(
  input: string,
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

  if (input.startsWith('@')) {
    const partial = input.slice(1);
    return listFilesSync(partial, cwd)
      .slice(0, 8)
      .map(f => ({ value: '@' + f, label: '@' + f, kind: 'file' as const }));
  }

  return [];
}
