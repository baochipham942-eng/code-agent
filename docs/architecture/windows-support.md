# Windows (win32-x64) 支持方案

> 状态：v1.2（**真机验证：核心打通**——天翼云电脑 Windows Server 2019 实测，窗口渲染 + 后端全活）｜创建 2026-06-10｜linchen
> 背景：macOS 双架构（v0.16.101，arm64 + x64）已发；现探索 Windows 支持，目标小范围朋友测试。
> 结构对齐先例 `docs/architecture/intel-x64-support.md`。实施记录见 §7、§8。

## 0. 结论先行

> **v1.2 真机验证结论（2026-06-10，天翼云电脑 Windows Server 2019 / GBK 936 / PowerShell 5.1）**：
> **Windows 版核心已打通**——unsigned NSIS perUser 安装（无 UAC）→ 窗口完整渲染主界面 → webServer / better-sqlite3 / 23 skills / 13 MCP server 全部正常。
> 从"窗口秒退"到"完整可交互"，连修 5 个实现期 bug（见 §7），全是静态盘点照不到、只有 CI 实跑 + 真机才能暴露的。
> 已上 `feat/windows-support` 分支（CI `build-windows-test.yml` 实跑绿、产物 OSS 国内可下）。
> **剩余 = 朋友消费版真机验收（§5）+ release.yml 矩阵折入（§4 P2）**。dogfooding 顺带发现的几个**平台无关产品 bug**（Ollama 假性可用 / 配 provider 默认模型不自动切 / 会话导出静默失败 / MiMo 托管 key）已分流到独立分支 `fix/model-config-and-export`，不混入本线。

- **能做，建议做，但工作量显著大于 x64**：x64 是同平台换架构（2–4 天），Windows 是换平台。**MVP（对话/工具执行/会话持久化/自动更新）估 2–3 周**：纯工程 8–12 天 + 朋友真机回归。大头不在打包链（~3–5 天，x64 先例可大量复用），而在**安全与工具层重设计（~4–6 天，不可压缩）**。
- **已定决策（执行确认）**：
  - 砍 macOS 专属能力：Swift sidecar ×3（system-audio-capture / vision-ocr / vision-tagger）、AppleScript connectors 全组、VAD runtime-assets。降级路径已逐项核验（见 §1.5），全部是"工具报不支持/connector unavailable/静默降级"，**无崩溃路径**。
  - 不买 Authenticode 证书：unsigned NSIS + 安装指引（SmartScreen「更多信息→仍要运行」）。
- **开放决策已拍板（2026-06-10，linchen）**：
  - **PowerShell 5.1 为兼容地板**（做 GBK 编码注入，不要求朋友装 pwsh 7；探测到 pwsh 优先用）。
  - **uv 带上、PII 安装链 MVP 标记不可用**（setup 脚本 Windows 化推 P3）。
  - **安全双模式**：硬毙清单永远拦；非硬毙是否 confirm 由 strict/lenient 开关控制，**朋友测试包默认 lenient**，正式分发默认 strict（§3.2 ④）。
  - 分发页本就是朋友间私发（非公开），windows 路由随 P2 正常做，无暴露顾虑。
- **本次核验推翻两个预设**（上游 GitHub API 实查，2026-06-10）：
  - **rtk 上游有 Windows 资产**：`rtk-x86_64-pc-windows-msvc.zip`（v0.39.0 release 实查）→ rtk 可带上。
  - **uv 上游有 Windows 资产**：`uv-x86_64-pc-windows-msvc.zip`（0.11.16 release 实查，含 .sha256）→ uv 可带上，**PII 脱敏（Python onnxruntime 有 win_amd64 wheel）理论可用**，从"必砍"改为"带上待真机验"。
- **更新链关键事实（核验结论）**：Tauri updater 的包完整性走 **minisign 签名（TAURI_SIGNING_PRIVATE_KEY，已有）**，与 Authenticode **完全无关**——无证书时 Windows 自动更新**完整可用**。两个坑：① NSIS 必须装 **perUser（currentUser）模式**，否则每次自动更新弹 UAC；② SmartScreen 只拦**浏览器下载的首装包**（MOTW 标记），updater 程序内下载无 MOTW，更新不弹 SmartScreen。
- **最大安全红线（P0，先于一切发包动作）**：`permissionPresets.ts:152` 的路径白名单用 `startsWith('/')` + `'/'` 拼接判断，Windows 路径（`C:\...`）下**白名单匹配失效 → 权限判定旁路**。命令安全分级 38+ 危险模式全部 POSIX 语义，PowerShell 危险命令（`Remove-Item -Recurse`、`rd /s /q`、`reg delete`、`-EncodedCommand`…）零覆盖。**安全层没重设计完之前不发包**。
- **建议做 / 不建议做**：
  - ✅ 做：MVP 四件套 + rtk/uv/CUA（Windows 官方资产齐）+ 安全规则平台化（共享分级框架 + 平台规则包，§3.2）。
  - ❌ 不做（后置）：Windows 端 GUI 深度自动化（UIAutomation 替代 AX/CGEvent）、connectors 的 Windows 等价物（Outlook/日历 API）、Authenticode 签名、Windows runtime-assets。

