import { ConnectorAuth } from './connectorAuth';
import type { ProviderDescriptor } from './providerDescriptor';

export const FEISHU_OAUTH_DESCRIPTOR = {
  id: 'feishu',
  displayName: '飞书',
  authorizeUrl: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
  tokenUrl: 'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
  clientId: process.env.NEO_FEISHU_OAUTH_CLIENT_ID?.trim() ?? '',
  scopes: {
    'message.send-as-user': 'im:message im:message.send_as_user',
  },
  redirect: { mode: 'loopback-fixed', port: 53_682 },
  // 飞书后台要求完整回调 URL 精确匹配；HTTP 127.0.0.1 是否可登记留到真机联调核验。
  loopbackRedirectUriSupport: 'pending-verification',
} satisfies ProviderDescriptor;

export type FeishuWritebackAction = keyof typeof FEISHU_OAUTH_DESCRIPTOR.scopes;

let connectorAuth: ConnectorAuth | undefined;

export function getFeishuAccessToken(
  accountId: string,
  action: FeishuWritebackAction,
): Promise<string> {
  connectorAuth ??= new ConnectorAuth();
  return connectorAuth.getAccessToken(accountId, FEISHU_OAUTH_DESCRIPTOR.scopes[action]);
}
