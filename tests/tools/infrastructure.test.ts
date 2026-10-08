import { describe, it, expect } from 'vitest';
import { truncateHead, truncateTail, truncateLine } from '../../src/core/tools/truncate.js';
import { applyEditToContent } from '../../src/core/tools/edit-diff.js';
import { withFileMutationQueue } from '../../src/core/tools/file-mutation-queue.js';
import { OutputAccumulator } from '../../src/core/tools/output-accumulator.js';
import { resolveToCwd } from '../../src/core/tools/path-utils.js';
import { homedir } from 'os';
import { join, resolve } from 'path';

describe('truncateHead / truncateTail', () => {
  const text = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n');

  it('returns content untouched when under both limits', () => {
    const r = truncateHead(text, { maxLines: 100 });
    expect(r.truncated).toBe(false);
    expect(r.content).toBe(text);
  });

  it('head keeps the first lines and reports truncatedBy lines', () => {
    const r = truncateHead(text, { maxLines: 3 });
    expect(r.content).toBe('line1\nline2\nline3');
    expect(r.truncatedBy).toBe('lines');
    expect(r.totalLines).toBe(10);
  });

  it('tail keeps the last lines', () => {
    const r = truncateTail(text, { maxLines: 2 });
    expect(r.content).toBe('line9\nline10');
    expect(r.truncated).toBe(true);
  });

  it('head flags a first line larger than the byte limit', () => {
    const r = truncateHead('x'.repeat(100), { maxBytes: 10 });
    expect(r.firstLineExceedsLimit).toBe(true);
    expect(r.content).toBe('');
  });

  it('tail keeps a partial last line when it alone exceeds the byte limit', () => {
    const r = truncateTail('a\n' + 'y'.repeat(100), { maxBytes: 10 });
    expect(r.lastLinePartial).toBe(true);
    expect(r.content).toBe('y'.repeat(10));
  });

  it('truncateLine clips long lines with a marker', () => {
    expect(truncateLine('abc', 10).wasTruncated).toBe(false);
    const r = truncateLine('a'.repeat(20), 5);
    expect(r.wasTruncated).toBe(true);
    expect(r.text).toBe('aaaaa... [truncated]');
  });
});

describe('applyEditToContent', () => {
  it('applies an exact unique match', () => {
    const r = applyEditToContent('a = 1;\nb = 2;\n', 'a = 1;', 'a = 9;');
    expect(r).toEqual({ content: 'a = 9;\nb = 2;\n', fuzzy: false });
  });

  it('matches across smart quotes and trailing whitespace, leaving other text byte-identical', () => {
    const original = 'say(“hi”);   \nkeep   \n';
    const r = applyEditToContent(original, 'say("hi");', 'say("bye");');
    expect(r).not.toBeNull();
    expect(r).not.toBe('AMBIGUOUS');
    if (r && r !== 'AMBIGUOUS') {
      expect(r.fuzzy).toBe(true);
      expect(r.content).toBe('say("bye");   \nkeep   \n');
    }
  });

  it('reports ambiguity for repeated matches', () => {
    expect(applyEditToContent('foo\nfoo\n', 'foo', 'bar')).toBe('AMBIGUOUS');
  });

  it('returns null when nothing matches or old_string is empty', () => {
    expect(applyEditToContent('abc', 'xyz', 'q')).toBeNull();
    expect(applyEditToContent('abc', '', 'q')).toBeNull();
  });

  it('preserves a leading BOM', () => {
    const r = applyEditToContent('\uFEFFhello', 'hello', 'bye');
    expect(r).not.toBeNull();
    if (r && r !== 'AMBIGUOUS') expect(r.content).toBe('\uFEFFbye');
  });
});

describe('withFileMutationQueue', () => {
  it('serializes operations on the same file and runs different files in parallel', async () => {
    const log: string[] = [];
    const slow = (name: string, ms: number) => async () => {
      log.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`${name}:end`);
    };
    const file = join(process.cwd(), '__queue_test_same__');
    await Promise.all([
      withFileMutationQueue(file, slow('a', 30)),
      withFileMutationQueue(file, slow('b', 1)),
    ]);
    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);

    log.length = 0;
    await Promise.all([
      withFileMutationQueue(join(process.cwd(), '__queue_x__'), slow('x', 30)),
      withFileMutationQueue(join(process.cwd(), '__queue_y__'), slow('y', 1)),
    ]);
    expect(log.indexOf('y:end')).toBeLessThan(log.indexOf('x:end'));
  });

  it('releases the queue when an operation throws', async () => {
    const file = join(process.cwd(), '__queue_throw__');
    await expect(withFileMutationQueue(file, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(withFileMutationQueue(file, async () => 'ok')).resolves.toBe('ok');
  });
});

describe('OutputAccumulator', () => {
  it('keeps small output intact with no temp file', () => {
    const acc = new OutputAccumulator();
    acc.append(Buffer.from('hello\nworld\n'));
    acc.finish();
    const snap = acc.snapshot();
    expect(snap.truncation.truncated).toBe(false);
    expect(snap.content).toBe('hello\nworld\n');
    expect(snap.fullOutputPath).toBeUndefined();
  });

  it('keeps the tail and spills to a temp file when over the line limit', async () => {
    const acc = new OutputAccumulator({ maxLines: 5 });
    for (let i = 1; i <= 20; i++) acc.append(Buffer.from(`row${i}\n`));
    acc.finish();
    const snap = acc.snapshot();
    await acc.closeTempFile();
    expect(snap.truncation.truncated).toBe(true);
    expect(snap.truncation.totalLines).toBe(20);
    expect(snap.content.split('\n').pop()).toBe('row20');
    expect(snap.fullOutputPath).toBeDefined();
  });

  it('decodes a multi-byte character split across chunks', () => {
    const acc = new OutputAccumulator();
    const bytes = Buffer.from('你好');
    acc.append(bytes.subarray(0, 2));
    acc.append(bytes.subarray(2));
    acc.finish();
    expect(acc.snapshot().content).toBe('你好');
  });
});

describe('resolveToCwd', () => {
  it('resolves relative paths against the given cwd', () => {
    expect(resolveToCwd('a/b.txt', resolve('/base'))).toBe(resolve('/base', 'a/b.txt'));
  });

  it('strips a leading @ and expands ~', () => {
    expect(resolveToCwd('@a.txt', resolve('/base'))).toBe(resolve('/base', 'a.txt'));
    expect(resolveToCwd('~/x.txt')).toBe(join(homedir(), 'x.txt'));
  });
});
