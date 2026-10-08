import { homedir } from 'os';
import { isAbsolute, join, resolve } from 'path';

function isUnicodeSpace(code: number): boolean {
  return code === 0xa0 || (code >= 0x2000 && code <= 0x200a) || code === 0x202f || code === 0x205f || code === 0x3000;
}

function normalizeSpaces(s: string): string {
  let out = '';
  for (const ch of s) out += isUnicodeSpace(ch.codePointAt(0) ?? 0) ? ' ' : ch;
  return out;
}

// Models often paste "@src/foo.ts" (the REPL's file-reference syntax) or "~/x"
// straight into tool arguments, and some copy paths with exotic unicode spaces.
export function resolveToCwd(filePath: string, cwd: string = process.cwd()): string {
  let p = normalizeSpaces(filePath);
  if (p.startsWith('@')) p = p.slice(1);
  if (p === '~') p = homedir();
  else if (p.startsWith('~/') || p.startsWith('~\\')) p = join(homedir(), p.slice(2));
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}
