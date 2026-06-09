// ── Harness-style Pipeline Engine ──────────────────────────────────────────
// Executes a sequence of stages against a shared PipelineContext.
// Handles lifecycle hooks, events, error recovery, and cancellation.
//
// Pattern reference: Harness CI/CD pipeline executor — stages are composed
// into a directed graph. Here we start with a linear sequence but the
// architecture supports future fan-out/fan-in patterns.

import type { Pipeline, PipelineContext, PipelineResult, Stage, StageResult } from './types.js';
import { getDefaultEventBus, type StageStartedEvent, type StageFinishedEvent } from '../events/bus.js';
import { getLogger } from '../observability/logger.js';
import { getDefaultMetrics } from '../observability/metrics.js';

const log = getLogger('pipeline:engine');

export class PipelineEngine {
  /** Execute a pipeline against the given context */
  async execute(pipeline: Pipeline, ctx: PipelineContext): Promise<PipelineResult> {
    const bus = getDefaultEventBus();
    const metrics = getDefaultMetrics();
    const pipelineStart = Date.now();

    bus.emit({ type: 'pipeline:started', pipelineName: pipeline.name, timestamp: pipelineStart });
    metrics.increment('pipeline.executions');

    const overallTimer = metrics.startTimer('pipeline.duration');
    let userRejected = false;
    let pipelineError: Error | null = null;

    try {
      for (const stage of pipeline.stages) {
        if (ctx.signal?.aborted) {
          log.info(`Pipeline "${pipeline.name}" aborted at stage "${stage.name}"`);
          break;
        }

        const stageStart = Date.now();
        const stageEvent: StageStartedEvent = {
          type: 'stage:started',
          stageName: stage.name,
          pipelineName: pipeline.name,
          iteration: ctx.iteration,
          timestamp: stageStart,
        };
        bus.emit(stageEvent);

        const stageTimer = metrics.startTimer(`stage.${stage.name}`);
        let result: StageResult;

        try {
          // Run lifecycle hooks
          if ('beforeExecute' in stage && typeof (stage as any).beforeExecute === 'function') {
            await (stage as any).beforeExecute(ctx);
          }

          result = await stage.execute(ctx);

          if ('afterExecute' in stage && typeof (stage as any).afterExecute === 'function') {
            await (stage as any).afterExecute(ctx);
          }
        } catch (err) {
          const durationMs = Date.now() - stageStart;
          stageTimer();
          log.error(`Stage "${stage.name}" failed`, {
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          });
          metrics.increment('stage.errors');

          bus.emit({
            type: 'stage:finished',
            stageName: stage.name,
            pipelineName: pipeline.name,
            durationMs,
            timestamp: Date.now(),
          } as StageFinishedEvent);

          pipelineError = err instanceof Error ? err : new Error(String(err));
          break;
        }

        const durationMs = Date.now() - stageStart;
        stageTimer();

        bus.emit({
          type: 'stage:finished',
          stageName: stage.name,
          pipelineName: pipeline.name,
          durationMs,
          timestamp: Date.now(),
        } as StageFinishedEvent);

        if (result.userRejected) {
          userRejected = true;
          break;
        }

        if (result.done) {
          break;
        }

        if (!result.continue) {
          break;
        }
      }
    } finally {
      overallTimer();
      const durationMs = Date.now() - pipelineStart;
      bus.emit({
        type: 'pipeline:finished',
        pipelineName: pipeline.name,
        durationMs,
        success: !userRejected && !pipelineError,
        timestamp: Date.now(),
      });
    }

    if (pipelineError) {
      return { done: true, userRejected: false, error: pipelineError };
    }
    return { done: true, userRejected };
  }
}

// ── Pipeline Builder (fluent API) ─────────────────────────────────────────

export class PipelineBuilder {
  private stages: Stage[] = [];
  private _name = 'default';

  name(n: string): this {
    this._name = n;
    return this;
  }

  addStage(stage: Stage): this {
    this.stages.push(stage);
    return this;
  }

  build(): Pipeline {
    return { name: this._name, stages: [...this.stages] };
  }
}
