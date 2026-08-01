import { describe, it, expect } from 'vitest';
import {
  formatDesignCanvasSessionReminder,
  composeDesignCanvasSystemPrompt,
} from '../../../src/shared/design/canvasSessionReminder';

describe('design canvas session reminder (server-side affordance)', () => {
  it('reminder 含三要点：画布会话 + ProposeCanvasOps/RequestDesignAutonomy + 严禁 shell/python', () => {
    const r = formatDesignCanvasSessionReminder(true);
    expect(r).toContain('design-canvas-session');
    expect(r).toContain('ProposeCanvasOps');
    expect(r).toContain('RequestDesignAutonomy');
    expect(r).toMatch(/shell|python/i);
  });

  // 注入卫生工单（2026-08-01）：host 版此前没有 canvasEmpty 动态参数，删掉 renderer 侧
  // 老模板前补齐——否则"画布已有元素"态相对旧版有语义损失。
  it('reminder 按 canvasEmpty 带空/非空态文案', () => {
    expect(formatDesignCanvasSessionReminder(true)).toContain('为空');
    expect(formatDesignCanvasSessionReminder(false)).toContain('已有元素');
    expect(formatDesignCanvasSessionReminder(false)).not.toContain('画布当前为空');
  });

  it('composeDesignCanvasSystemPrompt：active 时把引导拼到 base 之后，且带上 canvasEmpty 态', () => {
    const out = composeDesignCanvasSystemPrompt('BASE', true, false);
    expect(out).toContain('BASE');
    expect(out).toContain('ProposeCanvasOps');
    expect(out).toContain('已有元素');
    expect(out!.indexOf('BASE')).toBeLessThan(out!.indexOf('ProposeCanvasOps'));
  });

  it('composeDesignCanvasSystemPrompt：非 active 原样返回 base，不注入', () => {
    expect(composeDesignCanvasSystemPrompt('BASE', false, true)).toBe('BASE');
    expect(composeDesignCanvasSystemPrompt('BASE', undefined, true)).toBe('BASE');
  });

  it('composeDesignCanvasSystemPrompt：active 且无 base → 仅引导', () => {
    const out = composeDesignCanvasSystemPrompt(undefined, true, true);
    expect(out).toContain('ProposeCanvasOps');
    expect(out).toContain('为空');
  });

  // 注入卫生工单（2026-08-01）修 3：真机走查实证「通过侧边栏打开 example.com」在设计画布
  // 会话被劫持成 ProposeCanvasOps 审批超时 5m38s——浏览网页不是画布视觉产物，补一条边界。
  it('reminder 含边界句：浏览/打开网页不属于画布产物，改用浏览器 surface 工具', () => {
    const r = formatDesignCanvasSessionReminder(true);
    expect(r).toContain('浏览');
    expect(r).toContain('浏览器 surface 工具');
    expect(r).toContain('右栏浏览器 tab');
  });
});
