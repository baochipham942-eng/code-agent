# ADR-040 C2a：Poppler 随包分发决策稿

- **状态**：等待产品负责人 / 法务拍板
- **证据日期**：2026-07-15
- **适用基线**：`c2774c2730d5ba7385809ad24935530bd4080286`；CI 接线修复另见本分支提交 `b01140175aa64d9630f86e79ab661adaae7be881`
- **边界**：本文是证据盘点和备选方案，不是最终 `NOTICE`，也不改变 Agent Neo 的发版许可证口径。

## 产品判断

推荐短期选择方案 A：继续随包分发 Poppler sidecar，但把“许可证文本 + 精确对应源码 + 构建材料 + 可访问源码地址”设为发版硬门。Agent Neo 通过子进程执行 `pdftoppm`，没有链接其库；这给“主应用与 GPL sidecar 是独立程序”的判断提供了事实基础，但最终法律判断仍需法务确认。

没有拍板和合规包之前，不应发布包含 `scripts/poppler` 的 DMG。只放一份第三方名称清单或只链接上游首页不足以覆盖 GPL/LGPL/MPL 的源码可得义务。

## 已核实的技术边界

1. Tauri 把整个 `scripts/poppler` 目录复制到应用资源中（`src-tauri/tauri.conf.json:89-100`）。这属于向用户分发二进制，不是开发机私用。
2. Host 先解析随包的 `poppler/bin/pdftoppm`，再通过 `execSync` 启动独立进程；参数是输入 PDF、输出路径和渲染选项，没有动态链接 Agent Neo 进程、共享内存或进程内 API（`src/host/tools/media/ppt/visualReview.ts:136-185`）。
3. Poppler bundle 由 Homebrew 的 `pdftoppm` 传递依赖闭包生成；脚本会复制所有非系统 dylib、重写 install name、ad-hoc 重签，并真跑三页 PDF 自检（`scripts/fetch-poppler.sh:6-22`、`69-174`、`176-233`）。
4. 2026-07-15 arm64 实跑产物是 1 个 `pdftoppm` + 24 个 dylib，共 25 个 Mach-O 文件；原始文件总计 11,298,096 bytes，gzip 归档 3,998,972 bytes。`pdftoppm` 真跑三页输出三页，全部文件均为 arm64，动态依赖中没有 `/opt/homebrew` 残留。
5. 本分支已把 `fetch-poppler.sh` 接入正式 macOS 双架构 release matrix 和手动 x64 test workflow，并用结构测试保证生成步骤在 Tauri 打包之前执行（`.github/workflows/release.yml:92-111`、`.github/workflows/build-x64-test.yml:46-59`、`tests/scripts/releaseMacosGates.test.ts:254-286`）。
6. 2026-07-15 在当前 `0.27.1` 源码上完成同源 arm64 A/B：同一份 unsigned `.app`，只删除 B 组的 `Contents/Resources/scripts/poppler`，使用相同 `hdiutil create -format UDZO` 生成 DMG。含 Poppler 为 117,292,645 bytes（111.86 MiB），不含为 113,467,584 bytes（108.21 MiB），压缩后净增 3,825,061 bytes（3.65 MiB，+3.37%）。两份 DMG 均可只读挂载；含侧复核有 24 个 dylib，不含侧复核目录不存在。该 A/B 没有正式签名、公证和 Finder 样式，只用于隔离 Poppler 的包体增量，不能代替正式 release bundle 验收。

“独立进程”只支持主应用与 sidecar 分离的判断，不免除 sidecar 自身的分发义务。FSF FAQ 将简单 `fork/exec` 且不交换复杂数据的程序视为可分离情形，同时明确 GPL 二进制分发仍需提供精确对应源码；这里应由法务把 Agent Neo 的实际 IPC 形态对照该标准确认：

- https://www.gnu.org/licenses/gpl-faq.en.html#GPLPlugins
- https://www.gnu.org/licenses/gpl-faq.en.html#UnchangedJustBinary
- https://www.gnu.org/licenses/gpl-faq.en.html#AnonFTPAndSendSources

## arm64 实际分发清单

下表来自 `scripts/fetch-poppler.sh` 在本机 Homebrew Cellar 的实际传递闭包。版本必须随每个架构的正式构建重新生成证据，不能假定 x64 与本表一致。

