# Ship note · 2026-09-19 · Jev 浏览器步选（N-JEV-BROWSER-STEP）

给 Playwright 托管浏览器增加 `Browser.execute_goal` 内环：每步一次 Jev 并行四问，代码执行并刷新快照。默认关。失败回落现行主模型逐步 `Browser`。

## 开关与装配

- `CODE_AGENT_BROWSER_JEV_STEP=1` 显式开；缺 `TYPESAFE_API_KEY` 时 warn 一行且不装配。
- `CODE_AGENT_BROWSER_JEV_SOFT_STEP_LIMIT` 覆盖软步顶（正整数，封顶硬顶 60；缺省 20）。
- 不拦截现有 `click` / `type` / `get_dom_snapshot`。工具面 interactive cap 仍为 80。

## 数据出境（FolderTrust / 权限披露）

开启后，以下字段会经 `guardSensitiveText` 后再发到 `api.typesafe.ai`（TypeSafe System One，`jev-1.13.0`）。注入扫描命中 critical 则不调用 Jev。未开启则零出境。

- 已脱敏的浏览器 DOM 文本：页面标题、heading、窗口内候选控件短标签；密码/文件字段在窗口选择前丢弃
- `page.url`（截 1500）
- `task` 正文（截 2000）
- `recent_steps`（最近 8 步的 op / target_name / result）
- `assertions`（kind / needle / met）
- `window` 计数（selected / collected / in_view / above / below / truncated / dropped_below）
- `injection_flag` / `sensitive_fields_present` / `unavailable_frames`

权限分类线的命令行出境说明仍见 `docs/shipnotes/2026-08-30-ship-note-cli-permission-mode-auto.md`。
