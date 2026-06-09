# 技术提案：Computer Use 底座迁移 argus → cua-driver

> 状态：实施中 · 创建 2026-06-09 · 关联竞品分析 `docs/competitive/deepchat-vs-neo.html`
>
> **实施进度（分支 `feat/computer-use-cua-migration`）**：
> - ✅ Phase 1-2：cua-driver MCP 接入（`CODE_AGENT_ENABLE_CUA`/`CODE_AGENT_CUA_DRIVER_PATH`，mac/win 门控）+ 工具权限分级（commit `ed5518d`）
> - ✅ §10 部分：cua 工具差异化图标（commit `878580`）
> - ✅ 按实测 cua-driver **v0.5.1** 真实 `list-tools` 校正工具映射（commit `908dea4`）；官方驱动已装（`~/.local/bin/cua-driver`→`/Applications/CuaDriver.app`），`list_apps` 只读路径 PoC 跑通
> - ✅ §11 错误透传：Neo 现有 `transcriptProjection.ts` 已把工具 error 原样喂模型，无需改
> - ⏳ 待办：§3/§11 agent 操作引导注入（`buildEnhancedSystemPrompt` 现为 no-op，需谨慎设计落点）、权限引导 UI、分发打包（见 §12）、动作类 PoC（需用户授权 TCC Accessibility）

## 1. 背景与决策

Neo 当前的桌面 GUI 自动化（computer use）底座是 **argus**（源自 Anthropic Chicago 的闭源快照，挂在 `~/Downloads/ai/argus-automation`，通过 `CODE_AGENT_ENABLE_ARGUS_MCP=1` 以 MCP server 形式接入）。问题：

- **冻结快照**，无法跟随上游更新，能力停滞。
- **以像素坐标为主**，对分辨率/布局脆弱，token 成本高。
- 后台操作只在 macOS（CGEvent），Windows 无后台能力。

竞品 DeepChat 的 CUA 直接 vendor 了开源框架 **trycua/cua** 的 `cua-driver` 模块。经源码级核实（三闸门全部通过），决定 **用 cua-driver 替换 argus 作为 computer-use 底座**。

### 1.1 三闸门核实结论

| 闸门 | argus | cua-driver | 结论 |
|------|-------|-----------|------|
| Windows 本地裸机桌面 | ✅ robotjs+Win32 | ✅ 原生 `platform-windows` crate（UIA+MSAA+WGC），驱动真实 session 非 VM | cua 实现更专业 |
| 后台操作（无需前台） | ✅ 仅 macOS CGEvent | ✅ **mac+Win 双平台默认后台**（PostMessage 投子 HWND，不抢焦点不挪光标） | **cua 更强** |
| 录制/回放 | ✅ teach_step/batch | ✅ `start_recording`/`replay_trajectory` | 持平（语义需确认，见 §6） |

加分项：**MIT 协议可自由 vendor**、本身是 stdio MCP server（与 argus 同样接入方式）、AX 树优先策略原生内置、WGC 可截后台/被遮挡窗口、17.7k★ 活跃维护带 PARITY 对照表。

### 1.2 核心架构原则：按任务类型分工，不做运行时 fallback

```
原生桌面 App  ──►  cua-driver（新底座：AX 树优先 + 双平台后台）
浏览器 / 网页 ──►  Neo 现有 Playwright browser_action（保留不动）
```

**浏览器任务不走 cua**：cua 唯一短板是 Chromium/网页 DOM 的后台点击会退化为抢前台（返回 `background_unavailable`）。而 Neo 的 Playwright `browser_action`（DOM/a11y/targetRef）本就是更优的浏览器方案，正好规避此短板。两者按**任务类型**分工，**禁止做两个 computer-use 引擎的运行时互切 fallback**（坐标系/权限/快照不互通，长期维护脆弱）。

---

## 2. 接入方式

cua-driver 与 argus 一样是 stdio MCP server，复用 Neo 现有 MCP 加载链路（`src/main/mcp/`）。

- 启动命令：`cua-driver mcp`（DeepChat 用 `CUA_DRIVER_MCP_MODE=1` 环境变量）
- Windows 安装：`irm https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.ps1 | iex`
- 兼容模式：`--claude-code-computer-use-compat`（视觉 grounding 兼容，按需）

修改点：`src/main/mcp/mcpDefaultServers.ts`（当前 argus 配置在 L128-138）——把 argus 条目替换为 cua-driver 条目，保留 env 开关（建议改名 `CODE_AGENT_ENABLE_CUA=1`），仍默认关闭，灰度开启。

