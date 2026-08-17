import { describe, it, expect } from 'vitest';
import {
  CodeGruntError, RetryableError, ApiError, ValidationError,
  UserAbortError, ToolError, TimeoutError, formatErrorForDisplay,
} from '../../src/core/errors.js';

describe('typed error classes', () => {
  it('CodeGruntError carries a code and sets its name', () => {
    const err = new CodeGruntError('boom', 'CUSTOM_CODE');
    expect(err.code).toBe('CUSTOM_CODE');
    expect(err.name).toBe('CodeGruntError');
    expect(err.message).toBe('boom');
    expect(err).toBeInstanceOf(Error);
  });

  it('RetryableError sets code RETRYABLE', () => {
    const err = new RetryableError('timeout');
    expect(err.code).toBe('RETRYABLE');
    expect(err.name).toBe('RetryableError');
  });

  it('ApiError carries the HTTP status', () => {
    const err = new ApiError('unauthorized', 401);
    expect(err.status).toBe(401);
    expect(err.code).toBe('API_ERROR');
  });

  it('ValidationError sets code VALIDATION', () => {
    const err = new ValidationError('bad input');
    expect(err.code).toBe('VALIDATION');
  });

  it('UserAbortError has a sensible default message', () => {
    const err = new UserAbortError();
    expect(err.message).toBe('Operation cancelled by user');
    expect(err.code).toBe('USER_ABORT');
  });

  it('ToolError carries the tool name and an optional cause', () => {
    const cause = new Error('underlying failure');
    const err = new ToolError('execute_shell', 'threw', cause);
    expect(err.toolName).toBe('execute_shell');
    expect(err.cause).toBe(cause);
    expect(err.code).toBe('TOOL_ERROR');
  });

  it('TimeoutError sets code TIMEOUT', () => {
    const err = new TimeoutError('deadline exceeded');
    expect(err.code).toBe('TIMEOUT');
  });
});

describe('formatErrorForDisplay', () => {
  it('labels a RetryableError as network with a retry hint', () => {
    const { label, message } = formatErrorForDisplay(new RetryableError('connection reset'));
    expect(label).toBe('network');
    expect(message).toContain('connection reset');
    expect(message).toContain('retried 3x');
  });

  it('labels an ApiError as api and hints at /config for a 401', () => {
    const { label, message } = formatErrorForDisplay(new ApiError('invalid key', 401));
    expect(label).toBe('api');
    expect(message).toContain('/config');
  });

  it('hints at /model for a 404 ApiError', () => {
    const { message } = formatErrorForDisplay(new ApiError('model not found', 404));
    expect(message).toContain('/model');
  });

  it('gives no extra hint for an ApiError status with no special case', () => {
    const { message } = formatErrorForDisplay(new ApiError('bad request', 400));
    expect(message).toBe('bad request');
  });

  it('labels a ValidationError as config', () => {
    const { label } = formatErrorForDisplay(new ValidationError('missing field'));
    expect(label).toBe('config');
  });

  it('labels a ToolError as tool and includes the tool name', () => {
    const { label, message } = formatErrorForDisplay(new ToolError('write_file', 'disk full'));
    expect(label).toBe('tool');
    expect(message).toBe('write_file: disk full');
  });

  it('labels a TimeoutError as timeout', () => {
    const { label } = formatErrorForDisplay(new TimeoutError('took too long'));
    expect(label).toBe('timeout');
  });

  it('labels a UserAbortError as cancelled', () => {
    const { label } = formatErrorForDisplay(new UserAbortError());
    expect(label).toBe('cancelled');
  });

  it('falls back to a generic "error" label for a plain Error', () => {
    const { label, message } = formatErrorForDisplay(new Error('plain failure'));
    expect(label).toBe('error');
    expect(message).toBe('plain failure');
  });

  it('falls back gracefully for a non-Error thrown value', () => {
    const { label, message } = formatErrorForDisplay('just a string');
    expect(label).toBe('error');
    expect(message).toBe('just a string');
  });
});
