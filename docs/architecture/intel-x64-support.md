# Intel Mac (x86_64) 适配方案

> 状态：草案 v3（已过艾克斯交叉验证 + PII/VAD 澄清，待真机验证）｜创建 2026-06-09｜linchen + 艾克斯(Codex)
> 背景：同事用 Intel Mac，当前 Agent Neo 仅发 arm64，无法运行。
> 验证记录见 §7。

## 0. 结论先行

- **能做，工作量中等**：纯工程约 2–4 天，大头在 CI 改造 + 真机回归，不在写代码。
- **策略：独立 x64 构建 + 单 manifest 多 platform 更新**（不拆通道，不做 universal binary）。
  - 不做 universal：项目所有 native 资源本就按架构分目录，分架构构建比 lipo 每个 `.node` 更可控。
  - 不拆 `stable-x64` 通道：Tauri 2 updater 支持**一个 `stable/latest.json` 同时含 `darwin-aarch64` + `darwin-x86_64`**，客户端按自身架构选包，无需双通道。
- **rtk 带上 x64**（已决策，2026-06-09）：上游 `rtk v0.39.0+` 有 `rtk-x86_64-apple-darwin.tar.gz`，跟 uv 同级好拿，x64 用户功能与 arm64 对齐。
- **PII 脱敏在 x64 不受影响**：脱敏走 **Python 子进程**（uv → venv → pip 装 `onnxruntime` + GLiNER），Python 版 onnxruntime 有 macOS x64 wheel，只要 uv x64 跑起来即可，**不依赖 node `onnxruntime-node`**。
- **VAD 语音活动检测不适配 x64**（已决策，2026-06-09）：node `onnxruntime-node` 包只带 `darwin/arm64` 无 x64。VAD 走 runtime-asset 分发（不在 tauri.conf 资源里，不卡 build），且代码已对 `missing-runtime` 优雅降级（`audioVadRuntime.ts` + `desktopAudioCapture.ts:343`）。x64 只需**不产 `onnxruntime-vad` runtime-asset**，VAD 自动静默关闭，**零代码改动**。
- **唯一硬约束：真机验证**。交叉编译容易，验证 native 加载、签名公证、音频采集只能上真机 —— 由同事提供 Intel Mac 跑 §5 验收。

## 1. 现状盘点：哪些地方死锁了 arm64

全项目**没有任何 `process.arch` 运行时分支**，架构完全靠构建期路径写死。

| # | 层 | 当前状态 | 文件/位置 | x64 难度 |
|---|----|---------|----------|---------|
| 1 | Rust/Tauri 构建 | CI `runs-on: macos-latest`（ARM runner），只产 arm64 | `.github/workflows/release.yml:14` | 中 |
| 2 | Swift sidecar ×3 | 自编 arm64 Mach-O，需核 framework 最低系统版本 | `build-audio-capture.sh`、`build-vision-ocr.sh`、`build-vision-tagger.sh` | 易* |
| 3 | uv sidecar | fetch 脚本硬拒非 arm64；上游**有** x64 包 | `scripts/fetch-uv.sh:30,45` | 易 |
| 4 | rtk sidecar | fetch 脚本硬拒非 arm64；上游**有** x64 包（之前误判为无） | `scripts/fetch-rtk.sh:30,45`；`tauri.conf.json:86` | 易 |
| 5 | bundled-node | 已支持 `BUNDLED_NODE_ARCH=x64` 自动下官方 node | `prepare-bundled-node.mjs:25` | ✅ 就绪 |
| 6 | node-pty | 已同时有 darwin-arm64 + darwin-x64 prebuild | `node_modules/node-pty/prebuilds/` | ✅ 仅改 resource 路径 |
| 7 | better-sqlite3 | 只 rebuild 了 arm64 `.node` | `dist/native/better-sqlite3/build/Release/` | 中 |
| 8 | keytar | 只 rebuild 了 arm64 `.node` | `node_modules/keytar/build/Release/` | 中 |
| 9 | sharp + libvips | 只装/打了 arm64；**package-lock 已含 x64 条目** | `tauri.conf.json:76-80`、`build-runtime-assets.mjs:50,57` | 中 |
| 10a | PII 脱敏（gliner） | 走 Python 子进程（uv+venv），**不依赖 node onnxruntime** | `piiEntityDetector.ts`、`scripts/pii/gliner_onnx_runner.py` | ✅ 随 uv x64 即可 |
| 10b | VAD（onnxruntime-node，音频） | npm 包只有 darwin/arm64；runtime-asset 分发，已优雅降级 | `audioVadRuntime.ts`、`build-runtime-assets.mjs:22` | x64 不适配（决策） |
| 11 | tauri.conf.json resources | 写死 `darwin-arm64`/`sharp-darwin-arm64`/`scripts/rtk` 路径 | `tauri.conf.json:70,76-80,86` | 中 |
| 12 | 更新 manifest | `latest.json` / DMG URL 写死 arm64 | `build-stable-release-json.mjs` | 中 |
| 13 | runtimeAssetRegistry | sharp 资源硬编码 arm64 | `runtimeAssetRegistry.ts` | 中 |
| 14 | Vercel update API | 只按 `platform=darwin` 选包，会把 x64 导到 arm64 DMG | `vercel-api/lib/updateMetadata.ts:65` | 中 |
| 15 | release CI 内部下载 | ossutil 写死 `mac-arm64.zip`；矩阵并发会让 latest.json/OSS key/promotion 互相覆盖 | `release.yml` | 中 |
| 16 | verify-macos-release.sh | 只验 better-sqlite3，未覆盖 keytar/sharp/node-pty/sidecar | `scripts/verify-macos-release.sh:63` | 易 |

