// Shared harness for the flow characterization tests (chat / skill / coding).
// Drives the REAL generator + pipeline stages + tools against a scripted
// provider in a temp dir; only the terminal sink is replaced so output can be
// asserted instead of printed.

import { mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { vi } from 'vitest';
import { ContextManager } from '../../src/core/context/manager.js';
import { getDefaultMetrics } from '../../src/core/observability/metrics.js';
import { registerSink, unregisterSink } from '../../src/core/output/output-channel.js';
import type { OutputChannelSink } from '../../src/core/output/output-channel.js';
import {
  setTrustMode, resetYesAll, setWorkspacePermissions,
} from '../../src/core/policy/state.js';
import type { AgentRunOptions, CodeGruntConfig, LLMProvider } from '../../src/types.js';

export interface FlowEnv {
  dir: string;
  sink: OutputChannelSink & { lines: string[] };
  cleanup(): Promise<void>;
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

export function makeConfig(): CodeGruntConfig {
  return { provider: 'mock', model: 'mock-model', maxTokens: 1024, temperature: 0, apiKey: '', baseURL: '' };
}

/** Temp cwd + a capturing output sink + auto trust mode (no confirm prompts). */
export async function setupFlowEnv(trust: 'auto' | 'plan' | 'code' = 'auto'): Promise<FlowEnv> {
  const dir = join(tmpdir(), `codegrunt-flow-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });

  const lines: string[] = [];
  const sink = {
    lines,
    writeLine: (t: string) => { lines.push(t); },
    setLiveText: () => {},
    setLiveTool: () => {},
  };
  registerSink(sink);
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

  resetYesAll();
  setWorkspacePermissions(null);
  setTrustMode(trust);

  return {
    dir,
    sink,
    async cleanup() {
      stdout.mockRestore();
      unregisterSink();
      resetYesAll();
      setWorkspacePermissions(null);
      setTrustMode('code');
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    },
  };
}

export function makeOptions(
  env: FlowEnv,
  provider: LLMProvider,
  task: string,
  extra: Partial<AgentRunOptions> = {},
): AgentRunOptions {
  return { task, cwd: env.dir, config: makeConfig(), provider, language: 'en', ...extra };
}

export function newContext(): ContextManager {
  return new ContextManager();
}

export function metrics() {
  return getDefaultMetrics();
}

export const outputOf = (env: FlowEnv): string => stripAnsi(env.sink.lines.join(''));
