// ============================================================================
// 指挥台派活工具 2026-08-08 改名（spawn_task → delegate_task）的向后兼容契约
//
// 为什么要这道门：改名当天做变异验证（注释掉 TOOL_ALIASES 里那条）时**全量测试全绿**，
// 说明这条兼容此前零覆盖。它不是可有可无的——历史会话的 messages.tool_calls 里存的是
// 旧名，回看旧会话、以及模型沿用旧叫法时，都要能解析回当前工具。
//
// 改名本身的动机见 sessionCommandCenter.schema.ts 的头注：真机实测里模型宁可回复
// 「Edit/Write/Bash 均被禁用」也不调 spawn_task，因为它从 tool schema 推断能力边界，
// 而 spawn_task 这个名字与「写文件」无语义关联。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { resolveToolAlias } from '../../../src/host/services/toolSearch/deferredTools';
import { delegateTaskSchema } from '../../../src/host/tools/modules/commandCenter/sessionCommandCenter.schema';
import { SESSION_COMMAND_CENTER_BRAIN_TOOL_NAMES } from '../../../src/shared/constants/sessionCommandCenter';
import { TOOL_CONSENT_MAP } from '../../../src/shared/constants/toolConsentGroups';

describe('spawn_task → delegate_task 改名兼容', () => {
  it('旧名能解析回新工具（历史会话 tool_calls + 模型沿用旧叫法）', () => {
    expect(resolveToolAlias('spawn_task')).toBe('delegate_task');
  });

  it('新名是规范名，解析后不再被二次映射', () => {
    expect(resolveToolAlias('delegate_task')).toBe('delegate_task');
    expect(delegateTaskSchema.name).toBe('delegate_task');
  });

  it('新旧两个名字都能归到同一个审批组（回看旧会话不掉组）', () => {
    expect(TOOL_CONSENT_MAP.delegate_task).toEqual(TOOL_CONSENT_MAP.spawn_task);
  });

  it('前台 allowlist 用的是新名', () => {
    expect(SESSION_COMMAND_CENTER_BRAIN_TOOL_NAMES).toContain('delegate_task');
    expect(SESSION_COMMAND_CENTER_BRAIN_TOOL_NAMES).not.toContain('spawn_task');
  });
});

describe('delegate_task 的描述承载路由契约', () => {
  // 竞品调研结论：模型对工具 description 的遵循度远高于系统提示词；system prompt 与
  // tool schema 冲突时模型信 schema。所以「写请求必须走这里」必须写在描述里，不能只写提示词。
  const description = delegateTaskSchema.description;

  it('把自己声明为写入类请求的唯一受理入口', () => {
    expect(description).toContain('唯一');
    for (const intent of ['修改', '删除', '运行命令']) {
      expect(description).toContain(intent);
    }
  });

  it('显式覆盖「已经读过文件之后」——真机 FAIL 的触发条件', () => {
    // 对照实验：新会话第一句直接写 → 正确派活；先读一轮再写 → 拒绝。
    // 描述必须把后一种情形点名，否则模型在「自己动手」惯性里撞墙就收工。
    expect(description).toContain('已经读过文件之后');
  });

  it('说明它产出什么，而不是说它管理什么', () => {
    // Zed 的 create_thread / Cline 的 switch_to_act_mode 同理：以产出命名与描述。
    expect(description).toContain('带完整写工具的后台任务');
  });

  it('保留 accepted ≠ 完成的契约', () => {
    expect(description).toContain('accepted');
  });
});
