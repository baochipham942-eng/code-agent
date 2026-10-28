# ADR-086：原生依赖位置由构建期清单声明，不再运行时试探

- 状态：**已接受**（爸 2026-10-28 拍板：采纳 §4.5 源码模式纯包解析 + §5 子票 T1~T6 依次施工，T7 不排期）
- 单号：N-NATIVE-DEP-MANIFEST-DESIGN
- 基线：`origin/main@76b6e895`（开工时 origin/main 最新提交；本稿为纯设计文档，无生产代码改动）
- 相关：N-SQLITE-LOADER-LOG-NOISE（在飞分支 `origin/mq/sqlite-loader-log-noise`@cadb04f7：先行补丁给 nativeLoader 候选加 require 前存在性检查；本稿不碰其范围，§4.7 定其退役时点）；ADR-081-execution-environment（运行形态词汇）；ADR-083-resident-host（桌面常驻宿主）；`.claude/rules/testing.md` 2026-08-14 条目（按需下载组件「备了子弹没备枪」教训——声明的完备性必须是机器可验证的）
- 关系说明：仓库已有**可选下载资产**的清单先例（`src/host/runtime/runtimeAssetRegistry.ts` + `active.json`），但**随包分发的核心原生模块**没有对应物，仍靠逐路径试探。本稿补的就是后一半，并把两者按 delivery 分界对齐。

## 术语

| 术语 | 含义 |
|---|---|
| bundle 模式 | webServer 由 Tauri 壳拉起的形态：Rust 壳设了 `AGENT_NEO_BUNDLED_RUNTIME_ROOT` / `AGENT_NEO_RESOURCE_DIR`（`src-tauri/src/main.rs:74-75,1202-1213,2138-2140`）。生产包、dev 槽包都算 |
| 源码模式 | 没有 bundle 环境变量的形态：vitest、CI、eval 子进程、CLI、从 checkout 裸跑 `node dist/web/webServer.cjs` |
| runtime root | bundle 模式下 = webServer.cjs 所在的根（mac 包里是 `Contents/Resources/_up_`）；资源路径都相对它 |
| manifest | 本稿新增的 `dist/native/manifest.json`：构建期生成、随包分发、声明每个原生依赖在包内的位置 |
| 候选试探 | 现状模式：把一组可能路径逐个 `require()`，第一个不抛的算赢（`nativeLoader.ts:38-50`） |

## 1. 问题现状（全部引用当前代码）

### 1.1 better-sqlite3：三候选试探 + 包回退

`src/host/services/core/database/nativeLoader.ts:20-28`：

```ts
export function betterSqlite3CandidatePaths(moduleDir: string): string[] {
  // Web/Tauri 模式: 系统 Node.js 运行，Electron ABI 的 .node 文件不兼容
  // 优先从 dist/native/ 加载为系统 Node 编译的版本
  return [
    path.join(moduleDir, '../native/better-sqlite3'),
    path.join(moduleDir, '../../native/better-sqlite3'),
    path.join(process.cwd(), 'dist/native/better-sqlite3'),
  ];
}
```

`loadBetterSqlite3`（`nativeLoader.ts:30-71`）逐个 require，全败再 `require('better-sqlite3')` 回退。dev/CI（无 dist/native）时前两个候选必失败，第三个看 cwd——每次进程起 DB 都产生 2~3 条 `Cannot find module .../better-sqlite3` 错误级日志。这批噪音至少三次被误当成红 CI 的主因（任务书背景）。

消费方共 7 处 + 2 个子进程（`grep -rn "loadBetterSqlite3\|betterSqlite3CandidatePaths" src/`，2026-10-28 原始输出见证据档④）：

- `databaseService.ts:45`、`dbBackup.ts:202`、`browserProfileCatalog.ts:125`、`webServer.ts:1049` —— 各自传自己的 `moduleDir`，四处基准不同
- `dbQuickCheckSubprocess.ts:102-108` / `dbVacuumSubprocess.ts:145` —— 把候选清单 JSON 塞进 `NEO_QUICKCHECK_NATIVE_CANDIDATES`，子进程 `-e` 脚本里**再试探一遍**（`dbQuickCheckSubprocess.ts:59-89`），全败以专用退出码 3 退出

