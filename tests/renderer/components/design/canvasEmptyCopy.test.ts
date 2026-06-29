// ---------------------------------------------------------------------------
// #4 画布空态文案改成对话范式（旧表单话术「点生成」已无此按钮）。
//  确认 canvasEmpty zh/en 都改成对话向，不再提「点生成 / click Generate」。
// ---------------------------------------------------------------------------
import { describe, expect, it } from 'vitest';
import { zh } from '../../../../src/renderer/i18n/zh';
import { en } from '../../../../src/renderer/i18n/en';

describe('设计画布空态文案（对话范式）', () => {
  it('zh canvasEmpty：对话向，不含旧「点生成」话术', () => {
    expect(zh.design.canvasEmpty).toContain('对话');
    expect(zh.design.canvasEmpty).not.toContain('点「生成」');
  });

  it('en canvasEmpty：对话向，不含旧 Generate 话术', () => {
    expect(en.design.canvasEmpty.toLowerCase()).toContain('chat');
    expect(en.design.canvasEmpty).not.toContain('click Generate');
  });

  it('proposalApplying loading 文案 zh/en 都已就位', () => {
    expect(zh.design.proposalApplying).toBeTruthy();
    expect(en.design.proposalApplying).toBeTruthy();
  });
});
