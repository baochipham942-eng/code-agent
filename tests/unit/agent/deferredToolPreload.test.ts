import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/tools/protocolRegistry', async () => {
  const actual = await vi.importActual<typeof import('../../../src/host/tools/protocolRegistry')>(
    '../../../src/host/tools/protocolRegistry',
  );
    return {
      ...actual,
      isProtocolToolName: (name: string) =>
        name === 'Browser'
        || name === 'Computer'
        || name === 'workflow'
        || name === 'workflow_orchestrate'
        || name === 'MCPUnified'
        || actual.isProtocolToolName(name),
    };
  });

import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import type { ToolModule, ToolSchema } from '../../../src/host/protocol/tools';
import {
  getDeferredToolsToPreloadForTurn,
  preloadDeferredToolsForTurn,
} from '../../../src/host/agent/runtime/contextAssembly/deferredToolPreload';
import { getToolSearchService, resetToolSearchService } from '../../../src/host/services/toolSearch';
import { getProtocolRegistry, resetProtocolRegistry } from '../../../src/host/tools/protocolRegistry';

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function runtime(
  overrides: Partial<Pick<RuntimeContext, 'enableToolDeferredLoading' | 'executionIntent' | 'messages'>>,
): Pick<RuntimeContext, 'enableToolDeferredLoading' | 'executionIntent' | 'messages'> {
  return {
    enableToolDeferredLoading: true,
    executionIntent: undefined,
    messages: [],
    ...overrides,
  };
}

function registerProtocolToolForPreload(name: 'Browser' | 'Computer' | 'workflow' | 'workflow_orchestrate' | 'MCPUnified'): void {
  const schema: ToolSchema = {
    name,
    description: `${name} test schema`,
    inputSchema: {
      type: 'object',
      properties: {},
    },
    category: name === 'workflow' || name === 'workflow_orchestrate'
      ? 'multiagent'
      : name === 'MCPUnified'
        ? 'mcp'
        : 'vision',
    permissionLevel: 'execute',
    readOnly: false,
  };
  const module: ToolModule = {
    schema,
    createHandler: () => ({
      schema,
      async execute() {
        return { ok: true, output: null };
      },
    }),
  };
  getProtocolRegistry().register(schema, async () => module);
}

