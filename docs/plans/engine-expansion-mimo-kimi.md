# 计划:Neo 引擎扩展 —— 先加 MiMo + Kimi

> 创建:2026-06-22 · 状态:**引擎已合 main(`4bcbb14ba`)+ 兼容矩阵/设置页 IA 完成(待合 main)** · 来源:多轮引擎选型讨论收口
>
> **进度:§9 引擎实现 · §10 真机 dogfood + 权限修复 · §11 兼容矩阵 + 设置页「执行引擎」section。** 引擎链(适配器/分发/探测/catalog/权限)已 `--no-ff` 合本地 main `4bcbb14ba`(含 stability 批次),未推 origin。下一阶段(矩阵 + 设置页 IA)在 `feat/engine-compat-matrix`,待合。

## 0. 边界

- 本轮决策:在现有 **Native + Claude Code + Codex** 之上,新增 **MiMo-Code、Kimi Code** 两个执行引擎。
- **兼容矩阵(§5 ①)** 和 **PATH 发现 + fail-closed(§5 ②)** 已由另一会话进行中,本计划**只声明依赖和交接接口,不重复实现**。

## 1. 引擎名册最终决策(归档,避免反复)

| 决策 | 内容 | 依据 |
|---|---|---|
| ✅ 加 | MiMo-Code(先)、Kimi Code(次) | 自家可 spawn CLI + 可登订阅 + ToS 自用不禁 |
| ⏸ 观察位 | Grok Build | 够格但 beta + ToS 未核实,等 GA |
| ❌ 不加 | Google Antigravity | ToS 明令禁第三方接入 → Gemini 降为 model |
| 🔁 借壳非引擎 | GLM / MiniMax / Qwen | 走「Claude Code 引擎 + 自定义端点」,归到矩阵 ① |
| 🔕 暂不做 | OpenCode / Goose / OpenHands / Aider / Crush | 纯 BYOK,无计费红利,仅要其 harness/ACP 时才接 |

判定标准:① 有可 headless spawn 的编码 CLI；② 能经 CLI 登录吃到 API key 拿不到的订阅/账号额度(引擎 vs model 的分界);③ ToS 自用不禁。

## 2. 核心交付:新增 MiMo + Kimi(沿用现有 adapter 模式,每个 ~4 处改动)

现有引擎抽象位置:`src/shared/contract/agentEngine.ts`(`AgentEngineKind` 等类型)、`src/main/services/agentEngine/`(registry + 各 adapter)、`src/main/ipc/agentEngine.ipc.ts`、`agentAppService.sendMessage`(按 `engine.kind` 分发)、`ModelSwitcher.tsx`(引擎选择 UI)。

### 2.1 MiMo-Code(第一优先,最干净)

- **入口**:`mimo run --format json`(JSON 事件流,可直接解析)
- **计费**:`tp-` Token Plan 订阅;另有 OAuth 登录 / 免费通道 / BYO key
- **许可**:MIT,无封装 ToS 雷;**无原生 ACP → 直接 spawn**
- **改动面**:
  - `src/shared/contract/agentEngine.ts`:`AgentEngineKind` 加 `mimo_code`
  - 新建 `src/main/services/agentEngine/mimoCliAdapter.ts`:spawn + 解析 `--format json` + 归一回 `RuntimeRunEvent`/AgentEvent
  - `agentAppService.sendMessage`:加 `mimo_code` 分发分支
  - 模型目录:登记 MiMo 暴露的模型(走现有签名 catalog 机制)
  - **向 ① 注册** wire format + 计费模式;**向 ② 提供** detection 配置(binary `mimo`、`--version` 探活、`MIMO_BIN` 覆盖)

### 2.2 Kimi Code(第二,先验入口)