\* Swift sidecar 标"易"但需真机核 **ScreenCaptureKit 等 framework 在 x86_64 + minimumSystemVersion 11.0 的可用边界**。

## 2. 各 sidecar / native 模块 x64 来源

| 组件 | x64 怎么来 | 难度 |
|------|-----------|------|
| `system-audio-capture` / `vision-ocr` / `vision-tagger`（Swift） | `swiftc -target x86_64-apple-macos11` 重编 + 核 framework 可用性 | 易 |
| `uv` | 上游有 `uv-x86_64-apple-darwin.tar.gz`，改 fetch ASSET 名 + 放行非 arm64 | 易 |
| `rtk` | 上游有 `rtk-x86_64-apple-darwin.tar.gz`，同 uv 处理（**已决定带上**） | 易 |
| `bundled-node` | `BUNDLED_NODE_ARCH=x64` 已支持 | 免 |
| `node-pty` | x64 prebuild 已在 node_modules，仅改 resource 路径 | 免 |
| `better-sqlite3` / `keytar` | **在 Intel runner 原生 rebuild**（C++ 模块，arm64 交叉编 x64 易卡 node-gyp/ABI/codesign） | 中 |
| `sharp` + libvips | package-lock 已含 `@img/sharp-darwin-x64` / `sharp-libvips-darwin-x64`，按架构选打包路径 | 中 |
| PII 脱敏（gliner） | Python 子进程跑，Python `onnxruntime` 有 x64 wheel，随 uv x64 自动可用 | 免 |
| VAD（onnxruntime-node） | **x64 不适配**（决策）：不产 `onnxruntime-vad` runtime-asset，代码已对 missing-runtime 降级 | 免 |

## 3. 推荐策略：独立 x64 构建 + 单 manifest

```
arm64 构建（现状不动）          x64 构建（新增）
 macos-latest(ARM runner)        macos-15-intel(Intel runner, 官方支持到 2027.08)
   ↓ 原生 rebuild native           ↓ 原生 rebuild native（规避交叉编译坑）
 arm64 .app + sidecars          x64 .app + sidecars
        \                          /
         → 合并进同一 stable/latest.json（含 darwin-aarch64 + darwin-x86_64）
```

- **CI runner**：x64 用 `macos-15-intel`（**不是已退役的 `macos-13`**），在该机原生 rebuild 所有 native 模块。
- **更新分发（二选一，推荐 A）**：
  - **A. 单 manifest 多 platform**：`latest.json` 的 `platforms` 同时列 `darwin-aarch64` 和 `darwin-x86_64`，updater 自动按架构选。改动最小，无需拆通道。
  - B. 构建期 endpoint 分流：用 Tauri updater endpoint 的 `{{arch}}`/`{{target}}` 模板。比 A 复杂，不推荐。
  - ⚠️ "运行时拼 channel" 在当前代码**不可行**：打包态 renderer 走 `@tauri-apps/plugin-updater` 的静态 endpoint，`CODE_AGENT_RELEASE_CHANNEL` 只在 Rust cloud fallback 用。