在飞的 N-SQLITE-LOADER-LOG-NOISE 给候选加了 `fs.existsSync` 前置，把噪音压掉，但试探模型没变：仍是「试了才知道哪份是真的」，且多副本并存时「第一个成功的」可能是错的那份。

### 1.2 布局真源已有五份，互不同步

| # | 副本 | 位置 | 谁读 |
|---|---|---|---|
| ① | 候选路径表 | `nativeLoader.ts:20-28` | webServer + 2 个子进程 |
| ② | Rust 启动预检硬编码 | `src-tauri/src/main.rs:1721-1786`（`desktop_shell_resource_preflight`，release 下缺件启动失败弹窗 `main.rs:2102-2111`） | Tauri 壳 |
| ③ | TS 诊断镜像 | `src/host/diagnostics/desktopShellDiagnostics.ts:68-105`（`RESOURCE_DEFINITIONS`） | 桌面诊断 |
| ④ | 构建侧启动资源表 | `scripts/tauri-resource-inventory.mjs:23-40`（`REQUIRED_STARTUP_RESOURCES`） | `verify-macos-release.sh:106` |
| ⑤ | 实际决定打进包的映射 | `src-tauri/tauri.conf.json:48-102`（bundle.resources）+ 架构/平台 overlay（`tauri-arch-config.mjs:41`、`tauri-platform-config.mjs:60-71`） | 打包器 |

新增或移动一个原生资源要同时改五处；漏一处 = 某条腿（门 / 预检 / 诊断 / 运行期）悄悄走错。这是「运行期试探」的根因：没有任何一份**单一、机器可读**的声明说「这个包里原生模块在哪」。

### 1.3 其余原生/按需依赖的定位方式互不相同

| 依赖 | 定位方式 | 锚点 |
|---|---|---|
| keytar 7.9.0 | 普通 `require('keytar')`（N-API/node-addon-api），bundle 里走 node_modules 解析命中 `_up_/node_modules/keytar` | `keytarAdapter.ts:27-45`；`tauri.conf.json:63` |
| node-pty 1.1.0 | esbuild external 的静态 import，包内自探测 `build/Release → build/Debug → prebuilds/<plat>-<arch>` | `esbuild.config.ts:34`；`node_modules/node-pty/lib/utils.js:18-19`；`tauri.conf.json:64-78` |
| sharp 家族 | external + node_modules 解析（@img/sharp-<plat>、libvips、semver、detect-libc） | `esbuild.config.ts:33`；`tauri.conf.json:79-91` |
| onnxruntime-node + avr-vad | **不随包**（`delivery:'optional'`），运行期下载装数据目录，经 `active.json` + `resolveExistingNodeModule` 解析（本身又是一组候选路径） | `runtimeAssetRegistry.ts:71-77`；`runtimeAssetResolver.ts:98-138,174-190` |
| sidecar（rtk/uv/poppler/swift helper） | TS 侧 `resolveHelperBinary` 九候选探测；Rust 侧 resource_dir/cwd 探测 | `runtimeAssetResolver.ts:237-256`；`src-tauri/src/appshots.rs:1026-1029` |
| 更好的先例 | 上游 better-sqlite3 v13 自己就是**确定性单路径**：`lib/darwin-arm64.js` 直接 `require('../prebuilds/darwin-arm64.node')` | `node_modules/better-sqlite3/lib/darwin-arm64.js:2` |

即：上游包自己的加载器早已是「约定位置、平台标签」模式（node-gyp-build 约定），是我们在外面包了一层试探。

## 2. 业界依据（每条带出处）