## 1. 现状盘点：哪些地方死锁了 macOS

`src/main` 下 ~90 处 `process.platform` 分支盘点结论：**已兼容 16 处 / 需新增修正 ~8 处 / 随砍掉功能消失 10+ 处 / 现存 win32 分支全部是活代码（无死代码）**——CLI 时期遗产（where/which、.cmd 后缀、PowerShell 截图等）在桌面主链路仍被引用，是资产不是负债。

### 1.1 Shell / 工具执行层（方向 A 重点）

| # | 层 | 当前状态 | 文件/位置 | 难度 |
|---|----|---------|----------|------|
| 1 | PTY shell 选型 | win32 已选 `powershell.exe`，但 ConPTY 未显式配置、未真机验证 | `ptyExecutor.ts:228,231-241` | 中 |
| 2 | 后台任务 spawn | **硬编码 `spawn('bash', ['-c', ...])`**，Windows 直接起不来 | `backgroundTasks.ts:203` | 易 |
| 3 | 进程组 kill | `process.kill(-pid)` 负 PID Windows 不支持（有 fallback 但未验证）；SIGTERM 语义弱化 | `bash.ts:251,258`、`backgroundTasks.ts:235-241` | 中 |
| 4 | 命令安全分级 | `commandSafety.ts`（497 行）：47 白名单 + 15 条件检查 + 38 危险模式，**全 POSIX 语义** | `src/main/tools/.../commandSafety.ts:20-445` | **难（重设计）** |
| 5 | 命令硬阻断 | `commandPolicy.ts` 11 条 BLOCK_RULES（curl\|sh、/dev/tcp 反弹、fork bomb…），全 POSIX | `commandPolicy.ts:24-115` | 难（同上） |
| 6 | 复合命令解析 | 自研 regex 分词（无 shell-quote 依赖），解 `bash -c` 包裹、&&/;/\|，**不识别 PowerShell 语法**（别名、`-EncodedCommand`、子表达式） | `commandSafety.ts:145-219` | 难（同上） |
| 7 | exec 策略学习 | BANNED_PREFIXES 只禁 bash/sh/zsh/eval 等，**缺 powershell/pwsh/cmd/iex** | `execPolicy.ts:40-44` | 易 |
| 8 | 编码 | TERM 写死 xterm-256color；中文 Windows 下 PowerShell 5.1 默认 GBK 输出，无转码处理 | `ptyExecutor.ts:231-241` | 中 |
| 9 | 安全测试 | `commandSafety.test.ts` 431 行 45+ 用例，**Windows 用例为 0** | `tests/security/commandSafety.test.ts` | 中 |

### 1.2 路径 / 权限 / 文件锁散点

| # | 类别 | 当前状态 | 文件/位置 | 风险分级 |
|---|------|---------|----------|---------|
| 10 | **权限白名单路径判断** | `startsWith(dir + '/')` 判断目录归属，Windows 失效 → **权限旁路** | `permissionPresets.ts:152`；同类 `survivorManifest.ts:255`、`resultMeta.ts:245`、`runtimeAssetInstaller.ts:141` | **P0 阻断** |
| 11 | /tmp 硬编码 | 7 处（worktree 基目录、GUI 截图、exec-policy/policyEnforcer 的 fallback…），Windows 无 /tmp | `agentWorktree.ts:21`、`guiAgent.ts:17`、`execPolicy.ts:259`、`policyEnforcer.ts:358`、`permissionClassifier.ts:465` 等 | P0 阻断 |
| 12 | HOME 环境变量 | 5 处直接读 `process.env.HOME`（Windows 只有 USERPROFILE），降级成 `'~'` 字面量或空串 | `localSpeechToText.ts:33`、`modeInjection.ts:14`、`mcpDefaultServers.ts:97,177`、`webSearch.ts:329` 等 | P0 阻断 |
| 13 | 文件占用（真实风险） | rename/unlink 打开中的文件 POSIX 可行、Windows 报 EBUSY/EPERM：renderer 热更新替换 `active` 目录、日志 rotate（renameSync）、原子写 rename | `rendererBundleFetcher.ts:538`、`logCollector.ts:153`、`atomicWrite.ts:48,82,125`、4 处常开 append 日志流 | P0（需真机验证场景） |
| 14 | .sh 脚本被 spawn | PII 安装走 `setup-gliner-pii.sh`（bundle 内资源），Windows 跑不了 | `pii.ipc.ts:153`、`tauri.conf.json:89-90` | P1（PII 改造点） |
| 15 | chmod / 可执行位 | 下载脚本后 `fs.chmod`（Windows no-op 不报错，无功能依赖）；`chmod 777` 检测规则本身平台无关 | `gitDownloader.ts:332` | P2 |
| 16 | 中文路径 | path.join 体系基本正确；风险在子进程编码（§1.1 #8）与个别硬编码英文路径 | `voicePaste.ipc.ts:122` | P2 |

