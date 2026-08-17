import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRetry } from '../../src/providers/deepseek/provider.js';
import { ApiError, RetryableError, UserAbortError } from '../../src/core/errors.js';

function apiErr(status: number, message = 'api failure'): Error {
  const err = new Error(message);
  (err as unknown as Record<string, unknown>).status = status;
  return err;
}

function codeErr(code: string, message = 'network blip'): Error {
  const err = new Error(message);
  (err as unknown as Record<string, unknown>).code = code;
  return err;
}

describe('withRetry error wrapping', () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('returns the result directly when fn succeeds on the first try', async () => {
    const result = await withRetry(async () => 'ok');
    expect(result).toBe('ok');
  });

  it('wraps a non-retryable status (401) as ApiError immediately, without retrying', async () => {
    const fn = vi.fn(async () => { throw apiErr(401, 'bad key'); });
    const promise = withRetry(fn);
    await expect(promise).rejects.toBeInstanceOf(ApiError);
    await promise.catch((e: ApiError) => {
      expect(e.status).toBe(401);
      expect(e.message).toBe('bad key');
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('wraps a retryable status (429) as RetryableError after exhausting retries', async () => {
    const fn = vi.fn(async () => { throw apiErr(429, 'rate limited'); });
    const promise = withRetry(fn);
    // Attach the rejection assertion BEFORE advancing timers — withRetry's
    // final rejection happens inside runAllTimersAsync(), so waiting until
    // after to attach a handler leaves the promise unhandled in between.
    const assertion = expect(promise).rejects.toBeInstanceOf(RetryableError);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(4); // initial + 3 retries
  });

  it('wraps a retryable error code (ECONNRESET) as RetryableError', async () => {
    const fn = vi.fn(async () => { throw codeErr('ECONNRESET'); });
    const promise = withRetry(fn);
    const assertion = expect(promise).rejects.toBeInstanceOf(RetryableError);
    await vi.runAllTimersAsync();
    await assertion;
  });

  it('wraps an unrecognized error (no status/code) as RetryableError without retrying further than max', async () => {
    const fn = vi.fn(async () => { throw new Error('mystery failure'); });
    const promise = withRetry(fn);
    const assertion = expect(promise).rejects.toBeInstanceOf(RetryableError);
    await vi.runAllTimersAsync();
    await assertion;
    // Non-retryable-and-not-in-either-set errors fail on first attempt (isRetryable is false).
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws UserAbortError immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn(async () => 'unreachable');
    await expect(withRetry(fn, controller.signal)).rejects.toBeInstanceOf(UserAbortError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('throws UserAbortError if the signal aborts while waiting for backoff', async () => {
    const controller = new AbortController();
    const fn = vi.fn(async () => { throw apiErr(429, 'rate limited'); });
    const promise = withRetry(fn, controller.signal);
    // Let the first attempt fail and enter the backoff wait, then abort.
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(UserAbortError);
  });

  it('succeeds after a transient failure followed by a success', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls === 1) throw apiErr(500, 'server hiccup');
      return 'recovered';
    });
    const promise = withRetry(fn);
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
