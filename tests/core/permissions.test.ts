import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadWorkspacePermissions,
  saveWorkspacePermissions,
  getToolPermission,
  setToolPermission,
  resetToolPermission,
} from '../../src/core/permissions/index.js';

describe('permissions', () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `codegrunt-perm-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  describe('loadWorkspacePermissions', () => {
    it('returns null when permissions.json does not exist', async () => {
      const result = await loadWorkspacePermissions(dir);
      expect(result).toBeNull();
    });

    it('loads a valid permissions.json', async () => {
      await mkdir(join(dir, '.codegrunt'), { recursive: true });
      await writeFile(
        join(dir, '.codegrunt', 'permissions.json'),
        JSON.stringify({ tools: { execute_shell: 'ask' } }),
        'utf-8',
      );
      const result = await loadWorkspacePermissions(dir);
      expect(result).toEqual({ tools: { execute_shell: 'ask' } });
    });

    it('returns null for malformed JSON', async () => {
      await mkdir(join(dir, '.codegrunt'), { recursive: true });
      await writeFile(join(dir, '.codegrunt', 'permissions.json'), '{ not valid json', 'utf-8');
      const result = await loadWorkspacePermissions(dir);
      expect(result).toBeNull();
    });

    it('returns null when shape is invalid (missing tools key)', async () => {
      await mkdir(join(dir, '.codegrunt'), { recursive: true });
      await writeFile(join(dir, '.codegrunt', 'permissions.json'), JSON.stringify({ foo: 'bar' }), 'utf-8');
      const result = await loadWorkspacePermissions(dir);
      expect(result).toBeNull();
    });

    it('returns null when tools is not an object', async () => {
      await mkdir(join(dir, '.codegrunt'), { recursive: true });
      await writeFile(join(dir, '.codegrunt', 'permissions.json'), JSON.stringify({ tools: 'nope' }), 'utf-8');
      const result = await loadWorkspacePermissions(dir);
      expect(result).toBeNull();
    });
  });

  describe('saveWorkspacePermissions', () => {
    it('creates .codegrunt directory and writes the file', async () => {
      await saveWorkspacePermissions(dir, { tools: { write_file: 'allow' } });
      const raw = await readFile(join(dir, '.codegrunt', 'permissions.json'), 'utf-8');
      expect(JSON.parse(raw)).toEqual({ tools: { write_file: 'allow' } });
    });

    it('overwrites an existing file', async () => {
      await saveWorkspacePermissions(dir, { tools: { write_file: 'allow' } });
      await saveWorkspacePermissions(dir, { tools: { write_file: 'deny' } });
      const result = await loadWorkspacePermissions(dir);
      expect(result).toEqual({ tools: { write_file: 'deny' } });
    });
  });

  describe('getToolPermission', () => {
    it('returns null when permissions is null', () => {
      expect(getToolPermission(null, 'write_file')).toBeNull();
    });

    it('returns null when tool is not configured', () => {
      expect(getToolPermission({ tools: { write_file: 'allow' } }, 'execute_shell')).toBeNull();
    });

    it('returns the configured action for a tool', () => {
      expect(getToolPermission({ tools: { write_file: 'deny' } }, 'write_file')).toBe('deny');
    });
  });

  describe('setToolPermission', () => {
    it('creates a new permissions file when none exists', async () => {
      const result = await setToolPermission(dir, 'execute_shell', 'ask');
      expect(result).toEqual({ tools: { execute_shell: 'ask' } });
      const reloaded = await loadWorkspacePermissions(dir);
      expect(reloaded).toEqual({ tools: { execute_shell: 'ask' } });
    });

    it('merges with existing tool permissions', async () => {
      await setToolPermission(dir, 'write_file', 'allow');
      const result = await setToolPermission(dir, 'execute_shell', 'deny');
      expect(result).toEqual({ tools: { write_file: 'allow', execute_shell: 'deny' } });
    });

    it('overwrites an existing action for the same tool', async () => {
      await setToolPermission(dir, 'write_file', 'allow');
      const result = await setToolPermission(dir, 'write_file', 'deny');
      expect(result).toEqual({ tools: { write_file: 'deny' } });
    });
  });

  describe('resetToolPermission', () => {
    it('removes a single tool override and keeps the rest', async () => {
      await setToolPermission(dir, 'write_file', 'allow');
      await setToolPermission(dir, 'execute_shell', 'deny');
      const result = await resetToolPermission(dir, 'write_file');
      expect(result).toEqual({ tools: { execute_shell: 'deny' } });
    });

    it('is a no-op when the tool was not configured', async () => {
      await setToolPermission(dir, 'execute_shell', 'deny');
      const result = await resetToolPermission(dir, 'write_file');
      expect(result).toEqual({ tools: { execute_shell: 'deny' } });
    });

    it('is a no-op when no permissions file exists', async () => {
      const result = await resetToolPermission(dir, 'write_file');
      expect(result).toEqual({ tools: {} });
    });
  });
});
