import { writeEntry, readEntries } from './store.js';
import type { TurnSignal } from '../../types.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HabitState {
  turnCount: number;
  zhInputTurns: number;
  enInputTurns: number;
  totalResponseChars: number;
  totalToolConfirms: number;
  totalToolRejects: number;
  yesAllTriggers: number;
  codingTurns: number;
  chatTurns: number;
}

export interface HabitUpdate {
  id: string;
  name: string;
  description: string;
  body: string;
}

// ── Language detection ────────────────────────────────────────────────────────

export function detectInputLanguage(input: string): 'zh' | 'en' {
  if (input.length === 0) return 'en';
  const cjkCount = (input.match(/[一-鿿㐀-䶿豈-﫿]/g) ?? []).length;
  return cjkCount / input.length > 0.1 ? 'zh' : 'en';
}

// ── State management ──────────────────────────────────────────────────────────

export function createInitialHabitState(): HabitState {
  return {
    turnCount: 0,
    zhInputTurns: 0,
    enInputTurns: 0,
    totalResponseChars: 0,
    totalToolConfirms: 0,
    totalToolRejects: 0,
    yesAllTriggers: 0,
    codingTurns: 0,
    chatTurns: 0,
  };
}

export function observeTurn(signal: TurnSignal, state: HabitState): HabitState {
  return {
    turnCount:          state.turnCount + 1,
    zhInputTurns:       state.zhInputTurns + (signal.userInputLang === 'zh' ? 1 : 0),
    enInputTurns:       state.enInputTurns + (signal.userInputLang === 'en' ? 1 : 0),
    totalResponseChars: state.totalResponseChars + signal.responseLength,
    totalToolConfirms:  state.totalToolConfirms + signal.confirmations,
    totalToolRejects:   state.totalToolRejects + signal.rejections,
    yesAllTriggers:     state.yesAllTriggers + (signal.yesAll ? 1 : 0),
    codingTurns:        state.codingTurns + (signal.isCoding ? 1 : 0),
    chatTurns:          state.chatTurns + (signal.isCoding ? 0 : 1),
  };
}

// ── Habit analysis ────────────────────────────────────────────────────────────

export function analyzeHabits(state: HabitState): HabitUpdate[] {
  const updates: HabitUpdate[] = [];
  const { turnCount } = state;

  // ── Language preference ───────────────────────────────────────────────────
  if (turnCount >= 3) {
    const zhRatio = state.zhInputTurns / turnCount;
    const enRatio = state.enInputTurns / turnCount;
    if (zhRatio >= 0.7) {
      updates.push({
        id: 'habit_language',
        name: 'response_language',
        description: 'User consistently writes in Chinese',
        body: 'User consistently writes in Chinese (zh). ALWAYS respond in 简体中文 (Simplified Chinese) regardless of system language settings. Never switch to English unless the user explicitly requests it.',
      });
    } else if (enRatio >= 0.7) {
      updates.push({
        id: 'habit_language',
        name: 'response_language',
        description: 'User consistently writes in English',
        body: 'User consistently writes in English. ALWAYS respond in English regardless of system language settings. Never switch to Chinese unless the user explicitly requests it.',
      });
    }
  }

  // ── Verbosity preference ──────────────────────────────────────────────────
  if (turnCount >= 5) {
    const avg = state.totalResponseChars / turnCount;
    if (avg < 200) {
      updates.push({
        id: 'habit_verbosity',
        name: 'response_verbosity',
        description: 'User prefers terse responses',
        body: 'User prefers short, terse responses. Get straight to the point. Avoid preambles, explanations of what you are about to do, and trailing summaries. One or two sentences max unless the task genuinely requires more.',
      });
    } else if (avg > 800) {
      updates.push({
        id: 'habit_verbosity',
        name: 'response_verbosity',
        description: 'User prefers detailed responses',
        body: 'User prefers detailed, thorough responses with context and explanation. Do not sacrifice clarity for brevity — provide complete reasoning and relevant background when answering.',
      });
    }
    // Mid-range (200–800): no opinion, don't write/overwrite
  }

  // ── Tool confirmation behavior ────────────────────────────────────────────
  const totalCalls = state.totalToolConfirms + state.totalToolRejects;
  if (totalCalls >= 3) {
    if (state.yesAllTriggers >= 1) {
      updates.push({
        id: 'habit_confirmation',
        name: 'tool_confirmation_style',
        description: 'User uses yes-all for tool confirmations',
        body: 'User frequently approves all tool operations at once (yes-all). They trust batched operations. You can proceed confidently with multi-file changes without excessive step-by-step confirmation.',
      });
    } else if (state.totalToolRejects / totalCalls >= 0.4) {
      updates.push({
        id: 'habit_confirmation',
        name: 'tool_confirmation_style',
        description: 'User carefully reviews and often rejects tool calls',
        body: 'User carefully reviews file edits and frequently rejects them. Before executing write or edit operations, briefly describe what you are about to change and why, so the user can make an informed decision.',
      });
    }
  }

  // ── Task style preference ─────────────────────────────────────────────────
  if (turnCount >= 5) {
    const codingRatio = state.codingTurns / turnCount;
    if (codingRatio >= 0.75) {
      updates.push({
        id: 'habit_task_style',
        name: 'task_style',
        description: 'User primarily uses this tool for coding tasks',
        body: 'User primarily uses this tool for coding and file-editing tasks. Optimize for code actions over explanations. Default to reading files and making changes rather than asking clarifying questions.',
      });
    } else if (codingRatio <= 0.25) {
      updates.push({
        id: 'habit_task_style',
        name: 'task_style',
        description: 'User primarily uses this tool for Q&A and explanation',
        body: 'User primarily uses this tool for questions, explanations, and discussion rather than direct code changes. Lean toward thoughtful explanations and provide context before suggesting code edits.',
      });
    }
  }

  return updates;
}

// ── Persistence ───────────────────────────────────────────────────────────────

export async function persistHabitUpdates(updates: HabitUpdate[]): Promise<void> {
  if (updates.length === 0) return;

  // Load existing entries to preserve original createdAt timestamps
  const existing = await readEntries('user');
  const existingById = new Map(existing.map(e => [e.id, e]));

  const now = new Date().toISOString();
  for (const u of updates) {
    const prev = existingById.get(u.id);
    await writeEntry({
      id:          u.id,
      type:        'user',
      name:        u.name,
      description: u.description,
      body:        u.body,
      createdAt:   prev?.createdAt ?? now,
      updatedAt:   now,
    });
  }
}