| # | 来源 | 做法 | 引文/锚点 |
|---|---|---|---|
| 1 | VS Code `src/bootstrap-node.ts` | 生产把 node_modules 打成 `node_modules.asar`——**构建决定的单一位置**；`enableASARSupport()` 只在 `Module._resolveLookupPaths` 里往真实 node_modules 前插一个 .asar 路径，不做任何探测；`VSCODE_DEV` 环境变量区分：`// no ASAR when running out of sources` | microsoft/vscode main 分支 `src/bootstrap-node.ts`（2026-10-27 拉取原文）：`Production builds bundle our node_modules into a node_modules.asar archive that sits next to the (now mostly empty) node_modules folder. Node does not look into .asar archives on its own, so we splice the archive into the lookup paths`；`if (process.env['VSCODE_DEV']) { return; // no ASAR when running out of sources }` |
| 2 | node-gyp-build / prebuildify | `require('node-gyp-build')(__dirname)` 一次调用定终身：只看 `MODULE_PATH/prebuilds/` 和 `EXEC_PATH/prebuilds/` 两个已知位置，文件名编码 runtime/ABI/napi/libc/armv 标签按特异性匹配 | github.com/prebuild/node-gyp-build README：`Prebuilds will be attempted loaded from MODULE_PATH/prebuilds/... and then next EXEC_PATH/prebuilds/...`；`will work in both node and electron without the need to recompile between usage` |
| 3 | bindings 包（要搬走的模式） | 生成一大串候选路径逐个试，"returns the first one that loads successfully"，全败时错误形态是列一长串 `Tried:` 清单 | github.com/TooTallNate/node-bindings README：`This module checks all the possible locations that a native addon would be built at`。成熟产品避开它的原因：**a)** 每次 miss 都是一次真 require 异常（启动税+日志噪音——正是本仓 CI 的症状）；**b)** 多副本并存时「第一个成功的」未必是想要的那份（版本漂移静默选中旧副本）；**c)** 失败报告列全所有路径而不是指名「应该在哪、怎么修」。`nativeLoader.ts:38-50` 的循环正是同构物 |
| 4 | Electron asarUnpack | 原生模块必须从 asar 解包，位置由打包配置声明（`asarUnpack`），加载按 `app.asar.unpacked` 约定定位——又是「构建声明、约定取用」 | Electron 官方文档 asar-archives（2026-10-27 拉取）：`In the following example, shared libraries of native Node.js modules will not be packed`（`asar pack app app.asar --unpack *.node`）；`process.dlopen`（`require` 原生模块用）对包内文件要先抽临时文件 |
| 5 | Tauri 2 资源/sidecar | resources 声明源→目标映射，运行期 `resolveResource` / `BaseDirectory::Resource` 用**与写配置同一套规则**解析；sidecar 走 `externalBin` + 平台三段后缀，`Command.sidecar('name')` 按名匹配配置数组 | Tauri 2 官方文档（2026-10-27 拉取）：`The bundled files will be in $RESOURCES/ with the original directory structure preserved`；`'..' in a relative path will be replaced by '_up_'`；`these APIs use the same rules as you write tauri.conf.json > bundle > resources`；sidecar：`a binary with the same name and a -$TARGET_TRIPLE suffix must exist on the specified path` |

五家（含本仓 optional 资产先例）的共同点不是具体格式，而是**方向**：位置是构建产物的一部分，运行期按声明的名字/约定取——没有任何一家在运行期逐路径试探。

## 3. 运行形态 × 原生模块现状表

每个格子从代码/脚本验证；标「未验证」的项保留原判。ABI 结论先行：better-sqlite3 13.0.3、keytar 7.9.0（node-addon-api）、node-pty 1.1.0 都是 **Node-API**（实测 package.json + prebuilds 布局，见证据档④），「Electron ABI vs 系统 Node」的二分是历史残留（`nativeLoader.ts:21-22` 注释是 v12/bindings 时代写的）；真实维度是**平台×架构**与 **musl/glibc**（`rebuild-native-system.sh:57-63`、`tauri-resource-inventory.mjs:23-26`）。

