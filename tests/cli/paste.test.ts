import { describe, it, expect } from 'vitest';
import { processPasteChunk, normalizePastedText, INITIAL_PASTE_STATE } from '../../src/cli/ink/paste.js';

describe('processPasteChunk', () => {
  it('passes through a chunk with no paste markers untouched', () => {
    const result = processPasteChunk(INITIAL_PASTE_STATE, 'a');
    expect(result.consumed).toBe(false);
    expect(result.state).toEqual(INITIAL_PASTE_STATE);
  });

  it('assembles a single-chunk paste that contains both markers', () => {
    // Note: Ink strips exactly one leading ESC byte before handing the chunk
    // to useInput callbacks, so the marker as observed here has no '\x1b' prefix.
    const chunk = '[200~line one\nline two[201~';
    const result = processPasteChunk(INITIAL_PASTE_STATE, chunk);
    expect(result.consumed).toBe(true);
    expect(result.insertText).toBe('line one\nline two');
    expect(result.state.active).toBe(false);
  });

  it('buffers a paste split across multiple chunks and completes on the end marker', () => {
    const start = processPasteChunk(INITIAL_PASTE_STATE, '[200~first part');
    expect(start.consumed).toBe(true);
    expect(start.insertText).toBeUndefined();
    expect(start.state.active).toBe(true);

    const middle = processPasteChunk(start.state, ' second part');
    expect(middle.consumed).toBe(true);
    expect(middle.insertText).toBeUndefined();
    expect(middle.state.active).toBe(true);

    const end = processPasteChunk(middle.state, ' third part[201~');
    expect(end.consumed).toBe(true);
    expect(end.insertText).toBe('first part second part third part');
    expect(end.state.active).toBe(false);
  });

  it('does not treat a lone carriage return as Enter while a paste is active', () => {
    const start = processPasteChunk(INITIAL_PASTE_STATE, '[200~before');
    // A chunk boundary landing exactly on '\r' is the failure mode this
    // whole module exists to prevent — it must be buffered, not submitted.
    const mid = processPasteChunk(start.state, '\r');
    expect(mid.consumed).toBe(true);
    expect(mid.state.active).toBe(true);
    const end = processPasteChunk(mid.state, 'after[201~');
    expect(end.insertText).toBe('before\rafter');
  });

  it('resets cleanly so a normal keypress after a paste is handled as non-paste', () => {
    const chunk = '[200~x[201~';
    const { state } = processPasteChunk(INITIAL_PASTE_STATE, chunk);
    const next = processPasteChunk(state, 'a');
    expect(next.consumed).toBe(false);
  });
});

describe('normalizePastedText', () => {
  it('preserves embedded newlines as literal \\n (multi-line input is now supported)', () => {
    expect(normalizePastedText('line one\nline two\nline three')).toBe('line one\nline two\nline three');
  });

  it('normalizes CRLF sequences to a single \\n, not two', () => {
    expect(normalizePastedText('a\r\nb')).toBe('a\nb');
  });

  it('normalizes a lone CR to \\n', () => {
    expect(normalizePastedText('a\rb')).toBe('a\nb');
  });

  it('leaves single-line pasted text unchanged', () => {
    expect(normalizePastedText('just one line')).toBe('just one line');
  });
});
