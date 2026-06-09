// ── Harness-style Event Bus ─────────────────────────────────────────────────
// Provides typed, observable events for all major lifecycle transitions.
// Inspired by Harness's event-driven architecture for pipeline observability.
//
// Events are strongly typed — each event has a known shape and can be
// subscribed to individually. The bus is synchronous by default to avoid
// ordering issues, but async subscribers are supported.

export type EventHandler<T> = (event: T) => void | Promise<void>;

// ── Event Definitions ──────────────────────────────────────────────────────

export interface StageStartedEvent {
  type: 'stage:started';
  stageName: string;
  pipelineName: string;
  iteration: number;
  timestamp: number;
}

export interface StageFinishedEvent {
  type: 'stage:finished';
  stageName: string;
  pipelineName: string;
  durationMs: number;
  timestamp: number;
}

export interface ToolCallEvent {
  type: 'tool:called';
  toolName: string;
  args: Record<string, unknown>;
  iteration: number;
  timestamp: number;
}

export interface ToolResultEvent {
  type: 'tool:result';
  toolName: string;
  success: boolean;
  error?: string;
  userRejected?: boolean;
  timestamp: number;
}

export interface LLMRequestEvent {
  type: 'llm:request';
  model: string;
  messageCount: number;
  estimatedTokens: number;
  timestamp: number;
}

export interface LLMUsageEvent {
  type: 'llm:usage';
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  costUsd: number;
  timestamp: number;
}

export interface ErrorEvent {
  type: 'error';
  source: string;
  message: string;
  stack?: string;
  timestamp: number;
}

export type CodeGruntEvent =
  | { type: 'pipeline:started'; pipelineName: string; timestamp: number }
  | { type: 'pipeline:finished'; pipelineName: string; durationMs: number; success: boolean; timestamp: number }
  | StageStartedEvent
  | StageFinishedEvent
  | ToolCallEvent
  | ToolResultEvent
  | LLMRequestEvent
  | LLMUsageEvent
  | ErrorEvent;

// ── Event Bus ──────────────────────────────────────────────────────────────

export class EventBus {
  private handlers = new Map<string, Set<EventHandler<CodeGruntEvent>>>();

  /** Subscribe to a specific event type */
  on<T extends CodeGruntEvent>(eventType: T['type'], handler: EventHandler<T>): () => void {
    const key = eventType as string;
    if (!this.handlers.has(key)) {
      this.handlers.set(key, new Set());
    }
    this.handlers.get(key)!.add(handler as EventHandler<CodeGruntEvent>);
    return () => this.handlers.get(key)?.delete(handler as EventHandler<CodeGruntEvent>);
  }

  /** Emit an event to all subscribers */
  emit(event: CodeGruntEvent): void {
    const handlers = this.handlers.get(event.type);
    if (handlers) {
      for (const h of handlers) {
        try { h(event); } catch { /* don't let one handler break others */ }
      }
    }
  }

  /** Remove all subscribers */
  clear(): void { this.handlers.clear(); }
}

// ── Singleton for convenience (can also create separate instances) ─────────

let defaultBus: EventBus | null = null;

export function getDefaultEventBus(): EventBus {
  if (!defaultBus) defaultBus = new EventBus();
  return defaultBus;
}
