# Agent Neo FC 页面部署流程

本文档记录 `neo.llmxy.xyz` 这条落地页和控制面 API 的维护流程。日常更新页面时，通常只需要改静态文件、构建、部署和验收；域名、DNS、证书只在迁移、重建或续期时处理。

## 当前基线

| 项目 | 当前值 |
| --- | --- |
| 入口域名 | `https://neo.llmxy.xyz` |
| FC 地域 | `ap-southeast-1` |
| FC 函数 | `agent-neo-control-plane` |
| 自定义域名协议 | `HTTP,HTTPS` |
| 自定义域名路由 | `/* -> agent-neo-control-plane / LATEST` |
| DNS | `neo.llmxy.xyz CNAME 1145650533372320.ap-southeast-1.fc.aliyuncs.com` |
| 页面文件 | `vercel-api/public/code-agent/index.html` |
| 页面图片 | `vercel-api/public/code-agent/agent-neo-hero.webp` |
| 品牌标识 | `vercel-api/public/code-agent/agent-neo-mark.svg` |
| 运行入口 | `vercel-api/server.ts` -> `dist/server.js` |
| 部署配置 | `vercel-api/s.yaml` |

根路径 `/` 会由 `server.ts` 映射到 `public/code-agent/index.html`，所以更新落地页优先改 `vercel-api/public/code-agent/`。

## 日常更新页面

1. 修改页面和资源：

```bash
cd /Users/linchen/Downloads/ai/code-agent
$EDITOR vercel-api/public/code-agent/index.html
```

如需替换主视觉，保持文件名 `agent-neo-hero.webp` 最省事；如果改文件名，要同步更新 HTML 里的引用。

2. 本地构建和类型检查：

```bash
cd /Users/linchen/Downloads/ai/code-agent/vercel-api
npm run typecheck
npm run build
```

3. 部署到阿里云 FC：

```bash
cd /Users/linchen/Downloads/ai/code-agent/vercel-api
set -a
source /private/tmp/code-agent-fc-deploy.env
source /private/tmp/code-agent-fc-cert-paths.env
set +a
npm run deploy:fc
```

`code-agent-fc-deploy.env` 放函数运行环境变量。`code-agent-fc-cert-paths.env` 只放证书文件路径，例如：

```bash
FC_CUSTOM_DOMAIN_CERTIFICATE_PATH=/path/to/neo.llmxy.xyz.crt
FC_CUSTOM_DOMAIN_PRIVATE_KEY_PATH=/path/to/neo.llmxy.xyz.rsa.key
```

不要把证书私钥内容写进仓库，也不要在终端打印完整环境变量。

4. 验收公网页面：

```bash
curl -sS -o /tmp/neo-root.out -w "%{http_code}:%{content_type}:%{ssl_verify_result}\n" \
  "https://neo.llmxy.xyz/"

curl -sS -o /tmp/neo-hero.out -w "%{http_code}:%{content_type}:%{ssl_verify_result}\n" \
  "https://neo.llmxy.xyz/code-agent/agent-neo-hero.webp"

curl -sS -o /tmp/neo-health.out -w "%{http_code}:%{content_type}:%{ssl_verify_result}\n" \
  "https://neo.llmxy.xyz/api/update?action=health"
```

预期分别是：

```text
200:text/html; charset=utf-8:0
200:image/webp:0
200:application/json; charset=utf-8:0
```

5. 验收控制面签名接口：

```bash
cd /Users/linchen/Downloads/ai/code-agent
set -a
source /private/tmp/code-agent-fc-deploy.env
set +a
node scripts/control-plane-smoke.mjs https://neo.llmxy.xyz
```

预期看到 `passed: 4 signed envelope(s) checked`。

## 必跑检查

页面只改 HTML/CSS/图片时，至少跑：

```bash
cd /Users/linchen/Downloads/ai/code-agent/vercel-api
npm run typecheck
npm run build
```

如果动到 control-plane envelope、payload、签名或接口适配器，再从仓库根目录跑：

```bash
cd /Users/linchen/Downloads/ai/code-agent
npx vitest run \
  tests/unit/vercel/controlPlaneEnvelope.test.ts \
  tests/unit/vercel/controlPlaneArtifacts.test.ts \
  tests/unit/vercel/controlPlaneAudit.test.ts
```

收尾前跑：

```bash
git diff --check -- vercel-api
```

## GitHub Callback

线上函数环境变量必须保持：

```text
GITHUB_CALLBACK_URL=https://neo.llmxy.xyz/api/auth?action=callback
```

如果重新部署后登录异常，先检查 FC 线上函数环境变量有没有被旧值覆盖。历史上曾出现旧域名 `neo.llmxyz.com` 残留。

可在阿里云 FC 控制台检查，或通过已登录控制台会话查询函数环境变量。不要把完整环境变量输出到日志里。

## DNS 和自定义域名

`llmxy.xyz` 在当前阿里云 DNS 账号里可管理。`neo.llmxy.xyz` 需要这条 CNAME：

```text
neo.llmxy.xyz -> 1145650533372320.ap-southeast-1.fc.aliyuncs.com
```

验证：

```bash
curl -s "https://dns.google/resolve?name=neo.llmxy.xyz&type=CNAME"
```

如果 `https://neo.llmxy.xyz/api/update?action=health` 返回 `DomainRouteNotFound`，说明 DNS 已经打到 FC 账号入口，但 FC 自定义域名路由没有绑定好。检查 FC 域名管理里 `neo.llmxy.xyz` 是否存在，并确认路由是 `/* -> agent-neo-control-plane / LATEST`。

## HTTPS 证书维护

日常更新页面不需要重新签证书。只有证书过期、域名重建或 `s deploy` 需要重放完整 customDomain 时，才处理证书。

当前证书要求：

```text
Common Name / SAN: neo.llmxy.xyz
FC certName: cert-neo-llmxy-20260601
privateKey: 传统 RSA PEM，首行应为 -----BEGIN RSA PRIVATE KEY-----
```

如果 ACME 工具产出的是 PKCS#8 私钥，FC 可能拒绝并报：

```text
'private key' has to be in PEM format
```

转换成 FC 接受的传统 RSA PEM：

```bash
openssl rsa -traditional \
  -in /path/to/neo.llmxy.xyz.key \
  -out /path/to/neo.llmxy.xyz.rsa.key
chmod 600 /path/to/neo.llmxy.xyz.rsa.key
```

绑定证书后，用 HTTPS 验证命令确认 `ssl_verify_result` 是 `0`。

## 常见坑

- `llm.xyz` 不在当前阿里云 DNS 账号里，`neo.llmxyz.com` 也不可在当前账号新增；当前可维护域名是 `llmxy.xyz`。
- `s --debug`、`s info --debug` 可能把敏感环境变量写到日志里，部署排障时谨慎使用。
- `s deploy` 会读取 `s.yaml` 的 customDomain。缺少 `FC_CUSTOM_DOMAIN_CERTIFICATE_PATH` / `FC_CUSTOM_DOMAIN_PRIVATE_KEY_PATH` 时，不要贸然部署，避免覆盖 HTTPS 配置失败。
- `HEAD /hero.webp` 不是有效验收路径；当前主视觉路径是 `/code-agent/agent-neo-hero.webp`。
- 如果 Serverless Devs CLI 卡住，可用阿里云控制台确认函数、域名、环境变量状态；不要直接改 DNS 当成路由修复。
