import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, mkdir, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { exportSwebenchPrediction } from '../../src/core/swebench/export.js';

const execFileAsync = promisify(execFile);

describe('exportSwebenchPrediction', () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `codegrunt-swebench-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    await execFileAsync('git', ['init'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.name', 'test'], { cwd: dir });
    await writeFile(join(dir, 'file.txt'), 'original\n', 'utf-8');
    await execFileAsync('git', ['add', 'file.txt'], { cwd: dir });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('exports a JSONL entry with instance_id, model_patch, model_name_or_path', async () => {
    await writeFile(join(dir, 'file.txt'), 'modified\n', 'utf-8');

    const result = await exportSwebenchPrediction({
      cwd: dir,
      instanceId: 'astropy__astropy-1234',
      modelName: 'deepseek-v4-pro',
    });

    const raw = await readFile(result.outputPath, 'utf-8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]);
    expect(entry.instance_id).toBe('astropy__astropy-1234');
    expect(entry.model_name_or_path).toBe('deepseek-v4-pro');
    expect(entry.model_patch).toContain('-original');
    expect(entry.model_patch).toContain('+modified');
  });

  it('defaults the output path to <cwd>/swebench_predictions.jsonl', async () => {
    await writeFile(join(dir, 'file.txt'), 'modified\n', 'utf-8');
    const result = await exportSwebenchPrediction({
      cwd: dir,
      instanceId: 'test-1',
      modelName: 'deepseek-v4-pro',
    });
    expect(result.outputPath).toBe(join(dir, 'swebench_predictions.jsonl'));
  });

  it('appends multiple predictions as separate JSONL lines', async () => {
    await writeFile(join(dir, 'file.txt'), 'change-one\n', 'utf-8');
    const first = await exportSwebenchPrediction({ cwd: dir, instanceId: 'inst-1', modelName: 'm' });

    await writeFile(join(dir, 'file.txt'), 'change-two\n', 'utf-8');
    await exportSwebenchPrediction({ cwd: dir, instanceId: 'inst-2', modelName: 'm', outputPath: first.outputPath });

    const raw = await readFile(first.outputPath, 'utf-8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).instance_id).toBe('inst-1');
    expect(JSON.parse(lines[1]).instance_id).toBe('inst-2');
  });

  it('captures staged changes in the diff', async () => {
    await writeFile(join(dir, 'file.txt'), 'staged-change\n', 'utf-8');
    await execFileAsync('git', ['add', 'file.txt'], { cwd: dir });

    const result = await exportSwebenchPrediction({ cwd: dir, instanceId: 'inst-staged', modelName: 'm' });
    const raw = await readFile(result.outputPath, 'utf-8');
    const entry = JSON.parse(raw.trim());
    expect(entry.model_patch).toContain('+staged-change');
  });

  it('produces an empty patch when there are no changes', async () => {
    const result = await exportSwebenchPrediction({ cwd: dir, instanceId: 'inst-empty', modelName: 'm' });
    expect(result.patchLength).toBe(0);
  });

  it('respects a custom outputPath', async () => {
    await writeFile(join(dir, 'file.txt'), 'modified\n', 'utf-8');
    const customPath = join(dir, 'custom_predictions.jsonl');
    const result = await exportSwebenchPrediction({
      cwd: dir,
      instanceId: 'inst-custom',
      modelName: 'm',
      outputPath: customPath,
    });
    expect(result.outputPath).toBe(customPath);
    const raw = await readFile(customPath, 'utf-8');
    expect(JSON.parse(raw.trim()).instance_id).toBe('inst-custom');
  });

  it('rejects when cwd is not a git repository', async () => {
    const nonGitDir = join(tmpdir(), `codegrunt-nongit-${Date.now()}`);
    await mkdir(nonGitDir, { recursive: true });
    try {
      await expect(
        exportSwebenchPrediction({ cwd: nonGitDir, instanceId: 'inst-x', modelName: 'm' }),
      ).rejects.toThrow(/Failed to compute git diff/);
    } finally {
      await rm(nonGitDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
