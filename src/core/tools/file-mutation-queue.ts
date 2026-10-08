import { realpath } from 'fs/promises';
import { resolve } from 'path';

const queues = new Map<string, Promise<void>>();

async function queueKey(filePath: string): Promise<string> {
  const abs = resolve(filePath);
  try {
    return await realpath(abs);
  } catch {
    return abs;
  }
}

/**
 * Serialize mutations that target the same file so concurrent tool calls
 * (parallel edits from one assistant turn, sub-agents) can't interleave a
 * read-modify-write. Different files still run in parallel.
 */
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = await queueKey(filePath);
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  const chained = previous.then(() => gate);
  queues.set(key, chained);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (queues.get(key) === chained) queues.delete(key);
  }
}
