# ADR-060：内部插件运行时装载器（internal-feature runtime loader）

- 状态：**已采纳**（2026-08-31 爸拍板 D1–D5 通过；用户面术语统一为「插件」；插件的家是**能力中心 · 插件类目**，`CapabilityHubPage.tsx:54` 渲染的 `PluginsSettings` 只是旧组件名）
- 工单：N-SPLIT-EVAL-LOADER（插件化线 W7）
- 相关：#1489（评测中心拆成内部包）、ADR-049（能力中心）、N-EVAL-USAGE-COMPAT（完整真机验收的依赖）
- as-built 基线：origin/main@1834dac62

## 背景

#1489 把评测中心搬进 `packages/internal/evaluation-center/`，正式包 0 评测代码。但拆走的只是代码，没留把它**装回来**的路，而且断的是两条腿：

- **renderer 腿**：`internalFeature.rendererEntry` 指向源码路径 `src/renderer/evalCenter/EvalCenterPage.tsx`，全仓零消费方；主 renderer 是 Vite 静态包，没有任何运行时加载包内 UI 的机制。
- **host 腿**：`registerEvaluationHandlers()` 全仓零调用（只有 package.json 脚本和 CI 引用这个包）；`index.cjs` 的 `activate()` 是空壳。安装链对入口做 AST 校验（`assertNoAmbientAuthority`）禁止 `require`/`import`、入口 ≤48KB——包里 5.6k 行 host 评测代码从这条路进不来。
- **入口**：`SidebarAccountMenu` 的评测项、`App.tsx` 页面槽、`eval.center` access key 全删，旧 state 槽被 InAppValidation 挪用。

结果：管理员装了包，左下角没入口；有入口也没代码可显示；有 UI 也没有 IPC 应答。

爸 08-31 拍板：**A = 真运行时装卸语义**（正式包也能装、装了才出现、卸了消失），否决 B（打回正式包）/ C（dogfood 构建变体）。

## 决定方案形状的五条 as-built 事实

1. 桌面壳是 **Tauri 2 + 本地 Node web server（localhost:8180）**，不是交接档写的 Electron。renderer 由 `src/web/routes/static.ts` 的 `express.static` 托管；`src-tauri/tauri.conf.json` CSP 与 `src/renderer/index.html` CSP 都放行同源脚本。⇒ 远程模块走 HTTP 同源加载，没有 file:// / asar 问题。
2. 主 renderer 用 **Vite 8（Rolldown）**；`vite.config.ts` 注释记着改 chunk 图曾触发 minify TDZ 阻塞 React mount。⇒ 方案不给主 renderer 加新 entry / 新构建插件。
3. 依赖面：包 renderer 引主 renderer **20 个 `@renderer/*` 模块** + react + zustand（`lucide-react`/`react-virtuoso` 可打进包；`@shared/*` 只有常量与纯函数，可内联）。包 host 引 `@host/*` **35 个模块，其中 11 个是 `@host/testing/*`**（纯评测逻辑；主 host 只有 `agent/verification.ts` 一处消费它）。
4. Tailwind v4 扫描范围是 `tailwind.config.js` 的 `./src/renderer/**`，包里 686 处 className **不在主 CSS 里**。⇒ 远程模块必须自带 CSS。
5. 安装链现成：stage（目录/zip ≤50MB，沙箱试跑 `index.cjs`）→ confirm（`fs.cp` 整目录到 `<userData>/plugins/<id>/`，写 sha256 回执）→ `list()`（每次重算 hash 验回执）→ `uninstall()`。IPC 五通道全 `isCurrentUserAdmin()` 门控；web 侧 `ipcMain.handle` 是运行时 `Map`，`src/web/routes/domain.ts` 按通道名分发并过 `assertChannelAccess`，包的 ipc 已 `registerAdminChannels(EVALUATION_CHANNELS)`。⇒ 运行时注册的 handler，renderer 能直接调到。