- **Vercel `/api/update`**：必须新增 `arch` 入参，按 `darwin + arch` 返回正确 DMG（当前只看 platform，会导错包）。
- **CI 防覆盖**：矩阵两架构的 `.app.tar.gz` / `latest.json` / GitHub Release asset / OSS key / stable promotion 必须**按架构命名**或**最后做 manifest merge**，否则并发互相覆盖。
- **资源清单**：`tauri.conf.json` 的 `darwin-arm64`/`sharp-darwin-arm64`/`scripts/rtk` 路径改为构建期按架构注入。

## 4. 实施 checklist（按依赖顺序，单向链不可并行）

**P0 sidecar**
- [ ] 3 个 Swift 脚本加 `-target x86_64-apple-macos11`，真机核 ScreenCaptureKit 等 framework 可用
- [ ] `fetch-uv.sh` / `fetch-rtk.sh` 加 x64 ASSET 分支 + 放行非 arm64

**P0 native（在 Intel runner 上做）**
- [ ] 原生 rebuild `better-sqlite3` / `keytar`
- [ ] sharp 按架构选 `@img/sharp-darwin-x64` + libvips-x64（lock 已有条目）
- [ ] PII：确认 x64 上 `setup-gliner-pii.sh` 用 x64 uv 建 venv、装 Python `onnxruntime` x64 wheel 正常
- [ ] VAD：x64 构建跳过 `onnxruntime-vad` runtime-asset（`build-runtime-assets.mjs` 的 darwin/arm64 路径 x64 不产），依赖现成 missing-runtime 降级，无需改 VAD 代码

**P1 配置 / 资源**
- [ ] `tauri.conf.json` resources 按架构注入（rtk/sharp/node-pty 走对应架构路径）
- [ ] `build-runtime-assets.mjs`（line 22/50/57）、`runtimeAssetRegistry.ts` 架构参数化
- [ ] `build-stable-release-json.mjs` + DMG URL 去掉 arm64 硬编码

**P1 CI**
- [ ] `release.yml` 加 `macos-15-intel` x64 矩阵，原生 rebuild，签名公证同套
- [ ] ossutil `mac-arm64.zip` 等内部下载按架构取
- [ ] 两架构产物按架构命名 / 最后 manifest merge，防并发覆盖

**P2 更新分发**
- [ ] `latest.json` 合并 `darwin-aarch64` + `darwin-x86_64`（方案 A）
- [ ] Vercel `/api/update`（`updateMetadata.ts:65`）加 `arch` 入参与路由

**P2 验证脚本**
- [ ] `verify-macos-release.sh` 扩展覆盖 keytar / sharp / node-pty / sidecar 加载

**P3 收尾**
- [ ] 真机验收（同事，见 §5）
- [ ] CLAUDE.md 发版章节补 x64 流程

## 5. 真机验收清单（交同事执行，非开发可照做）

> 同事不用看代码，在 Intel Mac 上装包、逐项点、回报结果（截图/录屏）。任意一项失败 = 对应模块没编对，回报编号即可定位。

| # | 验收项 | 通过标准 | 对应模块 |
|---|--------|---------|---------|
| 1 | 安装 | DMG 拖入 Applications，首次打开不报"已损坏/无法验证" | 签名公证 |
| 2 | 启动 | App 正常起进主界面，无白屏/闪退 | Tauri/Rust |
| 3 | 对话 | 发消息能正常回复 | webServer + bundled-node |
| 4 | 数据库 | 历史会话保存、重启还在 | better-sqlite3 |
| 5 | API Key | 存 key、重启还在 | keytar |
| 6 | 终端工具 | Agent 跑 bash 命令看到输出 | node-pty |
| 7 | 图像 | 触发任意图片生成/处理 | sharp + libvips |
| 8 | 截图/视觉 | computerUse 截图或 OCR | vision-ocr/tagger |
| 9 | 音频 | 语音输入/系统音频采集 | system-audio-capture（+ ScreenCaptureKit） |
| 10 | PII 脱敏 | 触发 PII 脱敏，敏感信息被打码 | gliner（Python+uv，x64 应正常） |
| 11 | 语音活动检测 | x64 上语音输入无自动端点检测 | VAD（**x64 预期不可用，属正常**，不算失败） |
| 12 | 自动更新 | 检查更新能拉到 x64 包（不是 arm64 DMG） | latest.json + Vercel api arch 路由 |

