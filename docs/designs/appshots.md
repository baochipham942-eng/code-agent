# Appshots 设计（窗口快照 → 多模态上下文）

> Status: ✅ Phase 1-4 全部已并入 main（2026-05-26）· Owner: 林晨 · Created: 2026-05-26
> 本文是 Appshots 功能的 SDD spec。**§1 实现状态**记录 as-built 能力；§2 起为设计。

## 1. 实现状态（as-built，2026-05-26）

| Phase | 能力 | 状态 | commit |
|------|------|------|--------|
| Phase 1 | 原生核心：定位前台窗口 + `screencapture -l` 截图 + AX 文本 + 内联 swift Vision OCR 兜底 | ✅ main | 08c49139 |
| Phase 2 | 前端：composer chip + 隐藏 `<appshot>` XML 注入 + 渲染剥离 + 会话绑定防串台 | ✅ main | 3b7bf515 / 8b094157 |
| Phase 3 | 透明 overlay 飞入动画（单屏） | ✅ main | 53664f31 |
| 触发改造 | global-shortcut → `CGEventTap` 左右 Command 双击监听 | ✅ main | 2faf326e |
| 验收修复 | overlay data-url feature + 自身按 PID 排除 | ✅ main | 8dcaae35 |
| 体验 | chip 预览 Modal + appshot 入会话持久化 + trace/sidebar 呈现 | ✅ main | 309ba995 |
| Phase 3.1 | overlay 全屏 / 多屏并集覆盖（objc2 抬高 NSWindow level 盖全屏 app） | ✅ main | 0b70586f |
| Phase 4b | OCR 复用预编译 `vision-ocr` 二进制（冷启快，回退内联 swift） | ✅ main | 0b70586f |
| Phase 4a | 设置 tab（启用开关 / 发送目标 current\|new / 权限引导）+ `appshots_set_enabled` 同步原生热键 | ✅ main | 28b259e2 |

> ℹ️ 设置 UI 已并入 main：启用开关 + 发送目标 `current\|new` 选择见设置 tab；热键仍由原生 `APPSHOTS_ENABLED`（默认 true）门控，由 `appshots_set_enabled` 命令同步。设置 tab 的 live 渲染器点击验证仍待补（见 §9）。

**核心文件**：

| 文件 | 侧 | 职责 |
|------|----|------|
| `src-tauri/src/appshots.rs` | 原生 (Rust/swift) | CGEventTap 热键、窗口定位、screencapture、AX/OCR、overlay 动画、`APPSHOTS_ENABLED` 门控、Tauri 命令 |
| `src/shared/contract/appshot.ts` | shared | `AppshotCapture` 类型、`buildAppshotXml()` / `stripAppshotBlocks()` / `buildAppshotAttachment()` |
| `src/renderer/stores/appshotsStore.ts` | renderer | Zustand：`pending` / `pendingSessionId` / `starting` / `startingSessionId`（防串台） |
| `src/renderer/hooks/useAppshots.ts` | renderer | 监听 `appshots:*` 事件，按需读 dataURL，按 targetSession 绑定会话 |
| `src/renderer/components/features/chat/ChatInput/AppshotChip.tsx` | renderer | chip UI：缩略图 + 文本来源标签 + 预览 Modal + 下载 |
| `src/renderer/utils/sessionPresentation.ts` · `sessionManager.ts` | renderer/main | 会话标题剥离 `<appshot>`（`getDisplaySessionTitle` / `stripAppshotBlocks`） |
| `src/renderer/.../settings/tabs/AppshotsSettings.tsx` | renderer | 设置 tab（启用开关 / 发送目标 / 权限引导） |

---

## 2. 背景与目标

**一句话**：按一下快捷键，把当前前台 app 的**窗口截图 + 可读文本**一并塞进 Agent Neo 聊天上下文，省去"切窗口、手动截图、描述屏幕内容"的来回。

对标参考：alma 桌面应用有类似的屏幕上下文注入。本实现的差异点：文本优先走 **AX 无障碍树**（免 OCR、零成本、结构化），AX 为空才用**端上 Vision OCR**（免费 / 零 token）兜底——比纯 OCR 方案更准更省。

## 3. 触发机制

| 维度 | 实现 |
|------|------|
| 方案 | macOS `CGEventTap`（**listen-only**，不拦截事件），监听 `flagsChanged` |
| 判定 | 左 Command + 右 Command **同时按下**（读 `NX_DEVICEL/RCMDKEYMASK` 或物理 keycode 54/55），`armed` 原子去抖确保单次触发 |
| 为何不用 global-shortcut | Tauri global-hotkey 无法表达"纯修饰键组合"、也不能区分左右 Command（最初的 `CmdOrCtrl+Shift+S` 已废弃） |
| 门控 | `APPSHOTS_ENABLED`（AtomicBool）；`appshots_set_enabled` 命令由前端设置同步（Phase 4a，已并 main） |
| 权限 | Input Monitoring（监听）+ Accessibility（AX 文本）+ Screen Recording（截图） |

