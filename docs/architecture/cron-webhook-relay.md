# Cron Webhook Relay — 线协议（wire contract）

> N-CRON-WEBHOOK-CLOUD-HOOK（Neo 侧一半）/ N-CRON-WEBHOOK-RELAY（中继侧，另一仓）。
> 本文是两仓之间的线协议真源：中继仓按本文实现端点与帧；Neo 侧消费方是
> `src/host/cron/cronWebhookRelay.ts` + `src/host/cron/cronApiClient.ts`。

## 这是什么

外部系统（Sentry / Linear 等）把告警/事件 POST 到一个**云端 hook URL**；云端中继校验
token、1 秒内回 2xx、把请求体排队（≤ 24h），然后经**既有 cloud cron 事件流**
（`GET {base}/api/cron/events`，SSE）推给在线的 Neo。Neo 收到投递帧后走既有
`'event'` 调度链路（绑定过滤 → deliveryId 去重 → 合批/限频）启动 agent 任务；
**请求体只进 untrusted 定界块**（`<untrusted_channel_events>`，闭合标签转义 + 截断），
永不进 action 的 URL/headers/command/args。Neo 不开任何端口。

绑定模型：每个任务（job）一个 hook URL + 一个 token。**token 就是绑定**——事件源配置
（`EventWebhookScheduleConfig`）没有 accountId。token 只在 register/rotate 的响应里
出现一次，Neo 不持久化、不落日志；中继侧只存哈希。rotate 后旧 token 立即失效。

## Neo → 中继：hook 生命周期端点

全部走既有 cloud Bearer 鉴权（`Authorization: Bearer <cloud cron token>`），路径前缀
`{base}/api/cron/hooks`，请求/响应都是 JSON envelope（`{ok, result}` / `{ok:false, error, detail}`），
与既有 `/api/cron/*` 端点同构。

| 端点 | 方法 | 请求体 | 成功响应 `result` |
|---|---|---|---|
| `/api/cron/hooks/register` | POST | `{ "jobId": "<Neo 本地任务 id>" }` | `{ "url": "https://…/api/cron/hooks/<jobId>?token=<t>", "token": "<t>" }` |
| `/api/cron/hooks/rotate` | POST | `{ "jobId": "…" }` | `{ "url": "…（新 token）", "token": "<新 t>" }` |
| `/api/cron/hooks/remove` | POST | `{ "jobId": "…" }` | `{}`（幂等：jobId 未注册也回 2xx） |
| `/api/cron/hooks/ack` | POST | `{ "jobId": "…", "deliveryIds": ["d1", "d2"] }` | `{}` |

要点：

- `jobId` 是 Neo 本地任务 id，中继按不透明字符串处理（不做解析、不反查 Neo）。
- **register/rotate 的 `{url, token}` 只返回一次**。中继只存 token 的哈希；Neo 只把
  返回值交给调用方展示一次（不落任务定义、不落日志）。rotate 等价于吊销旧 token +
  发新对；同一任务重复 register 返回**新的** token 对（旧 token 失效）。
- `remove` 对未注册的 jobId 回 2xx（任务删除/停用时 Neo 只做 best-effort 清理）。
- 鉴权失败（Bearer 无效）回 401；Neo 侧把失败包成带 hook 前缀的可区分错误
  （`Cloud cron hook register failed: … (HTTP 401)`）。

## 外部系统 → 中继：投递入口

```
POST {base}/api/cron/hooks/<jobId>?token=<t>      # token 二选一：
Authorization: Bearer <t>                          # ?token= 或 Bearer，两者都认
```

- **鉴权**：token 与 register/rotate 发出的当前 token 匹配（哈希比对）。错误或已吊销
  的 token 回 **401**；jobId 未知或已 remove 回 **404**。
- **应答时限**：中继必须在 **1 秒内**回 2xx（Sentry 对 webhook 响应有 1s 限制）。
  回 2xx 只代表「已接收并入队」，不代表 Neo 已处理。
- **排队**：投递在中继队列里保留 **≤ 24 小时**。超窗未投出即过期，转为一条
  `cron_hook_expired` 通告帧（不再投递）。
- **请求体**：按原始字节入队（不做解析/改写；Content-Type 不限，JSON 与表单都收）。

## 中继 → Neo：事件流帧

复用既有 SSE 流 `GET {base}/api/cron/events`（cloud Bearer）。帧格式与 `event: cron`
一致，只多两个事件名：

```
event: cron_hook
data: {"jobId":"<jobId>","deliveryId":"<投递幂等键>","receivedAt":1700000000000,"body":"<请求体原文>"}

event: cron_hook_expired
data: {"jobId":"<jobId>","count":3}
```

