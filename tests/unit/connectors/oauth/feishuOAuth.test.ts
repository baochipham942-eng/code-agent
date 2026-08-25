import { describe, expect, it } from 'vitest';
import { FEISHU_OAUTH_DESCRIPTOR } from '../../../../src/host/connectors/oauth/feishuOAuth';

describe('Feishu OAuth adapter', () => {
  it('uses the fixed callback port that is registered in the Feishu console', () => {
    // 飞书后台按完整路径精确匹配且不支持动态路由，随机端口登记不上 —— 这里必须是固定端口。
    expect(FEISHU_OAUTH_DESCRIPTOR.redirect).toEqual({
      mode: 'loopback-fixed',
      port: 53_682,
    });
    // 2026-08-24 已在飞书后台真填进白名单并被接受，不是推测。
    expect(FEISHU_OAUTH_DESCRIPTOR.loopbackRedirectUriSupport).toBe('confirmed');
    expect(FEISHU_OAUTH_DESCRIPTOR.authorizeUrl)
      .toBe('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
    expect(FEISHU_OAUTH_DESCRIPTOR.tokenUrl)
      .toBe('https://open.feishu.cn/open-apis/authen/v2/oauth/token');
  });

  it('ships a non-empty client id so the packaged app is not stuck at "app not configured"', () => {
    expect(FEISHU_OAUTH_DESCRIPTOR.clientId).not.toBe('');
  });

  it('declares the writeback action to provider scope mapping', () => {
    expect(FEISHU_OAUTH_DESCRIPTOR.scopes['message.send-as-user'])
      .toBe('offline_access im:message im:message.send_as_user');
    expect(FEISHU_OAUTH_DESCRIPTOR.authMode).toBe('lark-cli');
    expect(FEISHU_OAUTH_DESCRIPTOR.requiresClientSecret).toBe(false);
  });

  it('always asks for offline_access, without which Feishu returns no refresh token', () => {
    // 2026-08-24 真机实测：不要 offline_access 时响应里没有 refresh_token，
    // access_token 只活 7200s，授权两小时后连接就死了。漏掉它是静默的——
    // 授权当场是成功的，两小时后才炸，所以这条断言必须钉住。
    for (const scope of Object.values(FEISHU_OAUTH_DESCRIPTOR.scopes)) {
      expect(scope.split(' ')).toContain('offline_access');
    }
  });
});
