# Telemetry 可诊断性增强实施方案

> 目标:把 Agent Neo 的迭代从"打补丁"升级为"按版本归因 + 现场可复现"。
> 现状结论:可观测性骨架已完备(Langfuse + 自有 span telemetry + 本地 SQLite turn 回溯),**缺的不是系统,是版本链和内容级 trace 的回流通道**。
> 日期:2026-06-08

---

## 0. 背景与根因

当前可观测性能回答"agent 做了什么 + 用了多少 token + 为什么失败(框架级)",但**无法脱离用户机器复现一条完整轨迹**。三个结构性缺口导致"别人出问题查不出":

| # | 缺口 | 现状 | 后果 |
|---|------|------|------|
| 1 | **版本链缺失** | 只存 `systemPromptHash`(SHA-256),无 `agentVersion`/`promptVersion`,hash 反查不到内容 | 用户报障不知其跑的哪版逻辑,改完无法确认是否对症 → 每次像打补丁 |
| 2 | **内容级 trace 不回流** | prompt/completion/工具参数默认脱敏,仅 👎 时随 feedback 上传;且要求"先复现" | 偶发 bug 录不到现场;能看到"调了 Edit 失败",看不到"old_string 传了什么" |
| 3 | **Langfuse 可选未强制** | 需用户自配 `langfuse_public/secret`,不配则跳过云端链路 | 大部分用户的 run 云端不可见 |

对应三项改造:**P1 版本登记表 / P2 本地全量录+触发上报 / P3 Langfuse 默认开**。

---

## P1 — Prompt/Agent 版本登记表(最高 ROI,先做)

### 目标
让每一条 trace 都带 `agentVersion + promptVersion`,并能从版本号反查到当时的 prompt 全文。把"hash 黑盒"变成"版本可追溯"。

### 设计
1. **版本登记表(构建期生成,随包发布)**
   - 在 build 流程里扫描所有 system prompt 模板,对每个内容算 hash,生成 `prompt-registry.json`:
     ```jsonc
     {
       "registryVersion": 1,
       "entries": [
         { "promptVersion": "sys-v42", "hash": "<sha256>", "role": "main-system",
           "snapshot": "<完整 prompt 文本>", "createdAt": "2026-06-08" }
       ]
     }
     ```
   - 该文件随版本入库(可上传 Supabase),供后台按 `promptVersion` / `hash` 反查全文。
2. **运行期打标**
   - `conversationRuntime.ts` 起 trace 时,除现有 `systemPromptHash` 外,补:
     - `agentVersion`:取自 app version / 内部 agent 迭代号
     - `promptVersion`:用当前 systemPromptHash 在 registry 里查到的版本号(查不到则 `unknown:<hash前8位>`)
     - `toolSchemaVersion`:工具集 schema 的内容 hash → 版本号(同机制)
   - 这三个字段进 Langfuse trace 的 metadata + 本地 SQLite session 表 + PostHog 事件公共属性。

### 改动点
- 新增 build 脚本:`scripts/gen-prompt-registry.ts`
- `src/main/telemetry/telemetryCollector.ts`:session schema 加 `agentVersion/promptVersion/toolSchemaVersion`
- `src/main/telemetry/telemetryStorage.ts`:SQLite session 表加列 + migration(schemaVersion bump)
- `src/main/agent/runtime/conversationRuntime.ts`:startTrace 时填充三字段
- `src/main/services/infra/langfuseService.ts`:trace metadata 透传三字段

### 验收
- [ ] 任意一条云端/本地 trace 都能看到 `promptVersion`
- [ ] 给定 `promptVersion`,后台能取回当时 system prompt 全文
- [ ] 可按 `promptVersion × errorType` 聚合失败率

### P1 实现记录(2026-06-08 已落地,typecheck 通过)

**设计变更**:调研发现运行时 system prompt 是逐块**动态拼装**(completion notifications / persistent context / artifact repair 等),其 hash 每次不同,**build 期扫静态文件做 registry 匹配不上运行时 hash**。故砍掉原计划的 `gen-prompt-registry.ts` 脚本和 registry 表(避免过度工程),改为:

| 字段 | 实现方式 |
|------|---------|
| `agentVersion` | 复用 `getAppVersion()`(= package.json version),自动 |
| `promptVersion` | `src/shared/constants/agent.ts` 的 `PROMPT_VERSION` 常量(人读粗标签,改提示词时手动 bump) |
| `toolSchemaVersion` | 运行时对 protocol registry 排序后 schema 关键字段算 SHA-256 前 12 位,自动确定性,进程内 memoize |
| 精确复现 | 仍靠 turn 级 `systemPromptHash` + `system_prompt_cache`(全文已本地存),三字段只解决"哪个版本"归因 |

**改动文件**:
- `src/shared/constants/agent.ts` — 新增 `PROMPT_VERSION`
- `src/main/telemetry/diagnosticVersions.ts` — **新增** helper(`getAgentVersion/getPromptVersion/getToolSchemaVersion/getDiagnosticVersions`)
- `src/shared/contract/telemetry.ts` — `TelemetrySession` 加 3 个可选字段
- `src/main/services/core/database/schema.ts` — `telemetry_sessions` CREATE TABLE 加 3 列(新库)
- `src/main/services/core/database/migrations.ts` — 加 3 条 `safeExec ALTER`(存量库)
- `src/main/telemetry/telemetryStorage.ts` — insertSession / rowToSession / updateSession fieldMap
- `src/main/telemetry/telemetryCollector.ts` — `SessionConfig` 加字段 + `startSession` 用 helper 兜底填充
- `src/main/services/infra/langfuseService.ts` — `TraceMetadata` + startTrace metadata 透传
- `src/main/agent/runtime/conversationRuntime.ts` — startTrace 调用 `...getDiagnosticVersions()`

**云端可见性走 Langfuse metadata**(接受任意字段)。**Supabase `telemetry_sessions` 上传 payload 暂不动** —— 加云端表没有的列会让 insert 报 `column does not exist` 把上传搞挂。待后台给 Supabase 表加 `agent_version/prompt_version/tool_schema_version` 列后,再在 `telemetryUploaderService.ts:toSessionRow` 补字段。

**bump promptVersion 工作流**:改任何 prompt 静态模块后,把 `PROMPT_VERSION` 从 `sys-v1` 递增(`sys-v2`...)。后续可在 dream/health 流程加一条提醒,或做成 pre-commit 检查 prompt 目录有改动时强制 bump。

---

## P2 — 本地全量录制 + 触发式上报

### 核心原则
**录制默认且无感(本地全量),用户的动作不是"开启录制"而是"同意上报已录好的现场"。** 杜绝"先开开关再复现"——偶发 bug 无法复现,事后开关录不到现场。

### 设计

**① 本地全量(已具备一半)**
- `telemetryStorage.ts` 的 SQLite 已存 turn/modelCall/toolCall,`TelemetryModelCall` 已有 prompt/completion 字段。
- 改动:确保本地落库时**不脱敏、存全量**(prompt/completion 全文、工具 arguments/result 全文),本地数据库加密。
- 加**滚动留存**:仅保留最近 N 轮(如 50 turn / 7 天),自动淘汰,控制磁盘。

**② 触发上报(两条路,均无需预先开关)**
- **自动触发**:命中失败信号时,自动把对应 trace 打包成"诊断包"暂存,并轻提示:
  - 触发条件:`errorCategory != null`(21 类)/ `circuitBreakerTripped` / `outcome=failure` / 用户 👎
  - UI:非阻断的轻提示"检测到一次异常,是否上报帮助修复?[上报] [忽略]"
- **手动触发**:会话区常驻"上报这个问题"入口,用户随时把当前/最近一次 run 打包。

**③ 上报时脱敏 + 知情同意**
- 打包→上传前跑脱敏管线(复用现有 `sanitizeBrowserComputerTool*` + 扩展通用密钥/token/PII 规则)。
- **本地原文不动,只脱敏上传副本。**
- 上传前给用户**可预览**将要发送的内容(至少给摘要 + 可展开全文)。
- 诊断包内容:P1 三个版本字段 + 环境指纹(OS/Node/cwd hash/git 状态)+ 完整 span 树 + 脱敏后的 prompt/completion/工具入出参。