参考 DeepChat plugin.json 的 mcpServer 配置（vendor 路径化）：
```jsonc
{
  "id": "cua-driver",
  "transport": "stdio",
  "command": "${runtime.cua-driver.command}",
  "args": ["mcp"],
  "env": { "CUA_DRIVER_MCP_MODE": "1" }
}
```

---

## 3. 工具映射表（argus → cua-driver）

| argus 工具 | cua-driver 对应 | 备注 |
|-----------|----------------|------|
| `screenshot` | `screenshot` | cua 用 WGC，可截后台窗口 |
| `left_click` / `right_click` / `double_click` | `click` / `right_click` / `double_click` | cua 默认后台 PostMessage |
| `triple_click` / `middle_click` | ⚠️ 需确认 | PARITY.md 核对，可能需自定义 |
| `type` | `type_text` | — |
| `key` / `hold_key` | `press_key` / `hotkey` | — |
| `scroll` | `scroll` | — |
| `left_click_drag` | `drag` | — |
| `mouse_move` | `move_cursor` | — |
| `left_mouse_down` / `left_mouse_up` | ⚠️ 需确认低级按下/释放 | 见 PARITY.md |
| `cursor_position` | `get_cursor_position` | — |
| `open_application` | `launch_app` | cua 支持 `bundle_id` + `urls` |
| `switch_display` | ⚠️ 需确认多显示器 | — |
| `read_clipboard` / `write_clipboard` | ⚠️ 需确认 | 可能需保留 Neo 内置实现 |
| `zoom` | `zoom` | — |
| `wait` | （agent 侧控制） | — |
| `request_access` / `list_granted_applications` | `check_permissions` | — |
| `computer_batch` | ⚠️ 无直接对应 | cua 无批量，靠 agent loop 串行；评估是否需要 |
| `request_teach_access` / `teach_step` / `teach_batch` | `start_recording` / `replay_trajectory` | **语义不同，见 §6** |
| — | `list_apps` / `list_windows` / `get_window_state` | **新增：AX 树快照（核心能力）** |
| — | `get_accessibility_tree` | **新增：元素索引来源** |
| — | `set_value` | **新增：AX 级直接赋值（输入框等）** |
| — | `page` | **新增：分页/页面级操作** |
| — | `kill_app` / `get_screen_size` / `get_config` / `set_config` | 新增 |
| — | agent cursor 系列 | 新增：UI 浮层（可选启用） |

> 完整以 cua 仓库 `libs/cua-driver/rust/PARITY.md` 逐工具平台对照为准，标 ⚠️ 的项必须在迁移前核对 Windows/macOS 实现完整度。

---

## 4. 交互范式升级：像素优先 → AX 树优先

这是迁移的**核心收益**。cua 的标准操作循环（参考 DeepChat 的 SKILL.md）：

```
1. list_apps              解析目标 App（优先 bundle_id）
2. launch_app({bundle_id}) 启动/复用，拿 pid
3. list_windows({pid})    定位窗口
4. get_window_state(...)   ← 每次动作前快照 AX 树，取元素索引
5. 按元素索引操作 click/set_value/type_text（而非猜坐标）
6. 再次快照，验证可见证据（选中态/文本变化/新面板…）
```

稀疏 UI 降级阶梯（媒体/Electron 类）：
```
AX 树 → Electron AX 强启(AXManualAccessibility…) → CDP DOM(9222) → 截图 → 最多一次 zoom → 像素 click(x,y)
```

**Neo 适配动作**：当前内置 `computer_use`（`src/main/tools/vision/computerUse.ts`）已有可选 AX 路径 + `coordSpace=image` 缩放（`coordinateTransform.ts`）。迁移后 agent 的系统提示/工具引导应改为「AX 树优先，像素兜底」，而非现状的像素为主。

---

## 5. 权限分类器适配

cua 在 plugin.json 用 **per-tool ask/allow** 策略（读类 allow、动作类 ask）。Neo 有更强的体系（`src/main/tools/permissionClassifier.ts`：注解分级 + 规则快路径 + LLM 分类器 + 缓存；权限类型见 `src/shared/contract/permission.ts`）。

适配方案：把 cua 工具按下表映射进 Neo 现有权限类型，**不引入 cua 的 ask/allow 第二套体系**：

