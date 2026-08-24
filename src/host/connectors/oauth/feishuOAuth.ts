import type { ProviderDescriptor } from './providerDescriptor';

// client_id 内置在包里，env 只作开发期覆盖：只读 env 会让发出去的包里 client_id 恒为空，
// 界面会永远显示「还没配应用」。client_id 本身不是机密（2026-08-24 真机确认飞书会把它明文
// 放进授权 URL）。
// 🔴 但飞书这条路**不是**「有 PKCE 就不需要密钥」：2026-08-24 真机实测，只带 client_id + PKCE
// 换 token 会被拒（400 invalid_client / code 20140「The auth method is not supported.」），
// 必须另带 App Secret。那个才是真机密，**绝不进包**——按爸 2026-08-24 拍板走「甲」：
// 存本机加密存储（SecureStorage），落地见 N-SAAS-FEISHUSECRET。
const FEISHU_CLIENT_ID = 'cli_aa0177eff53bdcc1';

export const FEISHU_OAUTH_DESCRIPTOR = {
  id: 'feishu',
  displayName: '飞书',
  authorizeUrl: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
  tokenUrl: 'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
  clientId: process.env.NEO_FEISHU_OAUTH_CLIENT_ID?.trim() || FEISHU_CLIENT_ID,
  scopes: {
    // 🔴 offline_access 不能省：2026-08-24 真机实测，不要它飞书就**不返回 refresh_token**，
    // access_token 只活 7200s ⇒ 授权两小时后 getAccessToken() 直接抛「没有 refresh token」，
    // 用户得重新授权一遍。要它才拿得到 refresh_token（同一次实测已验证）。
    // 它在飞书是一条要在开发者后台显式开通的权限（「持续访问已授权的数据」），
    // 没开通会在授权页就被拦下（错误码 20027），根本跳不回本机。
    'message.send-as-user': 'offline_access im:message im:message.send_as_user',
  },
  // 飞书后台按完整路径精确匹配、不支持动态路由，所以回环必须是固定端口。
  redirect: { mode: 'loopback-fixed', port: 53_682 },
  // 2026-08-24 已在飞书开放平台后台把 http://127.0.0.1:53682/callback 真填进重定向 URL 白名单
  // 并被接受，不是推测——所以设备码那条备选路线不启用。
  loopbackRedirectUriSupport: 'confirmed',
} satisfies ProviderDescriptor;

// 取 token 的入口（getAccessToken 包装）随 A2b 的第一个真写回动作一起加：
// 现在加进来就是「装好没接电」，生产可达性棘轮会直接拦下。
