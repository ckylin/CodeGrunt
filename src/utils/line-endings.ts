// ── CRLF-tolerant exact-string matching ──────────────────────────────────────
// edit_file requires old_string to match file content exactly. On Windows,
// files created by Notepad/Visual Studio/etc. commonly use \r\n line endings,
// but a model reasoning about "the text it read" often reproduces old_string
// with plain \n — it's invisible in almost every rendering of the file content
// the model saw, so there's no signal telling it to preserve \r. That mismatch
// makes an otherwise-correct edit fail with "old_string not found", even
// though the intended edit is unambiguous once line endings are normalized.
//
// This is a matching accommodation only: the file's original CRLF/LF style is
// preserved everywhere outside the matched span — the returned offsets index
// into the ORIGINAL (non-normalized) string, so splicing in the replacement
// never touches surrounding content's line endings.

export interface LineEndingMatch {
  start: number;
  end: number;
  /** The exact original substring that was matched — may differ from the
   *  search needle only in \r placement (CRLF vs LF), never in content. */
  matchedText: string;
}

/** Strips a '\r' that immediately precedes '\n', returning the normalized
 *  string plus a map from each normalized-string index back to its index in
 *  the original string (so match offsets can be translated back). */
function stripCRBeforeLF(s: string): { normalized: string; toOriginalIndex: number[] } {
  let normalized = '';
  const toOriginalIndex: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\r' && s[i + 1] === '\n') continue;
    normalized += s[i];
    toOriginalIndex.push(i);
  }
  return { normalized, toOriginalIndex };
}

/**
 * Finds `needle` in `haystack`, first via an exact match (the common, fast
 * path — also the only path taken when neither string contains '\r'), then
 * falling back to a CRLF/LF-normalized comparison if the exact match fails.
 * Returns 'AMBIGUOUS' if more than one occurrence is found (by whichever
 * method succeeded), or null if no match exists either way.
 */
export function findExactOrLineEndingTolerant(haystack: string, needle: string): LineEndingMatch | 'AMBIGUOUS' | null {
  // Fast path: neither string contains '\r', so normalizing would be a
  // no-op — plain exact matching is correct and cheaper.
  if (!haystack.includes('\r') && !needle.includes('\r')) {
    const first = haystack.indexOf(needle);
    if (first === -1) return null;
    const last = haystack.lastIndexOf(needle);
    if (first !== last) return 'AMBIGUOUS';
    return { start: first, end: first + needle.length, matchedText: needle };
  }

  // A '\r' is present somewhere — always resolve via the normalized view,
  // even if an exact (non-normalized) match happens to exist. Checking exact
  // match first as a shortcut would miss the case where the SAME content
  // appears twice with different line-ending styles (one CRLF, one LF): the
  // exact match would find only the literal-match occurrence and falsely
  // report a unique match, when in fact old_string is ambiguous once CRLF/LF
  // differences are treated as equivalent.
  const { normalized: normHaystack, toOriginalIndex } = stripCRBeforeLF(haystack);
  const { normalized: normNeedle } = stripCRBeforeLF(needle);
  if (normNeedle.length === 0) return null;

  const first = normHaystack.indexOf(normNeedle);
  if (first === -1) return null;
  const last = normHaystack.lastIndexOf(normNeedle);
  if (first !== last) return 'AMBIGUOUS';

  const start = toOriginalIndex[first];
  const end = toOriginalIndex[first + normNeedle.length - 1] + 1;
  return { start, end, matchedText: haystack.slice(start, end) };
}

/**
 * When a replacement was matched via the CRLF-tolerant fallback (matchedText
 * used \r\n but the model's replacement text uses plain \n, or vice versa),
 * rewrite the replacement's line endings to match the matched region's style.
 * Prevents an edit from introducing a mixed-line-ending file.
 */
export function conformLineEndings(replacement: string, matchedText: string): string {
  const matchedHasCRLF = /\r\n/.test(matchedText);
  const replacementHasCRLF = /\r\n/.test(replacement);
  if (matchedHasCRLF && !replacementHasCRLF) {
    return replacement.replace(/\n/g, '\r\n');
  }
  if (!matchedHasCRLF && replacementHasCRLF) {
    return replacement.replace(/\r\n/g, '\n');
  }
  return replacement;
}