Spike（仓库自带 Vite 8，`code-agent/scratchpad/mf-spike/`，08-31）：`rollupOptions.external` + 函数式 `output.globals` 产出
`})({}, window.__NEO_SDK__["react"], window.__NEO_SDK__["@renderer/stores/appStore"], …)`；函数式 `output.paths` 亦可（ESM 形态，改写成 `/internal-sdk/<spec>.js`）。Rolldown 两条都支持，`@shared` 常量按预期内联。

## 决策

### D1 机制：Module Federation 的语义，用 Vite 原生 external + globals 实现，不引 MF 库

"MF" 要的两件事——**宿主共享单例**（React / Zustand store / ipcService 只能有一份）与**远程模块运行时装载**——用原生能力就够：

- 宿主把要共享的模块显式挂成一张表：`window.__NEO_INTERNAL_SDK__ = { version: 1, modules: { react, zustand, '@renderer/stores/appStore': ns, … } }`（`src/renderer/internalFeatures/internalSdk.ts`，`src/renderer/index.tsx` import 一次；**不新增 Vite entry，不动 chunk 图**）。
- 包按 IIFE 构建：`external` = 表里的 specifier，`globals(id) = window.__NEO_INTERNAL_SDK__.modules[id]`。**包源码一行不改**（仍写 `@renderer/...`，typecheck 仍对着真源码）。
- ⚠️ spike 08-31 第二轮抓到的坑：只把 `react` 标 external 时，JSX（`jsx: react-jsx`）编译出的 `react/jsx-runtime` 会被 Rolldown **整个打进远程包**（产物从 1.7KB 涨到 12.7KB，内含 `node_modules/react/cjs/react-jsx-runtime.production.js` 和一句 `require("react")`）——这就是"两个 React"事故的入口。⇒ external 表必须含 `react/jsx-runtime` / `react/jsx-dev-runtime`（以及任何 `react-dom/*`、`zustand/*` 子路径），并加构建期断言：**产物里出现 `node_modules/(react|react-dom|zustand)` 或裸 `require(` 即红**。
- 宿主 `<script src>` 加载，读全局 `__neoInternalFeature_<id>.Page` 渲染。

不引 `@module-federation/vite` / `vite-plugin-federation`：它们声称支持 Vite 8/Rolldown（vite-plugin-federation 1.0 / @module-federation/vite 1.15.4，2026-05），但要在**主 renderer 构建**上装插件（碰 chunk 图 = 碰 TDZ 旧坑）；`shared` 面向 npm 包，`@renderer/*` 本地模块照样要 `exposes` + 别名——活一样多，多一个依赖和一层"编译器特定兼容层"（modulePreload 改写 / codeSplitting groups / TLA）。我们没有多宿主、多版本协商、跨仓远程的需求。用户可见行为两者完全一致，按"改动面决胜"选原生。

一手文档核过的三条硬事实（08-31，`github.com/module-federation/vite` README + vite-plugin-federation 1.0 发布文）：① host 侧会向 index.html / entry 注入 MF runtime，并「requires chunk splitting so `loadShare` and `runtimeInitStatus` stay isolated」，`codeSplitting:false` 会被忽略（警告）；② **Vite 8 上 `manualChunks` 被忽略（warns）**，必须迁到 `codeSplitting.groups`——而我们主 renderer 正是用函数式 `manualChunks` 钉着 3 个 vendor 组来绕 TDZ 坑的，装 MF 插件等于强制重写这段；③ `shared` 只面向 npm 包，本地模块走 `exposes`。这三条决定了：MF 库的代价落在**所有用户都跑的主 app** 上，而它多出来的优点（远程代码分割、版本协商、manifest 发现、重试/SRI/熔断）在「同仓构建 + localhost 同源 + 管理员专用」这个部署形态下没有一条能被用户感知。

升级路径（写进代码 `ponytail:` 注释）：IIFE 单文件不能代码分割；若远程模块需要拆 chunk，改 ES 形态 + 函数式 `output.paths` 指向 shim（spike 已验）。

### D2 host 腿：特权装载，不进沙箱，第一方 id 白名单

