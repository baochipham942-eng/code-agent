import { describe, it, expect } from 'vitest';
import {
  formatDesignCanvasSessionReminder,
  composeDesignCanvasSystemPrompt,
} from '../../../src/shared/design/canvasSessionReminder';

describe('design canvas session reminder (server-side affordance)', () => {
  it('reminder 含三要点：画布会话 + ProposeCanvasOps/RequestDesignAutonomy + 严禁 shell/python', () => {
    const r = formatDesignCanvasSessionReminder();
    expect(r).toContain('design-canvas-session');
    expect(r).toContain('ProposeCanvasOps');
    expect(r).toContain('RequestDesignAutonomy');
    expect(r).toMatch(/shell|python/i);
  });

  it('composeDesignCanvasSystemPrompt：active 时把引导拼到 base 之后', () => {
    const out = composeDesignCanvasSystemPrompt('BASE', true);
    expect(out).toContain('BASE');
    expect(out).toContain('ProposeCanvasOps');
    expect(out!.indexOf('BASE')).toBeLessThan(out!.indexOf('ProposeCanvasOps'));
  });

  it('composeDesignCanvasSystemPrompt：非 active 原样返回 base，不注入', () => {
    expect(composeDesignCanvasSystemPrompt('BASE', false)).toBe('BASE');
    expect(composeDesignCanvasSystemPrompt('BASE', undefined)).toBe('BASE');
  });

  it('composeDesignCanvasSystemPrompt：active 且无 base → 仅引导', () => {
    const out = composeDesignCanvasSystemPrompt(undefined, true);
    expect(out).toContain('ProposeCanvasOps');
  });
});