| 运行形态 | Node / ABI | better-sqlite3 今天在哪 | keytar / node-pty / sharp | onnxruntime-node(+avr-vad) | 锚点 |
|---|---|---|---|---|---|
| ① 生产包 macOS arm64 | bundled node（`Resources/_up_/dist/bundled-node/bin/node`，官方 Node 二进制），Node-API | 主副本 `_up_/dist/native/better-sqlite3/`（rebuild-native 按 lockfile 装配，含 `prebuilds/darwin-arm64.node`）；回退副本 `_up_/node_modules/better-sqlite3/`（lib+package.json+**单架构** prebuild）。加载走候选 1（webServer.cjs 在 `dist/web/`，`../native` 命中） | `_up_/node_modules/{keytar, node-pty, sharp…}` 普通 require/external import 解析；node-pty 包内自探测命中 `prebuilds/darwin-arm64/` | **不随包**，运行期下载到数据目录 `runtime/onnxruntime-vad/<hash>`，经 `active.json` 解析 | `main.rs:2116`；`tauri.conf.json:52,60-98`；`rebuild-native-system.sh:71-75`；`runtimeAssetRegistry.ts:71-77` |
| ② 生产包 macOS x64 | 同①（bundled node x64；runner 传 `BUNDLED_NODE_ARCH`——**未验证** release.yml 是否对 x64 腿传了 x64，标未验证） | 同①，`darwin-arm64`→`darwin-x64` 由 arch overlay 改写；dist/native 由 x64 runner 的 rebuild-native 按当前 arch 装配 | node-pty `prebuilds/darwin-x64/`、`@img/sharp-darwin-x64` 等 overlay 改写 | darwin-x64 **显式跳过**（上游无 x64 npm 包，VAD 降级 missing-runtime） | `tauri-arch-config.mjs:41`；`rebuild-native-system.sh:57-63`；`build-runtime-assets.mjs:359-365` |
| ③ 生产包 Windows x64 | bundled node（`Resources/dist/bundled-node/node.exe`） | `dist/native/better-sqlite3/prebuilds/win32-x64.node` + `node_modules/better-sqlite3/prebuilds/win32-x64.node`（overlay 改写） | node-pty `prebuilds/win32-x64/{conpty,pty}.node`；`@img/sharp-win32-x64`（libvips 静态进包）；keytar 整目录照带；swift helper/audio-capture/poppler/CUA 被 overlay 剔除 | 同①（不随包） | `tauri-platform-config.mjs:41-71`；`verify-windows-release.mjs:49-74` |
| ④ Dev 槽包（`Agent Neo Dev[N].app`） | 同①（同一构建链，只差 identifier/端口/数据目录） | 同①（`tauri:package:dev` 也跑 rebuild-native:system，dist/native 现装配） | 同① | 同① | `package.json:228`；CLAUDE.md dev 槽表 |
| ⑤ 源码态 webServer（系统 Node） | 系统 Node（node 24），Node-API | 候选 1 = `dist/native/`（**仅当** rebuild-native 跑过或 worktree-bootstrap 拷过）；候选 3 = `cwd/dist/native`；全 miss → 回退 `node_modules/better-sqlite3` + warn | node_modules 普通 require | **dev checkout 的 node_modules 里有**（npm ci 装的）——与打包态「下载到数据目录」是两个来源、同一个解析器 | `nativeLoader.ts:23-27,52-68`；`worktree-bootstrap.sh:149-151`；`audioVadRuntime.ts:61` |
| ⑥ CLI（`node dist/cli/index.cjs`） | 系统 Node；banner 注入 `CODE_AGENT_CLI_MODE=true` | nativeLoader 返回 null（host DB 禁用）；CLI 自己的库走 `cliRequire('better-sqlite3')` 纯包解析 | keytar 跳过（CLI guard）；node-pty 是否在 CLI 可达图内**未验证**（external import，有 node_modules 的 checkout 里总能解析） | 不适用（无 DB/voice 面） | `esbuild.config.ts:261`；`nativeLoader.ts:31-33`；`keytarAdapter.ts:30`；`src/cli/database.ts:48,178` |
| ⑦ vitest | 系统 Node，cwd=repo 根 | 候选 1/2 必 miss（moduleDir 在 `src/host/...` 下）；候选 3 命中当且仅当 dist/native 存在（worktree 有、CI `--ignore-scripts` 无）；否则回退 node_modules——**噪音主现场** | node_modules（eval-harness CI 单独 `npm rebuild node-pty --build-from-source`） | node_modules 有 | `nativeLoader.ts:23-27`；`worktree-bootstrap.sh:149-151`；`.github/workflows/eval-harness-gate.yml:129,186-191`；`main-full-gate.yml:58` |
| ⑧ CI runner | 系统 Node（node 24） | 有 dist/native：desktop-lifecycle（完整 `npm ci`，postinstall=rebuild-native）、x64/win 测试腿（显式 rebuild）；无：main-full-gate / eval-harness-gate / swarm-ci（`npm ci --ignore-scripts`） | 同上 | node_modules 有 | `desktop-lifecycle.yml:55-57`；`build-x64-test.yml:36-39,112`；`build-windows-test.yml:45-53`；`package.json:160` |
| ⑨ eval 子进程 | `spawn(process.execPath, [tsx, evalCi, ...])`，cwd=fixture、scratch 数据目录 | 系统 Node + repo node_modules 纯包解析（同⑦形态） | 同⑦ | 同⑦ | `scripts/acceptance/ls-tail-read-eval.ts:380-414` |
| ⑩ dbQuickCheck / dbVacuum 子进程 | `process.execPath -e CHILD_SCRIPT`；父进程是打包态时 execPath=bundled node，源码态=系统 Node | 候选清单 JSON 化传 `NEO_QUICKCHECK_NATIVE_CANDIDATES`，子进程**再试探一遍**，全败 exit 3 | 不涉及 | 不涉及 | `dbQuickCheckSubprocess.ts:59-108`；`dbVacuumSubprocess.ts:145-147` |

