import { describe, expect, it } from 'vitest';
import {
  buildWorkbenchToolScope,
  buildWorkbenchTurnSystemContext,
  withWorkbenchTurnSystemContext,
} from '../../../src/main/app/workbenchTurnContext';

describe('workbenchTurnContext', () => {
  it('builds a turn-scoped system context for selected skills, connectors, and MCP servers', () => {
    const blocks = buildWorkbenchTurnSystemContext({
      selectedSkillIds: ['review-skill', 'ship-skill'],
      selectedConnectorIds: ['mail'],
      selectedMcpServerIds: ['github'],
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('review-skill');
    expect(blocks[0]).toContain('ship-skill');
    expect(blocks[0]).toContain('mail');
    expect(blocks[0]).toContain('github');
    expect(blocks[0]).toContain('当前这一条消息');
  });

  it('projects browser execution intent into the hidden turn system context', () => {
    const blocks = buildWorkbenchTurnSystemContext({
      executionIntent: {
        browserSessionMode: 'desktop',
        preferBrowserSession: true,
        preferDesktopContext: true,
        allowBrowserAutomation: false,
        browserSessionSnapshot: {
          ready: false,
          blockedDetail: '当前桌面浏览器上下文未就绪：屏幕录制未授权、collector 未启动。',
          blockedHint: '先补权限并启动采集。',
          preview: {
            title: 'ChatGPT',
            url: 'https://chatgpt.com',
            frontmostApp: 'Google Chrome',
            lastScreenshotAtMs: Date.UTC(2026, 3, 17, 8, 30, 0),
          },
        },
      },
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('绑定当前桌面浏览器上下文');
    expect(blocks[0]).toContain('frontmost app');
    expect(blocks[0]).toContain('不要假设浏览器自动化可用');
    expect(blocks[0]).toContain('发送前 Browser session 预览：ChatGPT · https://chatgpt.com');
    expect(blocks[0]).toContain('发送前 frontmost app：Google Chrome');
    expect(blocks[0]).toContain('发送前最近截图时间：2026-04-17T08:30:00.000Z');
    expect(blocks[0]).toContain('当前 Browser workbench 未就绪：当前桌面浏览器上下文未就绪：屏幕录制未授权、collector 未启动。');
    expect(blocks[0]).toContain('修复提示：先补权限并启动采集。');
  });

  it('merges turn system context into existing run options', () => {
    expect(withWorkbenchTurnSystemContext(
      { mode: 'normal', researchMode: false },
      {
        selectedSkillIds: ['review-skill'],
        executionIntent: {
          browserSessionMode: 'managed',
          preferBrowserSession: true,
          allowBrowserAutomation: true,
        },
      },
    )).toEqual({
      mode: 'normal',
      researchMode: false,
      turnSystemContext: [
        expect.stringContaining('review-skill'),
      ],
      toolScope: {
        allowedSkillIds: ['review-skill'],
      },
      executionIntent: {
        browserSessionMode: 'managed',
        preferBrowserSession: true,
        allowBrowserAutomation: true,
      },
    });
  });

  it('builds tool scope from selected skills, connectors, and MCP servers', () => {
    expect(buildWorkbenchToolScope({
      selectedSkillIds: ['review-skill', 'review-skill', 'ship-skill'],
      selectedConnectorIds: ['mail', 'mail', 'calendar'],
      selectedMcpServerIds: ['github', 'github', 'slack'],
    })).toEqual({
      allowedSkillIds: ['review-skill', 'ship-skill'],
      allowedConnectorIds: ['mail', 'calendar'],
      allowedMcpServerIds: ['github', 'slack'],
    });
  });

  it('merges workbench scope into existing run option scope', () => {
    expect(withWorkbenchTurnSystemContext(
      {
        mode: 'normal',
        toolScope: {
          allowedSkillIds: ['baseline-skill'],
          allowedConnectorIds: ['reminders'],
          allowedMcpServerIds: ['filesystem'],
        },
      },
      {
        selectedSkillIds: ['review-skill'],
        selectedConnectorIds: ['mail'],
        selectedMcpServerIds: ['github'],
      },
    )).toEqual({
      mode: 'normal',
      turnSystemContext: [
        expect.stringContaining('review-skill'),
      ],
      toolScope: {
        allowedSkillIds: ['baseline-skill', 'review-skill'],
        allowedConnectorIds: ['reminders', 'mail'],
        allowedMcpServerIds: ['filesystem', 'github'],
      },
    });
  });

  it('returns the original options when nothing is selected', () => {
    const options = { mode: 'normal', reportStyle: 'summary' } as const;

    expect(withWorkbenchTurnSystemContext(options, undefined)).toBe(options);
  });
});
