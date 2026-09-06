# Ship Note — CLI 终端错误路径卫生：日志/key 不上屏

日期：2026-08-30
分支：fix/cli-terminal-error-cleanup

## 背景

longcat 欠费冒烟（`--provider longcat --model LongCat-2.0` 发一条消息）暴露两类终端污染：

1. **ERROR 日志行泄漏进 Ink TUI**：logger 在 CLI 模式把 ERROR 紧凑单行写 stderr，
   被 Ink patchConsole 收进 static 输出，每行触发整屏重绘，错误提示被重复渲染刷屏。
2. **明文 API key 上屏（三处）**：
   - AI SDK `streamText` 默认 `onError` 把整个错误对象（含 `requestBodyValues.messages`、
     `responseBody`、上游回显的 `ak_…` key）`console.error` 到终端——全量 dump，最严重；
   - logger 的脱敏注册表没有 `ak_` 前缀密钥形态（LongCat `无效的AppId: ak_…` 原样穿过）；
   - 上游 responseBody 里的 key 随之进日志文件与终端。

## 改动

- `src/host/model/adapters/aiSdkAdapter.ts`：streamText 显式 `onError: () => {}`，
  压住 SDK 默认全量 dump；错误仍经 stream 抛给外层 catch 走 logger 脱敏通道（行为不变）。
- `src/shared/security/secretPatterns.ts`：新增 `ak-prefixed-key` pattern
  （`\bak_[A-Za-z0-9]{20,}\b`，prefix 掩码 `ak_***REDACTED***`）；
  `sensitiveDetector.ts` 的 `SHARED_SECRET_TYPE_MAP` 同步 `generic_api_key` 映射。
- `src/host/services/infra/logger.ts`：新增 `setStderrSinkMuted()`——Ink TUI 拥有屏幕期间
  ERROR 单行不再写 stderr（文件持久化不受影响）；
  `src/cli/tui-app/main.tsx` 在 render 前开启、onExit 恢复。

## 验证

- 单测：新增 `logger.stderrMute.test.ts`（静音只挡 stderr 不挡文件；恢复后紧凑单行且 key 已脱敏）、
  `aiSdkAdapterStream.test.ts` 一条（onError 存在且被调用时不碰 console）、
  `secretRedaction.test.ts` / canary 各一条 `ak_` 用例。四门（typecheck/build:cli/eslint/knip×3）全过。
- pty 端到端（`/tmp/neo-p1-sandbox/pty_longcat_verify_fix.py`，真 longcat 欠费账户）：
  无日志行泄漏、无 `ak_` 明文上屏、人话错误提示（鉴权失败 + /login 建议）仍在、`/exit` exit 0。
- pty 回归：shell 直通 / 布局+model picker / P1 UX（审批卡、Ctrl+R、Ctrl+Q）三套全过；
  非 TTY `(sleep 5; printf '/exit\n') | node dist/cli/index.cjs` exit 0。

## 排查过程中的排除项（勿再误判）

- 「turn 结束后 UI 卡 running / /exit 退不出」经带计时复现排除：终态错误后 UI 正确回 idle，
  cleanup 正常完成，进程 exit 0；此前观察到的"卡死"是 pty 脚本 EOF 分支跳过 waitpid 的测量假象。
- 全量 dump 的来源不是项目代码：是 AI SDK streamText 的默认 onError（bundle 内
  `onError: se = ({error}) => { console.error(error) }`），项目从未显式传 onError。