### 改动点
- `src/main/telemetry/telemetryStorage.ts`:本地全量落库 + 加密 + 滚动淘汰策略
- 新增 `src/main/telemetry/diagnosticBundleService.ts`:打包 trace→诊断包、脱敏、暂存
- `src/main/telemetry/telemetryUploaderService.ts`:新增诊断包上传通道
- 失败信号 hook(runtime 内已有 errorCategory/circuitBreaker 判定点):接自动触发
- Renderer:轻提示组件 + "上报这个问题"入口 + 上传前预览弹窗

### 隐私边界(必须守住)
- 本地全量、上传脱敏、上传前可预览、用户显式同意。
- 默认**不自动外传内容**,只在用户点"上报"后发送。

### 验收
- [ ] 不做任何设置,本地能查到最近一次 run 的完整 prompt/completion/工具入出参
- [ ] 一次失败 run 后,用户一键即可上报,无需复现
- [ ] 上报内容经过脱敏且用户可预览
- [ ] 诊断包能在后台还原出完整轨迹(版本+环境+span+内容)

---

## P3 — Langfuse 默认启用

### 目标
用项目自有 key 默认开启云端链路,覆盖全部用户(而非只覆盖手动配 key 的人)。

### 设计
- 内置项目级 `langfuse_public`(走配置下发,不硬编码 secret;敏感部分走服务端代理或受控注入)。
- 默认开启 **metadata 级**上报(token/工具名/错误码/版本字段/span 结构)——不含内容,隐私安全。
- **内容级**上报仍只走 P2 的触发式诊断包,不随 Langfuse 默认链路外传。
- 用户可在设置里关闭遥测(opt-out)。

### 改动点
- `src/main/app/initBackgroundServices.ts`:无用户 key 时回退到项目默认 key,默认初始化
- 设置项:遥测开关(默认开)+ 文案说明上报范围
- 确认 Langfuse 默认链路**只传 metadata**,内容字段不进默认 generation input/output

### 验收
- [ ] 全新安装、用户未配 key,云端也能看到该用户的 trace(metadata 级)
- [ ] 默认链路不含 prompt/completion 全文
- [ ] 用户可一键关闭

---

## 实施顺序与优先级

| 阶段 | 内容 | 理由 |
|------|------|------|
| **第一步** | P1 版本登记表 | 改动小、风险低、立刻让"按版本归因"成立,直接打掉"打补丁"根因 |
| **第二步** | P2 本地全量 + 触发上报 | 解决偶发 bug 现场可复现,收益最大但工作量也最大 |
| **第三步** | P3 Langfuse 默认开 | 扩大覆盖面,让前两步的数据真正回流 |

## 上线后能力对照

| 能力 | 现在 | 落地后 |
|------|------|--------|
| 知道用户跑的哪版 prompt/agent | ❌ 只有 hash | ✅ 版本号可反查全文 |
| 偶发 bug 抓现场 | ❌ 需复现 | ✅ 本地已录,一键上报 |
| 看到工具入参/返回值 | ❌ 默认脱敏 | ✅ 诊断包内可见(脱敏后) |
| 按"版本×错误类型"看分布 | ❌ | ✅ 从打补丁→看分布定位 |
| 云端覆盖率 | ⚠️ 仅配 key 用户 | ✅ 默认全量(metadata) |

---

## 决策记录(2026-06-08 已定)

1. **本地全量留存窗口**:三重封顶,谁先到谁先淘汰 —— 最近 **100 turn / 14 天 / 单库 500MB**;单条 result 超 **256KB** 截断存储 + 记原始长度。均设为配置项,按实际占用再调。
2. **触发上报形态**:**现阶段静默自动上传**(dogfood 期,担心漏抓问题,不依赖用户点击)。
   - ⚠️ **底线**:静默也必须先跑密钥/token/PII 脱敏再上传,绝不外传原始 secret。
   - ⚠️ **推广前必须改回"知情同意 + 内联轻提示"**,不能带着静默全量上传上线。此条列为发布 gate。
3. **合规弹窗**:现阶段不弹。P3 简化为"默认开 metadata 级遥测 + 设置里一个关闭开关",首启同意流程**推广前补做**。
4. **版本快照存哪**:registry 拆两半 —— **客户端只带 `hash → promptVersion` 映射**(不含全文,避免 prompt 泄露到用户端);**全文 `snapshot` 只存后台**(Supabase/内部库),后台用 promptVersion 反查全文。