## 4. 清单设计

### 4.1 文件与格式

`dist/native/manifest.json`，随既有 `"../dist/native": "dist/native"` 资源映射自动进包（`tauri.conf.json:52`）——**不需要新增 resources 条目**。草案 schema：

```jsonc
{
  "schemaVersion": 1,
  "kind": "agent_neo_native_dep_manifest",
  "generatedAt": "…ISO8601…",
  "generator": "scripts/gen-native-dep-manifest.mjs",
  "appVersion": "0.33.0",
  "platform": "darwin-arm64",        // 写清单时的目标平台（win32-x64 等），与运行期 process 比对
  "modules": {
    "better-sqlite3": {
      "kind": "node-module",
      "entry": "dist/native/better-sqlite3",     // 相对 runtime root，require() 可直接吃
      "native": "dist/native/better-sqlite3/prebuilds/darwin-arm64.node",
      "packageVersion": "13.0.3"
    },
    "keytar":   { "kind": "node-module", "entry": "node_modules/keytar",
                  "native": "node_modules/keytar/build/Release/keytar.node", "packageVersion": "7.9.0" },
    "node-pty": { "kind": "node-module", "entry": "node_modules/node-pty",
                  "native": "node_modules/node-pty/prebuilds/darwin-arm64/pty.node", "packageVersion": "1.1.0" },
    "rtk":      { "kind": "tool-binary", "path": "scripts/rtk", "executable": true, "version": "0.39.0" },
    "poppler":  { "kind": "helper-dir",  "path": "scripts/poppler" }
    // darwin-only 条目只在 darwin 平台清单里出现；win32 清单是 win32-x64 路径
  }
}
```

- 路径一律相对 runtime root（bundle 模式 = `AGENT_NEO_BUNDLED_RUNTIME_ROOT`，即 `_up_`），与 Tauri resources 目标映射同构（§2-5 的 `_up_` 规则）。
- `kind` 沿用 `runtimeAssetRegistry.ts:7-22` 的词汇（node-module / helper-binary / tool-binary / app-bundle），便于远期并轨。
- **不含** onnxruntime-vad / playwright：它们 `delivery:'optional'`，有版本/哈希/下载源语义，已由 `build-runtime-assets.mjs:390-401` 的发布 manifest + `active.json` 覆盖。两份清单按 delivery 分界：**bundled=本清单，optional=既有体系**。

### 4.2 谁写、何时写

新脚本 `scripts/gen-native-dep-manifest.mjs`，唯一 writer（清单禁手改）：

- 数据源：`tauri.conf.json` resources + arch/platform overlay 的同款映射规则。为避免三处漂移，把 `tauri-platform-config.mjs` / `tauri-arch-config.mjs` 的 `mapPath` 抽成可 import 的共享模块，三个脚本共用。
- 写前自检：每条声明路径必须存在，缺则**构建直接红**并指名（对齐 `build-runtime-assets.mjs:189` `Missing runtime asset entry` 的 fail-loud 先例）。
- 挂点：`tauri:package` / `tauri:package:dev` 链，在 `rebuild-native:system` 之后（`package.json:224,228`）；x64/win CI 腿在 overlay 生成后、`cargo tauri build` 前。`rebuild-native-system.sh` 本身不写清单——它只知道 dist/native 一层，不知道 bundle 全貌。