### 1.3 打包 / 构建层

| # | 层 | 当前状态 | 文件/位置 | 难度 |
|---|----|---------|----------|------|
| 17 | bundle targets | `targets: ["app"]` 仅 macOS，无 nsis 配置段 | `tauri.conf.json:31-35` | 易 |
| 18 | resources macOS-only | Swift ×3、CUA .app、sharp-darwin、node-pty darwin-arm64、rtk/uv（Mach-O）、PII .sh——**缺任何资源 `tauri build` 直接失败（x64 先例 v0.16.89）** | `tauri.conf.json:44-91` | 中 |
| 19 | 架构资源覆盖机制 | `tauri-arch-config.mjs` 只做 arch 维度（darwin-arm64↔x64），需扩成平台维度 | `scripts/tauri-arch-config.mjs` | 中 |
| 20 | bundled-node | `prepare-bundled-node.mjs` 硬拒非 darwin（`platform !== 'darwin' return null`）；官方有 win-x64.zip，需加 .zip 解压 + node.exe 布局 | `prepare-bundled-node.mjs:26` | 易 |
| 21 | Rust 侧 node 拉起 | 系统 node 候选路径全 Unix（/usr/local/bin…）、bundled 路径 `bin/node` 无 .exe | `src-tauri/src/main.rs:45-50,250-281` | 易（cfg 分支） |
| 22 | prebuild-cleanup | 内嵌 3 个 Swift 编译脚本，Windows 侧需跳过 | `scripts/tauri-prebuild-cleanup.sh` | 易 |

### 1.4 分发 / 更新层

| # | 层 | 当前状态 | 文件/位置 | 难度 |
|---|----|---------|----------|------|
| 23 | updater manifest 生成 | `inferDarwinArch()` 写死 `darwin-` 键，需扩成 platform+arch 推断 | `scripts/tauri-update-manifest.mjs:43-88` | 易 |
| 24 | publish 合并 | 双架构 merge 逻辑已存在且校验 required keys，加 `windows-x86_64` 是增量 | `release.yml:392-410` | 易 |
| 25 | stable release.json | `build-stable-release-json.mjs` 只有 `--dmg-url/--dmg-url-x64`，需加 `--exe-url` | `scripts/build-stable-release-json.mjs:68-106` | 易 |
| 26 | Vercel update API | **已平台参数化**：platform 识别含 win32（.exe/.msi）、arch 路由先例在；预计零改动（需联调确认） | `vercel-api/lib/updateMetadata.ts:94-154` | ✅ 基本就绪 |
| 27 | 客户端 updater | `@tauri-apps/plugin-updater` 自动按平台选 latest.json 键，无 darwin 假设 | `src/renderer/utils/tauriUpdater.ts:36-51` | ✅ 就绪 |
| 28 | 分发页 | 下载按钮按芯片选 dmg（arch 路由先例），需加 platform=windows 路由 + exe 按钮 | vercel-api 分发页 | 易 |
| 29 | verify 脚本 | `verify-macos-release.sh` 全是 codesign/stapler/spctl，Windows 需新等价物（PE 架构 + 资源齐全检查） | `scripts/verify-macos-release.sh` | 易 |

### 1.5 砍掉能力的降级面核验（已逐项确认）

| 能力 | 平台检查/降级位置 | Windows 行为 | 风险 |
|------|------------------|-------------|------|
| system-audio-capture | binary 缺失 → null + warn（`desktopAudioCapture.ts:140-149`） | 无音频采集，不崩 | 低 |
| vision-ocr | `ocrSearch.ts:200-206` 显式 `PLATFORM_UNSUPPORTED` | 工具报不支持 | 低 |
| vision-tagger | `photoLibraryTagger.ts:268` 同上 | photo-archive 不可用 | 低 |
| AppleScript connectors ×4 | 各 connector 内部检查（calendar.ts:28 等）→ `readiness: 'unavailable'` | 不执行 osascript，但 **registry 无条件注册**（`registry.ts:68-89`），工具仍在列表里 | **中：建议按平台过滤注册**，省 LLM 无效调用轮次 |
| VAD | `audioVadRuntime.ts` missing-runtime 降级（x64 先例同路径） | win32 不产 runtime-asset 即自动关闭，零代码 | 低 |
| rtk（改为带上） | `rtkRewriter.ts:25-48` 缺失 → null → 原命令，fail-closed | 即使 fetch 失败也无损 | 低 |
| uv / PII（改为带上待验） | PII 安装失败 → setup 中止（可捕获），但 `.sh` 安装脚本需 Windows 等价改造 | 不装则 PII 不可用，不崩 | 中 |

