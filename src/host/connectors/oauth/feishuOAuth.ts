import type { ProviderDescriptor } from './providerDescriptor';

// 桌面应用的 client_id 是**公开值、不是机密**——正因为它藏不住，这条链路才用 PKCE。
// 所以它内置在包里，env 只作开发期覆盖用；只读 env 会让发出去的包里 client_id 恒为空。
const FEISHU_CLIENT_ID = 'cli_aa0177eff53bdcc1';

export const FEISHU_OAUTH_DESCRIPTOR = {
  id: 'feishu',
  displayName: '飞书',
  authorizeUrl: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
  tokenUrl: 'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
  clientId: process.env.NEO_FEISHU_OAUTH_CLIENT_ID?.trim() || FEISHU_CLIENT_ID,
  scopes: {
    'message.send-as-user': 'im:message im:message.send_as_user',
  },
  // 飞书后台按完整路径精确匹配、不支持动态路由，所以回环必须是固定端口。
  redirect: { mode: 'loopback-fixed', port: 53_682 },
  // 2026-08-24 已在飞书开放平台后台把 http://127.0.0.1:53682/callback 真填进重定向 URL 白名单
  // 并被接受，不是推测——所以设备码那条备选路线不启用。
  loopbackRedirectUriSupport: 'confirmed',
} satisfies ProviderDescriptor;

// 取 token 的入口（getAccessToken 包装）随 A2b 的第一个真写回动作一起加：
// 现在加进来就是「装好没接电」，生产可达性棘轮会直接拦下。