| cua 工具类 | Neo 权限映射 |
|-----------|-------------|
| `screenshot` / `list_*` / `get_*` / `check_permissions` | `read`（自动批准，readOnlyHint） |
| `click` / `type_text` / `press_key` / `hotkey` / `drag` / `scroll` / `set_value` / `move_cursor` | `mcp` / `execute`（需审批，destructiveHint） |
| `launch_app` / `kill_app` | `command`（需审批） |
| `set_config` / `set_recording` / agent cursor 系列 | `execute`（需审批） |

落点：`src/main/mcp/mcpToolRegistry.ts` 的 `mapMCPAnnotationsToPermission()`——若 cua 工具自带 annotations 则直接复用现有逻辑；若没有，补一张 cua 工具名→权限的显式映射表。

---

## 6. 上线前必压测项

| # | 风险点 | 验证内容 | 阻断级别 |
|---|--------|---------|---------|
| 1 | **teach 语义差异** | cua 的录制是 **agent 工具调用轨迹**级别（非低级人手鼠键钩子，无 SetWindowsHookEx）。确认 argus 的 teach 实际用法是哪种；若 Neo 依赖「录人类真实操作再回放」，cua 当前不满足 | **高**：用法不匹配则该子能力需另想办法 |
| 2 | **Chromium 网页后台点击** | cua 对 Chromium/部分 GTK/WPF 的 DOM 点击会退化抢前台。验证：凡浏览器任务一律路由到 Playwright，确保不误走 cua | **高**：路由层必须正确分流 |
| 3 | ⚠️ 工具对照 | §3 标 ⚠️ 的工具（triple_click/middle_click/computer_batch/clipboard/多显示器）在 mac+Win 的实现完整度，对 PARITY.md | 中 |
| 4 | vendor-sync 纪律 | cua 是快速迭代上游（DeepChat 周期性 `sync driver vX`）。建立 vendor 版本锁定 + 定期同步流程 | 中 |
| 5 | 安装/分发 | Windows `install.ps1` 与 Neo 打包流程整合；helper 二进制签名 | 中 |

---

## 7. 分阶段实施

1. **PoC（1 闸门验证）**：单机接入 cua-driver MCP，跑通 list_apps→get_window_state→click 闭环，验证 mac+Win 后台点击。
2. **工具映射 + 权限适配**：完成 §3/§5，补 cua 工具→Neo 权限映射，过 permissionClassifier。
3. **路由层**：实现「桌面→cua / 浏览器→Playwright」分流（按任务类型，非 fallback）。
4. **压测**：跑 §6 全部验证项，重点 teach 语义 + 浏览器路由。
5. **灰度**：`CODE_AGENT_ENABLE_CUA=1` 默认关，灰度开启；argus 保留一个 release 周期作回退，验证稳定后退役。

---

## 9. 接入姿势：走 MCP，不走 CLI+daemon

竞品有两种接 cua 的方式，Neo 选 **MCP**：

| | DeepChat（**Neo 学这个**） | Yansu（不学） |
|---|---|---|
| 接法 | vendor cua-driver，**stdio MCP server** | `cua-driver <tool> '<json>'` **CLI 子进程** |
| 进程模型 | MCP server 进程持有 element 缓存 | **必须自管常驻 daemon**（`cua-driver serve`），否则每次 fork 新进程，per-pid 元素缓存跨调用即死 |
| 与 Neo 架构 | 掉进现有 `src/main/mcp/` 链路 + per-tool 权限 | 要在外面包一层 daemon 生命周期管理 |

理由：Neo 已有成熟 MCP 架构（argus 就是 MCP 接的），走 MCP **零额外进程管理**，element_index 缓存天然活在 server 进程里。CLI 路径（Yansu）的唯一好处是"调试时 picks up rebuilds instantly"，对 Neo 不构成收益。

注册形态参考 §2，`command: cua-driver, args:["mcp"]`，stdio。

## 10. 差异化 UI 渲染规范

**反面教材**：DeepChat 把所有 CUA 操作渲染成同一个通用"工具胶囊"（`MessageBlockToolCall.vue`，无任何按操作类型分叉），只有 screenshot 因走 MCP image content 多一个缩略图，显示的是原始参数（`cua-driver.click {"element_index":14}`）。agent cursor 动画是原生 Swift 在真实屏幕上画的（`CuaDriverCore/Cursor/*`），不在 app UI 内。**这是 Neo 可以超越它的点。**

### 设计原则

