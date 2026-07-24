import { afterEach, describe, expect, it } from 'vitest';
import { getAgentPermissionPreset, getPredefinedAgent } from '../../../src/host/agent/agentDefinition';
import { setCustomAgentMapForTest } from '../../../src/host/agent/agentRegistry';
import { parseAgentMd } from '../../../src/host/agent/hybrid/agentMdLoader';
import { getPresetConfig } from '../../../src/host/services/core/permissionPresets';
import type { FullAgentConfig } from '../../../src/shared/contract/agentTypes';

/**
 * 承重点 A：断言打在 getAgentPermissionPreset —— 生产代码三条派活路径
 * （spawnAgent:346 / subagentExecutor:1187 / task.ts:270）实际调用的那个出口。
 * 打在 parseAgentMd 上是假绿：有人把 toFullAgentConfig 改回硬编码照样通过。
 */
describe('per-role 审批档真漏斗', () => {
  const agentWith = (preset?: 'strict' | 'development' | 'ci'): FullAgentConfig => {
    const override = preset ? `permission-override: ${preset}\n` : '';
    const parsed = parseAgentMd(
      `---\nname: researcher\ndescription: d\n${override}---\np`,
      'researcher.md',
    );
    if (!parsed) throw new Error('测试 agent.md 解析失败');
    setCustomAgentMapForTest(new Map([
      [parsed.id, { ...parsed, source: 'user' }],
    ]));
    return getPredefinedAgent(parsed.id);
  };

  afterEach(() => {
    setCustomAgentMapForTest(new Map());
  });

  it('A：声明的档位到达派活出口', () => {
    expect(getAgentPermissionPreset(agentWith('strict'))).toBe('strict');
    expect(getAgentPermissionPreset(agentWith('ci'))).toBe('ci');
  });

  it('A：未声明回落 development，行为与改造前一致', () => {
    expect(getAgentPermissionPreset(agentWith())).toBe('development');
  });

  /**
   * 承重点 B：档位真的改变了子 agent 拿到的审批配置。
   * subagentPipeline:166 就是 config.security?.permissionPreset → getPresetConfig 这一步。
   */
  it('B：严格档专家的读取操作也不自动批准', () => {
    const config = getPresetConfig(getAgentPermissionPreset(agentWith('strict')), '/tmp/work');
    expect(config.autoApprove.read).toBe(false);
    expect(config.trustProjectDirectory).toBe(false);
  });

  it('B：标准档专家读取自动、工作目录进入信任列表', () => {
    const config = getPresetConfig(getAgentPermissionPreset(agentWith()), '/tmp/work');
    expect(config.autoApprove.read).toBe(true);
    expect(config.trustedDirectories).toContain('/tmp/work');
  });
});
