import { describe, expect, it, vi } from 'vitest';
import { FeishuChannel } from '../../../src/host/channels/feishu/feishuChannel';

type FeishuChannelHarness = {
  client: {
    im: {
      chat: {
        list: ReturnType<typeof vi.fn>;
      };
    };
  };
};

describe('FeishuChannel.listConversations', () => {
  it('分页读取机器人所在群，返回会话 ID 和官方显示名并过滤已解散群', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [
            { chat_id: 'oc_one', name: '林晨, 苏三', chat_status: 'normal' },
            { chat_id: 'oc_old', name: '旧群', chat_status: 'dissolved' },
          ],
          has_more: true,
          page_token: 'next-page',
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ chat_id: 'oc_two', name: '项目群', chat_status: 'normal' }],
          has_more: false,
        },
      });
    const channel = new FeishuChannel('feishu-account');
    (channel as unknown as FeishuChannelHarness).client = { im: { chat: { list } } };

    await expect(channel.listConversations()).resolves.toEqual([
      { id: 'oc_one', name: '林晨, 苏三' },
      { id: 'oc_two', name: '项目群' },
    ]);
    expect(list).toHaveBeenNthCalledWith(2, {
      params: {
        page_size: 100,
        sort_type: 'ByActiveTimeDesc',
        page_token: 'next-page',
      },
    });
  });
});