1. **对话页是"agent 在你电脑上做事的旁白"，不是工具 JSON 流水账。**
2. **分层视觉权重**：工具分"看（plumbing）"和"做（action）"两种性质——看的弱化/折叠，做的突出成叙事行。
3. **app 图标当身份锚 + 动作图标当动词**：观察/打开本就锚定某个 app，让真实 macOS app 图标（通过 bundle_id 取，`launch_app`/`list_apps` 已给）贯穿始终，省掉一堆生造的通用图标。

### 按工具类型的呈现方案

身份锚 = 真实 app 图标；动作图标为单色 lucide（按实际图标库换名）。

| 层级 | cua 工具 | 视觉样式 | 文案模板（填参后） | 审批 |
|---|---|---|---|---|
| **观察(plumbing)** | `get_window_state` `list_apps` `list_windows` `get_*` `check_permissions` | **不独立成行**：表现为 app 图标上一道**扫描微光/脉冲**（置灰），动作来了即收起；或折叠进动作行。**不用眼睛图标** | 「读取界面…」瞬态 | allow |
| **打开 app** | `launch_app` | **该 app 真实图标**（彩色点亮）+ 显著动作卡 | 「打开 **计算器**」 | ask |
| **退出 app** | `kill_app` `hotkey(cmd+q)` | app 图标 + 右下角 `X` 角标 | 「退出 **Numbers**」 | ask |
| **点击类** | `click` `double_click` `right_click` | 小号 app 图标头像 + **箭头光标图标 `MousePointerClick`**（你要的箭头，带点击纹）；可在截图上高亮目标元素框 | 「点击 **重新加载** 按钮」 | ask |
| **输入类** | `type_text` `set_value` | `TextCursorInput`/`Keyboard` 图标 | 「在 **地址栏** 输入 `github.com`」 | ask |
| **按键/快捷键** | `press_key` `hotkey` | **不用图标，渲染键帽** | 「按 `⏎`」/「按 `⌘Q`」 | ask |
| **滚动/移动** | `scroll` `move_cursor` | `ChevronsDown`/`MoveVertical` | 「向下滚动」 | ask |
| **像素动作** | `drag` / canvas `click(x,y)` | 截图上画起止点/轨迹 | 「从 A 拖到 B」 | ask |
| **媒体** | `screenshot` / `get_window_state` 截图 | **缩略图卡片**（点开放大；存引用不内联 base64 省 token），缩略图即视觉无需图标 | 「截取了 **Safari** 窗口」 | allow |
| **代理光标/配置** | `set_agent_cursor_*` `zoom` `set_config` | 弱化系统行 | 「放大查看」 | ask |
| **录制** | `start/stop_recording` `replay_trajectory` | 🔴 录制状态条 | 「开始录制操作轨迹」 | ask |
| **❗错误态** | 任意 `isError:true` | **红色高亮** + 透传 cua 可执行 fix 提示 + 自纠状态 | 「定位失败，重新读取界面后重试」 | — |

### 两个关键实现点

1. **合并"快照-动作-再快照"的视觉噪音**：每个动作前后都有 `get_window_state`（§11 铁律），但用户不该看到两行观察夹一行动作。一个动作行 = [前快照(隐) + 动作(显) + 后快照验证(显示为 ✓/⚠ 小角标)]；silent-drop（前后快照无变化）标 ⚠"动作可能未生效"。
2. **文案的"人话"来自 AX 树，不是参数**：`click({element_index:14})` 里 14 无意义——前一步 `get_window_state` 的 AX 树里 element 14 = `{role:AXButton, title:"重新加载"}`。渲染层须把 element_index **反查 AX 树缓存**（缓存就在 MCP server 进程里）取 accessible name 生成文案。这是 DeepChat 只能显示原始参数的根因。

### 渲染示例

```
[计算器图标] 打开 计算器
[计算器·灰] ∿ 读取界面…                  (扫描微光,瞬态,动作来即收)
[计算器·小] ↖ 点击 数字键「7」           ✓
[计算器·小] ↖ 点击 运算符「+」           ✓
[计算器·小] ↖ 点击 数字键「5」           ✓
[计算器·小] ↖ 点击「=」                  ✓
[缩略图] 结果显示 12   ✓ 验证通过
```

对比 DeepChat 同场景是 8 行 `cua-driver.click {"element_index":14}` 灰条。

agent cursor：cua 默认在真实屏幕画浮层（三角指针贝塞尔滑动+落点涟漪+1.5s 自隐），Neo 可保留；如需在 app 内镜像另说。

