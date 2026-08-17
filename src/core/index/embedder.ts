// ── Semantic Vector Embedder ──────────────────────────────────────────────
// Lightweight local embedding for code symbols using TF-IDF vectors.
// No external API dependencies — runs entirely offline.
//
// Strategy:
//   1. Build a vocabulary from all symbol names and file paths in the index
//   2. Compute TF-IDF vectors for each symbol (name + file context)
//   3. At search time, compute cosine similarity between query vector and
//      symbol vectors, then merge with keyword match scores.
//
// This gives "semantic-like" fuzzy matching: `getUserById` will also match
// `fetchUser`, `UserService`, etc. based on shared subword tokens.

import type { CodeSymbol } from './index.js';

// ── Types ─────────────────────────────────────────────────────────────────

export interface VectorEntry {
  symbolIndex: number;   // index into the symbols array
  vector: Float32Array;  // TF-IDF vector
  norm: number;          // precomputed L2 norm for fast cosine similarity
}

export interface SemanticIndex {
  /** Vocabulary: token → dimension index */
  vocab: Map<string, number>;
  /** IDF values: dimension index → idf score */
  idf: Float32Array;
  /** Vector entries for each symbol */
  entries: VectorEntry[];
  /** Number of dimensions */
  dims: number;
  /** Total number of documents (symbols) */
  docCount: number;
}

// ── Tokenizer ─────────────────────────────────────────────────────────────

function isCJK(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (code >= 0x4e00 && code <= 0x9fff)   // CJK Unified Ideographs
    || (code >= 0x3400 && code <= 0x4dbf)     // CJK Extension A
    || (code >= 0xf900 && code <= 0xfaff);    // CJK Compatibility Ideographs
}

/**
 * Split a symbol name, file path, or natural-language query into subword
 * tokens. Handles: camelCase, PascalCase, snake_case, kebab-case, path
 * segments, and CJK text (character bigrams, since Chinese has no
 * whitespace/case delimiters to split on).
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];

  // Split on non-word boundaries using Unicode letter/number classes, not
  // [a-zA-Z0-9] — the ASCII-only version silently dropped every CJK
  // character, so any Chinese query tokenized to an empty array and scored
  // zero similarity against everything.
  const rawSegments = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const segments = rawSegments.map(s => s.toLowerCase());

  for (let i = 0; i < rawSegments.length; i++) {
    const rawSegment = rawSegments[i];
    const segment = segments[i];
    if (segment.length === 0) continue;

    // Add the full segment
    tokens.push(segment);

    // Split camelCase/PascalCase into sub-tokens. Must run on the
    // ORIGINAL-case segment — a pre-lowercased string has no uppercase
    // boundaries left, so splitting on /(?=[A-Z])/ never matched anything.
    const subTokens = rawSegment.split(/(?=[A-Z])/).filter(Boolean);
    for (const st of subTokens) {
      const lower = st.toLowerCase();
      if (lower !== segment && lower.length >= 2) {
        tokens.push(lower);
      }
    }

    // CJK text has no case/delimiter structure to split on — Chinese words
    // are typically 2 characters, so character bigrams approximate
    // word-level tokens for this lightweight offline tokenizer.
    if ([...segment].some(isCJK)) {
      const chars = [...segment];
      for (let c = 0; c < chars.length - 1; c++) {
        tokens.push(chars[c] + chars[c + 1]);
      }
    }

    // Add a bigram with the next segment for fuzzy matching
    // (e.g., "get_user_by_id" → "get_user", "user_by", "by_id")
    if (i < segments.length - 1) {
      tokens.push(`${segment}_${segments[i + 1]}`);
    }
  }

  // Add character n-grams from the full lowercased text for partial
  // matching. Unicode-aware clean-up keeps CJK characters — the old
  // [^a-z0-9] filter stripped them, zeroing out this block for Chinese text.
  const clean = text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const cleanChars = [...clean];
  const hasCJK = cleanChars.some(isCJK);
  // Chinese words average ~2 characters — trigrams would miss most of them.
  const nGramLen = hasCJK ? 2 : 3;
  for (let g = 0; g <= cleanChars.length - nGramLen; g++) {
    tokens.push(cleanChars.slice(g, g + nGramLen).join(''));
  }

  return [...new Set(tokens)]; // deduplicate
}

/**
 * Tokenize a symbol for TF-IDF: combine name tokens + file path tokens
 * with name tokens weighted higher (repeated in the token list).
 */