describe('deferred tool preload', () => {
  beforeEach(() => {
    resetProtocolRegistry();
    registerProtocolToolForPreload('Browser');
    registerProtocolToolForPreload('Computer');
    registerProtocolToolForPreload('workflow');
    registerProtocolToolForPreload('workflow_orchestrate');
    registerProtocolToolForPreload('MCPUnified');
    resetToolSearchService();
  });

  it('preloads Computer for explicit computer use requests', () => {
    const loaded = preloadDeferredToolsForTurn(runtime({
      messages: [{
        id: 'm1',
        role: 'user',
        content: '通过 computer use 打开记事本，记录会议内容',
        timestamp: 1,
      }],
    }));

    expect(loaded).toEqual(['Computer']);
    expect(getToolSearchService().isToolLoaded('Computer')).toBe(true);
  });

  it.each([
    '帮我记录当前腾讯会议的内容',
    '请整理会议内容',
    '帮我记录当前会议',
  ])('preloads Computer for desktop meeting context keywords: %s', (content) => {
    const loaded = preloadDeferredToolsForTurn(runtime({
      messages: [{
        id: 'm1',
        role: 'user',
        content,
        timestamp: 1,
      }],
    }));

    expect(loaded).toEqual(['Computer']);
    expect(getToolSearchService().isToolLoaded('Computer')).toBe(true);
  });

  it('preloads Computer for English screenshot requests', () => {
    const loaded = preloadDeferredToolsForTurn(runtime({
      messages: [{
        id: 'm1',
        role: 'user',
        content: 'Take a screenshot of the current screen and inspect it',
        timestamp: 1,
      }],
    }));

    expect(loaded).toEqual(['Computer']);
    expect(getToolSearchService().isToolLoaded('Computer')).toBe(true);
  });

  it('preloads Computer when Desktop workbench is selected', () => {
    expect(getDeferredToolsToPreloadForTurn(runtime({
      executionIntent: { browserSessionMode: 'desktop' },
      messages: [{
        id: 'm1',
        role: 'user',
        content: '帮我记录当前会议内容',
        timestamp: 1,
      }],
    }))).toEqual(['Computer']);
  });

  it('preloads Browser and Computer for Managed workbench automation', () => {
    expect(getDeferredToolsToPreloadForTurn(runtime({
      executionIntent: { browserSessionMode: 'managed' },
      messages: [{
        id: 'm1',
        role: 'user',
        content: '打开网页并填写表单',
        timestamp: 1,
      }],
    }))).toEqual(['Browser', 'Computer']);
  });

  it('keeps plain URL reading on the lightweight path', () => {
    expect(getDeferredToolsToPreloadForTurn(runtime({
      messages: [{
        id: 'm1',
        role: 'user',
        content: '帮我总结这个 URL：https://example.com/article，提取主要链接',
        timestamp: 1,
      }],
    }))).toEqual([]);
  });

  it('preloads Browser for interactive web flows', () => {
    expect(getDeferredToolsToPreloadForTurn(runtime({
      messages: [{
        id: 'm1',
        role: 'user',
        content: '打开这个网站，登录后填写表单并提交',
        timestamp: 1,
      }],
    }))).toEqual(['Browser']);
  });

  it('preloads workflow_orchestrate for explicit workflow tool requests', () => {
    const loaded = preloadDeferredToolsForTurn(runtime({
      messages: [{
        id: 'm1',
        role: 'user',
        content: '必须使用 workflow_orchestrate 派一个只读 reviewer 子阶段检查实现',
        timestamp: 1,
      }],
    }));

    expect(loaded).toEqual(['workflow_orchestrate']);
    expect(getToolSearchService().isToolLoaded('workflow_orchestrate')).toBe(true);
  });

  it('preloads dynamic workflow for /workflow and script workflow requests', () => {
    const loaded = preloadDeferredToolsForTurn(runtime({
      messages: [{
        id: 'm1',
        role: 'user',
        content: '/workflow 分批派 agent 梳理架构债并汇总',
        timestamp: 1,
      }],
    }));

    expect(loaded).toEqual(['workflow']);
    expect(getToolSearchService().isToolLoaded('workflow')).toBe(true);

    expect(getDeferredToolsToPreloadForTurn(runtime({
      messages: [{
        id: 'm2',
        role: 'user',
        content: 'Use a dynamic workflow with parallel agents',
        timestamp: 2,
      }],
    }))).toEqual(['workflow']);
  });

  it('preloads workflow_orchestrate for cowork and multi-agent requests', () => {
    expect(getDeferredToolsToPreloadForTurn(runtime({
      messages: [{
        id: 'm1',
        role: 'user',
        content: '用 cowork 方式跑一个多 agent 协作审查任务',
        timestamp: 1,
      }],
    }))).toEqual(['workflow_orchestrate']);
  });

  it('preloads MCPUnified for explicit MCP management requests', () => {
    const loaded = preloadDeferredToolsForTurn(runtime({
      messages: [{
        id: 'm1',
        role: 'user',
        content: '帮我配置一个 jira 的 http-streamable MCP server',
        timestamp: 1,
      }],
    }));

    expect(loaded).toEqual(['MCPUnified']);
    expect(getToolSearchService().isToolLoaded('MCPUnified')).toBe(true);
  });

  // role-edit-flow 根因 #2 回归护栏：active skill 的 allowedTools 里的非 core 工具
  // （如 propose_role）必须本轮预加载，否则 deferred-loading 下模型看不见它，会退用 Edit 绕过流程。
  it('preloads a skill boundary\'s non-core allowedTools (propose_role)，core 工具被过滤', () => {
    const preload = getDeferredToolsToPreloadForTurn({
      enableToolDeferredLoading: true,
      executionIntent: undefined,
      messages: [{ id: 'm1', role: 'user', content: '/edit-role 研究员', timestamp: 1 }],
      skillToolBoundary: {
        skillName: 'edit-role',
        // read_file/glob/grep/ask_user_question 都会归一到 core，应被过滤
        allowedTools: ['propose_role', 'read_file', 'ask_user_question', 'glob', 'grep'],
      },
    } as never);
    expect(preload).toEqual(['propose_role']);
  });

  it('actually loads propose_role through the skill boundary path', () => {
    registerProtocolToolForPreload('propose_role' as never);
    resetToolSearchService();
    const loaded = preloadDeferredToolsForTurn({
      enableToolDeferredLoading: true,
      executionIntent: undefined,
      messages: [{ id: 'm1', role: 'user', content: '/edit-role 研究员', timestamp: 1 }],
      skillToolBoundary: { skillName: 'edit-role', allowedTools: ['propose_role', 'read_file'] },
    } as never);
    expect(loaded).toEqual(['propose_role']);
    expect(getToolSearchService().isToolLoaded('propose_role')).toBe(true);
  });
});