- 包自带 `dist/host/index.cjs`（esbuild cjs），导出 `activate(ctx) → { deactivate }`。
- 宿主新增 `InternalFeatureHostRuntime`：三处调用——boot（registry 加载完之后）、`confirm()` 之后、`uninstall()` 之前。`require()` 前重验回执 hash；`activate({ ipcMain, sdk })`；`deactivate()` 摘 handler + 释放 admin 通道（`registerAdminChannels` 返回的 disposer）。失败 → 包 `state: 'error'` + `error` 文案，走 `InstalledCapabilityPackage` 已有字段，能力中心插件类目不用改就能显示。
- 共享面：`globalThis.__NEO_INTERNAL_HOST_SDK__.modules` 显式列 **24 个 `@host/*` 模块**（DB / auth / config / logger / platform / telemetry / sandbox / model / agent runtime——有状态或必须与活宿主同实例的）；`@host/testing/*` 与 `@shared/*` 是纯评测逻辑，**打进包**（重复一份无副作用，也不把评测 harness 塞回默认 host 包）。
- 构建期 fail-loud：包引了不在表里、也不在 testing/shared 的 `@host/*` → 构建报错指名道姓。相对路径 import 按解析后的绝对路径归一到 `@host/<rel>` 再判（否则 `../../model/quickModel` 这种会绕过表被打进包，产生第二个实例）。
- 信任模型：internal-feature 包**以宿主全权运行**（tools 包仍沙箱）。凭据 = 管理员安装 + `distribution: 'internal'` + hash 回执 + 宿主硬编码第一方 id 白名单（先只有 `evaluation-center`）。不做 worker/RPC 沙箱：轻资产硬约束，且评测本来就要碰 DB / agent runtime。

### D3 renderer 腿：同源静态路由 + 左下角按装载态出项

- 路由 `GET /internal-features/:id/*` → `<plugins>/<id>/dist/renderer/`：只对已装载成功的 id 开放；`isCurrentUserAdmin()` 否则 404；路径穿越 404；`?v=<packageHash>` 破缓存。不放 `/api` 下（`<script>` 带不了 bearer）；UI 代码不是秘密，数据在 IPC 层已 admin 门控。dev 模式 `vite.config.ts` proxy 加一条 `/internal-features`。
- 状态通路：`internalFeatureStore { features, refresh() }`（消费现有 `CAPABILITY_PACKAGE_LIST`，只留 `surface==='internal-feature' && state==='active'`）；能力中心·插件类目（组件 `PluginsSettings`）装/卸后、admin 登录后 `refresh()`。`appStore` 加 `activeInternalFeatureId` + setter（走 `SECONDARY_PAGES_CLOSED`）——这就是 #1489 删掉的 state/action 的重声明，不复活 `showEvalCenter`。
- `SidebarAccountMenu`：`canAccessFeature('capability.internal', user)`（现成 key，不再加 `eval.center`）→ 每个 active 内部功能一条 `AccountMenuItem`，label 取 manifest，图标统一。
- `App.tsx` 页面梯子加 `activeInternalFeatureId ? <InternalFeatureHost/>`：校 `sdkVersion`，注 `<link>` css，加载脚本，错误边界（加载失败 / 不兼容 → 一张卡 + 重试 / 重装提示）。卸载后 `refresh()` 发现 id 不在了 → 关页。
- 样式：包自己跑 Tailwind v4（复用主 `tailwind.config.js` 的 theme，`content` 只扫包内），只出 utilities 不出 preflight；主题 CSS 变量运行时从宿主拿。

### D4 契约：`internalFeature` v1

```json
"internalFeature": {
  "id": "evaluation-center",
  "label": "评测中心",
  "sdkVersion": { "host": "a1b2c3d4", "renderer": "e5f6a7b8" },
  "builtFrom": { "appVersion": "0.33.0", "commit": "1834dac" },
  "rendererEntry": "dist/renderer/index.js",
  "rendererStyles": "dist/renderer/index.css",
  "hostEntry": "dist/host/index.cjs"
}
```

