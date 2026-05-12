import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeContext } from '../../../src/main/agent/runtime/runtimeContext';
import {
  getDeferredToolsToPreloadForTurn,
  preloadDeferredToolsForTurn,
} from '../../../src/main/agent/runtime/contextAssembly/deferredToolPreload';
import { getToolSearchService, resetToolSearchService } from '../../../src/main/services/toolSearch';
import { resetProtocolRegistry } from '../../../src/main/tools/protocolRegistry';

vi.mock('../../../src/main/services/infra/logger', () => ({
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

describe('deferred tool preload', () => {
  beforeEach(() => {
    resetProtocolRegistry();
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
});
