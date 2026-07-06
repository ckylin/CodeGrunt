// ── Conversation Session Persistence ────────────────────────────────────────
// Saves and restores full message histories so sessions can be resumed.
// Sessions are stored as JSONL in ~/.codegrunt/sessions/<id>.json.
// Each file holds a SessionRecord: metadata header + serialized messages.
//
// Design:
//   - One file per session, named by UUID
//   - Index at ~/.codegrunt/sessions/index.jsonl for fast listing
//   - Auto-save triggered by the REPL after every agent turn
//   - --resume <id> or /resume restores messages into ContextManager

import { readFile, writeFile, mkdir, readdir, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { Message } from '../../types.js';

// ── Paths ─────────────────────────────────────────────────────────────────────

export const SESSIONS_DIR = join(homedir(), '.codegrunt', 'conv-sessions');
const INDEX_PATH = join(SESSIONS_DIR, 'index.jsonl');

// Keep at most this many sessions per working directory in the index.
const MAX_SESSIONS_PER_CWD = 20;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SessionRecord {
  id: string;
  cwd: string;
  model: string;
  /** ISO timestamp of last save */
  savedAt: string;
  /** First user message, truncated — shown in /resume picker */
  title: string;
  messageCount: number;
  messages: Message[];
}

export interface SessionIndexEntry {
  id: string;
  cwd: string;
  model: string;
  savedAt: string;
  title: string;
  messageCount: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function ensureDir(): Promise<void> {
  await mkdir(SESSIONS_DIR, { recursive: true });
}

function sessionPath(id: string): string {
  return join(SESSIONS_DIR, `${id}.json`);
}

/** Extract a display title from the first user message in the list. */
function extractTitle(messages: Message[]): string {
  const first = messages.find(m => m.role === 'user' && 'content' in m && m.content);
  if (!first || !('content' in first) || !first.content) return '(no messages)';
  const text = String(first.content).replace(/\[Previous conversation summary\][\s\S]*/, '').trim();
  return text.slice(0, 80) + (text.length > 80 ? '…' : '');
}

// ── Index management ──────────────────────────────────────────────────────────

async function readIndex(): Promise<SessionIndexEntry[]> {
  try {
    const raw = await readFile(INDEX_PATH, 'utf-8');
    return raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as SessionIndexEntry);
  } catch {
    return [];
  }
}

async function writeIndex(entries: SessionIndexEntry[]): Promise<void> {
  await ensureDir();
  await writeFile(INDEX_PATH, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
}

async function upsertIndex(entry: SessionIndexEntry): Promise<void> {
  let entries = await readIndex();
  const idx = entries.findIndex(e => e.id === entry.id);
  if (idx >= 0) {
    entries[idx] = entry;
  } else {
    entries.unshift(entry);
  }

  // Trim old sessions per cwd, keeping the most recent MAX_SESSIONS_PER_CWD
  const cwdEntries = entries.filter(e => e.cwd === entry.cwd);
  if (cwdEntries.length > MAX_SESSIONS_PER_CWD) {
    const toRemove = cwdEntries.slice(MAX_SESSIONS_PER_CWD).map(e => e.id);
    for (const id of toRemove) {
      const p = sessionPath(id);
      if (existsSync(p)) await unlink(p).catch(() => {});
    }
    entries = entries.filter(e => !toRemove.includes(e.id));
  }

  await writeIndex(entries);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Save (or update) a session. Returns the session ID.
 * Pass an existing `id` to update an in-progress session.
 */
export async function saveSession(
  messages: Message[],
  opts: { id?: string; cwd: string; model: string },
): Promise<string> {
  await ensureDir();
  const id = opts.id ?? randomUUID();
  const nonSystem = messages.filter(m => m.role !== 'system');
  const record: SessionRecord = {
    id,
    cwd: opts.cwd,
    model: opts.model,
    savedAt: new Date().toISOString(),
    title: extractTitle(nonSystem),
    messageCount: nonSystem.length,
    messages,
  };
  await writeFile(sessionPath(id), JSON.stringify(record, null, 2), 'utf-8');
  await upsertIndex({
    id,
    cwd: opts.cwd,
    model: opts.model,
    savedAt: record.savedAt,
    title: record.title,
    messageCount: record.messageCount,
  });
  return id;
}

/** Load a full session by ID. Returns null if not found. */
export async function loadSession(id: string): Promise<SessionRecord | null> {
  try {
    const raw = await readFile(sessionPath(id), 'utf-8');
    return JSON.parse(raw) as SessionRecord;
  } catch {
    return null;
  }
}

/** List sessions for a given cwd, most recent first. */
export async function listSessions(cwd: string): Promise<SessionIndexEntry[]> {
  const entries = await readIndex();
  return entries
    .filter(e => e.cwd === cwd)
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

/** List all sessions across all cwds, most recent first. */
export async function listAllSessions(): Promise<SessionIndexEntry[]> {
  const entries = await readIndex();
  return entries.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

/** Delete a session by ID. */
export async function deleteSession(id: string): Promise<boolean> {
  const p = sessionPath(id);
  if (!existsSync(p)) return false;
  await unlink(p).catch(() => {});
  const entries = (await readIndex()).filter(e => e.id !== id);
  await writeIndex(entries);
  return true;
}

/** Format a session entry for display in the picker. */
export function formatSessionEntry(e: SessionIndexEntry): string {
  const date = new Date(e.savedAt).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  return `[${date}] (${e.messageCount} msgs) ${e.title}`;
}