- `pluginValidator`：internal-feature 必须有 `sdkVersion`，三个文件必须存在；`sdkVersion ≠ 宿主 INTERNAL_SDK_VERSION` → **stage 阶段就拒**（"这个插件与当前应用的内部接口不匹配，请用当前版本重新构建"）。运行时再校一次（防云端 renderer 热换后版本错位）。
- `sdkVersion` **不许手写**：由构建脚本从两张 SDK 表的「模块名 + 导出名」**各自**算 sha256 前 8 位（host 一个、renderer 一个；宿主构建写进 `INTERNAL_SDK_VERSION`，包构建写进 plugin.json），两侧各校自己的（情形 D 的原因）。这样宿主改了任一共享模块的导出，旧包在 stage 就被拒，不靠人记得升号——这是本方案相对 MF 库唯一真缺一角（无版本协商）的补法。
- 包侧入口约定：`dist/renderer` 导出 `Page: React.FC`；`dist/host` 导出 `activate / deactivate`。
- 两张 SDK 表就是契约面；各配一个测试锁死"包 import ⊆ 表 ∪ 可内联"。

## 版本更新的四种情形

| 情形 | 谁动了 | 发生什么 | 用户看到 |
|---|---|---|---|
| **A 插件更新**（同一宿主契约） | 管理员在能力中心导入新 zip | stage 显示「将替换 v旧」（现成 `replacesInstalledVersion`）→ confirm：**Runtime.unload(旧)**（`deactivate()` 调 `evalRunBridge.abortRun()` 中止在跑评测，原因「插件正在更新」）→ 目录替换（现成：临时目录→hash→回执→旧目录改名备份→换入；失败回滚并 **重新 load 旧包**）→ **Runtime.load(新)** → renderer `refresh()`：packageHash 变 → `?v=` 破缓存拉新脚本，同名全局覆盖；页面若开着按 hash 作 key 强制重挂 | 不重启，页面一闪换新；在跑的评测被中止并说明原因 |
| **B 包比宿主新**（在更新的提交上构建） | 包 | stage 阶段契约哈希不符 → **拒**。包 `plugin.json` 带 `builtFrom: { appVersion, commit }`，文案能说准 | 「这个插件是为 Neo x.y.z 构建的，请先升级应用」 |
| **C 宿主更新、包旧** | Tauri updater 升级 app（`userData/plugins` 不动） | 启动 `loadInstalled()` 校哈希不符 → **不装载**，包 `state:'error'`，目录保留不自动删 | 菜单项消失；能力中心该插件红条「与当前版本不匹配，请重新安装新版插件」 |
| **D 云端 renderer 热换**（`rendererBundleCache`） | renderer 单独换了 | host 契约与 renderer 契约**分两个哈希**（`sdkVersion: { host, renderer }`），各校各的；热换只影响 renderer 侧检查 | 文案指向「界面版本与插件不匹配」而不是误报 host |

- 包版本号由 L2 构建脚本盖：`version = <appVersion>+<commit7>`，不手写 `1.0.0`；降级同 A（hash 变即可）。
- 分发渠道暂为手动 zip（CI artifact 下载后导入），不做内部包自动更新通道——管理员/dogfood 专用，不值一条基建。

## 扩展性边界：三类插件各走哪条路，以及什么时候该换 MF

| 插件类型 | 信任 | UI 从哪来 | host 代码 | 机制 |
|---|---|---|---|---|
| **tools 包**（现有，第三方可装） | 沙箱 | 主 renderer 统一渲染工具卡，包不带 UI | `index.cjs` 沙箱内 `registerTool`，权限枚举（filesystem/network/shell/…），AST 禁 require | 现成，与本 ADR 无关 |
| **internal-feature 包**（本 ADR，第一方/管理员） | 宿主全权 + id 白名单 | 包自带，宿主表共享单例 | `dist/host/index.cjs` 全权，经 SDK 表拿 DB/auth/runtime | 本 ADR；**N 个第一方包共用同一张表**（表不按包分），契约哈希各包各校 ⇒ 管理台/提示词管理/回放拆包零新机制 |
| **第三方带 UI 的插件**（未来：连接器设置面板、自定义产物查看器…） | 不可信 | 必须隔离 | 沙箱 | **iframe + 窄消息 API**（VS Code webview / Figma / Notion 一律如此）。MF 和本方案都是"按引用共享 store/ipcService"，对不可信代码谁都不能用。另开 ADR，本方案不挡它 |