- **前置已核实**(§8):改名后命令仍是 `kimi`,headless 入口 `kimi -p "<prompt>" --output-format stream-json`(JSONL 逐行解析),订阅经 `kimi login`(OAuth)消费。
- **计费**:Kimi 会员订阅(已验证 kimi.com/code = "a coding-focused perk of the Kimi membership")
- **ACP**:有(`kimi acp`),但本轮**走硬编码 adapter,不接 ACP**
- **凭据机制(关键,影响架构)**:CLI **不从 env var 读 API key**(`KIMI_API_KEY` 等无效)。适配器必须二选一:① 预先 `kimi login` 落盘 OAuth token;② 为目标 `KIMI_CODE_HOME` 写好 `config.toml` 的 `[providers.<name>] api_key`。**用 `KIMI_CODE_HOME` 给每个用户/子进程隔离一套凭据目录** —— 这正是 §2.3「每用户各自登录」约束的落地手段。
- **改动面**:同 2.1 五步(type / `kimiCliAdapter.ts` / dispatch / catalog / ①② 注册)。适配器**只读 stdout 即得正文**(thinking/进度在 stderr,需要再单独捞);text 模式有缓冲 → 固定用 `stream-json`;容错 OpenAI-compatible 后端偶发「empty response」错。

### 2.3 两家共用硬约束

1. **每用户各自登录自己的订阅** —— ToS 红线:禁一份订阅供多用户/转售;auth 状态按用户隔离。
2. **UI 诚实**:选这两个引擎 = 用它的 harness + 你的订阅,**吃不到 Neo harness 红利**。在引擎选择处明示。
3. **价值定位 = 计费,不是质量**:它们 harness 比 Claude/Codex 弱,加它们是为了让用户烧自己的订阅。

## 3. 设置页 IA(承接最初的问题)

- **通用模型(provider):不动**,已稳定。
- 新增独立 **「执行引擎」section**,与「通用模型」平级:
  - 引擎列表(Native/Claude/Codex/MiMo/Kimi)+ 安装状态徽标 + 版本 + 默认模型 + 登录入口 + **计费模式标注**
  - 引擎 ⟂ 模型是正交两层(先选谁执行,再选用什么脑子)
- 引擎切换的 fail-closed 语义由 ② 提供,这里只消费。

## 4. ACP:本轮不做,记录触发条件

MiMo(无 ACP 直 spawn)+ Kimi(硬编码)都不需要 ACP。**重新评估 ACP 的触发点**:

- (a) 要扩到第 5+ 个引擎,尤其 ACP 原生那批(OpenCode/Goose/OpenHands/Grok/Copilot);
- (b) 要让 Neo 被 Zed/lody 反向托管;
- (c) ~~接 Gemini 被 antigravity 吞输出坑卡住~~ —— agy 当前被 ToS 挡,该触发点暂冻结。

## 5. 依赖与交接(进行中,不重复)

- **① 兼容矩阵**:两个新引擎需向矩阵**注册** wire format + 计费模式。**请矩阵预留两列**:`计费模式(订阅/账号额度 vs API key PAYG)` 和 `借壳端点`(给 GLM/MiniMax/Qwen)。
- **② PATH 发现 + fail-closed**:两个新引擎需向发现框架**提供** detection 配置(binary 名、版本探活、`MIMO_BIN`/`KIMI_BIN` env 覆盖)。会话级 pin 的引擎不可用必须 throw,绝不静默降级。

## 6. 执行顺序

1. 与 ①/② 约定好接口(注册 wire format/计费、提供 detection 配置)
2. **MiMo-Code 端到端**:type → adapter → dispatch → catalog → ①② 注册 → UI
3. **dogfood**:真订阅 spawn 验证(每用户登录、JSON 解析、事件归一)—— ⚠️ 会消耗 MiMo 订阅额度(小额,提前告知)
4. **Kimi**:先验 spawn 入口(§8) → 同流程
5. 设置页「执行引擎」section 收口

## 7. 待确认(开工前)

- ✅ Kimi Code 改名后的 spawn 入口/flag/JSON 能力 —— 见 §8
- ①② 的接口契约(确保引擎接入能干净挂上)
- 现有签名 model catalog 机制是否覆盖 MiMo/Kimi,还是要扩

## 8. Kimi Code spawn 入口核实(2026-06-22 完成)

