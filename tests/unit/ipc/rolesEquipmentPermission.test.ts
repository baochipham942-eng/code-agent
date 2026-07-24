import { describe, expect, it } from 'vitest';
import { parseAgentMd, updateAgentMdEquipment } from '../../../src/host/agent/hybrid/agentMdLoader';

/**
 * IPC 层是薄透传，端到端语义用「写回 → 重新解析」这条往返来钉：
 * 详情页存下的档位，下次派活读 agent.md 时必须原样拿到。
 */
describe('安全页档位往返', () => {
  const base = '---\nname: r\ndescription: d\nmodel: balanced\nmax-iterations: 30\ntools:\n  - Read\n---\n正文';
  const equipment = { skills: [], tools: ['Read'], model: 'balanced' as const, modelOverride: null, maxIterations: 30 };

  it('设置严格档后重新解析仍是严格档', () => {
    const written = updateAgentMdEquipment(base, { ...equipment, permissionPreset: 'strict' });
    expect(parseAgentMd(written, 'r.md')?.permissionPreset).toBe('strict');
  });

  it('清除后重新解析回到未设置', () => {
    const written = updateAgentMdEquipment(base, { ...equipment, permissionPreset: 'ci' });
    const cleared = updateAgentMdEquipment(written, { ...equipment, permissionPreset: null });
    expect(parseAgentMd(cleared, 'r.md')?.permissionPreset).toBeUndefined();
  });

  it('改档位不冲掉技能页与模型页的字段', () => {
    const written = updateAgentMdEquipment(base, {
      skills: ['ppt'], tools: ['Read', 'Write'], model: 'powerful',
      modelOverride: { provider: 'zhipu', model: 'glm-5' }, maxIterations: 42, permissionPreset: 'strict',
    });
    const parsed = parseAgentMd(written, 'r.md');
    expect(parsed?.tools).toEqual(['Read', 'Write']);
    expect(parsed?.model).toBe('powerful');
    expect(parsed?.modelOverride).toEqual({ provider: 'zhipu', model: 'glm-5' });
    expect(parsed?.maxIterations).toBe(42);
    expect(parsed?.permissionPreset).toBe('strict');
  });
});
