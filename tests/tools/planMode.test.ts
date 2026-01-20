// ============================================================================
// Plan Mode Tools Unit Tests
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enterPlanModeTool } from '../../src/main/tools/planning/enterPlanMode';
import { exitPlanModeTool } from '../../src/main/tools/planning/exitPlanMode';
import type { ToolContext } from '../../src/main/tools/toolRegistry';

describe('Plan Mode Tools', () => {
  let mockContext: ToolContext;

  beforeEach(() => {
    mockContext = {
      workingDirectory: '/test/project',
      conversationId: 'test-conv-id',
      generationId: 'gen3',
      setPlanMode: vi.fn(),
      emitEvent: vi.fn(),
    };
  });

  describe('enter_plan_mode', () => {
    it('should activate plan mode', async () => {
      const result = await enterPlanModeTool.execute({}, mockContext);

      expect(result.success).toBe(true);
      expect(mockContext.setPlanMode).toHaveBeenCalledWith(true);
    });

    it('should emit planModeChanged event', async () => {
      await enterPlanModeTool.execute({ reason: '复杂功能实现' }, mockContext);

      expect(mockContext.emitEvent).toHaveBeenCalledWith('planModeChanged', {
        active: true,
        reason: '复杂功能实现',
      });
    });

    it('should use default reason when not provided', async () => {
      const result = await enterPlanModeTool.execute({}, mockContext);

      expect(result.output).toContain('复杂任务需要前期规划');
    });

    it('should include planning guidance in output', async () => {
      const result = await enterPlanModeTool.execute({}, mockContext);

      expect(result.output).toContain('已进入规划模式');
      expect(result.output).toContain('探索与设计');
      expect(result.output).toContain('exit_plan_mode');
    });

    it('should be available in gen3+', () => {
      expect(enterPlanModeTool.generations).toContain('gen3');
      expect(enterPlanModeTool.generations).toContain('gen4');
      expect(enterPlanModeTool.generations).toContain('gen8');
      expect(enterPlanModeTool.generations).not.toContain('gen1');
      expect(enterPlanModeTool.generations).not.toContain('gen2');
    });

    it('should not require permission', () => {
      expect(enterPlanModeTool.requiresPermission).toBe(false);
      expect(enterPlanModeTool.permissionLevel).toBe('read');
    });

    it('should handle missing setPlanMode gracefully', async () => {
      const contextWithoutSetPlanMode = {
        ...mockContext,
        setPlanMode: undefined,
      };

      const result = await enterPlanModeTool.execute(
        {},
        contextWithoutSetPlanMode
      );

      expect(result.success).toBe(true);
    });
  });

  describe('exit_plan_mode', () => {
    it('should deactivate plan mode with valid plan', async () => {
      const plan = `## 实现计划
1. 创建组件
2. 添加样式
3. 编写测试`;

      const result = await exitPlanModeTool.execute({ plan }, mockContext);

      expect(result.success).toBe(true);
      expect(mockContext.setPlanMode).toHaveBeenCalledWith(false);
    });

    it('should emit planModeChanged event with plan', async () => {
      const plan = '测试计划内容';

      await exitPlanModeTool.execute({ plan }, mockContext);

      expect(mockContext.emitEvent).toHaveBeenCalledWith('planModeChanged', {
        active: false,
        plan,
      });
    });

    it('should fail when plan is empty', async () => {
      const result = await exitPlanModeTool.execute({ plan: '' }, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('请提供实现计划');
    });

    it('should fail when plan is missing', async () => {
      const result = await exitPlanModeTool.execute({}, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('请提供实现计划');
    });

    it('should fail when plan is whitespace only', async () => {
      const result = await exitPlanModeTool.execute(
        { plan: '   ' },
        mockContext
      );

      expect(result.success).toBe(false);
    });

    it('should include plan in output', async () => {
      const plan = '这是一个测试计划';

      const result = await exitPlanModeTool.execute({ plan }, mockContext);

      expect(result.output).toContain(plan);
      expect(result.output).toContain('实现计划');
    });

    it('should include confirmation options in output', async () => {
      const result = await exitPlanModeTool.execute(
        { plan: '计划内容' },
        mockContext
      );

      expect(result.output).toContain('确认执行');
      expect(result.output).toContain('修改计划');
      expect(result.output).toContain('取消');
    });

    it('should set requiresUserConfirmation metadata', async () => {
      const result = await exitPlanModeTool.execute(
        { plan: '计划内容' },
        mockContext
      );

      expect(result.metadata).toBeDefined();
      expect(result.metadata?.requiresUserConfirmation).toBe(true);
      expect(result.metadata?.confirmationType).toBe('plan_approval');
      expect(result.metadata?.plan).toBe('计划内容');
    });

    it('should be available in gen3+', () => {
      expect(exitPlanModeTool.generations).toContain('gen3');
      expect(exitPlanModeTool.generations).toContain('gen5');
      expect(exitPlanModeTool.generations).toContain('gen8');
    });

    it('should require plan parameter in schema', () => {
      const schema = exitPlanModeTool.inputSchema;
      expect(schema.required).toContain('plan');
    });
  });

  describe('Plan Mode Workflow', () => {
    it('should support full workflow: enter -> exit', async () => {
      // Enter plan mode
      const enterResult = await enterPlanModeTool.execute(
        { reason: '实现新功能' },
        mockContext
      );
      expect(enterResult.success).toBe(true);

      // Verify plan mode is active
      expect(mockContext.setPlanMode).toHaveBeenCalledWith(true);

      // Exit plan mode with plan
      const exitResult = await exitPlanModeTool.execute(
        {
          plan: `## 计划
1. 步骤一
2. 步骤二`,
        },
        mockContext
      );
      expect(exitResult.success).toBe(true);

      // Verify plan mode is deactivated
      expect(mockContext.setPlanMode).toHaveBeenCalledWith(false);
    });
  });
});