| 组件 / 实际版本 | 随包文件 | 保守许可证口径 | 发版义务要点 |
|---|---|---|---|
| Poppler `26.02.0_1` | `pdftoppm`、`libpoppler.157.0.0.dylib` | GPL-2.0-only | 随包保留 GPLv2 全文、版权/免责信息；提供精确对应源码和控制编译/安装的脚本。GPLv2 §3 明确把这些脚本计入源码（https://www.gnu.org/licenses/old-licenses/gpl-2.0.en.html#section3）。 |
| Fontconfig `2.17.1` | `libfontconfig.1.dylib` | HPND / Unicode / MIT 系列复合许可证 | 保留上游版权、许可与免责文本；精确文本从该版本源码包提取，不能只写 SPDX 简称。 |
| FreeType `2.14.3` | `libfreetype.6.dylib` | FTL | 随包保留 FreeType License 全文和要求的 acknowledgement；如选择 GPL 替代路径需法务明确，不默认切换。 |
| libpng `1.6.56` | `libpng16.16.dylib` | libpng-2.0 | 保留版权、许可与免责文本。 |
| GPGME++ `2.0.0` | `libgpgmepp.7.0.0.dylib` | LGPL-2.1-or-later | 明示使用该库、附 LGPL 全文、提供对应源码，并保证用户替换兼容共享库及为调试修改而逆向的权利。 |
| GPGME `2.0.1` | `libgpgme.45.dylib` | LGPL-2.1-or-later | 同上。 |
| libassuan `3.0.2` | `libassuan.9.dylib` | 库文件按 LGPL-2.1-or-later；源码包另含 GPL/FSFULLR 文件 | 必须按实际库文件的版权头和源码包许可证核对，不能把 formula 聚合许可证直接当最终 NOTICE。 |
| libgpg-error `1.58` | `libgpg-error.0.dylib` | LGPL-2.1-or-later | 同 LGPL 义务。 |
| GNU gettext `1.0` | `libintl.8.dylib` | `libintl` 按 LGPL-2.1-or-later；源码包其他工具含 GPL | 只分发 `libintl`，仍需从精确版本源码核实文件级许可证并提供对应源码。 |
| NSS `3.120_1` | `libnss3`、`libnssutil3`、`libsmime3`、`libssl3` | MPL-2.0 | 告知用户源码获取地址，保证 MPL 覆盖源码及时可得，不限制其源码权利；保留源码内 notice。MPL §3.2：https://www.mozilla.org/en-US/MPL/2.0/#distribution-of-executable-form |
| NSPR `4.38.2` | `libnspr4`、`libplc4`、`libplds4` | MPL-2.0 | 同上。 |
| libjpeg-turbo `3.1.4.1` | `libjpeg.8.3.2.dylib` | IJG / zlib / BSD-3-Clause 复合 | 保留精确版本的全部版权、许可与免责文本。 |
| Little CMS `2.18` | `liblcms2.2.dylib` | MIT | 保留版权、许可与免责文本。 |
| XZ Utils `5.8.3` | `liblzma.5.dylib` | `liblzma` 以 0BSD 为主；源码包含 GPL 文件 | 按库文件版权头核最终 NOTICE；不要把整个源码包的 GPL 工具误标为随包库许可证。 |
| OpenJPEG `2.5.4` | `libopenjp2.2.5.4.dylib` | BSD-2-Clause | 保留版权、许可与免责文本。 |
| libtiff `4.7.1_1` | `libtiff.6.dylib` | libtiff | 保留版权、许可与免责文本。 |
| WebP `1.6.0` | `libwebp.7.2.0`、`libsharpyuv.0.1.2` | BSD-3-Clause | 保留版权、许可与免责文本。 |
| Zstandard `1.5.7_1` | `libzstd.1.5.7.dylib` | 对该库选择 BSD 路径；源码包另有 GPL 选项和 BSD/MIT 文件 | NOTICE 明确采用的许可证路径并保留相关文本。 |

LGPL v2.1 §6 要求显著告知、附许可证，并通过对应源码/可重链接材料或可替换共享库机制满足用户修改权；当前 bundle 使用独立 dylib，技术上保留了替换机制，但最终包的签名、公证和运行时加载是否构成实际限制需要法务与发布工程共同确认：https://www.gnu.org/licenses/old-licenses/lgpl-2.1.en.html#section6

## 源码获取路径

推荐在与每个 DMG / updater 归档同一 release 可见面提供按架构、按版本固定的 source bundle，例如：

```text
release-assets/
  Agent.Neo-<version>-arm64.dmg
  Agent.Neo-<version>-x64.dmg
  third-party-sources/
    poppler-sidecar-macos-arm64-<manifest-sha>.tar.zst
    poppler-sidecar-macos-x64-<manifest-sha>.tar.zst
```

每个 source bundle 至少包含：

