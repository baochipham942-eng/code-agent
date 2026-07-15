# ADR-040 C2a：Poppler 随包分发决策记录

- **状态**：方案 A 已批准；发版等待双架构不可变制品 promotion
- **证据日期**：2026-07-15
- **适用基线**：`c2774c2730d5ba7385809ad24935530bd4080286`；CI 接线修复另见本分支提交 `b01140175aa64d9630f86e79ab661adaae7be881`
- **当前候选**：`codex/adr040-p1-integration` @ `9519532e866fe004a7d877d128fe2fa3bb011f41` 已推远端，尚未建 PR / 合入默认分支
- **发布身份**：公开材料统一使用 `Agent Neo project`，不得包含项目维护者或内部审核人员的姓名、个人邮箱、本机路径或主机名。

## 产品判断

已选择方案 A：继续随包分发 Poppler sidecar，并把“许可证文本 + 精确对应源码 + 构建材料 + 可访问源码地址 + 原生双架构证据”设为发版硬门。Agent Neo 通过子进程执行 `pdftoppm`，没有链接其库；项目维护者按这一技术边界接受现阶段的剩余许可证解释风险，不把外部法务签字设为发版前置。

没有拍板和合规包之前，不应发布包含 `scripts/poppler` 的 DMG。只放一份第三方名称清单或只链接上游首页不足以覆盖 GPL/LGPL/MPL 的源码可得义务。

## 已核实的技术边界

1. Tauri 把整个 `scripts/poppler` 目录复制到应用资源中（`src-tauri/tauri.conf.json:89-100`）。这属于向用户分发二进制，不是开发机私用。
2. Host 先解析随包的 `poppler/bin/pdftoppm`，再通过 `execSync` 启动独立进程；参数是输入 PDF、输出路径和渲染选项，没有动态链接 Agent Neo 进程、共享内存或进程内 API（`src/host/tools/media/ppt/visualReview.ts:136-185`）。
3. Poppler bundle 由 Homebrew 的 `pdftoppm` 传递依赖闭包生成；脚本会复制所有非系统 dylib、重写 install name、ad-hoc 重签，并真跑三页 PDF 自检（`scripts/fetch-poppler.sh:6-22`、`69-174`、`176-233`）。
4. 2026-07-15 arm64 实跑产物是 1 个 `pdftoppm` + 24 个 dylib，共 25 个 Mach-O 文件；原始文件总计 11,298,096 bytes，gzip 归档 3,998,972 bytes。`pdftoppm` 真跑三页输出三页，全部文件均为 arm64，动态依赖中没有 `/opt/homebrew` 残留。
5. 正式 macOS 双架构 release matrix 和手动 x64 test workflow 只运行 `fetch-poppler-sidecar.mjs` 下载 lock 中的不可变资产；`fetch-poppler.sh` 只允许在独立 promotion workflow 中从固定 Homebrew formula 源码构建候选制品。
6. 2026-07-15 在当前 `0.27.1` 源码上完成同源 arm64 A/B：同一份 unsigned `.app`，只删除 B 组的 `Contents/Resources/scripts/poppler`，使用相同 `hdiutil create -format UDZO` 生成 DMG。含 Poppler 为 117,292,645 bytes（111.86 MiB），不含为 113,467,584 bytes（108.21 MiB），压缩后净增 3,825,061 bytes（3.65 MiB，+3.37%）。两份 DMG 均可只读挂载；含侧复核有 24 个 dylib，不含侧复核目录不存在。该 A/B 没有正式签名、公证和 Finder 样式，只用于隔离 Poppler 的包体增量，不能代替正式 release bundle 验收。

“独立进程”只支持主应用与 sidecar 分离的判断，不免除 sidecar 自身的分发义务。FSF FAQ 将简单 `fork/exec` 且不交换复杂数据的程序视为可分离情形，同时明确 GPL 二进制分发仍需提供精确对应源码。仓库结构测试锁住当前边界；出现进程内链接、共享内存、复杂双向 IPC、sidecar 源码修改、主程序许可证或商业分发模式变化时必须重新评估：

