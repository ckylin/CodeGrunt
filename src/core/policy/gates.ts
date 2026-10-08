import type { ToolResult } from '../../types.js';
import type { PermissionAction } from '../permissions/index.js';
import { policyState } from './state.js';

export interface GateContext {
  name: string;
  args: Record<string, unknown>;
  /** Parameters the tool's own schema marks required. */
  required: string[];
  /** The tool declared `meta.destructive`. */
  destructive: boolean;
  /** Workspace permission override for this tool, if any. */
  permission: PermissionAction | null;
}

/** A gate either lets the call through (null) or ends it with a result. */
export type Gate = (ctx: GateContext) => ToolResult | null;

const requiredParams: Gate = ({ name, args, required }) => {
  for (const p of required) {
    if (args[p] === undefined || args[p] === null) {
      return { success: false, output: '', error: `Missing required parameter "${p}" for tool ${name}` };
    }
  }
  return null;
};

// A hard deny beats everything, including plan and auto trust modes.
const workspaceDeny: Gate = ({ name, permission }) =>
  permission === 'deny'
    ? {
        success: false,
        output: '',
        error: `[permissions] Tool "${name}" is denied by .codegrunt/permissions.json.`,
        userRejected: true,
      }
    : null;

const planMode: Gate = ({ name, destructive, permission }) =>
  policyState.trustMode === 'plan' && destructive && permission !== 'allow'
    ? {
        success: false,
        output: '',
        error: `[plan mode] Tool "${name}" is blocked in plan (read-only) mode. Switch to code or auto mode with /trust.`,
        userRejected: true,
      }
    : null;

/** Order matters: argument validity first, then the hard deny, then plan mode. */
const GATES: readonly Gate[] = [requiredParams, workspaceDeny, planMode];

export function runGates(ctx: GateContext): ToolResult | null {
  for (const gate of GATES) {
    const blocked = gate(ctx);
    if (blocked) return blocked;
  }
  return null;
}
