import { describe, expect, it } from 'vitest';
import {
  buildInheritanceRows,
  buildPermissionModeRows,
  buildPermissionRuleSummary,
  parsePermissionRules,
} from '../../../src/renderer/components/features/settings/tabs/GeneralSettings';

describe('GeneralSettings management helpers', () => {
  it('parses permission rules by trimming blank lines', () => {
    expect(parsePermissionRules('\n Bash(git push *) \n\nWrite(*.env)\n')).toEqual([
      'Bash(git push *)',
      'Write(*.env)',
    ]);
  });

  it('builds permission mode rows with selected state and risk labels', () => {
    const rows = buildPermissionModeRows('acceptEdits');

    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({
      id: 'acceptEdits',
      selected: true,
      actionLabel: '当前模式',
      riskLevel: 'medium',
      riskLabel: '中风险',
    });
    expect(rows[2]).toMatchObject({
      id: 'bypassPermissions',
      selected: false,
      actionLabel: '切换',
      riskLevel: 'high',
    });
  });

  it('builds inheritance rows with recommended and warning metadata', () => {
    const rows = buildInheritanceRows('strict-inherit');

    expect(rows[0]).toMatchObject({
      id: 'strict-inherit',
      selected: true,
      recommended: true,
      exposureLabel: '永不扩张',
    });
    expect(rows[2]).toMatchObject({
      id: 'independent',
      selected: false,
      statusLabel: '谨慎使用',
      exposureLabel: '可能扩张',
    });
    expect(rows[2].warning).toContain('grandfathering');
  });

  it('summarizes deny, ask, and allow rule counts', () => {
    expect(buildPermissionRuleSummary({
      denyRules: 'Bash(rm -rf *)\nWrite(/etc/*)',
      askRules: '\nBash(git push *)',
      allowRules: 'Read(*)\n\nBash(ls *)',
    })).toEqual({
      denyCount: 2,
      askCount: 1,
      allowCount: 2,
      totalCount: 5,
      highestPriority: 'Deny',
    });
  });

  it('uses the strongest available priority when no deny rules exist', () => {
    expect(buildPermissionRuleSummary({
      denyRules: '',
      askRules: '',
      allowRules: 'Read(*)',
    })).toMatchObject({
      totalCount: 1,
      highestPriority: 'Allow',
    });
  });
});
