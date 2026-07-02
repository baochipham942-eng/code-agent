import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initializeSessionStore,
  whenInitialSessionStateSettled,
} from '../../../src/renderer/stores/sessionStore';

const mockDomainInvoke = vi.fn();

/**
 * renderer-ready 的就绪门：窗口要等"首帧 + 初始会话数据落定"再显示，
 * 否则用户会看到空聊天→内容弹入。whenInitialSessionStateSettled 必须在
 * initializeSessionStore 完成后 resolve，且失败也要 resolve（不许挂死窗口）。
 */
describe('whenInitialSessionStateSettled', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as Record<string, unknown>).window = {
      domainAPI: { invoke: mockDomainInvoke },
    };
  });

  it('initializeSessionStore 完成后 resolve', async () => {
    mockDomainInvoke.mockImplementation(async (_domain: string, action: string) => {
      if (action === 'list') {
        return {
          success: true,
          data: [{
            id: 's1',
            title: 's1',
            modelConfig: { provider: 'openai', model: 'gpt-5' },
            createdAt: 1,
            updatedAt: 1,
            messageCount: 1,
            turnCount: 1,
          }],
        };
      }
      if (action === 'load') {
        return {
          success: true,
          data: {
            id: 's1',
            title: 's1',
            modelConfig: { provider: 'openai', model: 'gpt-5' },
            createdAt: 1,
            updatedAt: 1,
            messages: [],
            todos: [],
          },
        };
      }
      return { success: true, data: [] };
    });

    let settled = false;
    void whenInitialSessionStateSettled().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await initializeSessionStore();
    await whenInitialSessionStateSettled();
  });
});