切 MF 库的三个触发条件（任一出现即重议，形状一样所以是包侧构建配置 + host 加插件的活）：① 第一方远程之间互相 import（包 A 用包 B 的组件）；② 远程独立发版、挂云端（需要 manifest 发现 / 预加载 / 重试）；③ 同一宿主要同时装两套不同契约版本的远程。现在三条都没有。

**Native 层**（爸 08-31 问）：
- Tauri/Rust 层（`src-tauri/src` 7 文件 ≈1 万行、47 个 `tauri::command`，全是窗口/托盘/截图/PiP/更新这类壳的事，业务全在 Node webServer）：插件 = 编译期 Cargo crate，**任何方案都做不到运行时加 Rust**（MF 是纯 JS，一样不行），也不需要——要碰 OS 的能力走 Node host。
- Node host 层：本 ADR 的 host 腿就是它。internal-feature 包能 `require` 原生 addon、`spawn` 进程、经 SDK 拿 `databaseService`（better-sqlite3 在宿主 `NATIVE_EXTERNALS` 里）。约束：包自带 `.node` addon 要按 app 的 `bundled-node` ABI/平台预编译；沙箱 tools 包不能 require，但有 `shell` 权限可 spawn 外部命令。
- Rust 能力的扩展路径（爸 08-31 确认）：**第一方在编译期加 `tauri::command` + renderer 侧 service 封装**（现成样板 `src/renderer/services/nativeDesktop.ts` 经 `window.__TAURI_INTERNALS__` invoke）→ 挂进 renderer SDK 表 → 内部包/未来 UI 插件消费。今天的桥是单向的：Rust 用 `reqwest` 打 Node、renderer 经 `/api/domain/desktop/*` 把原生事件送进 Node，**没有 Node→Rust 直连**——插件的 host（Node）代码要用 Rust 能力，得先开一条 Node→Rust 桥（另一道题，不在本 ADR）。
- 第三方带 UI 的插件 → 已开 **N-PLUGIN-UI-SURFACE**（插件化线 W8，设计单）：参考 dsh「Web UI = slot 挂载的第二棵插件树」，核心待决=信任模型（dsh 式按引用挂 slot 扩到第三方 vs iframe+窄消息 API）。08-14 借鉴清单 N8 的两票否决按归档冻结规则改状态不改正文。
- 原生二进制先例：computer-use 的 `cua-driver` 是重签名成独立 `.app` 随 **app 资源**发（`scripts/fetch-cua-driver.sh`，因 macOS TCC 权限按发起请求的 bundle 归属），不是随插件目录来的。要让插件自带需要 TCC 权限的二进制，签名/公证/TCC 归属是另一道题。

## 后果

- 得到：任何 `surface: internal-feature` 的包都能走这条路（不只评测中心）；正式包 0 评测代码不变；装/卸即时生效，不重启。
- 代价（如实，不是零缺点）：
  1. **IIFE 无代码分割**：评测中心 6k 行 + 打进去的 lucide/virtuoso 一次性加载（估 300–600KB min），点开时多一拍；MF 库的远程能拆 chunk，这是真让出去的一项。升级路径已 spike（ES + `output.paths`）。
  2. **两张显式表要人维护**：包要用新的宿主模块 = 宿主 PR 加一行 + 包重构建。MF 库对本地模块同样要 `exposes`，这条两边一样；只有 npm 包（react/zustand）MF 的 `shared` 省一行。
  3. **契约漂移没有协商机制**：宿主改了共享模块的导出，只有「包在同一提交上重构建」才能靠 typecheck 发现；跨提交装旧包靠 `sdkVersion` 挡。⇒ 上面把 `sdkVersion` 改成自动契约哈希就是补这一角。
  4. **远程开发没有热更**：改评测 UI = 重构建 + 能力中心重装（D5 已定先这样）；MF 的 Vite 插件有 dev 远程直连。做评测 UI 的工人会感到慢，后续开 link 模式单补。
  另：`list()` 每次重算 hash 多了 dist 的 1–2MB（sha256 毫秒级）；host SDK 让 24 个 `@host/*` 模块成为半公开面；两个 `window.__neo*` 全局。
