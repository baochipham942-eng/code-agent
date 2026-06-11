# 2026-06-11 Windows (win32-x64) 移植与发版链折入 Spec（as-built）

> 状态: accepted
> 时间窗: 2026-06-10 ~ 2026-06-11（两天：D1 移植打通 + 真机验证，D2 发版链折入 + 收尾）
> 依据: `feat/windows-support` 分支 `ac59cdc84`..`81363a25e` 全部提交
> 关联架构: [windows-support.md](../architecture/windows-support.md)（方案/盘点/checklist/真机记录/验收清单的单一真相源）、[intel-x64-support.md](../architecture/intel-x64-support.md)（结构先例）、[sensitive-data-guard.md](../architecture/sensitive-data-guard.md)（PII 链）

## 背景

macOS 双架构（v0.16.101，arm64 + x64）发版后，探索 Windows 支持，目标小范围朋友测试。
x64 是同平台换架构（2–4 天），Windows 是换平台——大头不在打包链，在**安全与工具层重设计**
（路径语义 / PowerShell 命令安全 / 文件锁差异）。完整盘点与决策见 windows-support.md §0–§3，
本 spec 只记两天实际落地的东西。

## D1（2026-06-10）：移植打通 + 真机验证

### P0 安全与路径地基（全部带单测）

- **权限路径判定旁路修复**：`permissionPresets.ts` 等 4 处 `startsWith('/')` 体系改
  `path.relative`（含 NTFS 大小写不敏感）；顺手堵了 `runtimeAssetInstaller` 归档
  反斜杠/盘符条目的 Windows 解压逃逸（盘点时漏的真实洞）。
- 7 处 `/tmp` → `os.tmpdir()`；11 处 `process.env.HOME` → `os.homedir()`。
- `backgroundTasks` spawn('bash') → platformShell；killProcessTree win32 走 taskkill /T。
- **commandSafety 平台规则包**：结构化解析 + PowerShell 别名/参数前缀归一 +
  硬毙/分级清单 + strict/lenient 双模式（朋友测试包默认 lenient）；
  `windowsCommandSafety.test.ts` 51 用例（别名/缩写/cmd 形态/嵌套包裹变体爆破）。
- execPolicy BANNED_PREFIXES 补 powershell/pwsh/cmd/iex。

### P0 打包链 + P1 CI

- bundled-node win32 分支（.zip / node.exe 顶层布局）、fetch-rtk/uv windows-msvc
  分支 + sha256 实拉锁定、`tauri-platform-config.mjs`（mac 资源剔除 + win32 路径替换 +
  NSIS currentUser + WebView2 embedBootstrapper + updater pubkey 注入）、
  main.rs cfg(windows)（node.exe 候选 + CREATE_NO_WINDOW）。
- `build-windows-test.yml`（manual dispatch）4 轮迭代实跑绿 + `verify-windows-release.mjs`
  （pre 资源逐项 / post NSIS/PE/.sig）+ 产物上传 OSS `wintest/`（国内测试机直连）。

### 真机验证（天翼云电脑 Windows Server 2019 / GBK 936）

