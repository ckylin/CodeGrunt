import { describe, it, expect, vi } from 'vitest';
import { EventBus, getDefaultEventBus, type CodeGruntEvent } from '../../src/core/events/bus.js';

const errorEvent = (message = 'boom'): CodeGruntEvent => ({ type: 'error', source: 'test', message, timestamp: 1 });

describe('EventBus', () => {
  it('delivers an event only to subscribers of that type', () => {
    const bus = new EventBus();
    const onError = vi.fn();
    const onTool = vi.fn();
    bus.on('error', onError);
    bus.on('tool:called', onTool);
    bus.emit(errorEvent());
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(errorEvent());
    expect(onTool).not.toHaveBeenCalled();
  });

  it('emitting with no subscribers is a no-op', () => {
    expect(() => new EventBus().emit(errorEvent())).not.toThrow();
  });

  it('on() returns an unsubscribe function', () => {
    const bus = new EventBus();
    const h = vi.fn();
    const off = bus.on('error', h);
    off();
    bus.emit(errorEvent());
    expect(h).not.toHaveBeenCalled();
  });

  it('registering the same handler twice delivers once (handlers are kept in a Set)', () => {
    const bus = new EventBus();
    const h = vi.fn();
    bus.on('error', h);
    bus.on('error', h);
    bus.emit(errorEvent());
    expect(h).toHaveBeenCalledTimes(1);
  });

  it('a throwing handler is swallowed and later handlers still run', () => {
    const bus = new EventBus();
    const after = vi.fn();
    bus.on('error', () => { throw new Error('handler failed'); });
    bus.on('error', after);
    expect(() => bus.emit(errorEvent())).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('calls handlers in subscription order', () => {
    const bus = new EventBus();
    const order: number[] = [];
    bus.on('error', () => { order.push(1); });
    bus.on('error', () => { order.push(2); });
    bus.emit(errorEvent());
    expect(order).toEqual([1, 2]);
  });

  it('clear() removes every subscriber', () => {
    const bus = new EventBus();
    const h = vi.fn();
    bus.on('error', h);
    bus.clear();
    bus.emit(errorEvent());
    expect(h).not.toHaveBeenCalled();
  });

  it('routes the orchestrator:batch event type', () => {
    const bus = new EventBus();
    const h = vi.fn();
    bus.on('orchestrator:batch', h);
    const event: CodeGruntEvent = {
      type: 'orchestrator:batch', batchIndex: 0, mode: 'parallel', stepIds: [1, 2],
      succeededStepIds: [1], failedStepIds: [2], durationMs: 5, timestamp: 1,
    };
    bus.emit(event);
    expect(h).toHaveBeenCalledWith(event);
  });

  it('getDefaultEventBus() returns one shared instance', () => {
    expect(getDefaultEventBus()).toBe(getDefaultEventBus());
  });
});
