# ADR-048：云下发角色包复用控制面签名通道，内置包保持编译内分发

- 状态：proposed
- 日期：2026-07-22

## 背景

内置专家（数据分析师、牧之、溯真、青禾、明镜）以 `BuiltinRoleDefinition` 常量编译进产物，配套 skill 以 `ParsedSkill` 常量住在 `skills/rolePacks/*`，由 `rolePacks/index.ts` 聚合后并入 `BUILTIN_SKILLS`。`validateBuiltinRolePack()` 是上架硬门：内置包的 frontmatter 只能引用内置且可解析的 skill，空壳包与外部依赖一律拒绝。这条约束保证了「装完即用、断网可用」。

代价是新增或修订一个专家必须发版。ADR-042 之后已有一条可验证分发链：控制面签名信封（`kind` 参数化 + Ed25519 + `expiresAt` + `contentHash`）承载 `skill_registry`，条目钉死 `pinnedCommit`/`contentHash`，由 marketplace `installService` fail-closed 安装到用户 skill 目录。E5 要解决的是「角色包能不能同样脱离发版下发」，同时不能牺牲上述两条保证。

## 决策

### 1. 复用同一条控制面通道，新增 `role_registry` 制品种类；不新建第二条分发链

角色包走既有签名信封与既有安装流水线，只做「冲压件」增量：`ControlPlaneArtifactKind` 联合三处（`src/shared/contract/controlPlane.ts`、`vercel-api/lib/controlPlaneEnvelope.ts`、`src/shared/ipc/schemas/admin.ts` 的 admin 枚举）加 `role_registry`、`CLOUD_ENDPOINTS` 加 `roleRegistry`、新增读取器 `remoteRolePackRegistryService`（形状照抄 `remoteSkillRegistryService`：签名校验失败即空货架、单条畸形只丢该条）。

payload 另立 schema 而非塞进 `SkillRegistryEntry`：角色包的实体是 `{roleId, agentMd, visual, skillRefs[]}`，与 skill 条目的 `{repository, path, skills[]}` 没有共同字段。合表要给两边各加一半无意义的可选字段，是把两个 schema 塞进一张表。

**角色包不自带 skill 内容，只按 registry 名引用 skill 条目**。安装角色包 = 先按引用装齐 skill（走 `installService` 的钉 SHA + hash 强校验链），再写角色定义。skill 的下载、校验、卸载、升级只有一条实现。

两套并行长起来的代价（因此不做）：签名与轮换、钉点与哈希校验、TTL 缓存、失败码、控制面 env JSON 与部署流程、以及「skill 从哪装的」这一问题的答案都会各有两份。仓内已经因为「discover tab 旧链走 gitDownloader、registry 链走 installService」两条 install 链吃过一次苦，不再新增第三条。

### 2. 契约与版本：registry 为版本源，手动升级，本地修改永不覆盖

- 条目带 `packVersion`（展示与比对用）与 `minAppVersion`（客户端丢弃高于自身版本的条目，向「不装」方向 fail-closed）。
- 沿用 skill registry 的版本纪律：registry 是版本真源，客户端比对本机安装记录得出「有新版」标记，由用户手动升级，禁止追分支头或轮询。
- 回滚是**控制面侧动作**：撤下或改回上一版条目。客户端不保留历史版本，不做本地降级——保留多版本需要一套本地版本库与迁移语义，价值远低于成本。已装的旧版不会被撤下条目影响，继续可用。
- **同名角色的用户本地定义永不被覆盖，这是底线**。`installBuiltinRoles()` 现有语义（`agents/<id>.md` 不存在才写、角色资产目录只建不改）原样延伸到云包。判定是否被用户改过，靠安装记录里存的「本次写入内容哈希」与磁盘现值比对，不靠猜测原始内容：一致则升级可覆盖定义文件，不一致则跳过并在货架上标「本地已修改，未更新」。
- **编译内内置角色的 id 优先于云包**：同 id 时云条目被丢弃并留 warn。否则控制面可以静默替换牧之。

### 3. 离线与首启：编译内内置包就是快照，云下发只做增量

现有 5 个内置包**不迁往云端**，继续编译进产物。它们即是离线快照，不需要另造快照文件或快照更新机制。E5 是纯增量能力：新专家从云端来，装完落盘，之后完全离线可用。

首启路径零改动：`installBuiltinRoles()` 仍在启动期同步执行且不触网；云货架在用户打开「发现」页时才惰性拉取。拉不到时的表现与 skill 货架一致——空货架 + 诊断码，既有专家不受影响。「拉不到控制面就没有专家」这一失败类因此不存在，无需兜底设计。

### 4. 角色资产（L1 记忆、履历、bindings）纯本地，双向都不参与下发

只下发 L0：`agentMd` + `visual` + skill 引用。理由：

- **语义**：L1 按定义是使用痕迹（「定义是出厂设置，记忆是使用痕迹」）。下发来的履历是别人的使用痕迹，产品承诺的「越用越懂你这个专家」立即失效。
- **隐私**：角色记忆装的是用户业务上下文（定价规则、客户名、求职材料——dogfood 实际写入的正是这类）。资料库与角色资产目前**没有任何云或 telemetry 外发面**，一旦为 L1 开上行通道，这会成为应用第一条个人内容外发链路，连带引入同意、留存、删除三套设计。
- **注入面不对等**：下发的 `agentMd` 是用户一屏可读完的提示词；下发的记忆是每轮注入、数量不受控的文件集合，同样的签名强度换来大得多的提示词注入面。
- **bindings 本身跨机无意义**：`ExpertContextBinding` 指向本机 file/folder 路径与 `library_item` id，下发过来要么悬空，要么等于让控制面投递路径形状的载荷。