## 2. 各组件 Windows 来源（上游实查 2026-06-10）

| 组件 | Windows 怎么来 | 核验状态 | 难度 |
|------|---------------|---------|------|
| bundled-node | nodejs.org 官方 `node-v24.x-win-x64.zip`（.zip 非 .tar.gz，产物是顶层 `node.exe` 无 bin/ 目录） | 官方长期供应 | 易 |
| node-pty | `prebuilds/win32-x64/` **已在 node_modules**（conpty.node + winpty.dll 实 ls 确认） | ✅ 就绪，仅改 resource 路径 | 免 |
| better-sqlite3 / keytar | prebuild-install 在 Windows runner `npm ci` 时自动拉 win32-x64 预编译（package-lock 已含依赖链） | 机制就绪，CI 实跑确认 | 易 |
| sharp | `@img/sharp-win32-x64` **package-lock 已有条目（line 1750 实查）**；注意 Windows 版 libvips 静态打进 sharp 包，**无独立 libvips-win32 包**——tauri 资源只需打一条 | ✅ lock 就绪 | 易 |
| uv | 上游 `uv-x86_64-pc-windows-msvc.zip`（0.11.16 release 实查，含官方 .sha256） | ✅ 上游就绪 | 易 |
| rtk | 上游 `rtk-x86_64-pc-windows-msvc.zip`（v0.39.0 release 实查） | ✅ 上游就绪 | 易 |
| CUA driver | `cuaSupported` 代码已含 win32（`mcpDefaultServers.ts:76`）；macOS 走重签 .app，**Windows 走官方 install.ps1**（`fetch-cua-driver.sh:39` 注释已预留此路线）；或仿 macOS 模式预构建上传 OSS + sha256 锁定 | 代码就绪，分发方式待选 | 中 |
| PII（gliner） | Python `onnxruntime` PyPI 有 win_amd64 wheel + uv win 资产 → 链路理论可用；`setup-gliner-pii.sh` 需出 PowerShell 版或 Node 化 | 待真机验 | 中 |
| Swift ×3 / AppleScript / VAD | **不做**，降级路径已核（§1.5） | 决策 | 免 |

## 3. 推荐策略

### 3.1 总体路线：三阶段，先试验工作流再折生产矩阵

```
阶段一：安全与路径地基（纯 macOS 上可做，单测保护）
  权限路径判断修复 + /tmp/HOME 清理 + 安全规则平台化 + spawn('bash') 修复
        ↓
阶段二：build-windows-test.yml（manual dispatch，复刻 build-x64-test.yml 模式）
  windows-latest runner 跑通 NSIS unsigned 包 → artifact → 朋友真机 §5 验收
        ↓
阶段三：折入 release.yml 矩阵 + 分发链
  矩阵加 windows leg → manifest 三键合并 → 分发页 windows 路由
```

x64 的教训直接继承：**①** 工具链装错架构（taiki-e）→ Windows 用 `cargo install tauri-cli --locked` 或验证 taiki-e windows 资产对位；**②** 矩阵产物按平台命名防覆盖（`Agent-Neo-<ver>-win-x64-setup.exe`、`latest-win-x64.json`）；**③** bundle resources 与 CI 产出步骤必须同步改（v0.16.89 之坑）——Windows 的资源覆盖文件里删掉的每条 mac 资源，CI 的 fetch/build 步骤也要对应跳过。

### 3.2 命令安全：共享分级框架 + 平台规则包（方向 A 核心方案）

**这不是把 38 条正则翻译成 PowerShell——语义模型不同，必须重新设计**：

- PowerShell 是**别名体系**：`rm`/`del`/`erase`/`rd`/`ri` 都是 `Remove-Item` 的别名，`ls`/`dir`/`gci` 都是 `Get-ChildItem`；参数可前缀缩写且顺序任意（`-Recurse -Force` ≡ `-r -fo`），大小写不敏感。按命令字符串写 regex 必然漏。
- PowerShell 有 POSIX 没有的逃逸面：`-EncodedCommand`（base64 整段命令）、`Invoke-Expression`（iex）、`& $var` 间接调用、子表达式 `$()`、反引号转义、`cmd /c` 嵌套套娃。
- cmd 侧另有一套：`rd /s /q`、`del /f /s`、`format`、`reg delete`、`schtasks`、`bcdedit`、`vssadmin delete shadows`。

**架构方案**（在现有集中式 `commandSafety.ts` 上演进，不推倒）：

