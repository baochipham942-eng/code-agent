import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TaskPlan } from '@shared/contract';

import { PlanPanel } from '../../../src/renderer/components/features/chat/PlanPanel';

// 构造组件实际读取的最小 TaskPlan（title/metadata/objective/phases/时间戳）
const makePlan = (): TaskPlan =>
  ({
    title: '测试计划',
    objective: '验证迁移',
    metadata: { totalSteps: 2, completedSteps: 1 },
    phases: [
      {
        id: 'p1',
        title: '阶段一',
        status: 'in_progress',
        steps: [{ id: 's1', content: '步骤一', status: 'completed' }],
      },
    ],
    createdAt: 0,
    updatedAt: 0,
  }) as unknown as TaskPlan;

// 验证 PlanPanel 从手搓 fixed-inset-0 弹窗迁移到 Modal primitive 后行为不回归
describe('PlanPanel (Modal primitive 迁移验证)', () => {
  it('走 Modal primitive（role=dialog + aria-modal），标题/进度/阶段齐全', () => {
    const html = renderToStaticMarkup(<PlanPanel plan={makePlan()} onClose={() => {}} />);

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('测试计划');
    expect(html).toContain('进度: 1/2 步骤');
    expect(html).toContain('阶段一');
    expect(html).toContain('步骤一');
    expect(html).toContain('创建于');
  });
});