## 11. 错误处理 loop 约定

cua 的设计哲学是**错误几乎全在 driver 内处理，以 `isError:true` 文本+可执行 fix 提示返回，靠 agent 自纠**——TS 侧基本没有重试/重连。所以恢复逻辑要 Neo 在 agent loop 里接住：

**cua 官方错误模式（透传给模型，别吞）**：

| 错误文本 | 修复动作 |
|---|---|
| `No cached AX state for pid X window_id W` | 先对同一 window_id `get_window_state` |
| `Invalid element_index N` | 重新快照取新索引（**索引跨快照即失效，永不复用**） |
| `AX action AXPress failed` | 改 `show_menu`/`confirm`/`cancel`/`pick` |
| `Accessibility/Screen Recording permission not granted` | 停，引导授权 helper app |
| minimized 窗口按键只响铃 | 改 AX-click 等效按钮 |

**Neo loop 必须实现的五条**：
1. **硬约束「快照-动作-再快照」**：每个动作前 `get_window_state` 取 element_index，动作后再快照验证。cua 无批量工具（argus 的 `computer_batch{observeAfter}` 在 cua 没有对应），要在 loop 层 enforce。
2. **可执行错误提示透传**：把 driver 的 fix 提示原样喂给模型，别压成"工具失败"，让模型自纠。
3. **silent-drop 检测**：动作后 diff 前后快照，无变化判定静默失败（cua 称之为"最常见失败模式"）。
4. **权限引导接审批 UI**：`check_permissions` 缺失 → 走 Neo 现有审批流引导授权（见 §12 权限 UX）。
5. **轨迹预算上限（借鉴 cua-agent SDK 的 `max_trajectory_budget`）**：每个 computer-use 任务设 token/成本上限，防止 agent 卡死无限点击烧钱。复用 Neo 现有 budget 基建。

driver 内已自动处理的（Neo 不用管）：AX 树稀疏自动试 Electron AX 强启、off-Space 窗口返回 `off_space:true`、焦点抑制不抢前台。

### 11.1 capture_mode 默认 ax —— 把录屏权限降为可选

`get_window_state` 三档（实测 v0.5.1）：`som`（AX+截图，默认，需录屏权限）/ `vision`（仅截图）/ **`ax`（仅 AX 树，不截图，免录屏权限）**。

我们走 AX 树优先，**Neo 应默认 `capture_mode=ax`**（连接时 `set_config capture_mode ax` 或每次 `get_window_state` 显式传 `ax`）：
- 用户**只需授权 Accessibility，无需 Screen Recording**——大幅降低授权门槛（实测中 Screen Recording 授权常卡住）。
- 代价仅丢"截图视觉消歧 + 像素兜底"，而像素兜底场景（canvas/网页）本就路由给 Playwright。
- 需要视觉消歧的个别场景再按需升 `som`（且仅当用户已授权录屏）。

## 12. 分发与权限 UX（决策）

### 12.1 TCC 归属问题（实测踩坑 2026-06-09）

macOS TCC 权限按**实际发起请求的 bundle** 归属。cua-driver 跑在独立 helper `/Applications/CuaDriver.app`（bundle id `com.trycua.driver`），所以授权弹窗写的是 **"CuaDriver"** 而非 "Agent Neo"——用户不知道在给谁授权。更糟：实测机器上**同时存在两个 CuaDriver.app**（官方 + Yansu 内置的 `com.yansu.cuadriver`），`open -a CuaDriver` 被 LaunchServices 解析到 Yansu 那个，弹窗甚至打上 **"Yansu"** 牌子。这是身份冲突。

### 12.2 分发方案决策：重签名内嵌（方案 A）

| 方案 | 弹窗显示 | 取舍 |
|---|---|---|
| **A. 重签名内嵌（推荐）** | **"Agent Neo Computer Use"** | 用 cua-driver-rs（Rust, MIT）从源码构建，Neo CI 用自有 Developer ID 重签名为 `Agent Neo Computer Use.app`（自有 bundle id，如 `com.agentneo.computeruse`）。DeepChat/Yansu 都这么做。品牌正确 + 离线可用 + 版本可控 + **消除多 CuaDriver 冲突**。代价：CI 加 Rust 构建+签名，bundle +~50MB |
| B. 按需下载 | "CuaDriver" | 首次用 computer-use 时提示跑官方 installer。轻量，但品牌混乱（即 12.1 踩的坑）+ 首用需联网 |

