// ── Workspace Permissions ─────────────────────────────────────────────────
// Per-workspace, tool-level allow/deny/ask overrides layered on top of the
// global trust mode (plan/code/auto). Config lives at .codegrunt/permissions.json
// in the project root and is optional — absence means "defer to trust mode"
// for every tool.
//
// Semantics:
//   deny — hard block, tool call fails immediately (like plan mode's block)
//   allow — skip confirmation prompts for this tool, even outside auto mode
//   ask — always prompt for confirmation, even in auto mode / yes-for-all

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { getLogger } from '../observability/logger.js';

const log = getLogger('permissions');

export type PermissionAction = 'allow' | 'deny' | 'ask';

export interface WorkspacePermissions {
  tools: Record<string, PermissionAction>;
}

function permissionsPath(cwd: string): string {
  return join(cwd, '.codegrunt', 'permissions.json');
}

/** Load .codegrunt/permissions.json. Returns null if the file doesn't exist or is invalid. */
export async function loadWorkspacePermissions(cwd: string): Promise<WorkspacePermissions | null> {
  const path = permissionsPath(cwd);
  if (!existsSync(path)) return null;

  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' && parsed !== null &&
      'tools' in parsed && typeof (parsed as { tools: unknown }).tools === 'object'
    ) {
      return parsed as WorkspacePermissions;
    }
    log.warn('Invalid permissions.json shape, ignoring', { path });
    return null;
  } catch (err) {
    log.warn('Failed to read permissions.json, ignoring', { path, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Save a WorkspacePermissions object to .codegrunt/permissions.json. */
export async function saveWorkspacePermissions(cwd: string, permissions: WorkspacePermissions): Promise<void> {
  const path = permissionsPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(permissions, null, 2) + '\n', 'utf-8');
}

/** Get the configured action for a tool, or null if unconfigured (defer to trust mode). */
export function getToolPermission(
  permissions: WorkspacePermissions | null,
  toolName: string,
): PermissionAction | null {
  if (!permissions) return null;
  return permissions.tools[toolName] ?? null;
}

/** Set a single tool's permission and persist. */
export async function setToolPermission(
  cwd: string,
  toolName: string,
  action: PermissionAction,
): Promise<WorkspacePermissions> {
  const existing = (await loadWorkspacePermissions(cwd)) ?? { tools: {} };
  const updated: WorkspacePermissions = { tools: { ...existing.tools, [toolName]: action } };
  await saveWorkspacePermissions(cwd, updated);
  return updated;
}

/** Remove a single tool's permission override and persist. */
export async function resetToolPermission(cwd: string, toolName: string): Promise<WorkspacePermissions> {
  const existing = (await loadWorkspacePermissions(cwd)) ?? { tools: {} };
  const tools = { ...existing.tools };
  delete tools[toolName];
  const updated: WorkspacePermissions = { tools };
  await saveWorkspacePermissions(cwd, updated);
  return updated;
}
