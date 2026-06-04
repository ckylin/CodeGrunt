import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

// ── Paths ─────────────────────────────────────────────────────────────────────

const MEMORY_DIR = join(homedir(), '.codegrunt', 'memory');
const SESSIONS_DIR = join(MEMORY_DIR, 'sessions');
const ENTRIES_PATH = join(MEMORY_DIR, 'entries.jsonl');

// ── Types ─────────────────────────────────────────────────────────────────────

export type MemoryEntryType = 'user' | 'feedback' | 'project' | 'reference';

export interface MemoryEntry {
  id: string;
  type: MemoryEntryType;
  name: string;
  description: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export { randomUUID };

// ── Helpers ───────────────────────────────────────────────────────────────────

function cwdHash(cwd: string): string {
  return createHash('sha1').update(cwd).digest('hex').slice(0, 12);
}

// ── Direction A: Session summary ──────────────────────────────────────────────

export async function saveSessionSummary(cwd: string, summary: string): Promise<void> {
  await mkdir(SESSIONS_DIR, { recursive: true });
  const path = join(SESSIONS_DIR, `${cwdHash(cwd)}.json`);
  await writeFile(path, JSON.stringify({ cwd, summary, savedAt: new Date().toISOString() }), 'utf-8');
}

export async function loadSessionSummary(cwd: string): Promise<string | null> {
  const path = join(SESSIONS_DIR, `${cwdHash(cwd)}.json`);
  try {
    const raw = await readFile(path, 'utf-8');
    const data = JSON.parse(raw) as { summary?: string };
    return data.summary ?? null;
  } catch {
    return null;
  }
}

// ── Direction B: Structured entries ───────────────────────────────────────────

export async function writeEntry(entry: MemoryEntry): Promise<void> {
  await mkdir(MEMORY_DIR, { recursive: true });
  let lines: string[] = [];
  try {
    const raw = await readFile(ENTRIES_PATH, 'utf-8');
    lines = raw.split('\n').filter(l => l.trim());
  } catch { /* file doesn't exist yet */ }

  const idx = lines.findIndex(l => {
    try { return (JSON.parse(l) as MemoryEntry).id === entry.id; } catch { return false; }
  });

  const serialized = JSON.stringify(entry);
  if (idx >= 0) {
    lines[idx] = serialized;
  } else {
    lines.push(serialized);
  }
  await writeFile(ENTRIES_PATH, lines.join('\n') + '\n', 'utf-8');
}

export async function readEntries(type?: MemoryEntryType): Promise<MemoryEntry[]> {
  try {
    const raw = await readFile(ENTRIES_PATH, 'utf-8');
    const entries = raw.split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l) as MemoryEntry);
    return type ? entries.filter(e => e.type === type) : entries;
  } catch {
    return [];
  }
}

export async function listEntries(): Promise<MemoryEntry[]> {
  return readEntries();
}

export async function deleteEntry(id: string): Promise<boolean> {
  try {
    const raw = await readFile(ENTRIES_PATH, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim());
    const before = lines.length;
    const filtered = lines.filter(l => {
      try { return (JSON.parse(l) as MemoryEntry).id !== id; } catch { return true; }
    });
    if (filtered.length === before) return false;
    await writeFile(ENTRIES_PATH, filtered.length ? filtered.join('\n') + '\n' : '', 'utf-8');
    return true;
  } catch {
    return false;
  }
}
