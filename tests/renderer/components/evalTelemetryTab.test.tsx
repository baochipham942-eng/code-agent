// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const invokeMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  ipcService: { invoke: invokeMock, on: vi.fn(() => () => {}) },
  default: { invoke: invokeMock, on: vi.fn(() => () => {}) },
}));

import { EvalTelemetryTab } from '../../../src/renderer/components/features/evalCenter/EvalTelemetryTab';
import { useTelemetryStore } from '../../../src/renderer/stores/telemetryStore';
import type { TelemetrySession, TelemetrySessionListItem } from '../../../src/shared/contract/telemetry';

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

describe('EvalTelemetryTab', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useTelemetryStore.getState().reset();
    invokeMock.mockImplementation(async (channel: string) => {
      switch (channel) {
        case 'telemetry:list-sessions': return [listItem];
        case 'telemetry:get-session': return sessionDetail;
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