```
commandSafety.ts（框架层，保留）
 ├─ 共享类型：RiskLevel / ValidationResult / DangerousPattern（加 platforms 维度）
 ├─ 调度：validateCommand(cmd, { shell: 'posix' | 'powershell' | 'cmd' }) 按 shell 选规则包
 ├─ rules/posixRules.ts          ← 现 38 危险模式 + 11 BLOCK_RULES 原样搬入
 └─ rules/windowsRules.ts        ← 新写，设计原则：
     ① 规范化先行：别名表展开（rm→Remove-Item）+ 参数前缀归一（-r→-Recurse）+ lowercase，
        然后才进危险模式匹配——规则写在规范名上，别名变体在归一层消化
     ② 硬毙清单（BLOCK 级）：Remove-Item 指向盘根/用户根 + -Recurse、format、
        vssadmin delete shadows、bcdedit、diskpart、-EncodedCommand、iex+IWR/iwr 下载执行、
        Set-ExecutionPolicy Bypass、reg delete HKLM、Stop-Computer/Restart-Computer
     ③ 高危（confirm 级）：rd /s、del /f /s、Remove-Item -Recurse（非根路径）、
        schtasks /create、netsh、Set-ItemProperty 注册表写、icacls 放权
     ④ 双模式（已决策 2026-06-10）：硬毙清单（②）任何模式下都拦；
        strict 模式 = 未识别命令走 confirm（fail-closed）；lenient 模式 = 非硬毙放行。
        朋友测试包默认 lenient（白名单从零起步，strict 会每两条命令弹一次确认，体验不可用），
        正式分发默认 strict，随评测覆盖率上来再放宽
```

- **shell 选型**：PowerShell 为主（`ptyExecutor.ts:228` 已选 powershell.exe；conpty prebuild 就绪；cmd 功能太弱；Git-Bash 依赖用户自装不可作默认）。增强：启动时探测 pwsh（PowerShell 7）优先、fallback Windows PowerShell 5.1；ConPTY 显式启用 + 输出编码强制 UTF-8（5.1 中文系统默认 GBK，须 `[Console]::OutputEncoding` 注入或 `chcp 65001`）。
- **白名单**：47 个 UNCONDITIONALLY_SAFE（cat/ls/grep…）在 PowerShell 是别名仍可用，但语义略差（如 `ls -la` 参数不通）→ 白名单同样按 shell 维度拆，PowerShell 包以 cmdlet 规范名收录。
- **execPolicy**：BANNED_PREFIXES 补 `powershell`/`pwsh`/`cmd`/`iex`/`Invoke-Expression`（`execPolicy.ts:40-44`，5 行改动但属安全闭环必需）。

**评测扩展方案**：

1. 现有 `tests/security/commandSafety.test.ts`（431 行 45+ 用例，形态"输入命令→期望分级"）按 shell 参数化：每个 describe 跑 `posix` 一遍保回归。
2. 新增 `windowsCommandSafety.test.ts`：对 POSIX 危险用例逐条问"Windows 等价形态"生成对照组（rm -rf / ↔ Remove-Item C:\ -Recurse -Force ↔ rd /s /q C:\），再加 Windows 特有组（EncodedCommand、iex 下载执行、别名/参数缩写爆破——同一危险意图至少 3 个变体写法都要拦到）。
3. eval set 同构扩展：现有命令安全 eval 用例按上述映射出 Windows 子集，作为 Windows 包发布的硬门禁（目标：硬毙清单 100% 拦截、别名变体 ≥90%）。

### 3.3 打包与分发（方向 B 方案）

- **NSIS unsigned + perUser**：`tauri.conf.json` 加 Windows 段：targets 含 `nsis`、`installMode: "currentUser"`（**锁定 perUser**：装到 %LOCALAPPDATA%，安装与每次自动更新都无 UAC 弹窗；perMachine 会让每次静默更新弹 UAC，体验不可接受）。
- **资源覆盖**：扩 `tauri-arch-config.mjs` 为 `tauri-platform-config.mjs`（机制复用：派生配置 + `--config` 透传，`tauri-release-bundle.sh` 已支持）——win32 派生时剔除 Swift ×3 / CUA .app / PII .sh / VAD，替换 node-pty→`win32-x64`、sharp→`@img/sharp-win32-x64`（单条，无 libvips）、rtk/uv→windows-msvc 产物、bundled-node→node.exe 布局。
- **更新链**：updater 端点/客户端零改动（§1 #26-27）；`tauri-update-manifest.mjs` 的 `inferDarwinArch` 扩成 platform+arch 推断（.exe→`windows-x86_64`）；publish merge 校验列表加第三键；`build-stable-release-json.mjs` 加 `--exe-url`。NSIS 更新体验：updater 下载 .exe（minisign 验签）→ 退出应用 → 静默重装 → 重启，perUser 全程无 UAC、无 SmartScreen（程序内下载无 MOTW）。
- **fetch 脚本**：Windows runner 上 GitHub Actions 用 `shell: bash`（Git Bash 预装）跑现有 .sh 体系，**不重写为 PowerShell**——只需给 fetch-rtk/uv 加 windows-msvc 资产分支（.zip 用 `unzip`/bsdtar 解，Git Bash 都有）+ 实拉计算 sha256 锁定（x64 先例做法）。
- **CUA**：MVP 先不 bundle——`cuaSupported` 已含 win32，首版让用户按需跑官方 install.ps1（设置页给指引）；验证通过后再仿 macOS 模式预构建上 OSS。
- **朋友安装指引**（随包发）：① 下载 `Agent-Neo-<ver>-win-x64-setup.exe`；② SmartScreen 蓝屏「Windows 已保护你的电脑」→ 点「更多信息」→「仍要运行」；③ 若 Defender 拦截 → 「允许在设备上」。指引里直说原因（小范围测试包未购买企业证书）。
- **降级注册优化**：ConnectorRegistry 按平台过滤 4 个 mac connector 的注册（§1.5），Windows 工具列表不出现注定 unavailable 的项。