核心打通：perUser 无 UAC 安装 → 窗口完整渲染 → webServer / better-sqlite3 /
23 skills / 13 MCP 全活。连修 5 个实现期 bug（shasum 缺失 / GNU tar 把 C: 当远程主机 /
首次非 mac 编译暴露的存量 cfg 洞 / Server 2019 无 WebView2 秒退 / `\\?\` verbatim
路径崩 node 模块解析），全部是静态盘点照不到的。明细见 windows-support.md §7。

## D2（2026-06-11）：发版链折入 + 全入口设备感知 + 收尾

### release.yml 矩阵折入（§4 P2 收口）

- 新增独立 `build-windows` job（不进 build-mac 矩阵——mac 有 codesign/notarize 专属步），
  步骤复刻 build-windows-test.yml 绿链路；产物**先重命名最终 OSS key 名再生成 updater
  manifest**（mac 同款做法，URL 与对象名天然一致）。
- publish merge 合并 `windows-x86_64` 第三键 + required keys 校验；stable/release.json
  经 `--exe-url` 写入 exe（OSS versioned 路径，同 dmg）。
- **fail-fast 策略**：publish `needs: [build-mac, build-windows]` +
  `if: always() && build-mac 成功`——windows leg 失败自动降级 mac-only 发版，绝不拖死 mac。
- `releaseMacosGates.test.ts` 同步特征断言（windows leg 存在性 + fail-closed 步骤顺序 +
  publish 降级条件）。
- **预发布 tag `v0.16.101-wintest1` 空跑验证全绿**（run 27319024947，四 job 首跑全过）：
  合并 manifest 含全部三平台键、OSS exe 可达、stable 零污染（prerelease 闸门全守住）。

### 全入口设备感知下载/更新

- **分发页**：OS 识别（userAgentData→platform→UA 三级降级，mac 先于 win 判防
  'dar**win**' 子串误判）**只决定推荐排序**——Windows 访客在 win 资产已发布时置顶
  Windows 卡片 + 主推按钮 + hero CTA 切换；所有平台入口永远可见可点（与芯片检测
  同一条铁律：识别可被伪装，绝不据此隐藏入口）。Playwright 实测基线/推荐态/探测
  404 安全隐藏。
- **修两个资产选择真 bug**（复核时发现）：
  1. 服务端 `updateMetadata.selectAsset`：`runtime-assets-manifest-darwin-x64.json`
     同时命中 'win'(darwin) 与 'x64' token，靠资产数组顺序才没把 JSON 当 Windows
     下载目标 → sidecar（json/sha256/sig）永不作为下载资产 + win32 匹配显式排除 darwin。
  2. 客户端 `updateService` OSS fallback 同源 bug 更严重（会真把 runtime manifest JSON
     给 win32 当下载地址）且完全不看 arch（Intel mac fallback 拿 arm64 dmg）→ 抽
     `selectReleaseAssetForPlatform` 与服务端同语义，附对抗性排序单测。
- 其余入口复核：Tauri updater（stable/latest.json 平台键自动选，矩阵折入后端到端就绪）、
  应用内检查更新（platform+arch 已上送、服务端已修）、localBridge 安装指引（指向分发页
  锚点，随设备感知生效）。

### ConnectorRegistry 平台过滤（§1.5 降级注册优化）

三层过滤：registry `configure`/`listAvailableNativeIds` 按平台（构造注入便于测试）、
`registerMigratedTools` 非 darwin 跳过 11 个 connector 工具 schema（LLM 工具列表
不再出现注定 unavailable 的项，省无效调用轮次）、settings 开关清单走 registry。

### PII 安装链 Node 化（P3 最后一个工程项）

`setup-gliner-pii.sh` → `setup-gliner-pii.mjs`，双平台一份实现（Node 化 > PowerShell 版：
bundled node 本来在包里，消灭双脚本漂移）。平台差异收敛在两个可测函数
（venv python 路径 / uv 二进制名）；模型下载保留系统 curl（Node 原生 fetch 不读
HTTPS_PROXY env，spawn curl 保住代理行为）；pii.ipc 用 `process.execPath` spawn。
mac 本机真实环境全链路回归 + ONNX 推理 smoke 通过；win32 bundle 恢复带 PII 资源 + uv.exe。

## 非目标（维持既有决策）

- 不买 Authenticode 证书（unsigned NSIS + SmartScreen 指引；更新完整性走 minisign）。
- 不做 Swift sidecar ×3 / AppleScript connectors / VAD 的 Windows 等价物（降级面已逐项核验）。
- CUA Windows 侧 MVP 不 bundle（官方 install.ps1 路线留待验证）。

## 遗留（非代码项）

- **真机验收**（windows-support.md §5）：最关键 #13 WebView2 **干净机**自动装
  （embedBootstrapper 自动链路从未验证，"安装包自给自足"的命门，正式发版前置条件）；
  其余 ⏳/🔑 项需配 key 的消费版真机。
- 朋友安装指引 `docs/guides/windows-test-install.md` 差截图。
- 命令安全 eval set 的 Windows 子集随朋友测试期真实命令样本回填后再切 strict。