function tokenizeSymbol(symbol: CodeSymbol): string[] {
  const nameTokens = tokenize(symbol.name);
  const fileTokens = tokenize(symbol.file);

  // Name tokens are more important — include them twice
  return [...nameTokens, ...nameTokens, ...fileTokens];
}

/**
 * Tokenize a search query.
 */
function tokenizeQuery(query: string): string[] {
  return tokenize(query);
}

// ── TF-IDF Builder ────────────────────────────────────────────────────────

/**
 * Build a semantic (TF-IDF) index from an array of code symbols.
 * Returns null if there are too few symbols to build a meaningful index.
 */
export function buildSemanticIndex(symbols: CodeSymbol[]): SemanticIndex | null {
  if (symbols.length < 5) return null;

  // ── Pass 1: build vocabulary and count document frequencies ──────────
  const docFreq = new Map<string, number>(); // token → number of docs containing it
  const docTokens: string[][] = [];

  for (const symbol of symbols) {
    const tokens = tokenizeSymbol(symbol);
    const uniqueTokens = [...new Set(tokens)];
    docTokens.push(uniqueTokens);

    for (const token of uniqueTokens) {
      docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
    }
  }

  const docCount = symbols.length;

  // ── Filter vocabulary: keep only tokens that appear in >1 doc and <80% of docs ──
  const vocabEntries = [...docFreq.entries()]
    .filter(([, freq]) => freq > 1 && freq < docCount * 0.8)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2000); // cap at 2000 dimensions for performance

  const vocab = new Map<string, number>();
  const idfValues: number[] = [];
  for (const [token, freq] of vocabEntries) {
    vocab.set(token, vocab.size);
    idfValues.push(Math.log((docCount + 1) / (freq + 1)) + 1); // smoothed IDF
  }

  const dims = vocab.size;
  if (dims === 0) return null;

  const idf = new Float32Array(idfValues);

  // ── Pass 2: compute TF-IDF vectors ───────────────────────────────────
  const entries: VectorEntry[] = [];
  for (let i = 0; i < symbols.length; i++) {
    const tokens = docTokens[i];
    const tf = new Map<string, number>();
    for (const t of tokens) {
      tf.set(t, (tf.get(t) ?? 0) + 1);
    }

    const vec = new Float32Array(dims);
    let sumSq = 0;
    for (const [token, termFreq] of tf) {
      const dim = vocab.get(token);
      if (dim === undefined) continue;
      const tfidf = (1 + Math.log(termFreq)) * idf[dim]; // sublinear TF scaling
      vec[dim] = tfidf;
      sumSq += tfidf * tfidf;
    }

    const norm = Math.sqrt(sumSq) || 1;
    entries.push({ symbolIndex: i, vector: vec, norm });
  }

  return { vocab, idf, entries, dims, docCount };
}

// ── Cosine Similarity Search ──────────────────────────────────────────────

export interface SemanticHit {
  symbolIndex: number;
  score: number; // cosine similarity (0-1)
}

/**
 * Search the semantic index with cosine similarity.
 * Returns top-K results sorted by similarity score descending.
 */