## 4. 实施 checklist（按依赖排序）

**P0 安全与路径地基（macOS 上即可完成，全部带单测）**
- [x] `permissionPresets.ts` 等路径归属判断改 `path.relative` 体系（含 NTFS 大小写不敏感）；附带堵了 `runtimeAssetInstaller` 归档反斜杠/盘符条目的 Windows 解压逃逸（盘点时漏的真实洞）
- [x] 7 处 `/tmp` → `os.tmpdir()`；11 处 `process.env.HOME` → `os.homedir()`（实改比盘点多）
- [x] `backgroundTasks` spawn('bash') → platformShell（win32 PowerShell）；killProcessTree（win32 taskkill /T，POSIX 原语义零改动）
- [x] commandSafety 平台规则包（shellRules/windowsRules.ts：结构化解析+别名/参数归一+硬毙/分级）+ strict/lenient 开关（win32 默认 lenient，env 可覆盖）
- [x] execPolicy BANNED_PREFIXES 补 powershell/pwsh/cmd/iex
- [x] `windowsCommandSafety.test.ts` 51 用例（别名/缩写/cmd 形态/嵌套包裹变体爆破）；eval set Windows 子集后续随真实样本回填

**P0 打包链（依赖地基完成）**
- [x] `prepare-bundled-node.mjs` win32 分支（.zip / node.exe 顶层布局）
- [x] `fetch-rtk.sh` / `fetch-uv.sh` windows-msvc 分支 + sha256 实拉锁定（macOS 交叉实测通过，uv zip 与官方 .sha256 一致）
- [x] `tauri-platform-config.mjs`（剔 mac 资源 + win32 路径 + NSIS currentUser + updater pubkey 注入；base tauri.conf.json 零改动）
- [x] `src-tauri/src/main.rs` cfg(windows)（node.exe 候选 + Program Files + CREATE_NO_WINDOW），cargo check 通过
- [x] ptyExecutor：pwsh 探测（platformShell 共享）+ useConpty 显式 + UTF-8 编码注入（5.1 地板决策）

**P1 CI（先试验后生产，复刻 x64 节奏）**
- [x] `build-windows-test.yml`（仅 workflow_dispatch；npm script-shell 必须切 Git Bash——仓内 scripts 的 env 前缀语法 cmd 下直接挂）
- [x] `verify-windows-release.mjs`：pre（win32 资源逐项）+ post（NSIS/PE/体积/.sig）
- [x] renderer probe 复用（CHROME_PATH 指 runner Chrome）
- [x] **build-windows-test 实跑绿**（2026-06-10，run 27260731349，4 轮迭代修 3 个实跑坑：
  runner Git Bash 无 shasum → sha256sum 兜底；GNU tar 把 C: 当远程主机 → 系统 bsdtar；
  capture_frontmost_context_snapshot 缺非 mac cfg 变体——首个 Windows 编译暴露的存量洞）
- [ ] 真机验证文件占用三场景：renderer 热更新 rename active / 日志 rotate / DB 打开时更新替换（朋友真机）

**P2 分发链（惰性部分已就绪，矩阵折入待验收）**
- [ ] `release.yml` 矩阵加 windows leg —— **刻意推迟**：fail-fast:true 下未实跑过的 windows leg 会把 mac 发版一起拖死，必须等 build-windows-test 实跑绿 + 朋友验收（§5）通过再折
- [x] `tauri-update-manifest.mjs` platform+arch 推断（.exe → windows-x86_64，darwin 兼容键保留）
- [x] `build-stable-release-json.mjs` 加 `--exe-url`；Vercel updateMetadata 复核完成（win32 平台/arch 路由就绪，**补了 win32 缺省 arch → x64**，否则无 arch 请求会 404）+ 分发页 Windows 卡片（探测式显示，资产未发布不出死链）
- [ ] publish merge required keys 加 `windows-x86_64`（随矩阵折入一起做）
- [ ] `releaseMacosGates.test.ts` 同步特征断言（随矩阵折入一起做）

