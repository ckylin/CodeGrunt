import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readdir, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { buildCrashReport, writeCrashReport, getCrashReportDir } from '../../src/core/observability/crash-report.js';

describe('buildCrashReport', () => {
  it('captures error name, message, and stack from a real Error', () => {
    const err = new Error('something broke');
    const report = buildCrashReport(err, { cwd: '/proj', task: 'do the thing', model: 'deepseek-v4-pro' });
    expect(report.errorName).toBe('Error');
    expect(report.errorMessage).toBe('something broke');
    expect(report.errorStack).toContain('something broke');
    expect(report.model).toBe('deepseek-v4-pro');
    expect(report.cwd).toBe('/proj');
    expect(report.platform).toBe(process.platform);
  });

  it('falls back to UnknownError for a non-Error thrown value', () => {
    const report = buildCrashReport('raw string throw', { cwd: '/proj', task: 't', model: 'm' });
    expect(report.errorName).toBe('UnknownError');
    expect(report.errorMessage).toBe('raw string throw');
    expect(report.errorStack).toBeUndefined();
  });

  it('truncates a long task to a preview with an ellipsis', () => {
    const longTask = 'x'.repeat(500);
    const report = buildCrashReport(new Error('e'), { cwd: '/proj', task: longTask, model: 'm' });
    expect(report.taskPreview.length).toBeLessThan(longTask.length);
    expect(report.taskPreview.endsWith('…')).toBe(true);
  });

  it('leaves a short task untouched', () => {
    const report = buildCrashReport(new Error('e'), { cwd: '/proj', task: 'short task', model: 'm' });
    expect(report.taskPreview).toBe('short task');
  });
});

describe('writeCrashReport', () => {
  const dir = getCrashReportDir();

  afterEach(async () => {
    // Clean up anything this test suite wrote, without touching real
    // crash reports a developer might have from actual runs elsewhere —
    // we only remove files whose content matches our test marker.
    try {
      const files = await readdir(dir);
      for (const f of files) {
        const full = join(dir, f);
        const content = await readFile(full, 'utf-8').catch(() => '');
        if (content.includes('__crash_report_test_marker__')) {
          await rm(full).catch(() => {});
        }
      }
    } catch { /* dir may not exist */ }
  });

  it('writes a JSON file to the crash report directory and returns its path', async () => {
    const path = await writeCrashReport(new Error('__crash_report_test_marker__'), {
      cwd: '/proj', task: 'test task', model: 'test-model',
    });
    expect(path).not.toBeNull();
    expect(path).toContain(dir);
    const content = await readFile(path!, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.errorMessage).toBe('__crash_report_test_marker__');
    expect(parsed.model).toBe('test-model');
  });

  it('never throws even if the underlying error value is unusual (e.g. undefined)', async () => {
    // writeCrashReport swallows all internal failures — this asserts the
    // promise settles (either a path or null) rather than rejecting.
    const path = await writeCrashReport(undefined, { cwd: '/proj', task: '__crash_report_test_marker__', model: 'm' });
    expect(typeof path === 'string' || path === null).toBe(true);
  });
});
