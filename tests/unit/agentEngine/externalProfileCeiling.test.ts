import { describe, expect, it } from 'vitest';
import {
  clampProfileToCeiling,
  externalProfileCeilingForSessionMode,
} from '../../../src/shared/contract/agentEngine';
import {
  permissionModeAutoApproves,
  type PermissionMode,
} from '../../../src/host/permissions/modes';

const ALL_MODES = [
  'default',
  'readOnly',
  'acceptEdits',
  'dontAsk',
  'bypassPermissions',
  'plan',
  'delegate',
] as const satisfies readonly PermissionMode[];

const EXPECTED_CEILING: Record<PermissionMode, 'read_only' | 'workspace_write'> = {
  default: 'workspace_write',
  readOnly: 'read_only',
  acceptEdits: 'workspace_write',
  dontAsk: 'read_only',
  bypassPermissions: 'workspace_write',
  plan: 'read_only',
  delegate: 'read_only',
};

function ceilingRank(mode: string | undefined): number {
  return externalProfileCeilingForSessionMode(mode) === 'workspace_write' ? 1 : 0;
}

/** 免确认宽度：execute > 仅 write > 都不免。default 不在这把尺子上（它不免确认，但外部引擎仍可问审批）。 */
function autoApproveRank(mode: PermissionMode): number {
  if (permissionModeAutoApproves(mode, 'execute')) return 2;
  if (permissionModeAutoApproves(mode, 'write')) return 1;
  return 0;
}

describe('external profile ceiling for session permission mode', () => {
  it('maps every PermissionMode, undefined, and a garbage string', () => {
    for (const mode of ALL_MODES) {
      expect(externalProfileCeilingForSessionMode(mode)).toBe(EXPECTED_CEILING[mode]);
    }
    expect(externalProfileCeilingForSessionMode(undefined)).toBe('read_only');
    expect(externalProfileCeilingForSessionMode('not-a-mode')).toBe('read_only');
  });

  it('keeps bypassPermissions at the acceptEdits ceiling and never promotes restrictive modes', () => {
    expect(externalProfileCeilingForSessionMode('bypassPermissions'))
      .toBe(externalProfileCeilingForSessionMode('acceptEdits'));

    for (const mode of ['readOnly', 'dontAsk', 'plan', 'delegate'] as const) {
      expect(externalProfileCeilingForSessionMode(mode)).toBe('read_only');
    }

    for (const left of ALL_MODES) {
      if (left === 'default') continue;
      for (const right of ALL_MODES) {
        if (right === 'default') continue;
        if (autoApproveRank(left) < autoApproveRank(right)) {
          expect(ceilingRank(left)).toBeLessThanOrEqual(ceilingRank(right));
        }
      }
    }
  });

  it('clamps a profile so the result is never more permissive than either input', () => {
    expect(clampProfileToCeiling('workspace_write', 'read_only', 'codex_cli')).toBe('read_only');
    expect(clampProfileToCeiling('workspace_write', 'workspace_write', 'kimi_code_acp')).toBe('workspace_write');
    expect(clampProfileToCeiling('read_only', 'workspace_write', 'codex_cli')).toBe('read_only');
    expect(clampProfileToCeiling('default', 'workspace_write', 'native')).toBe('default');
    expect(clampProfileToCeiling('default', 'read_only', 'native')).toBe('read_only');
    expect(clampProfileToCeiling('default', 'workspace_write', 'codex_cli')).toBe('default');
    expect(clampProfileToCeiling('default', 'read_only', 'codex_cli')).toBe('default');
    expect(clampProfileToCeiling(undefined, 'workspace_write', 'native')).toBe('read_only');
    expect(clampProfileToCeiling('workspace_write', 'read_only')).toBe('read_only');
  });
});