**P3 收尾**
- [ ] ConnectorRegistry 平台过滤注册；PII setup 的 Windows 路径（PowerShell 版或 Node 化，可后置）
- [ ] 朋友安装指引文档（SmartScreen 话术 + 截图）
- [ ] 朋友真机验收（§5）；CLAUDE.md 发版章节补 Windows 流程

## 5. 朋友真机验收清单（非开发可照做）

> 在 Windows 10/11 x64 上装包逐项点，回报编号 + 截图。任意一项失败即可定位对应模块。
> **状态列**：✅=云电脑(Server 2019)已验证；⏳=待消费版真机；🔑=需先配 API key。

| # | 验收项 | 通过标准 | 对应模块 | 状态 |
|---|--------|---------|---------|------|
| 1 | 安装 | SmartScreen 出现「更多信息→仍要运行」可绕过，安装**无管理员/UAC 弹窗**，装到用户目录 | NSIS perUser + 指引有效性 | ✅ perUser 无 UAC 已验（SmartScreen 待浏览器下载真机） |
| 2 | 启动 | 正常进主界面，无白屏/闪退/报毒拦死 | Tauri/Rust + bundled-node + WebView2 | ✅ 窗口完整渲染（需 WebView2，见 §7） |
| 3 | 对话 | 发消息正常回复 | webServer + bundled-node | 🔑 后端已起，发消息需配 key |
| 4 | 会话持久化 | 历史会话保存、重启还在 | better-sqlite3 win32 | ✅ code-agent.db + WAL 已建 |
| 5 | API Key | 存 key、重启还在 | keytar（Windows 凭据管理器） | ✅ secure-storage.json 已建（持久性待复验） |
| 6 | 终端工具 | 让 Agent 跑 `Get-ChildItem` 之类命令能看到输出，**中文输出不乱码** | node-pty ConPTY + 编码 | ⏳🔑 |
| 7 | **危险命令拦截** | 让 Agent 执行「递归删除我的文档目录」类请求，确认被拦截或要求确认（**不是直接执行**） | windowsRules 安全包 | ⏳🔑 |
| 8 | 中文路径 | 在含中文名的目录里让 Agent 读写文件正常 | 路径/编码链 | ⏳🔑 |
| 9 | 图像 | 触发任意图片处理功能正常 | sharp win32-x64 | ⏳🔑 |
| 10 | 文件占用 | App 开着的状态下完成一次自动更新，无「文件被占用」报错 | 文件锁风险面 | ⏳ |
| 11 | 自动更新 | 设置里检查更新能拉到 win 包，下载→重装→重启全程无 UAC/SmartScreen | latest.json windows 键 + minisign + NSIS | ⏳（需 P2 矩阵折入后） |
| 12 | 降级确认 | 语音输入/OCR/日历邮件等显示「平台不支持」而非报错崩溃（**预期不可用，属正常**） | §1.5 降级面 | ⏳ |

> §3/§6-9 标 🔑：云电脑后端已证明健康，但发消息/工具执行需先配一个 API key（key 每台机存 SecureStorage、不打包，全新机为空——这是设计而非 bug）。这几项留给配好 key 的真机验。

## 6. 风险与未决