- 不做：多窗口同步、热重载、link 模式开发（先「构建 → 从目录重装」）、非管理员可见。

## 验证预告

- 机制层（单测 + 反向变异）：runtime load/unload 注册/摘除 handler；validator 拒缺文件 / 版本不符；路由穿越 / 非 admin 404；SDK 表越界 import 构建红（变异：往包里加一行未暴露 import，构建必红）。
- 集成层：`eval-harness-gate.yml` 加包构建步，证明包构得出来。
- 全链路（真机，Playwright 驱动 web 模式；`CODE_AGENT_WEB_MODE=true + CODE_AGENT_ENABLE_DEV_API=true` 即 `isLocalWebAdminTestMode` admin）：装真 zip → 左下角出项 → 点开渲染 → 卸载 → 项消失页关闭，截图归档。N-EVAL-USAGE-COMPAT 通后接爸定的完整真评测流程（选集 → 真跑 → 进行中 → 结果 → 抽屉 → 基准）。

## 施工拆单（ADR 过后开）

| 单 | 内容 | 门 | 依赖 |
|---|---|---|---|
| L1 契约 + host 装载器 | validator / sdkVersion、`internalHostSdk`、`InternalFeatureHostRuntime`、`/internal-features` 路由、list() state | 单测 + 变异 | — |
| L2 包构建流水线 | vite IIFE + Tailwind 作用域 CSS、esbuild host + SDK stub 插件 + 越界报错、zip、CI 构建步、`entry.tsx` / `entry.ts`、`deactivate` | 构建绿 + 越界红 | 契约（与 L1 同步定） |
| L3 renderer 装载 + 入口 | `internalSdk.ts`、store / appStore 槽、`InternalFeatureHost`、菜单项、App 梯子、dev proxy；**用户面文案统一「插件」**（`zhSettingsModels.ts:753-776` 的 5 处旧术语 + en 对应） | 单测 + Kimi before/after | L1 契约 |
| L4 真机验收 | Playwright 装 → 开 → 卸截图；USAGE-COMPAT 后扩真评测 | 截图 + 断言 | L1–L3 |

L1 ∥ L2 可并行（契约先钉），L3 可用 mock list 并行起步，L4 收尾。

## 事实锚点

- `src/host/plugins/types.ts:70-74` internalFeature 类型；`src/shared/contract/capabilityPackage.ts:31-50` InstalledCapabilityPackage
- `src/host/services/capabilities/manualCapabilityPackageService.ts:171-201` assertNoAmbientAuthority；`:326-352` stage 输入；`:374` 48KB；`:268` fs.cp；`:540-583` list/uninstall
- `src/host/plugins/pluginApprovalReceipt.ts:25-35` hashPluginPackage 全目录；`:74-92` 每次 verify 重算
- `src/host/ipc/adminGuard.ts:18-30` isCurrentUserAdmin / 本地 web 测试模式
- `src/web/routes/static.ts` express.static；`src/web/app.ts:139-241` 中间件顺序；`src/web/electronMock.ts:14-32` handlers Map；`src/web/routes/domain.ts` 通道分发 + assertChannelAccess
- `src/host/ipc/channelAccessPolicy.ts:8` registerAdminChannels 返回 disposer；包 `src/host/ipc/evaluation.ipc.ts:44` 已调用
- `vite.config.ts:123-129` alias；`:130-146` dev proxy；chunk/TDZ 注释在 build.rollupOptions.output
- `tailwind.config.js:3-5` content 只扫 src/renderer；`src/renderer/styles/global.css:11-12` @import + @config
- `src-tauri/tauri.conf.json` build.devUrl=localhost:8180 / app.security.csp / bundle.resources 含 dist/renderer
- `src/renderer/utils/accessControl.ts:10-31` 注册表含 `capability.internal`；`src/renderer/stores/appStore.ts:232,504,677` showInAppValidation 三处形态
- `packages/internal/evaluation-center/src/renderer/evalCenter/EvalCenterPage.tsx:61` `React.FC` 无 props；包 `plugin.json` 现 rendererEntry 指源码