export function semanticSearch(
  index: SemanticIndex,
  query: string,
  maxResults: number = 20,
): SemanticHit[] {
  const queryTokens = tokenizeQuery(query);
  const uniqueTokens = [...new Set(queryTokens)];

  // Build query TF vector
  const queryTf = new Map<string, number>();
  for (const t of queryTokens) {
    queryTf.set(t, (queryTf.get(t) ?? 0) + 1);
  }

  // Build query TF-IDF vector
  const queryVec = new Float32Array(index.dims);
  let queryNorm = 0;
  for (const [token, termFreq] of queryTf) {
    const dim = index.vocab.get(token);
    if (dim === undefined) continue;
    const tfidf = (1 + Math.log(termFreq)) * index.idf[dim];
    queryVec[dim] = tfidf;
    queryNorm += tfidf * tfidf;
  }
  queryNorm = Math.sqrt(queryNorm) || 1;

  // Compute cosine similarity against all entries
  const hits: SemanticHit[] = [];
  for (const entry of index.entries) {
    let dotProduct = 0;
    const vec = entry.vector;
    for (let d = 0; d < index.dims; d++) {
      dotProduct += queryVec[d] * vec[d];
    }
    const similarity = dotProduct / (queryNorm * entry.norm);
    if (similarity > 0.05) { // minimum similarity threshold
      hits.push({ symbolIndex: entry.symbolIndex, score: similarity });
    }
  }

  // Sort descending by score
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, maxResults);
}

// ── Combined Search ───────────────────────────────────────────────────────

// Keyword scores from index.ts's searchIndex() top out at 100 (exact name
// match) + 5 (file path bonus) = 105. Semantic cosine similarity is 0-1.
// Both are rescaled to a common 0-100 range before blending so neither
// metric structurally dominates the other regardless of query shape.
const KEYWORD_SCORE_CAP = 105;
const SEMANTIC_SCALE = 100;

/**
 * Combine keyword-based search with semantic (TF-IDF) search.
 * Keyword matches get a base score, semantic similarity boosts it.
 */
export function combinedSearch(
  keywordHits: Array<{ symbol: CodeSymbol; score: number }>,
  semanticHits: SemanticHit[],
  symbols: CodeSymbol[],
  maxResults: number = 20,
): Array<{ symbol: CodeSymbol; score: number }> {
  // Build a map of symbolIndex → normalized keyword score (0-100)
  const keywordScores = new Map<number, number>();
  for (const hit of keywordHits) {
    const idx = symbols.indexOf(hit.symbol);
    if (idx >= 0) {
      keywordScores.set(idx, (hit.score / KEYWORD_SCORE_CAP) * 100);
    }
  }

  // Merge semantic hits (cosine similarity 0-1, rescaled to 0-100)
  const merged = new Map<number, number>();
  for (const hit of semanticHits) {
    const keywordScore = keywordScores.get(hit.symbolIndex) ?? 0;
    const combined = keywordScore + hit.score * SEMANTIC_SCALE;
    merged.set(hit.symbolIndex, combined);
  }

  // Add keyword-only hits that didn't have semantic matches
  for (const [idx, score] of keywordScores) {
    if (!merged.has(idx)) {
      merged.set(idx, score);
    }
  }

  return [...merged.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxResults)
    .map(([idx, score]) => ({ symbol: symbols[idx], score }));
}

// ── Serialization ─────────────────────────────────────────────────────────

/**
 * Serialize a SemanticIndex to a JSON-compatible object for disk storage.
 */
export function serializeSemanticIndex(index: SemanticIndex): Record<string, unknown> {
  return {
    vocab: [...index.vocab.entries()],
    idf: Array.from(index.idf),
    entries: index.entries.map(e => ({
      symbolIndex: e.symbolIndex,
      vector: Array.from(e.vector),
      norm: e.norm,
    })),
    dims: index.dims,
    docCount: index.docCount,
  };
}

/**
 * Deserialize a SemanticIndex from a JSON-compatible object.
 */
export function deserializeSemanticIndex(data: Record<string, unknown>): SemanticIndex {
  const vocabEntries = data['vocab'] as Array<[string, number]>;
  const vocab = new Map<string, number>(vocabEntries);
  const idf = new Float32Array(data['idf'] as number[]);
  const rawEntries = data['entries'] as Array<{ symbolIndex: number; vector: number[]; norm: number }>;
  const entries: VectorEntry[] = rawEntries.map(e => ({
    symbolIndex: e.symbolIndex,
    vector: new Float32Array(e.vector),
    norm: e.norm,
  }));

  return {
    vocab,
    idf,
    entries,
    dims: data['dims'] as number,
    docCount: data['docCount'] as number,
  };
}
