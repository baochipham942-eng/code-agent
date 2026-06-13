import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import type { ConnectorStatus } from '../../../src/main/connectors';
import { getConnectorRegistry } from '../../../src/main/connectors';
import {
  buildWorkbenchToolScope,
  buildWorkbenchTurnSystemContext,
  withWorkbenchTurnSystemContext,
} from '../../../src/main/app/workbenchTurnContext';
import { directionTokens } from '../../../src/design/direction-tokens';

describe('workbenchTurnContext', () => {
  const registry = getConnectorRegistry();
  let tmpDirs: string[] = [];

  function registerConnector(id: string, status: Partial<ConnectorStatus>): void {
    registry.register({
      id,
      label: id,
      capabilities: ['get_status'],
      getCachedStatus: () => ({
        connected: false,
        capabilities: ['get_status'],
        ...status,
      }),
      async getStatus() {
        return this.getCachedStatus!();
      },
      async execute() {
        return { data: null };
      },
    });
  }

  afterEach(() => {
    ['mail', 'calendar', 'reminders'].forEach((id) => registry.unregister(id));
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs = [];
  });

  function makeTmpDir(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'workbench-turn-context-'));
    tmpDirs.push(dir);
    return dir;
  }

  it('builds a turn-scoped system context for selected skills, connectors, and MCP servers', () => {
    registerConnector('mail', { connected: true, readiness: 'ready' });

    const blocks = buildWorkbenchTurnSystemContext({
      selectedSkillIds: ['review-skill', 'ship-skill'],
      selectedConnectorIds: ['mail'],
      selectedMcpServerIds: ['github'],
      turnCapabilityScopeMode: 'manual',
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('review-skill');
    expect(blocks[0]).toContain('ship-skill');
    expect(blocks[0]).toContain('mail');
    expect(blocks[0]).toContain('github');
    expect(blocks[0]).toContain('本轮能力范围由用户手动选择');
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
    expect(blocks[0]).toContain('纯阅读、单 URL 摘要、内容抽取或链接汇总');
    expect(blocks[0]).toContain('登录态、表单填写、按钮点击、下载/上传、多页跳转');
    expect(blocks[0]).toContain('必须先确认权限、目标前台窗口或后台 target app、最近快照，以及坐标/locator 来源');
    expect(blocks[0]).toContain('动作执行后先 re-observe');
    expect(blocks[0]).toContain('发送前 Browser session 预览：ChatGPT · https://chatgpt.com');
    expect(blocks[0]).toContain('发送前 frontmost app：Google Chrome');
    expect(blocks[0]).toContain('发送前最近截图时间：2026-04-17T08:30:00.000Z');
    expect(blocks[0]).toContain('当前 Browser workbench 未就绪：当前桌面浏览器上下文未就绪：屏幕录制未授权、collector 未启动。');
    expect(blocks[0]).toContain('修复提示：先补权限并启动采集。');
  });

  it('injects design brief tokens and root DESIGN.md summary as structured JSON', () => {
    const cwd = makeTmpDir();
    writeFileSync(
      path.join(cwd, 'DESIGN.md'),
      '# Product Principles\nUse dense admin layouts and restrained color.',
      'utf-8',
    );

    const blocks = buildWorkbenchTurnSystemContext({
      workingDirectory: cwd,
      designBrief: {
        surface: 'dashboard',
        direction: 'technical',
        directionTokens: directionTokens.technical,
        references: ['existing reference'],
        source: 'manual',
      },
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('<design_brief_json>');
    expect(blocks[0]).toContain('"direction": "technical"');
    expect(blocks[0]).toContain('"directionTokens"');
    expect(blocks[0]).toContain(directionTokens.technical.palette.accent);
    expect(blocks[0]).toContain('existing reference');
    expect(blocks[0]).toContain('DESIGN.md:');
    expect(blocks[0]).toContain('Product Principles');
    // Self-critique section 同条件追加
    expect(blocks[0]).toContain('<design_self_critique>');
    expect(blocks[0]).toContain(directionTokens.technical.posture);
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
    registerConnector('mail', { connected: true, readiness: 'ready' });
    registerConnector('calendar', { connected: true, readiness: 'ready' });

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

  it('does not allow unchecked or failed connectors into the runtime tool scope', () => {
    registerConnector('mail', { connected: false, readiness: 'unchecked' });
    registerConnector('calendar', { connected: false, readiness: 'failed', error: 'not authorized' });
    registerConnector('reminders', { connected: true, readiness: 'ready' });

    expect(buildWorkbenchToolScope({
      selectedConnectorIds: ['mail', 'calendar', 'reminders'],
    })).toEqual({
      allowedConnectorIds: ['reminders'],
    });
  });

  it('merges workbench scope into existing run option scope', () => {
    registerConnector('mail', { connected: true, readiness: 'ready' });

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

  // 定点反馈 loop：main 侧消费 envelope.livePreviewSelection（此前是死数据）。
  it('injects a live_preview_selection block guiding visual_edit when an element is selected', () => {
    const blocks = buildWorkbenchTurnSystemContext({
      livePreviewSelection: {
        location: { file: '/abs/project/src/App.tsx', line: 42, column: 7 },
        tag: 'button',
        text: '提交',
        rect: { x: 0, y: 0, width: 100, height: 40 },
        componentName: 'PrimaryButton',
      },
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('<live_preview_selection>');
    expect(blocks[0]).toContain('定点反馈');
    expect(blocks[0]).toContain('/abs/project/src/App.tsx');
    expect(blocks[0]).toContain('行号：42');
    expect(blocks[0]).toContain('列号：7');
    expect(blocks[0]).toContain('<button>');
    expect(blocks[0]).toContain('PrimaryButton');
    expect(blocks[0]).toContain('可见文本：提交');
    expect(blocks[0]).toContain('visual_edit');
    expect(blocks[0]).toContain('局部锚定反馈');
    expect(blocks[0]).toContain('忽略本段');
  });

  it('does not inject a selection block when livePreviewSelection is absent or incomplete', () => {
    expect(buildWorkbenchTurnSystemContext({ livePreviewSelection: null })).toHaveLength(0);
    expect(buildWorkbenchTurnSystemContext({
      // 缺 line：定位不全，不注入（避免给模型半截坐标）
      livePreviewSelection: {
        location: { file: '/abs/x.tsx', line: 0, column: 0 },
        tag: 'div',
        text: '',
        rect: { x: 0, y: 0, width: 0, height: 0 },
      },
    })).toHaveLength(0);
  });

  it('carries a selection-only context through withWorkbenchTurnSystemContext (not swallowed by the early return)', () => {
    const merged = withWorkbenchTurnSystemContext(
      { mode: 'normal' },
      {
        livePreviewSelection: {
          location: { file: '/abs/x.tsx', line: 10, column: 1 },
          tag: 'span',
          text: 'hi',
          rect: { x: 0, y: 0, width: 10, height: 10 },
        },
      },
    );

    expect(merged).not.toBe(undefined);
    expect(merged?.turnSystemContext?.[0]).toContain('<live_preview_selection>');
  });
});