1. 18 个实际组件的精确上游源码归档，不使用会漂移到最新版的首页链接；Poppler `26.02.0` 的官方历史归档存在于 https://poppler.freedesktop.org/releases.html 。
2. 每份源码归档的 SHA-256、上游 URL、组件版本、随包二进制映射和许可证文件路径。
3. 构建 Poppler bottle 所用的 Homebrew formula / patch / build metadata，以及仓内 `scripts/fetch-poppler.sh` 和本次 install-name 重定位说明。GPLv2 §3 把控制编译和安装的脚本列入 complete source。
4. 最终 arm64 / x64 sidecar 的文件清单、架构、SHA-256、`otool -L` 输出和自检结果。
5. GPLv2、LGPLv2.1、MPLv2 及所有 permissive 组件的原文许可证和版权 notice。

源码 URL 必须由 Agent Neo 发布方控制可用性。只指向上游项目不能保证以后仍有精确版本，也不能覆盖 Homebrew patch / build metadata；FSF FAQ要求源码与二进制版本精确对应且与二进制同样易取得：https://www.gnu.org/licenses/gpl-faq.en.html#AnonFTPAndSendSources

## 可选方案

### 方案 A：继续随包分发，补齐合规包（推荐）

产品收益：保持 ADR-040 D3 的截图优先体验，用户不安装 Homebrew 也能看到全部 PPT 页。

必须同时完成：

- 法务书面确认 Agent Neo 与 `pdftoppm` 的独立程序边界；
- 生成并随包展示 `THIRD_PARTY_NOTICES` 与完整许可证文本；
- 上线精确对应 source bundle 和稳定 URL；
- arm64 / x64 各自产出清单和自检，不拿一侧代替另一侧；
- release gate 验证 NOTICE 存在、source URL 可访问、manifest 与 bundle 哈希一致。

主要风险：Homebrew 依赖版本会漂移，合规清单必须跟随每次 sidecar 重建更新；如果最终签名机制阻止用户替换 LGPL dylib，需要额外合规设计。

### 方案 B：发版时移除随包 Poppler

产品代价：回到系统 `pdftoppm` / ImageMagick / `qlmanage` 降级；干净用户机可能整份 deck 只有一张缩略图，第 2 页起无法靠截图选择，直接违背 ADR-040 D3 的非程序员体验要求。

合规收益：本轮不再分发这些 25 个 Mach-O，新增的 GPL/LGPL/MPL 分发义务退出发版面。系统已安装工具的许可证责任不由 Agent Neo 二进制分发触发。

### 方案 C：自建最小 Poppler sidecar

只编译 `pdftoppm` 所需功能，关闭签名后端等无关能力，理论上可移除 NSS/NSPR、GPGME 系列和部分体积。它仍然是 GPL sidecar，仍需对应源码，但第三方组件数量、NOTICE 复杂度和攻击面会下降。

代价是新增一条可复现构建与双架构验证项目，需重新做运行时、多页、字体、复杂 PDF、签名、公证和 DMG 体积验收，不适合在没有单独工单和排期时塞进本次收尾。

### 方案 D：把 sidecar 改成安装后按需下载

不推荐。只要 Agent Neo 发布方仍向用户提供该二进制，分发义务没有消失；同时引入首次使用下载失败、离线不可用、版本与 source bundle 错配的新风险。

## 当前阻塞与待拍板项

1. **法务边界**：是否接受“主应用通过简单子进程调用 GPL `pdftoppm`，两者为独立程序”的发版口径。
2. **方案选择**：A（推荐）、B 或另立工单实施 C。
3. **源码托管**：确定 release asset / OSS 的真实公开路径、保留周期和责任人。
4. **用户可见入口**：确定 About / 帮助页 / DMG 内文件中的第三方许可证入口；不能只在仓库里放开发者文档。
5. **release gate**：是否批准“许可证文件存在 + source URL 200 + 两架构 manifest/hash 对齐”作为不可跳过的发版硬门。
6. **Homebrew pin 漂移**：脚本固定 `26.02.0_1`（`scripts/fetch-poppler.sh:27-31`），但 2026-07-15 本机 Homebrew API 已显示当前 stable `26.07.0`。fresh runner 能否取得固定 Cellar 版本尚未核实；在 x64 真跑前不能把 CI 接线等同于 x64 通过。
7. **x64 实跑**：本机有 Rosetta 但没有 Intel Homebrew，无法生成可信 x64 传递闭包；需 `macos-15-intel` 真 runner 证实。
8. **正式 DMG**：同源 unsigned UDZO A/B 已完成，Poppler 的实测压缩增量是 3.65 MiB；正式签名、公证、Finder 样式后的 release DMG 尚未运行，不应把本地 A/B 的总大小当成最终发布物大小。

在 1–5 拍板前，不新增或修改 `NOTICE` / 关于页文案，不改变现有产品许可证声明。