### 4.3 谁读、进程怎么知道自己的模式

模式信号已存在，零新发明：Rust 壳起 webServer 时必设 `AGENT_NEO_BUNDLED_RUNTIME_ROOT` 与 `AGENT_NEO_RESOURCE_DIR`（`main.rs:74-75,1202-1213,2138-2140`），源码态两者皆无。`desktopShellDiagnostics.ts:117-127` 已按同一信号判 bundle root。

新读取方 `src/host/runtime/nativeDepManifest.ts`（与 runtimeAssetResolver 同层）：

```
readNativeDepManifest(env)
  bundle 模式（AGENT_NEO_BUNDLED_RUNTIME_ROOT 已设）：
    读 <root>/dist/native/manifest.json → 校验 kind / schemaVersion / platform
    缺失或坏 → throw（文案见 4.4）
    成功 → 返回条目表；resolve(id) 前校验路径存在，缺 → throw
  源码模式（未设）：
    返回 null → 调用方走纯包解析 require('<pkg>')
```

- `nativeLoader.ts` 的 `loadBetterSqlite3` 改为：bundle 模式 → manifest 取 `entry` 一次 require；源码模式 → 直接 `require('better-sqlite3')`。**候选循环整体删除**。
- 子进程交接（`dbQuickCheckSubprocess.ts` / `dbVacuumSubprocess.ts`）：父进程把 manifest 解析出的**单个绝对路径**传给子进程（替代 `NEO_QUICKCHECK_NATIVE_CANDIDATES` 候选表），子进程一次 require，失败即 exit 3。一个进程一个决定，子进程不再重复试探。
- keytar / node-pty / sharp 的装载第一期不动（两种模式下普通 require 都工作），只把声明写进清单供门做闭合校验（T6 再决定是否逐个切到 manifest 解析）。
- sidecar/helper：bundle 模式下 `resolveHelperBinary` 的九候选探测（`runtimeAssetResolver.ts:237-256`）改为 manifest 直取；源码模式维持探测（只发生在有完整 repo 布局的源码态，无噪音问题）。

### 4.4 缺失 / 过期行为（错误文案）

三条都是 throw / 启动失败，**无静默回退**（文案保持英文，对齐 host 侧既有错误文案口径）：

bundle 模式清单缺失：

```text
[native-dep-manifest] bundle mode but manifest is missing: expected ${AGENT_NEO_BUNDLED_RUNTIME_ROOT}/dist/native/manifest.json. This app bundle is incomplete (packaging bug). Fix: rebuild the bundle so scripts/gen-native-dep-manifest.mjs runs (tauri:package / tauri:package:dev chains). Do not hand-patch the bundle.
```

清单在但声明路径缺失（stale / 装配不一致）：

```text
[native-dep-manifest] module 'better-sqlite3' is declared at <root>/dist/native/better-sqlite3 but the path is missing (manifest platform=darwin-arm64, generatedAt=…). The bundle was assembled inconsistently. Fix: rebuild the bundle; manifest entries must match the shipped files.
```

平台不匹配（拿错 overlay 的包）：

```text
[native-dep-manifest] manifest platform darwin-arm64 does not match this process darwin-x64; wrong overlay used at build time. Fix: rebuild with the matching arch/platform overlay.
```

源码模式清单缺席**不是错误**——它就是 4.5 的规则本身；加载器直取包解析，debug 级别记一行（区别于「降级不留痕」反模式：这里没有降级，是两条不同模式的正路）。

### 4.5 dev / test 无构建怎么办（选型）

**选「源码模式 = 纯包解析」，不生成 dev manifest。** 理由：

1. 源码态所有形态（vitest / CI / eval 子进程 / CLI / 裸跑 webServer）都跑在有 node_modules 的 checkout 里——`worktree-bootstrap.sh:140-148` 第一条就是软链 node_modules；包解析永远可用。
2. 核心原生模块全是 Node-API 带全平台 prebuild（§3 ABI 结论）：系统 Node 下 `require('better-sqlite3')` 与 dist/native 副本**同版本同 ABI**（rebuild-native 本来就按 lockfile 装干净包再拷，`rebuild-native-system.sh:26-53`）。dev 优先 dist/native 没有正确性收益，只有副本漂移风险。
3. dev manifest（如由 worktree-bootstrap 生成）会引入第二个 writer 和陈旧性来源（bootstrap 拷来的 dist/native 可能落后主树 lockfile），而它声明的信息 node_modules 本来就有——纯重复。
4. 附带收益最大：源码模式从「三次试探 + 回退」变成「零试探直达」，CI 的 Cannot find module 噪音在**根上**消失（N-SQLITE-LOADER-LOG-NOISE 的 existsSync 补丁此后无对象可补）。