**决策：走 A**（computer-use 定位为"对大部分用户实用"的功能，值得做成一等公民）。配 **懒激活**：首次用到才起 helper 进程 + 申请权限。

### 12.3 权限引导 UX（必做）

不能让用户直接面对裸的 CuaDriver 权限面板。Neo app 内需一段 onboarding：
- 文案：「Agent Neo 需要**辅助功能**权限来替你操作应用」（**录屏标注为可选**，见 §11.1）。
- 一个按钮触发授权 + 深链 System Settings → Privacy & Security → Accessibility。
- 用重签名后的 `Agent Neo Computer Use.app` 身份请求，弹窗即显示 Agent Neo，用户能对上号。
- `check_permissions` 缺失 → 接 Neo 现有审批流（§11 第 4 条）。

### 12.4 打包（Phase 5 落地项，未完成）

- 写 `scripts/fetch-cua-driver.sh`（仿 `fetch-rtk.sh`/`fetch-uv.sh`）：构建/拉取 cua-driver-rs + 重签名，产物进 `tauri.conf.json` bundle resources。
- 首次 clone 须跑（同 build-audio-capture / fetch-rtk）。
- `CODE_AGENT_CUA_DRIVER_PATH` 默认指向 bundle 内重签名后的二进制。

### 12.5 实施顺序：打包（重签名）必须先于权限 UI

勘察 `computerUseWorkbench.ts` 发现 Neo **已有完整的 computer-use 权限诊断 UI**（`NativePermissionSnapshot` 区分 accessibility/screenCapture、blocked/warning 诊断、中文文案、`openNativeDesktopSystemSettings('accessibility'|'screenCapture')` 深链、`useAppIcon` 取 app 图标），cua 路径可大量复用，无需从零造。

**但权限 UI 与打包强耦合，顺序必须是：先 §12.4 重签名打包，再 §12.3 权限 UI。** 原因：TCC 按 bundle 归属。权限快照要查的、深链要引导去开的、图标要显示的，都应是**重签名后的 `Agent Neo Computer Use.app`**（自有 bundle id）。若基于当前未重签名的官方 `com.trycua.driver` 先做权限 UI，等于对着错误的 TCC 身份做验证，打包后必返工。

→ 修订 §7 实施顺序：**Phase 5 拆成 5a 重签名打包 → 5b 权限 UI（在 5a 的 bundle 身份上做，且需 `cargo tauri dev`/真机验证授权流）**。本会话已把 5a/5b 的设计全部锁定，执行留待 CI/GUI 环境。

## 13. 关键参考

- cua-driver README：`github.com/trycua/cua/blob/main/libs/cua-driver/README.md`
- 平台工具对照：`libs/cua-driver/rust/PARITY.md`
- Windows 实现解析：`blog/inside-windows-computer-use.md`
- 录制工具实现：`libs/cua-driver/rust/crates/cua-driver-core/src/recording_tools.rs`
- DeepChat 集成范例（plugin.json + SKILL.md）：`github.com/ThinkInAIXYZ/deepchat/tree/dev/plugins/cua`
- Neo 现有锚点：`src/main/mcp/mcpDefaultServers.ts`、`src/main/tools/vision/computerUse.ts`、`src/main/tools/permissionClassifier.ts`、`src/main/tools/vision/browserAction.ts`（保留）
- cua 官方操作/错误/接法文档（可从 Yansu 安装包提取，或 cua.ai/docs）：`SKILL.md`（snapshot-before-action 不变量、no-foreground 契约、Common error patterns 表、capture_mode som/ax/vision）、`WEB_APPS.md`、`RECORDING.md`、`tool-output-format.md`（✅ 文本输出）
- DeepChat UI 渲染参考（反面教材，证明差异化是机会点）：`src/renderer/src/components/message/MessageBlockToolCall.vue`（通用胶囊）、`MessageBlockToolCallImagePreview.vue`（截图缩略图）、`src/main/presenter/pluginPresenter/index.ts`（权限探测/平台门禁/启动 harden）、`toolPolicyStore.ts`（ask/allow 策略）
- 接法实证对照：DeepChat = stdio MCP 插件；Yansu（`/Applications/Yansu.app/Contents/Resources/cua-driver-bundle/CuaDriver.app`，bundle id `com.yansu.cuadriver` v0.1.4）= CLI 子进程 + 常驻 daemon