对应的一句话规则：**下发定义，不下发痕迹**。

### 5. 硬门跟着走：三次校验，分层判定；允许退化安装，但退化必须可见

`validateBuiltinRolePack()` 的可解析 skill 集合从「内置 skill 全集」放宽为「内置 skill ∪ 本包 manifest 声明且已成功安装的 registry skill」。**不放宽为「本机全部已装 skill」**——那会让包意外依赖用户碰巧装过的东西，恰好毁掉这道门存在的理由（开箱即用）。

校验点：

1. **收录时**（发布流水线脚本，服务端权威）：坏包不得上架，与 `skill-registry-pin.mjs` 同位置同性质。此处仍要求全部 skill 引用可解析。
2. **客户端解析后、展示前**：schema 与信封校验；不过则丢弃该条目并 warn，其余货架照常（照抄 registry 逐条 drop 的容错）。
3. **安装完成、落盘生效前**：以真正安装成功的 skill 名字集重跑校验，按下述分层判定。

**分层判定**——不同性质的失败给不同处置，不再一律拒装：

| 层 | 判据 | 处置 |
|---|---|---|
| 信任层 | 签名 / 信封 / kind / schema 不过 | 丢弃条目，不可退让 |
| 底线层 | frontmatter 不可解析、name 与 roleId 不一致、visual 缺失、**声明的 skill 一个都没装上** | 拒装 + 整包回滚 |
| 退化层 | 部分 skill 未装上（其余已装成功） | **照常安装**，标记 `degraded` 并记录缺失清单 |

**退化安装的条件是可见性，不是宽容**。落地要求三条，缺一条就退回拒装：

- 安装记录写 `installState: 'complete' | 'degraded'` + `missingSkills[]`；
- 货架卡与「我的专家」卡都显示「N 项技能不可用」并提供**重试补装**；registry 侧修好后，升级流程自动带上补装；
- 角色被请到会话时，缺失技能进角色卡的可见状态，不靠用户从答得不好反推。

理由：一个 5 技能的包缺 1 个，专家的主体能力仍然成立；拒装等于用户完全得不到这个专家，而缺失是**可见且可恢复**的（重试补装 / 上游修复后升级）。原先「装残包 = 专家变笨而用户不知道」的顾虑，正解是把缺失暴露出来，不是把整个包挡掉。底线层保留拒装，是因为「一个 skill 都没有」的包等于纯 prompt 空壳，正是 `validateBuiltinRolePack()` 当初要挡的东西。

安装卡片必须展示该包声明的工具集与 skill 清单。工具边界沿用既有 `agentMd` 语义，不为云包新增特权路径；披露口径与 skill registry 的 risk tier 对齐。

## 理由

信任模型、密钥轮换、钉点校验、失败降级这四件事在 `controlPlaneTrust` + `installService` 里已经各有一份经过生产验证的实现，角色包与它们的差异只在 payload 形状。把差异控制在 payload 与一个新读取器上，是让新能力继承既有安全属性的最短路径。

内置包留在编译内，使「离线兜底」从一个需要设计的问题退化为不存在的问题；同时它天然构成硬门的锚——可解析 skill 集合永远有一个不依赖网络的下界。

「不覆盖用户定义」与「不下发痕迹」共同守住同一条产品边界：出厂内容归产品，使用痕迹归用户。这条边界一旦破，专家的记忆资产就不再可信。

## 影响面

- 契约与端点：`src/shared/contract/controlPlane.ts`、`src/shared/ipc/schemas/admin.ts`、`vercel-api/lib/controlPlaneEnvelope.ts`、`src/shared/constants/network.ts`、新增 `src/shared/contract/rolePackRegistry.ts`。
- 读取与安装：新增 `src/host/services/roleAssets/rolePackRegistryService.ts` 与 `rolePackInstallService.ts`（`installService.ts` 已达千行债门上限，新逻辑不得加在其中，只复用其导出的安装能力）。
- 硬门与安装：`src/host/services/roleAssets/builtinRoles.ts` 的 `validateBuiltinRolePack()` 增加可解析集合参数；`installBuiltinRoles()` 语义不变。
- 界面与 IPC：`ExpertPanel` 发现页新增货架区；`domain:roles` 新增动作须同步登记 `src/host/shellCapabilities.ts`。
- 控制面：`vercel-api/api/v1/role-registry.ts` 与对应 env JSON、签名、部署流程。

## 替代方案

- **角色包自带 skill 正文（内嵌 `ParsedSkill`）**：省掉引用解析，但 skill 会有「编译内、registry 装、角色包内嵌」三种来源，卸载与升级语义各不相同，且内嵌正文绕开了钉 SHA 与内容哈希这层校验。
- **角色包单独一套下发通道**：短期实现更直，长期要维护两份签名/轮换/钉点/缓存/失败码，并让「skill 从哪来」重新变成需要查代码才能回答的问题。
- **把现有 5 个内置包迁到云端**：能统一路径，但把「装完即用」变成依赖首次联网，并要求另造离线快照机制——为消除一处重复引入一整类失败模式。
- **L1 资产参与云同步**：能实现换机延续，但需要个人内容外发通道与配套合规设计，且与「记忆是用户使用痕迹」的产品定义冲突。跨机延续应由本地导出/导入解决，不由下发解决。
- **任一 skill 装不上就整包拒装**：口径最简单，但把一次上游波动放大成「这个专家你用不了」。改为退化安装 + 可见缺失 + 可补装后，失败被限制在缺失的那部分能力上。