先例：VS Code 的 `VSCODE_DEV` → "no ASAR when running out of sources"（§2-1），同一选型——dev 态直接用普通 node_modules，不为它造第二套定位机制。

窄例外：**dev 槽包是 bundle 模式**（同一构建链产出），不落本例外，照常要求清单。

### 4.6 发版门怎么验（缺件在门上红，不到用户机器）

mac（`verify-macos-release.sh`）：

1. 新增清单校验：读 bundle 内 `dist/native/manifest.json`；(a) 每条声明路径在 `RESOURCES_ROOT` 下存在；(b) **闭合校验**——bundle 里所有 `**/*.node` 与 `scripts/` 下可执行 helper 要么被清单声明、要么进非原生 allowlist（poppler 的 dylib 闭包已有自己的 sidecar-manifest 门，`verify-macos-release.sh:108-140`，不算漏网）；(c) 清单 `platform` 与 `lipo` 实测架构一致（对齐 poppler 门的 lipo 先例 `:121-129`）。
2. 既有「拿 bundled node 真 require better-sqlite3 prebuild」（`:157-191`）保留，但路径从硬编码改为按清单条目取。
3. `tauri-resource-inventory.mjs:33-40` 的 `REQUIRED_STARTUP_RESOURCES` 改为从清单生成（消灭布局副本④）。

win（`verify-windows-release.mjs`）：

1. pre：清单存在且声明与源路径一致——现在 `verifyPre` 是手写路径表（`:49-74`），改为清单驱动；补齐「拿 `dist/bundled-node/node.exe` 真加载 win32-x64.node」的检查（mac 有、win 目前是空档）。
2. post：NSIS 解包校验成本高，维持现状（exe + PE 魔数 + 体积），靠 pre 侧清单 + 安装后首启 Rust 预检兜底。
3. 同步 `build-windows-test.yml` 与 `releaseMacosGates.test.ts` 特征断言（CLAUDE.md 发版节的既有要求）。

Rust 壳首启预检（`main.rs:1721` `desktop_shell_resource_preflight`）：native 条目改为读清单（serde_json 已在依赖内），缺清单 = 启动失败走 Layer 3 弹窗（`main.rs:2102-2111` 既有通道）——用户机器上的最后防线；按本节设计它应该永远轮不到触发，因为门先红。**未验证项**：`cargo tauri dev`（debug）下 resource_dir 指向 target/debug，清单可达性需在 T4 实测定义。

### 4.7 迁移与回滚

顺序（每步独立可合、独立可回滚）：

| 步 | 内容 | 说明 |
|---|---|---|
| 1 | T1：writer + 清单进 bundle | 纯新增文件，无人读，零行为变化；门开始读 |
| 2 | T2：读取方 + nativeLoader 切换 | bundle=manifest、源码=包解析，删候选循环。**前置**：N-SQLITE-LOADER-LOG-NOISE（在飞）先合——它改同一函数，后合方 rebase；T2 合入后候选循环消失，其测试随 T2 迁移改写 |
| 3 | T3：子进程交接 | quickcheck/vacuum 收单路径，`NEO_QUICKCHECK_NATIVE_CANDIDATES` 语义退役 |
| 4 | T4：Rust 预检 + 诊断镜像 + 构建侧资源表消费清单 | 消灭布局副本②③④ |
| 5 | T5：发版门全量校验 | mac 闭合校验 + win 清单驱动 |
| 6 | T6：清单扩容（keytar/node-pty/sharp/sidecar 声明） | 门 allowlist 收紧到全量闭合 |
| 7 | T7（远期，不排期）：与 optional 资产 registry 并轨 | 概念收敛，优先级最低 |