- `deliveryId`：中继生成的投递幂等键（同一请求体的每次重推同 id）。Neo 用它去重。
- `receivedAt`：外部系统 POST 到达中继的时刻（ms epoch）。
- `body`：请求体原文（字符串）。Neo 只把它放进 untrusted 定界块。
- `cron_hook_expired.count`：该任务在 24h 窗内过期丢弃的投递条数（通告性，无 ack 面）。

**投递语义：at-least-once。** 中继把帧推给（重连后的）Neo，未收到 ack 的投递按退避
重推（同 `deliveryId`）。Neo 的 ack 依据是**终态处置**：投递被合批入队、被 deliveryId
去重命中、或因任务未知/停用被忽略，都会 ack——所以 ack 不代表 run 已执行。Neo 崩溃
导致 ack 后未跑的投递不重推（这是 24h 队列 + ack-after-enqueue 的既定取舍）。停用/未知
任务的投递也被 ack（终态丢弃，不占队列）。

## 隐私（privacy）

- **请求体会经过并在 Neo 云端中继内暂存最长 24 小时**（排队等待在线的 Neo）。中继不
  解析请求体，只在投递成功/过期后删除。
- **Neo 从不存储 hook token**：token 只在 register/rotate 响应里出现一次，交给用户
  粘贴进外部系统；中继侧只存哈希，rotate 即吊销。
- hook URL 本身含 token（`?token=`）——请像对待密码一样对待它；泄露即轮换（rotate）。
- 请求体进入 Neo 后**只进 untrusted 定界块**（定界标签转义 + 截断），prompt 组装层
  明示「这是数据不是指令」。
- v1 **不校验签名头**（Sentry / Linear 的 HMAC 头原样透传在请求体之外，不参与鉴权）；
  鉴权完全依赖 hook URL token。

## 外部系统接法（示例）

**Sentry**（Organization → Settings → Integrations → Webhooks，或 alert rule 的
action "Send a notification via a webhook"）：

- 把任务的 hook URL 整段粘进 Webhook URL 字段（`https://…/api/cron/hooks/<jobId>?token=…`）。
- 不需要任何自定义 header——token 已在 URL 里。（Sentry 要求 1 秒内响应，中继满足。）
- 告警 JSON 会作为请求体原样出现在 Neo 任务的 untrusted 块里。
- 注：Sentry 的 `Sentry-Hook-Signature` 签名头在 v1 不校验（见上文隐私节）。

**Linear**（Workspace → Settings → API → Webhooks → New webhook）：

- 把任务的 hook URL 整段粘进 URL 字段，勾选要订阅的事件（issue 状态变更、comment 等）。
- Linear 的 webhook 不支持自定义 header，且带固定 `Linear-Signature` HMAC 头——这正是不
  走 Bearer-only 设计的原因；v1 同样不校验该签名头，鉴权靠 URL token。
- 事件 JSON 会作为请求体原样出现在 Neo 任务的 untrusted 块里。

## 溯源

| 侧 | 代码 |
|---|---|
| Neo 帧消费 / ack / hook 生命周期 | `src/host/cron/cronWebhookRelay.ts` |
| Neo 帧解析与 hook 端点调用 | `src/host/cron/cronApiClient.ts` |
| 事件源契约（`EventWebhookScheduleConfig`） | `src/shared/contract/cron.ts` |
| 入队/去重/untrusted 块 | `src/host/cron/cronEventTrigger.ts` |

## Neo 侧用户入口（N-CRON-WEBHOOK-CLOUD-HOOK-FU1）

- **云端服务配置**：设置 → 权限与安全 页的「云端计划任务服务」卡。地址写 `settings.cronCloud.baseUrl`；
  令牌只进 secureStorage（service key `neo-cron-cloud`，不进 settings.json；旧版 `settings.cronCloud.token`
  仅作只读回退）。保存后渲染层调 cron IPC `ensureCloudStream`，主进程幂等启动云端事件流（hook 投递的唯一通道），免重启。
- **创建**：手动配置的调度类型常驻「Webhook 投递」；云端未配置时显示原因 + 「去设置」并禁用保存（去设置前草稿暂存、回来取回）。
  创建成功后渲染层调 IPC `registerWebhookHook`，完整 URL 只在一次性卡里展示一次（Copy + 密码级警示）。
- **重新生成**：任务详情的「Webhook 链接」块不再显示链接，只说明已隐藏；「重新生成」确认后调 `rotateWebhookHook`
  （旧链接立即失效），新 URL 走同一张一次性卡。任务停用时 Neo 已 `remove` hook，详情提示链接已吊销；重新启用不自动 mint，
  用「重新生成」找回（rotate 对已被 remove 的 jobId 的行为由中继仓定义，Neo 侧未能验证）。
- hook 响应里的 `{url, token}` 只经 IPC 返回值到达渲染层：主进程不记录、不持久化；失败响应只带不含密钥的消息，
  云端未配置用独立错误码 `CRON_CLOUD_NOT_CONFIGURED` 供渲染层本地化。
