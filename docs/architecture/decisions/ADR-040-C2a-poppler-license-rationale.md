# ADR-040 C2a：Poppler sidecar 许可证判断依据

- **状态**：产品路线已批准；已按 Poppler `26.07.0` 的实际组件集合重核（2026-07-15）
- **发布身份**：Agent Neo project
- **主程序许可证**：MIT
- **sidecar 许可证**：按 Poppler 及其实际传递依赖各自许可证分发
- **隐私边界**：公开制品、manifest、NOTICE 和源码包不得写入项目维护者或内部审核人员的姓名、个人邮箱与本机路径

## Poppler 双许可择一（26.07.0 起）

Poppler `26.07.0` 的声明许可证是 `GPL-2.0-only OR GPL-3.0-only`——上游给的是**二选一**，不是同时受两者约束。**Agent Neo 择 GPL-2.0-only**，理由是本文余下部分（对应源码义务、§3 把构建脚本计入源码、独立进程边界论证）全部建立在 GPLv2 条款上，择 v2 使既有判断依据无需重做。择定即须履行 GPLv2 全部义务；改择 GPL-3.0-only 属于重新评估触发器。

`26.02.0_1` 时代上游只声明 `GPL-2.0-only`，无可择。这一条是 `26.07.0` 重核新增的实质变化——组件集合本身没变（17 个，无增无减），其余 16 个组件的声明许可证一字未改。

## 决定

Agent Neo 继续随包分发 `pdftoppm` sidecar，以保留干净用户机上的 PPT/PDF 多页截图体验。主程序与 sidecar 按独立分发单元管理：Agent Neo 保持 MIT；sidecar 单独携带许可证、版权信息、精确对应源码和构建材料。

本决定由项目维护者按现有技术事实接受剩余许可证解释风险，不以外部法务签字作为发版前置。未来出现动态链接、共享内存、复杂双向 IPC、sidecar 源码修改、主程序许可证变化或企业级商业分发时，必须重新评估该判断。

## 技术边界

1. `src/host/tools/media/ppt/visualReview.ts` 通过 `execSync` 启动独立的 `pdftoppm` 可执行文件。
2. 交互只包含命令行参数、输入 PDF 路径、输出图片路径和进程退出状态。
3. Agent Neo 不链接 Poppler 动态库，不共享内存，不交换进程内数据结构。
4. sidecar 可以脱离 Agent Neo 独立执行 `pdftoppm -v` 和 PDF 转图。
5. 结构测试必须锁住以上边界；越界改动触发许可证重新评估。

GNU GPL FAQ 将简单 `fork/exec` 且没有紧密通信的形态描述为独立程序判断的事实基础：

- https://www.gnu.org/licenses/gpl-faq.en.html#GPLPlugins

这份判断依据不是对 GPL 义务的豁免。分发 sidecar 仍需满足对应源码和许可证义务：

- https://www.gnu.org/licenses/old-licenses/gpl-2.0.en.html#section3

## 发版硬门

正式发布包含 Poppler 的 DMG 前，必须同时满足：

1. `config/poppler-sidecar.lock.json` 为 `ready`，并完整锁定 arm64/x64 manifest、sidecar archive 和 source bundle 的 HTTPS URL、bytes 与 SHA-256。
2. 两个架构都来自原生 runner；x64 必须来自 `macos-15-intel`，不得使用 Rosetta 代替。
3. manifest 只包含 `Agent Neo project` 发布身份，不包含维护者姓名、个人邮箱、主机名或本机绝对路径。
4. sidecar archive 内含 `compliance/THIRD_PARTY_NOTICES.txt` 和从精确源码归档提取的完整许可证文本。
5. source bundle 内含精确上游源码归档、Homebrew formula、安装 receipt、构建脚本、二进制来源映射和 SHA-256 清单。
6. release workflow 下载全部三类资产并校验 hash、架构、文件清单和 source URL；任一步失败即停止 GitHub Release 与 stable 提升。

## 责任与验收证据

- promotion workflow 负责在原生 arm64 与 `macos-15-intel` runner 生成候选制品、完整源码包和 manifest。
- 项目维护者负责复核两个 workflow run、公开 URL、hash/bytes 和许可证材料，再把 lock 从 `pending-promotion` 改为 `ready`。
- formal release workflow 负责重新下载并校验全部资产；它的双架构成功 run、最终 DMG 内许可证文件和 GitHub Release source bundle 是放行证据。
- 任何角色都不能用 Rosetta、本机残留 Cellar、手工复制 NOTICE 或跳过 source gate 替代上述证据。

## 重新评估触发器

- `pdftoppm` 从子进程调用改成进程内链接；
- 新增共享内存、复杂 RPC 或双向结构化状态同步；
- 修改 Poppler 或依赖组件源码；
- sidecar manifest 无法追溯到精确源码与构建材料；
- 签名或运行时策略阻止 LGPL 组件的替换权；
- Agent Neo 的主程序许可证或商业分发模式发生变化；
- **`config/poppler-sidecar.lock.json` 的 `popplerBrewVersion` 或 `formula.commit` 变动**——换快照会连带换掉整个传递闭包的版本，本文的组件表与择一结论都以某一个快照为准；
- **任何组件的 `declaredLicense` 与本文记录不符**——升到 `26.07.0` 时 Poppler 就从 `GPL-2.0-only` 变成了 `GPL-2.0-only OR GPL-3.0-only`，组件集合却毫无变化。只盯组件增删会漏掉这类变化，必须逐个对声明许可证。
