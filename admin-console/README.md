# Agent Neo Admin Console

独立 Next.js 控制台，用开发者 Supabase 账号读取 `telemetry_*` 表，服务 Agent Neo 外部分发后的根因定位。

## 能力

- Dashboard：会话总数、错误率、最近会话，以及按 sessionId 跳转根因页。
- Users：读取 `admin_per_user_telemetry`，看 per-user 会话、错误、token 和成本。
- Errors：14 天错误趋势、错误率和最近出错会话列表，点 sessionId 进入详情。
- Feedback：最近 100 条负反馈队列，点 sessionId 进入详情。
- Session detail：会话头、turn 时间线、model/tool 摘要、失败工具、用户反馈、负反馈全文片段，以及 Sentry issue 关联。

## 环境变量

```bash
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SENTRY_ORG_SLUG=...
SENTRY_PROJECT_ID=...        # 可选；填项目数字 ID 时搜索会收窄到该项目
SENTRY_AUTH_TOKEN=...        # 可选；不填时只显示 Sentry 搜索链接，不在本页拉 issue
SENTRY_API_BASE_URL=...      # 可选；默认 https://sentry.io
SENTRY_WEB_BASE_URL=...      # 可选；默认跟 API base 一致
```

登录用户必须满足数据库函数 `is_code_agent_admin()`，普通用户会被重定向到 `/unauthorized`。

## 本地验证

```bash
npm run lint
npm run build
```
