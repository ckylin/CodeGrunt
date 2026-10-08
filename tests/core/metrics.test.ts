import { describe, it, expect, vi, afterEach } from 'vitest';
import { Metrics, getDefaultMetrics, resetDefaultMetrics } from '../../src/core/observability/metrics.js';

afterEach(() => {
  vi.restoreAllMocks();
  resetDefaultMetrics();
});

describe('Metrics counters', () => {
  it('starts at 0, increments by 1 by default and by a given amount', () => {
    const m = new Metrics();
    expect(m.getCounter('x')).toBe(0);
    m.increment('x');
    m.increment('x', 4);
    expect(m.getCounter('x')).toBe(5);
  });

  it('snapshot() lists counters', () => {
    const m = new Metrics();
    m.increment('a', 2);
    m.increment('b');
    expect(m.snapshot().counters).toEqual({ a: 2, b: 1 });
  });
});

describe('Metrics timers', () => {
  it('records duration from performance.now() and returns it from stop()', () => {
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValueOnce(100).mockReturnValueOnce(130);
    const m = new Metrics();
    const stop = m.startTimer('t');
    expect(stop()).toBe(30);
    expect(m.snapshot().timers.t).toEqual({ count: 1, totalMs: 30, minMs: 30, maxMs: 30 });
  });

  it('aggregates count / total / min / max across runs', () => {
    const now = vi.spyOn(performance, 'now');
    const m = new Metrics();
    for (const [start, end] of [[0, 10], [0, 40], [0, 20]]) {
      now.mockReturnValueOnce(start).mockReturnValueOnce(end);
      m.startTimer('t')();
    }
    expect(m.snapshot().timers.t).toEqual({ count: 3, totalMs: 70, minMs: 10, maxMs: 40 });
  });

  it('a timer that was started but never stopped does not appear in the snapshot', () => {
    const m = new Metrics();
    m.startTimer('never-stopped');
    expect(m.snapshot().timers).toEqual({});
  });

  it('snapshot().uptimeMs is non-negative', () => {
    expect(new Metrics().snapshot().uptimeMs).toBeGreaterThanOrEqual(0);
  });
});

describe('Metrics.printSummary / reset', () => {
  it('prints nothing when there are no counters or timers', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    new Metrics().printSummary();
    expect(write).not.toHaveBeenCalled();
  });

  it('prints counters and timer stats to stderr', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValueOnce(0).mockReturnValueOnce(12.34);
    const m = new Metrics();
    m.increment('calls', 3);
    m.startTimer('llm')();
    m.printSummary();
    const out = String(write.mock.calls[0][0]);
    expect(out).toContain('── Metrics ──');
    expect(out).toContain('Counters:');
    expect(out).toContain('  calls: 3');
    expect(out).toContain('Timers (ms):');
    expect(out).toContain('  llm: avg=12.3 min=12.3 max=12.3 count=1');
  });

  it('reset() clears counters and timers', () => {
    const m = new Metrics();
    m.increment('x');
    m.startTimer('t')();
    m.reset();
    const s = m.snapshot();
    expect(s.counters).toEqual({});
    expect(s.timers).toEqual({});
  });
});

describe('default metrics singleton', () => {
  it('is shared until resetDefaultMetrics() drops it', () => {
    const a = getDefaultMetrics();
    expect(getDefaultMetrics()).toBe(a);
    resetDefaultMetrics();
    expect(getDefaultMetrics()).not.toBe(a);
  });
});