- https://www.gnu.org/licenses/gpl-faq.en.html#GPLPlugins
- https://www.gnu.org/licenses/gpl-faq.en.html#UnchangedJustBinary
- https://www.gnu.org/licenses/gpl-faq.en.html#AnonFTPAndSendSources

## 双架构实际分发清单（Poppler `26.07.0`）

下表**由 2026-07-15 的真实 promotion 候选生成**（run 29411394063，双架构 manifest + source bundle），不是本机 Cellar 的推测。跨架构版本对账门已证两架构 18/18 组件版本一致，故一表通用；`declaredLicense` 一列直接取自各组件精确源码归档对应的 formula 声明。

> 上一版本表列出 WebP 且自称「18 个实际组件」，而实物从来只有 17 个、不含 WebP——手写表与实物脱节。此表改由制品生成，任何版本/许可证变化都会在下一次 promotion 的复核里显形。

| 组件 / 实际版本 | 随包文件 | 声明许可证 | 发版义务要点 |
|---|---|---|---|
| poppler `26.07.0` | `pdftoppm`、`libpoppler.162.0.0.dylib` | GPL-2.0-only OR GPL-3.0-only | **上游给的是二选一，Agent Neo 择 GPL-2.0-only**（依据见许可证判断依据文档）。随包保留 GPLv2 全文、版权/免责信息；提供精确对应源码和控制编译/安装的脚本。GPLv2 §3 明确把这些脚本计入源码（https://www.gnu.org/licenses/old-licenses/gpl-2.0.en.html#section3）。 |
| fontconfig `2.18.1` | `libfontconfig.1.dylib` | HPND-sell-variant AND Unicode-3.0 AND MIT-Modern-Variant AND MIT AND LicenseRef-Homebrew-public-domain | 保留上游版权、许可与免责文本；精确文本从该版本源码包提取，不能只写 SPDX 简称。 |
| freetype `2.14.3` | `libfreetype.6.dylib` | FTL | 随包保留 FreeType License 全文和要求的 acknowledgement；如选择 GPL 替代路径需法务明确，不默认切换。 |
| gettext `1.0` | `libintl.8.dylib` | GPL-3.0-or-later AND LGPL-2.1-or-later | 只分发 `libintl`（按 LGPL-2.1-or-later），源码包其他工具含 GPL。仍需从精确版本源码核实文件级许可证并提供对应源码。 |
| gpgme `2.1.2` | `libgpgme.45.dylib` | LGPL-2.1-or-later | 明示使用该库、附 LGPL 全文、提供对应源码，并保证用户替换兼容共享库及为调试修改而逆向的权利。 |
| gpgmepp `2.1.0` | `libgpgmepp.7.1.0.dylib` | LGPL-2.1-or-later | 同上。 |
| jpeg-turbo `3.2.0` | `libjpeg.8.3.2.dylib` | IJG AND Zlib AND BSD-3-Clause | 保留精确版本的全部版权、许可与免责文本。 |
| libassuan `3.0.2` | `libassuan.9.dylib` | LGPL-2.1-or-later AND GPL-3.0-or-later AND FSFULLR | 库文件按 LGPL-2.1-or-later；源码包另含 GPL/FSFULLR 文件。必须按实际库文件的版权头和源码包许可证核对，不能把 formula 聚合许可证直接当最终 NOTICE。已不是 poppler 的直接依赖，仍经 gpgme 传递引入。 |
| libgpg-error `1.61` | `libgpg-error.0.dylib` | LGPL-2.1-or-later | 同 LGPL 义务。 |
| libpng `1.6.58` | `libpng16.16.dylib` | libpng-2.0 | 保留版权、许可与免责文本。 |
| libtiff `4.7.1_1` | `libtiff.6.dylib` | libtiff | 保留版权、许可与免责文本。 |
| little-cms2 `2.19` | `liblcms2.2.dylib` | MIT | 保留版权、许可与免责文本。 |
| nspr `4.39` | `libnspr4.dylib`、`libplc4.dylib`、`libplds4.dylib` | MPL-2.0 | 告知用户源码获取地址，保证 MPL 覆盖源码及时可得，不限制其源码权利；保留源码内 notice。MPL §3.2：https://www.mozilla.org/en-US/MPL/2.0/#distribution-of-executable-form |
| nss `3.125` | `libnss3.dylib`、`libnssutil3.dylib`、`libsmime3.dylib`、`libssl3.dylib` | MPL-2.0 | 同上。 |
| openjpeg `2.5.4` | `libopenjp2.2.5.4.dylib` | BSD-2-Clause | 保留版权、许可与免责文本。 |
| xz `5.8.3` | `liblzma.5.dylib` | 0BSD AND GPL-2.0-or-later | `liblzma` 以 0BSD 为主；源码包含 GPL 文件。按库文件版权头核最终 NOTICE；不要把整个源码包的 GPL 工具误标为随包库许可证。 |
| zstd `1.5.7_1` | `libzstd.1.5.7.dylib` | (BSD-3-Clause OR GPL-2.0-only) AND BSD-2-Clause AND MIT | 对该库选择 BSD 路径；NOTICE 明确采用的许可证路径并保留相关文本。 |

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

