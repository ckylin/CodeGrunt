// ── Hook Registry ─────────────────────────────────────────────────────────
// Loads user-defined hook scripts from ~/.codegrunt/hooks/ and fires them at
// four lifecycle points: UserPromptSubmit, PreToolUse, PostToolUse, Stop.
//
// Scripts receive a JSON event on stdin and must write a JSON response to
// stdout within HOOK_TIMEOUT_MS. The response shape is:
//
//   { "action": "continue" }                         — pass through
//   { "action": "block", "reason": "..." }           — abort the operation
//   { "action": "modify", "data": { ... } }          — replace event data
//
// Scripts that exit non-zero or exceed the timeout are treated as "continue"
// (hooks must not crash the agent). Both shell scripts (.sh, .bash) and JS
// scripts (.js, .mjs, .cjs) are supported.
//
// File naming convention:
//   ~/.codegrunt/hooks/pre-tool-use.sh
//   ~/.codegrunt/hooks/post-tool-use.sh
//   ~/.codegrunt/hooks/user-prompt-submit.sh
//   ~/.codegrunt/hooks/stop.sh
//
// Multiple scripts per event type are supported — all files matching the
// event prefix are executed in lexicographic order.
//
// Example (pre-tool-use.sh):
//   #!/bin/bash
//   INPUT=$(cat)
//   TOOL=$(echo "$INPUT" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write(d.tool_name)")
//   if [ "$TOOL" = "execute_shell" ]; then
//     CMD=$(echo "$INPUT" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write(d.tool_input.command||'')")
//     if echo "$CMD" | grep -qE 'rm\s+-rf\s+/'; then
//       echo '{"action":"block","reason":"Refusing dangerous rm -rf /"}'
//       exit 0
//     fi
//   fi
//   echo '{"action":"continue"}'

import { existsSync, readdirSync } from 'fs';
import { spawn } from 'child_process';
import { homedir } from 'os';
import { join, extname, basename } from 'path';
import { getLogger } from '../observability/logger.js';

const log = getLogger('hooks');

const HOOK_TIMEOUT_MS = 10_000;
const HOOKS_DIR = join(homedir(), '.codegrunt', 'hooks');

// ── Event types ───────────────────────────────────────────────────────────

export type HookEventType = 'user-prompt-submit' | 'pre-tool-use' | 'post-tool-use' | 'stop';

export interface UserPromptSubmitEvent {
  event: 'user-prompt-submit';
  prompt: string;
  cwd: string;
}

export interface PreToolUseEvent {
  event: 'pre-tool-use';
  tool_name: string;
  tool_input: Record<string, unknown>;
  cwd: string;
}

export interface PostToolUseEvent {
  event: 'post-tool-use';
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_result: { success: boolean; output: string; error?: string };
  cwd: string;
}

export interface StopEvent {
  event: 'stop';
  cwd: string;
  response_length: number;
}

export type HookEvent = UserPromptSubmitEvent | PreToolUseEvent | PostToolUseEvent | StopEvent;

// ── Response types ────────────────────────────────────────────────────────

export interface HookContinue {
  action: 'continue';
}

export interface HookBlock {
  action: 'block';
  reason: string;
}

export interface HookModify {
  action: 'modify';
  data: Record<string, unknown>;
}

export type HookResponse = HookContinue | HookBlock | HookModify;

// ── Loaded hook descriptor ────────────────────────────────────────────────

export interface HookDescriptor {
  eventType: HookEventType;
  scriptPath: string;
  name: string;
}

// ── Registry ──────────────────────────────────────────────────────────────

export class HookRegistry {
  private hooks: HookDescriptor[] = [];