回滚：每步 `git revert` 即回。清单是 bundle 内**新增**文件，旧 reader 视之为惰性多余文件；reader 回退后恢复的是合入前的镜像行为（候选试探仍在旧代码里）。不需要用户侧动作、不需要发迁移公告。

### 4.8 预期收益

- **定位一次**：bundle 模式一次读清单直取，源码模式零试探直达包解析——替代每次进程启动 3+ 次试探 require。
- **缺件前移**：构建期（writer 自检）→ 发版门（闭合校验 + 真 load）→ 首启 Rust 预检，三级都在用户拿到包之前；现状是用户机器上 webServer 起不来、或日志三连红误导排障。
- **布局真源收敛**：五份副本 → 一份 manifest（tauri.conf.json 仍是「打进什么」的声明源，manifest 是「打进后在哪」的机器可读快照）。
- **CI 噪音根除**：源码模式不再产生候选 Cannot find module 错误。

## 5. 子票拆分（只列不立）

| # | 标题 | 范围 | 验收 | 风险 |
|---|---|---|---|---|
| T1 | 构建期清单 writer | `scripts/gen-native-dep-manifest.mjs`；抽取 arch/platform overlay 的 `mapPath` 为共享模块；挂进 `tauri:package` / `tauri:package:dev` 与 x64/win CI 腿；package.json script | 三条平台腿产物均含 `dist/native/manifest.json`；缺输入文件时构建红且指名路径；schema 守门测试 | overlay 函数抽取触碰两个 overlay 脚本，`releaseMacosGates.test.ts` 特征断言需同步 |
| T2 | 读取方 + nativeLoader 切换 | `src/host/runtime/nativeDepManifest.ts`；`nativeLoader.ts` 重写；测试迁移（含 N-SQLITE-LOADER-LOG-NOISE 的测试） | 4.4 三条错误文案逐字断言；源码模式零候选试探（spy 断言 require 仅一次）；vitest/CI 全量绿 | 与在飞补丁分支的合并顺序；源码模式不再读 dist/native 是行为变化，需在开发者文档写明 |
| T3 | 子进程交接 | `dbQuickCheckSubprocess.ts` / `dbVacuumSubprocess.ts` | 子进程收解析后单路径；缺路径 exit 3 且 stderr 指名清单条目；子进程测试更新 | 低（退出码语义不变） |
| T4 | Rust 预检 + 诊断镜像消费清单 | `main.rs:desktop_shell_resource_preflight`、`desktopShellDiagnostics.ts`、`tauri-resource-inventory.mjs` | 三处不再各自硬编码 native 路径；预检失败信息带清单路径；`cargo tauri dev` 下行为定义并实测（标未验证项收口） | Rust 改动走 rust-ci；debug 构建下清单可达性未验证 |
| T5 | 发版门清单校验 | `verify-macos-release.sh`、`verify-windows-release.mjs`、`releaseMacosGates.test.ts`、`build-windows-test.yml` | mac 双向闭合校验；win pre 门清单驱动 + bundled-node 真加载 win32-x64.node；故意删一个 .node 门必红（变异验证，对齐 ship 硬规③） | 闭合校验 allowlist 初始噪音（CUA .app、poppler dylib 等要正确归类） |
| T6 | 清单扩容 + 全量闭合 | writer 补 keytar/node-pty/sharp/sidecar 条目；门 allowlist 收紧；（可选）`resolveHelperBinary` bundle 模式直取 | bundle 内每个 .node / 可执行 helper 均有声明或 allowlist 理由；装载行为零变化（既有测试回归） | node-pty win32 双文件（conpty.node + pty.node）易漏，win 门必须覆盖 |
| T7 | （远期）bundled 清单与 optional registry 并轨 | `runtimeAssetRegistry` 吸收 manifest 或反之 | 单一资产声明层 | 动 optional 下载链路（active.json/哈希校验）；收益主要是概念收敛，不排期 |

## 6. 不做的事

- 不改 `src/`、`scripts/`、`src-tauri/` 任何现有文件（本稿是设计文档；以上全部进子票）。
- 不给 optional 下载资产（onnxruntime-vad / playwright）换机制——它们的 manifest 体系已在服役。
- 不引入 Electron/asar——本仓是 Tauri + 独立 bundled node，清单落在 Tauri resources 语义里。
- 不为源码模式生成任何清单（§4.5 已论证）。
