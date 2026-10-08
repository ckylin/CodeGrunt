// ── Harness-style Structured Logger ─────────────────────────────────────────
// Provides leveled, structured logging with namespace support.
// Events are emitted through the EventBus for centralized collection.
//
// v2 enhancements:
//   - File transport: writes structured JSON logs to ~/.codegrunt/logs/
//   - Trace IDs: unique runId for correlating entries across a single session
//   - Simple log rotation: keeps last 5 log files, max 5 MB each
//   - Environment: CODEGRUNT_LOG_LEVEL, CODEGRUNT_LOG_FILE, CODEGRUNT_VERBOSE

import { mkdir, appendFile, readdir, unlink } from 'fs/promises';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { getDefaultEventBus, type ErrorEvent } from '../events/bus.js';
import { randomUUID } from 'crypto';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  namespace: string;
  message: string;
  data?: Record<string, unknown>;
  timestamp: number;
  runId?: string;
}

export interface LoggerConfig {
  minLevel: LogLevel;
  /** If true, emit error events to EventBus */
  emitErrors: boolean;
  /** If true, write structured JSON to log files */
  fileLogging: boolean;
  /** Custom log directory (default: ~/.codegrunt/logs) */
  logDir?: string;
  /** Shared trace ID for correlating entries */
  runId?: string;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const DEFAULT_LOG_DIR = join(homedir(), '.codegrunt', 'logs');
const MAX_LOG_FILES = 5;
const MAX_LOG_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

// ── File transport helpers ─────────────────────────────────────────────────

let fileLogPath: string | null = null;
let fileLogInitialized = false;
let currentLogFileSize = 0;

async function initFileLogging(logDir: string, runId: string): Promise<void> {
  if (fileLogInitialized) return;

  try {
    await mkdir(logDir, { recursive: true });

    // Clean old log files if we exceed the max count
    try {
      const files = (await readdir(logDir))
        .filter(f => f.endsWith('.jsonl'))
        .sort(); // oldest first (timestamp-prefixed names are naturally sortable)
      while (files.length >= MAX_LOG_FILES) {
        const toRemove = files.shift()!;
        await unlink(join(logDir, toRemove)).catch(() => {});
      }
    } catch { /* directory might not exist yet */ }

    // Create a new log file named with timestamp + runId prefix
    const ts = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
    const shortId = runId.slice(0, 8);
    const filename = `${ts}-${shortId}.jsonl`;
    fileLogPath = join(logDir, filename);

    // Seed with a session-start entry
    const bootEntry: LogEntry = {
      level: 'info',
      namespace: 'logger',
      message: 'Log session started',
      data: { runId, nodeVersion: process.version, platform: process.platform, cwd: process.cwd() },
      timestamp: Date.now(),
      runId,
    };
    const line = JSON.stringify(bootEntry) + '\n';
    await appendFile(fileLogPath, line, 'utf-8');
    currentLogFileSize = Buffer.byteLength(line);

    fileLogInitialized = true;
  } catch {
    // If file logging fails to initialize, silently disable it — don't
    // break the CLI just because we can't write logs.
    fileLogPath = null;
    fileLogInitialized = true;
  }
}

async function writeToFile(entry: LogEntry): Promise<void> {
  if (!fileLogPath) return;

  // Rotate if the current file exceeds max size
  if (currentLogFileSize >= MAX_LOG_SIZE_BYTES) {
    fileLogPath = null; // disable further writes for this file
    try {
      // Mark rotation in a new file
      const logDir = dirname(fileLogPath ?? DEFAULT_LOG_DIR);
      const ts = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
      const newPath = join(logDir, `${ts}-overflow.jsonl`);
      fileLogPath = newPath;
      currentLogFileSize = 0;
    } catch {
      fileLogPath = null;
      return;
    }
  }

  try {
    const line = JSON.stringify(entry) + '\n';
    await appendFile(fileLogPath, line, 'utf-8');
    currentLogFileSize += Buffer.byteLength(line);
  } catch {
    // Silently drop — log failures must not crash the CLI
  }
}

// ── Logger ──────────────────────────────────────────────────────────────────

export class Logger {
  private config: LoggerConfig;
  private runId: string;

  constructor(private namespace: string, config?: Partial<LoggerConfig>) {
    this.runId = config?.runId ?? randomUUID();
    this.config = {
      minLevel: config?.minLevel ?? (process.env.CODEGRUNT_LOG_LEVEL as LogLevel) ?? 'info',
      emitErrors: config?.emitErrors ?? true,
      fileLogging: config?.fileLogging ?? (process.env.CODEGRUNT_LOG_FILE !== '0' && process.env.CODEGRUNT_LOG_FILE !== 'false'),
      logDir: config?.logDir ?? DEFAULT_LOG_DIR,
      runId: this.runId,
    };

    // Init file transport on first logger creation
    if (this.config.fileLogging && !fileLogInitialized) {
      initFileLogging(this.config.logDir ?? DEFAULT_LOG_DIR, this.runId).catch(() => {});
    }
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log('debug', message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log('warn', message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log('error', message, data);
  }

  /** Create a child logger with a sub-namespace */
  child(subNamespace: string): Logger {
    return new Logger(`${this.namespace}:${subNamespace}`, this.config);
  }

  /** Get the trace ID for this logger */
  getRunId(): string {
    return this.runId;
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.config.minLevel]) return;

    const entry: LogEntry = {
      level,
      namespace: this.namespace,
      message,
      data,
      timestamp: Date.now(),
      runId: this.runId,
    };

    // ── stderr output ──────────────────────────────────────────────────
    const prefix = `[${entry.namespace}] ${level.toUpperCase()}:`;
    if (level === 'error' || level === 'warn') {
      process.stderr.write(`\n${prefix} ${message}\n`);
    } else if (process.env.CODEGRUNT_VERBOSE) {
      process.stderr.write(`${prefix} ${message}\n`);
    }

    // ── File transport ─────────────────────────────────────────────────
    if (this.config.fileLogging) {
      writeToFile(entry).catch(() => {});
    }

    // ── EventBus ───────────────────────────────────────────────────────
    if (level === 'error' && this.config.emitErrors) {
      const bus = getDefaultEventBus();
      const errorEvent: ErrorEvent = {
        type: 'error',
        source: this.namespace,
        message,
        stack: data?.stack as string | undefined,
        timestamp: entry.timestamp,
      };
      bus.emit(errorEvent);
    }
  }
}

// ── Convenience factory ────────────────────────────────────────────────────

const loggers = new Map<string, Logger>();

/**
 * Get or create a logger for the given namespace.
 * Loggers are cached — repeated calls with the same namespace
 * return the same instance.
 */
export function getLogger(namespace: string): Logger {
  if (!loggers.has(namespace)) {
    loggers.set(namespace, new Logger(namespace));
  }
  return loggers.get(namespace)!;
}

/**
 * Create a logger with a specific runId. Useful for CLI entry points
 * that want to propagate a trace ID throughout the session.
 */
export function createLogger(namespace: string, runId: string): Logger {
  const key = `${namespace}:${runId}`;
  if (!loggers.has(key)) {
    loggers.set(key, new Logger(namespace, { runId }));
  }
  return loggers.get(key)!;
}

/**
 * Get the directory where log files are stored.
 */
export function getLogDir(): string {
  return DEFAULT_LOG_DIR;
}