## 6. 风险与未决

- **VAD x64 关闭**（已决策）：x64 用户无自动语音端点检测（影响语音输入体验，不影响脱敏/核心功能）。PII 脱敏在 x64 正常（Python 路径）。
- **真机依赖**：开发机 arm64，§5 全部靠同事真机，回归周期受其时间约束。
- **CI 并发覆盖**：矩阵双架构若不隔离命名，会污染 stable 通道，必须先解决再开矩阵。
- **签名公证**：x64 .app 走同一 Developer ID 链，理论无差异，需真机验 Gatekeeper 放行。
- **Intel runner 长期**：`macos-15-intel` 支持到 2027.08，之后需自托管 Intel mac 或本地 x64 Mac 构建。

## 7.5 实施进度（2026-06-09）

已落地并验证（本地 typecheck + 单测通过，分支 `feat/intel-x64-support`）：

| 阶段 | 内容 | 状态 |
|------|------|------|
| 阶段3 | `updateMetadata.ts` arch 感知选包 + `/api/update` 加 arch；`build-stable-release-json` 产双架构；分发页下载按钮按芯片选 dmg | ✅ 已提交（21 测试） |
| 阶段1 | `fetch-rtk/uv.sh` arch + x64 真实 sha256；3 swift 脚本 `-target`（audio 实测 13.0）；`build-runtime-assets` arch 工厂 + x64 跳 VAD；`runtimeAssetRegistry` arch | ✅ 已提交（24 测试） |
| 阶段2-构建 | `tauri-arch-config.mjs` 派生 x64 资源覆盖（`tauri-release-bundle.sh` 已透传 `--config`，零改动） | ✅ 已提交 |
| 阶段2-CI | release.yml 矩阵 + updater 端点 arch 化 | ⏳ 见 §8（需预发布 tag 验证） |

### 关键实测结论（写代码时发现）
- **audio sidecar x64 最低 macOS 13.0**：`SCStream`(12.3)+`capturesAudio`(13.0)；macOS 26 Tahoe 已弃 Intel，13.0 是 Intel 可用区间地板。
- **onnxruntime-node npm 仅 darwin/arm64**（实 `find` 确认）→ x64 跳 `onnxruntime-vad` runtime-asset，VAD 走现成 `missing-runtime` 降级。
- **rtk/uv x64 真实 sha256 已实拉计算并锁定**（非伪造）。

## 8. CI 矩阵 + updater 端点实施细则（待预发布 tag 验证）

> ⚠️ release.yml 是生产发版管线，且改 updater 端点涉及**老客户端迁移**，不可盲发。
> 安全验证路径：用预发布 tag（`v0.x.y-x64test1`，带 `-` 后缀）触发——管线现有闸门保证它**不提升 stable、不抢 latest**，可安全空跑。

### 8.1 release.yml 矩阵化
- `release-mac` 改 `strategy.matrix.include`：`{arch:arm64, sysarch:aarch64, runner:macos-latest, ossutil:mac-arm64}` 与 `{arch:x64, sysarch:x86_64, runner:macos-15-intel, ossutil:mac-amd64}`，`fail-fast:false`。
- sidecar 步加 `env: SWIFT_BUILD_ARCH: ${{ matrix.sysarch }}`（x64 leg 强制 audio 13.0 地板；fetch-rtk/uv 原生 host arch 自动对）。
- x64 bundle：`node scripts/tauri-arch-config.mjs x64 --out "$RUNNER_TEMP/tauri.x64.json"` → `bash scripts/tauri-release-bundle.sh --config "$RUNNER_TEMP/tauri.x64.json"`。
- ossutil 安装：`mac-arm64.zip` → `mac-${{ matrix.ossutil }}`（按 leg）。
- OSS dmg 名：`Agent-Neo-${VERSION}-${{ matrix.arch }}.dmg`（已与 build-stable-release-json 命名对齐）。
- runtime-assets 步加 `if: matrix.arch == 'arm64'`（x64 无 onnxruntime，跳过；manifest 仍 `darwin-arm64`）。
- GitHub Release 各 leg 追加自己 arch 的 dmg/app.tar.gz；`latest.json` 按 arch 命名上传避免覆盖。

