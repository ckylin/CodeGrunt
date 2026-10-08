import type { WorkspacePermissions } from '../permissions/index.js';

export type TrustMode = 'plan' | 'code' | 'auto';

/** Per-process tool-policy state: trust mode, session-wide "yes for all", workspace permissions. */
export const policyState: {
  trustMode: TrustMode;
  yesAll: boolean;
  permissions: WorkspacePermissions | null;
} = {
  trustMode: 'code',
  yesAll: false,
  permissions: null,
};

export function setTrustMode(mode: TrustMode): void {
  policyState.trustMode = mode;
  // auto mode is equivalent to yes-for-all
  if (mode === 'auto') policyState.yesAll = true;
}

export function getTrustMode(): TrustMode {
  return policyState.trustMode;
}

export function resetYesAll(): void {
  policyState.yesAll = false;
}

export function isYesAllActive(): boolean {
  return policyState.yesAll;
}

/** Set the active workspace permissions (.codegrunt/permissions.json). Called once per turn. */
export function setWorkspacePermissions(permissions: WorkspacePermissions | null): void {
  policyState.permissions = permissions;
}

export function getWorkspacePermissions(): WorkspacePermissions | null {
  return policyState.permissions;
}
