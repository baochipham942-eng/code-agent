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

// 取 token 的入口（getAccessToken 包装）随 A2b 的第一个真写回动作一起加：
// 现在加进来就是「装好没接电」，生产可达性棘轮会直接拦下。
