import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectorAuth } from '../../../../src/host/connectors/oauth/connectorAuth';
import {
  FEISHU_OAUTH_DESCRIPTOR,
  getFeishuAccessToken,
} from '../../../../src/host/connectors/oauth/feishuOAuth';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Feishu OAuth adapter', () => {
  it('uses a fixed callback port and keeps loopback HTTP support pending verification', () => {
    expect(FEISHU_OAUTH_DESCRIPTOR.redirect).toEqual({
      mode: 'loopback-fixed',
      port: 53_682,
    });
    expect(FEISHU_OAUTH_DESCRIPTOR.loopbackRedirectUriSupport).toBe('pending-verification');
    expect(FEISHU_OAUTH_DESCRIPTOR.authorizeUrl)
      .toBe('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
    expect(FEISHU_OAUTH_DESCRIPTOR.tokenUrl)
      .toBe('https://open.feishu.cn/open-apis/authen/v2/oauth/token');
  });

  it('maps the writeback action to the provider scope at the token entry', async () => {
    const getAccessToken = vi.spyOn(ConnectorAuth.prototype, 'getAccessToken')
      .mockResolvedValue('feishu-access');

    await expect(getFeishuAccessToken('feishu:account-1', 'message.send-as-user'))
      .resolves.toBe('feishu-access');
    expect(getAccessToken).toHaveBeenCalledWith(
      'feishu:account-1',
      'im:message im:message.send_as_user',
    );
  });
});