> 全部一手来源:moonshotai.github.io/kimi-code、www.kimi.com/code/docs、github.com/MoonshotAI/{kimi-code,kimi-cli}。

| 项 | 结论 |
|---|---|
| **命令名** | 仍是 `kimi`(改名不影响命令;子命令 `kimi login` / `kimi acp`)。安装:官方脚本 / `npm i -g @kimi-ai/kimi-code`(Node≥22.19)/ `brew install kimi-code` |
| **headless 入口** | `kimi -p "<prompt>"`(=`--prompt`)。**没有 `--print`、没有 `kimi run`、prompt 不能走 stdin 管道**(必须当命令行参数);`-p` 默认 auto 权限,`--prompt` 不能与 `--yolo/--auto/--plan` 同用 |
| **结构化输出** | `--output-format stream-json`(仅配 `-p`):stdout 每行一个 JSON(JSONL),tool_calls 先于 Tool message。**适配器逐行 parse JSONL**,比解带 `•` 前缀的纯文本稳;thinking 不写进 JSONL |
| **认证/计费** | `kimi login`(RFC 8628 device-code OAuth,吃会员订阅额度)或 platform API key |
| **凭据带入(大坑)** | **不从 shell env var 读 key**(`KIMI_API_KEY`/`ANTHROPIC_API_KEY`/`OPENAI_API_KEY` 都不读)。必须:预先 `kimi login` 落盘,或为 `KIMI_CODE_HOME`(默认 `~/.kimi-code`)写 `config.toml` 的 `[providers.<name>] api_key`。**`KIMI_CODE_HOME` 可给每个子进程隔离凭据目录** |
| **stdout/stderr** | 正文走 stdout,thinking/tool 进度/"resuming session" 走 stderr —— 只读 stdout **不丢正文**(优于 antigravity 老坑) |
| **ACP** | `kimi acp`(JSON-RPC over stdio,Zed/JetBrains 同款),本轮不用,备用 |
| **已知坑** | text 模式可能缓冲(用 stream-json 规避);OpenAI-compatible 后端偶发流式完成但空响应报 `empty response`(issue #1172),需容错;**非 TTY 是否 stdout 为空「未核实到」证据 → 接入前在无 TTY 子进程实跑一次确认** |

**适配器建造结论**:对着 `kimi -p "<prompt>" --output-format stream-json` 建,逐行解 JSONL,凭据走 `kimi login` 预登录或 `KIMI_CODE_HOME`/`config.toml`(**不能传 env var**),只读 stdout 取正文,容 empty-response 错,开工前验一次无 TTY 子进程。

## 9. 实现状态(2026-06-22 完成核心 + 集成)

> 由多 agent team 推进(实现→自纠→对抗审计→修),代码在 worktree `code-agent-mimo-kimi`。

### 9.1 引擎分支 `feat/engine-mimo-kimi`(6 commit,基于 main `1c5f5b397`)
| commit | 内容 |
|---|---|
| `e6eeb2d5c` | mimoCliAdapter + kimiCliAdapter + 测试 |
| `c994323dd` | 自纠:退回 registry/catalog 改动→handoff,缩合并面 |
| `e227acbcc` | 修审计 HIGH(接通真实 web route 分发)+ M1/M2/M3 |
| `606b09d44` | registry detectMimo/detectKimi + catalog 登记 |
| `3ba138840` | 修审计 MED-1(去掉无实现的 import_sessions 能力声明) |

### 9.2 端到端链路(代码层已通)
适配器(spawn/解析/归一)→ 分发(IPC `agentAppService` + **真实 web route `web/routes/agent.ts`**)→ registry 探测(引擎在列表可选)→ catalog 降级(无签名条目不崩)。
- **Kimi**:`kimi -p --output-format stream-json`,逐行 JSONL,凭据走 `KIMI_CODE_HOME`/`config.toml`(不传 env var),只读 stdout 取正文,容 empty-response。
- **MiMo**:`mimo run --format json`,逐条解析,补了对称的空响应容错。
- **模型解析**:codex/claude 走 `resolveModelId`(strict fail-closed),mimo/kimi 不入签名 catalog 故直传 `launch.model`。

### 9.3 质量证据
- typecheck 净;agentEngine 单测 74 绿(含 JSONL 跨 chunk 截断、装/没装探测)。
- **两轮独立对抗审计**:R1 逮到真实 HIGH(选 mimo/kimi 在真机 web 路径静默跑成 native——typecheck+单测全放过)+ M1/M2/M3,已修;R2 判可合并,MED-1 已修、MED-2 记为运维项。

### 9.4 集成分支 `integration/engine-mimo-kimi`(merge `f0b9e073b`)
stability `fix/stability-batch`(4 commit:探测缓存 TTL/fail-closed/log retention/inference token) + 引擎 6 commit,**冲突已解**(registry `list()` 缓存+探测合并;web route strict+per-engine 直传共存),**typecheck 净 + 873 测全绿**。可直接合 main。备份 `backup/engine-mimo-kimi-pre-integrate`。

### 9.5 仍未做(诚实清单)
- **真机 dogfood:mimo 免费层已通,付费/kimi 受阻**(详见 §10)。
- **兼容矩阵(§5①更大那部分)+ 设置页独立「执行引擎」section 未建**:引擎现靠 registry 探测已能在 ModelSwitcher 选;那张「引擎×模型×计费模式」矩阵 + 设置页 IA 留作下一阶段。
- **MED-2 运维项**:发布远程签名 catalog 时须登记 `mimo_code`/`kimi_code`,否则 UI 模型列表空(默认 bundled 态无碍)。
- **合并 main**:待用户拍板(建议合 `integration/engine-mimo-kimi`)。

## 10. 真机 dogfood + mimo 权限修复(2026-06-22)

> CLI 已装:mimo 0.1.1(`.mimocode/bin`)、kimi 0.15.0(`.npm-global/bin`)。dogfood 在非 TTY(Bash 子进程)下跑,正好实测交互行为。

### 10.1 dogfood 抓到的真 bug:mimo 非 TTY 权限卡死(已修)
适配器 spawn `mimo run` 未传任何权限约束 → 非 TTY 下 mimo 弹交互式权限请求(如 `external_directory`)阻塞等批准 → 挂死超时。**74 单测 + 2 轮审计全放过**(mock 不出真 CLI 交互)。
- **修复 commit `12b3d4104`**(在 `integration/engine-mimo-kimi`):mimo 是 OpenCode fork,暴露 `MIMOCODE_PERMISSION` 环境变量(JSON,deep-merge 进权限配置)。新建 `src/shared/constants/mimoCode.ts` 定义只读策略(catch-all `"*":"deny"` + read/glob/grep/list/lsp `allow` + 写/执行/越权/外联全 `deny`,**任何工具不解析成 `ask`**——ask 会非 TTY 阻塞)。适配器按 read_only profile 注入,并剥离用户 shell 里的同名 env(防放宽绕过)。**不用 `--dangerously-skip-permissions`**(违反 read-only)。
- **验证**:typecheck 净 + agentEngine 75 测;真机负向对照(无策略强制写 → 复现卡死 exit 124)+ 注入后(exit 0、JSONL 到最终文本 + cost)+ 对抗(要求写文件 → write 被 deny、文件未创建、优雅继续);独立对抗审计无 HIGH(机械核验 16 工具全 allow/deny 零 ask、catch-all deny fail-closed、继承 env 被剥离)。

### 10.2 dogfood 验证结论
| 项 | 结论 |
|---|---|
| mimo 适配器端到端 | ✅ 免费 mimo-auto 真机 exit 0 + 完整 JSONL + cost,经真实只读策略 |
| mimo 付费 token-plan | ⚠️ 适配器侧全通(走到 streamText:provider/凭据/模型/权限均 OK),卡在 **xiaomi 海外端点(ams)网络可达性——Clash 代理路由问题,非适配器**(no-proxy 快速 error / with-proxy 挂起;直接用 mimo CLI 同样卡)。付费花费≈0(LLM 调用未成功) |
| Kimi 命令 + 非 TTY | ✅ 干净报错(`No model configured` → stderr,exit 1),无 stdout 空坑(未核实的坑被证伪) |
| Kimi 完整端到端 | ⏸ 用户无 Kimi 订阅,跑不了(登录即通的已知良性路径) |

### 10.3 待用户侧动作
- **xiaomi token-plan 付费路径**:需用户 Clash 配 xiaomi ams/sgp 端点可达规则(Neo 和直接用 mimo CLI 同此前提)。配好后可补跑一次付费验证。
- **Kimi 完整 dogfood**:需用户 `kimi login` + Kimi 会员订阅。

### 10.4 教训(泛化)
外部 CLI 引擎接入,**单测 mock spawn 测不出真 CLI 的非 TTY 交互行为**(权限审批/TTY 探测/网络)。新引擎必须真机 dogfood,且 OpenCode 系引擎(mimo 等)要显式注入只读权限策略,否则非 TTY 必挂。

### 10.5 付费订阅验证(2026-06-22,Singapore 跑通)
mimo token-plan 真机端到端验证:`xiaomi-token-plan-ams`(Europe)凭据 401 失效;**`xiaomi-token-plan-sgp`(Singapore)跑通**——经只读策略 + proxy + 有效订阅,模型回 "DONE",step_finish,cost=0(订阅 quota 非 PAYG)。证明适配器付费订阅路径完整可用。坑:海外端点(ams/sgp)需 Clash 路由规则可达,否则挂起;凭据按 region 区分。

## 11. 兼容矩阵 + 设置页「执行引擎」section(2026-06-22,IA 落地)

> 分支 `feat/engine-compat-matrix`(基于含引擎的 main `4bcbb14ba`),回答最初的"设置页该不该分专用模型 + IA 怎么设计"。

### 11.1 commit
| commit | 内容 |
|---|---|
| `ba4f1a23a` | Runtime×Model 兼容矩阵 + billingMode(`src/shared/constants/engineCompat.ts`):`EngineBillingMode`(subscription/api_key_payg/free_tier)+ 各引擎映射(native=按量,codex/claude/mimo/kimi=订阅)+ `getEngineModelCompat()` 判定 + reason code;ModelSwitcher 消费(计费标签 + 不可用 reason)。顺带修真 bug:renderer 旧 `isExternalEngineKind` 只认 codex/claude→mimo/kimi 被当 native catalog 列不出,改 `kind!=='native'` |
| `d1aa6792a` | 设置页独立「执行引擎」section(`AgentEngineListSection.tsx`):5 引擎卡(label + 安装状态徽标 + 计费标签 + 版本/路径 + 默认模型来源 + 登录指引/获取指引)+ [检测引擎] 按钮(invalidate+list 强制重探);与通用模型 provider 平级,**ModelSettings 主体未动**;清矩阵审计 L1/L3 |
| `fe6b6d0d8` | 修审计 LOW-1(section 加载失败退出 loading 态) |
| (CatalogI18n) | i18n 化原 AgentEngineModelCatalogSection 残留硬编码中文 |

### 11.2 IA 最终形态
设置页 = **通用模型 provider 区(稳定不动)+ 独立「执行引擎」区**。引擎区按引擎(执行内核)组织,每卡显示计费模式(内置/订阅/按量)+ 安装状态 + 版本 + 默认模型来源 + 登录指引。引擎 ⟂ 模型两层分明,计费差异一眼可见。截图 `/tmp/engine-section.png`。

### 11.3 质量
typecheck 净 · 95 测绿(矩阵 + section + ModelSwitcher,无回归)· **两轮对抗审计**(矩阵 + section)无 HIGH/MED;3 关键结论过(真机读实时 descriptor / 不破坏通用模型与默认模型选择 / i18n zh-en 对齐)。billingMode 真机读 registry.list() 实时探测,非写死。

### 11.4 待办
- 合 `feat/engine-compat-matrix` → main(待拍板)。
- 兼容矩阵当前是"引擎×模型"判定 + 计费;"借壳端点"(GLM/MiniMax/Qwen 经 Claude Code 自定义端点)那列未做,留后续。
