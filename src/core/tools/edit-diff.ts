import { findExactOrLineEndingTolerant, conformLineEndings, type LineEndingMatch } from '../../utils/line-endings.js';

// Shared by the edit_file tool and the confirm-dialog preview so both agree on
// what counts as a match. Order: exact -> CRLF/LF tolerant -> fuzzy fold.

const BOM_CODE = 0xfeff;

function foldChar(ch: string): string {
  const c = ch.codePointAt(0) ?? 0;
  if (c === 0x2018 || c === 0x2019 || c === 0x201a || c === 0x201b) return "'";
  if (c === 0x201c || c === 0x201d || c === 0x201e || c === 0x201f) return '"';
  if ((c >= 0x2010 && c <= 0x2015) || c === 0x2212) return '-';
  if (c === 0xa0 || (c >= 0x2002 && c <= 0x200a) || c === 0x202f || c === 0x205f || c === 0x3000) return ' ';
  return ch;
}

/**
 * Fold text for fuzzy comparison (1:1 char mapping, plus dropping trailing
 * spaces/tabs and CR-before-LF) and remember each folded char's index in the
 * original, so a match can be translated back to original offsets.
 */
function fold(s: string): { folded: string; toOriginal: number[] } {
  let folded = '';
  const toOriginal: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\r' && s[i + 1] === '\n') continue;
    if (ch === ' ' || ch === '\t') {
      let j = i;
      while (s[j] === ' ' || s[j] === '\t') j++;
      if (j >= s.length || s[j] === '\n' || (s[j] === '\r' && s[j + 1] === '\n')) {
        i = j - 1;
        continue;
      }
    }
    folded += foldChar(ch);
    toOriginal.push(i);
  }
  return { folded, toOriginal };
}

export interface EditMatch extends LineEndingMatch {
  fuzzy: boolean;
}

export function findEditMatch(original: string, oldString: string): EditMatch | 'AMBIGUOUS' | null {
  if (oldString.length === 0) return null;
  const exact = findExactOrLineEndingTolerant(original, oldString);
  if (exact === 'AMBIGUOUS') return 'AMBIGUOUS';
  if (exact) return { ...exact, fuzzy: false };

  const { folded: hay, toOriginal } = fold(original);
  const { folded: needle } = fold(oldString);
  if (needle.length === 0) return null;
  const first = hay.indexOf(needle);
  if (first === -1) return null;
  if (first !== hay.lastIndexOf(needle)) return 'AMBIGUOUS';
  const start = toOriginal[first];
  const end = toOriginal[first + needle.length - 1] + 1;
  return { start, end, matchedText: original.slice(start, end), fuzzy: true };
}

export interface AppliedEdit {
  content: string;
  fuzzy: boolean;
}

/** Applies one replacement. BOM is set aside so the model never has to reproduce it. */
export function applyEditToContent(original: string, oldString: string, newString: string): AppliedEdit | 'AMBIGUOUS' | null {
  const hasBom = original.charCodeAt(0) === BOM_CODE;
  const bom = hasBom ? original[0] : '';
  const text = hasBom ? original.slice(1) : original;
  const match = findEditMatch(text, oldString);
  if (match === null || match === 'AMBIGUOUS') return match;
  const replacement = conformLineEndings(newString, match.matchedText);
  return { content: bom + text.slice(0, match.start) + replacement + text.slice(match.end), fuzzy: match.fuzzy };
}