  /** Load all hook scripts from ~/.codegrunt/hooks/. Safe to call multiple times. */
  load(): void {
    this.hooks = [];
    if (!existsSync(HOOKS_DIR)) return;

    let files: string[];
    try {
      files = readdirSync(HOOKS_DIR).sort();
    } catch {
      return;
    }

    const EVENT_PREFIXES: Record<string, HookEventType> = {
      'user-prompt-submit': 'user-prompt-submit',
      'pre-tool-use': 'pre-tool-use',
      'post-tool-use': 'post-tool-use',
      'stop': 'stop',
    };

    const SUPPORTED_EXTS = new Set(['.sh', '.bash', '.js', '.mjs', '.cjs']);

    for (const file of files) {
      const ext = extname(file);
      if (!SUPPORTED_EXTS.has(ext)) continue;

      const nameWithoutExt = basename(file, ext);

      for (const [prefix, eventType] of Object.entries(EVENT_PREFIXES)) {
        if (nameWithoutExt === prefix || nameWithoutExt.startsWith(prefix + '-') || nameWithoutExt.startsWith(prefix + '_')) {
          this.hooks.push({
            eventType,
            scriptPath: join(HOOKS_DIR, file),
            name: file,
          });
          log.info('Loaded hook', { file, eventType });
          break;
        }
      }
    }
  }

  /** Returns all loaded hook descriptors. */
  list(): HookDescriptor[] {
    return [...this.hooks];
  }

  /** Returns hooks registered for a specific event type. */
  hooksFor(eventType: HookEventType): HookDescriptor[] {
    return this.hooks.filter(h => h.eventType === eventType);
  }

  /**
   * Run all hooks for the given event in order.
   * - Returns the first "block" response encountered.
   * - Returns the last "modify" response (if any), merged with original data.
   * - Returns "continue" if all hooks pass.
   */
  async run(event: HookEvent): Promise<HookResponse> {
    const matching = this.hooksFor(event.event as HookEventType);
    if (matching.length === 0) return { action: 'continue' };

    const payload = JSON.stringify(event);
    let lastModify: HookModify | null = null;

    for (const hook of matching) {
      let response: HookResponse;
      try {
        response = await runScript(hook.scriptPath, payload);
      } catch (err) {
        log.warn('Hook script error (ignoring)', { hook: hook.name, error: err instanceof Error ? err.message : String(err) });
        continue;
      }

      if (response.action === 'block') {
        log.info('Hook blocked operation', { hook: hook.name, reason: response.reason });
        return response;
      }
      if (response.action === 'modify') {
        lastModify = response;
      }
    }

    return lastModify ?? { action: 'continue' };
  }
}

// ── Script runner ─────────────────────────────────────────────────────────

function runScript(scriptPath: string, stdinData: string): Promise<HookResponse> {
  return new Promise((resolve) => {
    const ext = extname(scriptPath);
    const isJs = ext === '.js' || ext === '.mjs' || ext === '.cjs';

    const cmd = isJs ? process.execPath : scriptPath;
    const args = isJs ? [scriptPath] : [];

    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: HOOK_TIMEOUT_MS,
    });

    let stdout = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, HOOK_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    // If spawn() fails asynchronously (bad interpreter path, EACCES), writing
    // to stdin can emit an 'error' event on the stream. Without a listener,
    // Node treats that as an uncaught exception — defeating the "hooks must
    // never crash the agent" guarantee this module documents. The child's
    // own 'error' handler below still fires and resolves the promise.
    child.stdin.on('error', () => { /* handled via child.on('error') below */ });
    child.stdin.write(stdinData);
    child.stdin.end();

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ action: 'continue' });
        return;
      }
      if (code !== 0) {
        resolve({ action: 'continue' });
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim()) as HookResponse;
        if (parsed.action === 'block' || parsed.action === 'modify' || parsed.action === 'continue') {
          resolve(parsed);
        } else {
          resolve({ action: 'continue' });
        }
      } catch {
        resolve({ action: 'continue' });
      }
    });

    child.on('error', () => {
      clearTimeout(timer);
      resolve({ action: 'continue' });
    });
  });
}

// ── Singleton ─────────────────────────────────────────────────────────────

let _registry: HookRegistry | null = null;

export function getHookRegistry(): HookRegistry {
  if (!_registry) {
    _registry = new HookRegistry();
    _registry.load();
  }
  return _registry;
}