### 8.2 updater 端点 arch 化（含老客户端迁移）
- `tauri.conf.json` updater endpoint：`stable/latest.json` → `stable/latest-{{arch}}.json`（Tauri 解析 `{{arch}}` 为 `aarch64`/`x86_64`）。
- CI 各 leg 上传 `stable/latest-${{ matrix.sysarch }}.json`。
- **迁移兜底**：继续发布 `stable/latest.json`（= arm64），老 arm64 客户端端点是旧路径，不能 404。即同时存在 `latest.json`(legacy=arm64) + `latest-aarch64.json` + `latest-x86_64.json`。
- 改端点必须与 CI 发布同一版落地，否则新 arm64 包指向尚未发布的 `latest-aarch64.json`。

### 8.3 stable 提升（合并双架构）
- 新增 `promote-stable` job `needs: release-mac`（等两 leg 都完），仅非预发布 tag。
- in-app updater 的 `stable/release.json`：`build-stable-release-json.mjs --dmg-url <arm64 OSS url> --dmg-url-x64 <x64 OSS url>`（两 URL 按 `v<ver>/Agent-Neo-<ver>-<arch>.dmg` 约定构造），单 manifest 含双架构，`updateMetadata.ts` 已能按 `?arch=` 选。
- Vercel cloud publish 步（§ Publish ... Cloud API）payload 加 `arch`，或依赖 release.json 双 dmg（已支持）。

## 7. 交叉验证记录（艾克斯 / Codex，2026-06-09）

独立 context 审查，核了 GitHub release API、npm pack、Tauri 文档、runner-images。改正了草案 v1 的 4 处硬错：

1. ❌→✅ **runner**：`macos-13` 已退役 → 改 `macos-15-intel`（runner-images 现行表已不列 macos-13）。
2. ❌→✅ **rtk**：v1 误判"上游仅 arm64" → 实际 `v0.39.0+` 有 x64 包；且"不打包零改动"错——`tauri.conf.json:86` 固定打 `scripts/rtk`，缺文件 `tauri build` 直接失败。
3. ⚠️→修正 **updater**：v1 拆 stable/stable-x64 双通道 + "运行时拼 channel" 不准 → 改单 manifest 多 platform；补 Vercel api 加 arch。
4. ⚠️→补 **遗漏点**：onnxruntime npm 无 x64、ossutil 写死 mac-arm64、CI 并发覆盖、build-stable-release-json/runtimeAssetRegistry 硬编码 arm64、verify 脚本覆盖不足。

外部依据：[Tauri updater docs](https://v2.tauri.app/plugin/updater/)、[actions/runner-images](https://github.com/actions/runner-images)（Intel 迁移 [#13045](https://github.com/actions/runner-images/issues/13045)）、[uv 0.11.16](https://api.github.com/repos/astral-sh/uv/releases/tags/0.11.16)、[rtk v0.39.0](https://api.github.com/repos/rtk-ai/rtk/releases/tags/v0.39.0)。

**v3 追加澄清（2026-06-09，本地核查）**：v2 把 onnxruntime 笼统当作"最大未决"，实为两条独立路径——① PII 脱敏走 Python 子进程（uv+venv+pip onnxruntime，有 x64 wheel），x64 不受影响；② VAD 走 node `onnxruntime-node`（仅 arm64），但它是 runtime-asset（不卡 build）且代码已对 `missing-runtime` 优雅降级（`audioVadRuntime.ts`、`desktopAudioCapture.ts:343`）。决策：**VAD 不适配 x64，零代码改动自动降级**。onnxruntime 不再是阻塞项，工期由 3–5 天回落到 2–4 天。

总体：**v3 可作施工依据**。剩余真正要做的：native rebuild（Intel runner）+ rtk/uv/sharp/swift x64 + CI 防覆盖 + updater 单 manifest + Vercel api 加 arch。