- **安全规则包是新写的**：POSIX 规则有 30+ 轮评测沉淀，Windows 包零积累。缓解：fail-closed 默认（未识别→confirm）+ 别名变体爆破测试 + 朋友测试期收集真实命令样本回填 eval。
- **Defender 误报**：unsigned NSIS + 解包 node.exe 子进程 + 本地 8180 webServer 的组合是启发式重点关照对象，**误报概率中等偏高**。缓解：朋友指引含「允许在设备上」步骤；若被标记，向 Microsoft 提交误报申诉（免费，1–3 天）；这是不买证书的已知代价，朋友规模可接受。
- **文件占用是 Windows 真实差异**，不是理论风险：renderer 热更新 rename、日志 rotate、更新替换 DB 三个场景必须真机验（§5 #10）。可能需要 retry-on-EBUSY 或重启时清理两种兜底。
- **PowerShell 版本碎片**：Win10 默认只有 5.1（GBK 编码坑），pwsh 7 需自装。MVP 以 5.1 为兼容地板 + 编码注入，探测到 pwsh 优先用。
- **WebView2 依赖**（真机新增，已解决）：Win11/新 Win10 自带，但**旧 Win10/Server 2019 不带**，缺了窗口创建失败秒退。已用 `embedBootstrapper` 内嵌引导器（§7 bug #4）；朋友若在很旧的离线机上装失败，退路是 `offlineInstaller`（+150MB）。
- **conpty 真机未验**：prebuild 在、窗口与后端已真机验证，但 conpty 的 resize/挂起/**GBK 中文输出**仍需配好 key 后真机过一遍（§5 #6）。**无自有持久 Windows 验证机**（天翼云电脑按量、九州 VPS 已过期），文件占用三场景 / Defender 实测 / 终端编码合并进朋友验收。
- **PII Windows 链路**（已决策）：uv 二进制随包带上（成本近零），PII 安装链 MVP 标记不可用（setup 脚本是 .sh），P3 出 Windows 版再开。onnxruntime win_amd64 wheel 链路理论通，届时真机验。
- **lenient 模式的安全敞口**（已决策接受）：朋友测试包非硬毙命令不 confirm，依赖硬毙清单兜底——清单完备性靠别名变体爆破测试 + codex 对抗审计保证，测试期收集的真实命令样本回填后再切 strict。
- **CI runner**：windows-latest 长期供应无虞（对比 macos-15-intel 2027.08 限期），无平台续命风险。
- **工期主要不确定性**：安全规则包的评测打磨轮次（估 3–4 天可能滑到 5–6 天）+ 朋友真机回归节奏受对方时间约束（x64 同款依赖）。

## 7. 实施 + 真机调试记录（2026-06-10）

静态盘点（§1）之外，CI 实跑（6 轮）+ 天翼云电脑真机连挖 **5 个实现期 bug**，全部已在 `feat/windows-support` 修复。这些是规划阶段照不到的——只有真实 Windows 工具链 / runtime 才会触发：

| # | bug | 暴露环节 | 根因 | 修复 |
|---|-----|---------|------|------|
| 1 | `shasum: command not found` | CI fetch 脚本 | GH windows runner 的 Git Bash 无 perl shasum，只有 coreutils sha256sum | `fetch-rtk/uv.sh` 加 `sha256_of` 按可用性选 shasum/sha256sum |
| 2 | `tar: Cannot connect to C: resolve failed` | CI prepare-bundled-node | Git Bash PATH 上的 GNU tar 把 `C:\` 当远程主机、且不识别 zip | win32 显式用系统 `System32\tar.exe`（bsdtar） |
| 3 | `cannot find frontmost_app_triplet` / E0308 | CI 首次 Windows 编译 | `capture_frontmost_context_snapshot` 调 macos-cfg 函数但自身无 cfg 门——**项目史上首次非 mac 编译才暴露的存量洞** | 补 `#[cfg(not(target_os="macos"))]` 变体返回 Err 走降级；并审计全部 macos-cfg 调用面确认是唯一缺口 |
| 4 | 窗口弹出秒退 | 真机启动 | **Windows Server 2019 不自带 WebView2 Runtime**，缺了 Tauri 窗口创建失败 | `tauri-platform-config.mjs` 加 `webviewInstallMode: embedBootstrapper`（嵌 ~2MB 引导器装机时拉运行时，微软 CDN 已实测国内可达） |
| 5 | `EISDIR: lstat 'C:'`，webServer 启动即崩 | 真机启动（WebView2 装上后） | **Tauri `resource_dir()`/`current_exe()` 在 Windows 返回 `\\?\C:\...` verbatim 路径**，传给 bundled node 当主脚本时 node 模块解析把盘符 `C:` 抠出来 lstat 崩溃 | main.rs `strip_verbatim_prefix` 规整路径（candidate_roots + spawn_web_server 三处）；非 Windows 恒等 |

**真机已确认正常**：node v24 / better-sqlite3（DB+WAL 建出）/ 23 skills / 13 MCP（memory-kv/code-index/context7/deepwiki 全连上）/ webServer HTTP 起来 / 窗口完整渲染 + 可交互。

**真机发现的非 Windows 问题**（平台无关，分流 `fix/model-config-and-export`，不混入本线）：
- Local(Ollama) provider `requiresApiKey:false` → 未探测端点就显"3/3 已可用"（`providerRegistryBase.ts:273`）
- 配好新 provider 后默认/活动模型不自动切，发送报"默认模型未配置 key"（`ChatView.tsx:373`）
- 右键会话「导出会话日志/Markdown」静默失败（`Sidebar.tsx:552` → `saveTextFile.ts`，catch 只 log 无 toast）
- MiMo 托管 key 全员可用机制在全新机未生效（需补设计上下文）

**已知低优先级（不阻断）**：webServer 启动 banner 的框线字符在 GBK 936 控制台乱码（`鈺?鈥?`），纯装饰、生产态用户看不到控制台。

## 8. CI 与产物现状

- `build-windows-test.yml`（手动 dispatch）实跑绿：windows-msvc sidecar（sha256 锁定）→ bundled node.exe → 全量 build → 资源验证 → renderer 探针 → NSIS unsigned 打包 → minisign 签名 → 产物上传 GH artifact **+ Aliyun OSS**（`wintest/` 路径，国内测试机直连下载，免文件中转）。
- Rust 依赖缓存命中后 NSIS 编译 ~7min（冷编译 ~20min）。
- 产物：`Agent-Neo-<ver>-win-x64-TEST-setup.exe`（~62MB，含 WebView2 引导器后体积基本不变）。
- 朋友安装指引：`docs/guides/windows-test-install.md`。
