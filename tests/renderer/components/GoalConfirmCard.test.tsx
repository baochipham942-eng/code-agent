import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GoalConfirmCard } from '../../../src/renderer/components/features/chat/ChatInput/GoalConfirmCard';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

const noop = () => {};

const render = (over: Partial<React.ComponentProps<typeof GoalConfirmCard>> = {}) =>
  renderToStaticMarkup(
    <GoalConfirmCard
      initialGoal="把首页改成深色"
      verifyCandidates={['npm run typecheck', 'npm test']}
      submitting={false}
      onSubmit={noop}
      onDismiss={noop}
      {...over}
    />,
  );

describe('GoalConfirmCard（安静确认卡：默认只有 目标+验证命令+启动）', () => {
  it('预填目标原话，标题与按钮走 i18n', () => {
    const html = render();
    expect(html).toContain('把首页改成深色');
    expect(html).toContain(zh.goalConfirm.title);
    expect(html).toContain(zh.goalConfirm.start);
  });

  it('验证命令是候选下拉：包含项目探测候选 + 留空选项，不可自由输入', () => {
    const html = render();
    expect(html).toContain('npm run typecheck');
    expect(html).toContain('npm test');
    expect(html).toContain(zh.goalConfirm.verifyEmpty);
    expect(html).toContain('data-goal-field="verify-select"');
  });

  it('默认折叠：软验收/边界/暂停条件/预算字段不出现在首屏', () => {
    const html = render();
    expect(html).toContain(zh.goalConfirm.advancedToggle);
    expect(html).not.toContain('data-goal-field="acceptance"');
    expect(html).not.toContain('data-goal-field="boundaries"');
    expect(html).not.toContain('data-goal-field="max-turns"');
  });

  it('展开高级编辑后出现完整表单字段（含自定义验证命令输入）', () => {
    const html = render({ initialAdvancedOpen: true });
    expect(html).toContain(zh.goalConfirm.acceptanceLabel);
    expect(html).toContain(zh.goalConfirm.boundariesLabel);
    expect(html).toContain(zh.goalConfirm.pauseLabel);
    expect(html).toContain(zh.goalConfirm.maxTurnsLabel);
    expect(html).toContain(zh.goalConfirm.verifyCustomLabel);
  });

  it('无候选时验证命令默认留空，卡片仍可启动', () => {
    const html = render({ verifyCandidates: [] });
    expect(html).toContain(zh.goalConfirm.verifyEmpty);
    expect(html).toContain('data-goal-start');
  });

  it('目标为空时启动按钮禁用（引导态，替代旧大表单）', () => {
    const html = render({ initialGoal: '' });
    expect(html).toMatch(/data-goal-start[^>]*disabled/);
  });

  it('zh/en 键对齐（Translations 类型推导的运行时兜底断言）', () => {
    expect(Object.keys(en.goalConfirm).sort()).toEqual(Object.keys(zh.goalConfirm).sort());
  });
});