## 4. 原生捕获链路（Phase 1）

```
trigger_capture → 后台线程 capture_now()
  ├─ emit appshots:capture_starting { requestId }
  ├─ 定位前台窗口（NSWorkspace.frontmostApplication + CGWindowList，swift -e）
  │    └─ 排除 Agent Neo 自身（PID + bundleId 双保险）
  ├─ screencapture -l <windowId> -o -x -t png → ~/.code-agent/appshots/appshot-<ts>.png
  │    （复用系统 CLI，非弃用的 CGWindowListCreateImage；-o 去阴影 -x 静音）
  ├─ 快门音反馈
  ├─ 文本：extract_ax_text(pid)（AX 树递归取 AXValue/AXTitle/AXDescription）
  │         └─ 为空 → ocr_image()（Vision VNRecognizeTextRequest，zh-Hans+en；Phase 4b 已并 main：优先预编译 vision-ocr 二进制，回退内联 swift）
  └─ emit appshots:capture_ready { AppshotsCaptureInfo } | appshots:error
```

`AppshotsCaptureInfo`：`requestId / appName / bundleId / windowTitle / screenshotPath / axText / textSource('ax'|'ocr'|'none') / windowFrame / capturedAtMs`。

**事件只带磁盘路径**（几百字节），前端按需调 `appshots_read_image_data_url` 读 base64 dataURL（避免几 MB base64 走事件通道，chip 先秒出、大数据异步）。

## 5. 前端注入链路（Phase 2）

```
useAppshots 监听事件
  ├─ capture_starting → setStarting(true, currentSessionId)
  ├─ capture_ready → 读 dataURL → 按 targetSession 决定会话（'new' 先 createSession / 'current' 用 startingSessionId ?? current）→ setPending
  └─ error → toast
        ▼
ChatInput：AppshotChip 渲染（缩略图 + app名/标题 + 文本来源标签：已读取窗口文字/OCR识别文字/仅截图）
  └─ 发送时：
       ├─ buildAppshotXml(capture) → <appshot app="..." name="...">\n# Appshot of ...\n\n<文本></appshot>
       ├─ 在 buildEnvelope【之后】注入 content（避开 XML 里的 @ 被当 @mention 解析）
       ├─ buildAppshotAttachment(capture) → 图片附件随消息发给模型
       └─ clearAppshot()
```

**会话亲和（防串台，commit 8b094157）**：`capture_starting` 时记 `startingSessionId`，`capture_ready` 用它绑定——异步读图期间用户切会话也绑回正确会话；新建/清空会话时 `appshotsStore.clear()`。

**XML 对用户隐藏、对模型可见**：渲染层 `stripAppshotBlocks()` 把 `<appshot>…</appshot>` 从展示文本剔除（UserMessage / Sidebar 标题 / TraceNodeRenderer），但发给模型的原始 content 保留 XML + 图片附件。会话标题生成前先 `stripAppshotBlocks`，避免标题里出现 `<appshot`。

## 6. Overlay 动画（Phase 3）

截图从源窗口位置"飞入"composer 缩略图槽位再淡出，给用户即时的捕获反馈。

- composer 侧用 0 高 `aria-hidden` div 测量屏幕坐标，`appshots_report_composer_slot` 上报给原生。
- 原生建透明 `WebviewWindow`（transparent / no-decoration / always-on-top / ignore-cursor-events / skip-taskbar），内联 data-url HTML，用 Web Animations API 做 translate+scale+opacity 关键帧，动画结束后自动 close。
- 参数用 `__APPSHOT_PARAMS__` JSON 占位符字符串替换内联，不用 `eval`。
- Phase 3.1（已并 main）：求所有显示器并集坐标覆盖全屏 / 多屏；objc2 抬高 NSWindow level 以盖住全屏 app。
- best-effort：overlay 失败不影响核心捕获链路。

## 7. 设置（Phase 4a，已并 main）

`AppSettings.appshots = { enabled: boolean; targetSession: 'current' | 'new' }`（默认 `{ enabled: true, targetSession: 'current' }`，`configService`）。

设置 tab：启用开关（切换时调 `appshots_set_enabled` 同步原生 `APPSHOTS_ENABLED`）/ 发送目标选择 / 触发方式说明（左+右 Command，只读）/ 权限引导按钮（Screen Recording + Accessibility，点击打开系统设置）/ Web 模式禁用提示。

## 8. 平台限制

**macOS only**：CGEventTap / NSWorkspace / screencapture / AX(ApplicationServices) / Vision 全是 macOS API，`#[cfg(target_os = "macos")]` 条件编译；非 macOS `capture_now` 空实现、`appshots_read_image_data_url` 直接报错；Web 模式前端禁用相关 UI。无其他平台分支。

## 9. 后续

- 全屏 app 的 Spaces 切换覆盖（Phase 3.1 尚未支持）。
- 设置 UI 点击行为 + new-session 路由的 live 渲染器验证（commit 28b259e2 标注仅静态验证）。
