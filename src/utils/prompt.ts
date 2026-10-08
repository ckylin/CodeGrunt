import { createInterface } from 'readline';

export type Ask = (question: string) => Promise<string>;

/**
 * Runs `fn` with a line-asking function bound to a fresh readline interface.
 * The interface is always closed, even if `fn` throws or the user interrupts.
 */
export async function withPrompt<T>(fn: (ask: Ask) => Promise<T>): Promise<T> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask: Ask = (question) => new Promise((resolve) => rl.question(question, resolve));
  try {
    return await fn(ask);
  } finally {
    rl.close();
  }
}

/** Asks a single question and returns the raw answer. */
export function askOnce(question: string): Promise<string> {
  return withPrompt((ask) => ask(question));
}
