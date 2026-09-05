// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// 显式标注签名：vi.fn(async () => undefined) 会把类型推成零参，
// 后面 mockImplementation((channel) => ...) 就装不进去（tests tsconfig 棘轮会红）。
const invokeMock = vi.hoisted(() => vi.fn<(channel: string, arg?: unknown) => Promise<unknown>>(async () => undefined));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  ipcService: { invoke: invokeMock, on: vi.fn(() => () => {}) },
  default: { invoke: invokeMock, on: vi.fn(() => () => {}) },
}));

import { EvalTelemetryTab } from '@internal-evaluation/renderer/evalCenter/EvalTelemetryTab';
import { useTelemetryStore } from '@internal-evaluation/renderer/stores/telemetryStore';
import type { TelemetrySession, TelemetrySessionListItem } from '../../../src/shared/contract/telemetry';
import type { PostLaunchReport } from '../../../src/shared/contract/postLaunchScore';

const listItem: TelemetrySessionListItem = {
  id: 'sess-1',
  title: '遥测会话甲',
  modelProvider: 'anthropic',
  modelName: 'claude',
  startTime: 1000,
  turnCount: 3,
  totalTokens: 12000,
  estimatedCost: 0,
  status: 'completed',
};

const sessionDetail: TelemetrySession = {
  id: 'sess-1',
  title: '遥测会话甲',
  modelProvider: 'anthropic',
  modelName: 'claude',
  workingDirectory: '/tmp',
  startTime: 1000,
  turnCount: 3,
  totalInputTokens: 8000,
  totalOutputTokens: 4000,
  totalTokens: 12000,
  estimatedCost: 0,
  totalToolCalls: 5,
  toolSuccessRate: 1,
  totalErrors: 0,
  status: 'completed',
};

// 上线后质量卡挂在会话列表上方，跟列表同一次加载（ADR-063 刀 1）。
const postLaunchReport: PostLaunchReport = {
  generatedAt: 0,
  days: 7,
  judgeVersion: 'postlaunch-judge-v1',
  rubricVersion: 'postlaunch-rubric-v1',
  scoredTurns: 0,
  groups: [],
  calibration: { state: 'insufficient', reason: 'no_record' },
  budget: { day: '2026-09-05', spentUsd: 0, limitUsd: 0.5, sampledCount: 0, sampleLimit: 20, stopped: false },
};

describe('EvalTelemetryTab', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useTelemetryStore.getState().reset();
    invokeMock.mockImplementation(async (channel: string) => {
      switch (channel) {
        case 'telemetry:list-sessions': return [listItem];
        case 'telemetry:get-session': return sessionDetail;
        case 'telemetry:get-postlaunch-report': return postLaunchReport;
        default: return [];
      }
    });
  });

  afterEach(() => {
    cleanup();
    useTelemetryStore.getState().reset();
  });

  it('列出遥测会话（i18n 文案），无数据时空态', async () => {
    render(<EvalTelemetryTab />);

    expect(await screen.findByText('遥测会话甲')).toBeTruthy();
    expect(screen.getByText('会话遥测')).toBeTruthy();
    // 上线后质量卡真的接了电：列表视图一加载就调了新通道并渲染出卡片。
    expect(await screen.findByTestId('postlaunch-card')).toBeTruthy();
    expect(invokeMock.mock.calls.some(([channel]) => channel === 'telemetry:get-postlaunch-report')).toBe(true);
    expect(screen.getByText('3 轮')).toBeTruthy();
    expect(screen.getByText('已完成')).toBeTruthy();
  });

  it('空列表时显示空态文案', async () => {
    invokeMock.mockImplementation(async () => []);
    render(<EvalTelemetryTab />);

    expect(await screen.findByText('暂无遥测数据')).toBeTruthy();
  });

  it('点会话进入详情视图：四个子 tab + 返回列表', async () => {
    render(<EvalTelemetryTab />);

    fireEvent.click(await screen.findByText('遥测会话甲'));

    expect(await screen.findByTestId('eval-telemetry-subtab-overview')).toBeTruthy();
    expect(screen.getByTestId('eval-telemetry-subtab-turns')).toBeTruthy();
    expect(screen.getByTestId('eval-telemetry-subtab-timeline')).toBeTruthy();
    expect(screen.getByTestId('eval-telemetry-subtab-tools')).toBeTruthy();

    fireEvent.click(screen.getByText('返回列表'));
    expect(await screen.findByText('遥测会话甲')).toBeTruthy();
  });
});