1. 17 个实际组件的精确上游源码归档，不使用会漂移到最新版的首页链接；Poppler `26.07.0` 的官方历史归档存在于 https://poppler.freedesktop.org/releases.html 。每份归档的版本必须与随包二进制的版本一致——源码清单硬门会逐个组件校验，对不上即 fail-closed（2026-07-15 真拦下过「二进制 26.07.0 / 源码 26.06.0」）。
2. 每份源码归档的 SHA-256、上游 URL、组件版本、随包二进制映射和许可证文件路径。
3. 构建 Poppler bottle 所用的 Homebrew formula / patch / build metadata，以及仓内 `scripts/fetch-poppler.sh` 和本次 install-name 重定位说明。GPLv2 §3 把控制编译和安装的脚本列入 complete source。
4. 最终 arm64 / x64 sidecar 的文件清单、架构、SHA-256、`otool -L` 输出和自检结果。
5. GPLv2、LGPLv2.1、MPLv2 及所有 permissive 组件的原文许可证和版权 notice。

源码 URL 必须由 Agent Neo 发布方控制可用性。只指向上游项目不能保证以后仍有精确版本，也不能覆盖 Homebrew patch / build metadata；FSF FAQ要求源码与二进制版本精确对应且与二进制同样易取得：https://www.gnu.org/licenses/gpl-faq.en.html#AnonFTPAndSendSources

## 可选方案

### 方案 A：继续随包分发，补齐合规包（已批准）

产品收益：保持 ADR-040 D3 的截图优先体验，用户不安装 Homebrew 也能看到全部 PPT 页。

必须同时完成：

- 维护者记录并接受 Agent Neo 与 `pdftoppm` 的独立程序边界及剩余解释风险；
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

## 当前 stop-ship 项

1. **workflow 注册**：`build-poppler-sidecar.yml` 是 feature branch 新增 workflow，尚未进入默认分支；GitHub 首次手动 dispatch 返回 workflow-not-found，因此当前没有可验收的真实 run id。
2. **不可变托管**：arm64/x64 的 manifest、sidecar archive、complete-source bundle 尚未上传到稳定 HTTPS 地址并回填 lock。
3. **x64 原生证据**：必须由 `macos-15-intel` promotion run 产出，manifest 记录 run id、源码 SHA、`x86_64` 和 `rosettaTranslated=false`。
4. **完整合规包**：每个实际组件的精确源码归档、formula、install receipt、许可证全文和二进制来源映射必须由构建脚本生成并校验。
5. **正式 DMG**：同源 unsigned UDZO A/B 已完成，Poppler 的实测压缩增量是 3.65 MiB；正式签名、公证和安装版验证仍需在 ready lock 后运行。

以上任一项未完成，`release:poppler:verify` 和正式 tag workflow 都必须失败。不得用 `--skip-gates`、Rosetta、本机残留 Homebrew Cellar 或只上传 NOTICE 的方式放行。
