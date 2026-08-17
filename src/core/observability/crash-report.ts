// ── Local Crash Reports ──────────────────────────────────────────────────────
// Opt-in (config.crashReportOnError), local-only artifact for uncaught agent
// loop errors. No upload path exists or is planned here — the file is meant
// to be attached manually to a GitHub issue if the user chooses to. Never
// includes message history or file contents, only the failing task text
// (truncated) and error metadata, to keep the report small and low-risk to
// share.

import { mkdir, appendFile, readdir, unlink } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

const CRASH_DIR = join(homedir(), '.codegrunt', 'crash-reports');
const MAX_REPORTS = 20;
const TASK_PREVIEW_CHARS = 200;

export interface CrashReportContext {
  cwd: string;
  task: string;
  model: string;
}

export interface CrashReport {
  timestamp: string;
  errorName: string;
  errorMessage: string;
  errorStack?: string;
  taskPreview: string;
  model: string;
  cwd: string;
  platform: string;
  nodeVersion: string;
}

export function buildCrashReport(err: unknown, ctx: CrashReportContext): CrashReport {
  const isError = err instanceof Error;
  return {
    timestamp: new Date().toISOString(),
    errorName: isError ? err.name : 'UnknownError',
    errorMessage: isError ? err.message : String(err),
    errorStack: isError ? err.stack : undefined,
    taskPreview: ctx.task.length > TASK_PREVIEW_CHARS
      ? ctx.task.slice(0, TASK_PREVIEW_CHARS) + '…'
      : ctx.task,
    model: ctx.model,
    cwd: ctx.cwd,
    platform: process.platform,
    nodeVersion: process.version,
  };
}

/** Keeps at most MAX_REPORTS files, deleting the oldest (by filename, which
 *  is timestamp-prefixed and thus sortable) once the cap is exceeded. */
async function pruneOldReports(dir: string): Promise<void> {
  try {
    const files = (await readdir(dir)).filter(f => f.endsWith('.json')).sort();
    while (files.length >= MAX_REPORTS) {
      const oldest = files.shift();
      if (oldest) await unlink(join(dir, oldest)).catch(() => {});
    }
  } catch { /* directory might not exist yet */ }
}

/** Writes a crash report JSON file. Never throws — a failure here must not
 *  mask or replace the original error being reported. */
export async function writeCrashReport(err: unknown, ctx: CrashReportContext): Promise<string | null> {
  try {
    await mkdir(CRASH_DIR, { recursive: true });
    await pruneOldReports(CRASH_DIR);

    const report = buildCrashReport(err, ctx);
    const filename = `${report.timestamp.replace(/[:.]/g, '-')}.json`;
    const filePath = join(CRASH_DIR, filename);
    await appendFile(filePath, JSON.stringify(report, null, 2), 'utf-8');
    return filePath;
  } catch {
    return null;
  }
}

export function getCrashReportDir(): string {
  return CRASH_DIR;
}
