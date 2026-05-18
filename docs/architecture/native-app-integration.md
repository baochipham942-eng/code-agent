# Native App 集成架构

> 关键问题：模型 / 工具 / Skill / Service / Connector / MCP 这些元素之间的关系是什么？为什么 Photos.app 这种本机应用走 Connector 而不走 MCP？

本文澄清 code-agent 项目中 6 种能力扩展元素的边界、定位、以及调用链路真实形态。

---

## 6 种元素一表看清

| 元素 | 是什么 | 谁能看见 | 进程关系 | 适合场景 |
|------|--------|----------|---------|----------|
| **Agent (LLM)** | 模型本身。识别意图，决定下一步动作 | 不适用 | 不适用 | — |
| **Skill** | 给模型看的**指南**（不是执行者）。`.md` frontmatter + prompt，描述场景、步骤、用哪些工具 | 模型（注入 system prompt） | 进程内（编译进 binary 或读 `.code-agent/skills/`） | "教模型怎么干一类活" |
| **Tool** | 模型可调用的**统一接口**：schema 给模型看、handler 是执行体 | 模型看 schema | 进程内 | 单步原子能力 |
| **Service** | 工程层**业务编排**：一个 service 内可调多个 connector / binary / MCP / DB | 模型看不到，tool / IPC 间接调 | 进程内 | 多步流程串联 |
| **Connector** | 包装**本机原生应用**的统一抽象，含 status / actions / lifecycle | 模型看不到，service / tool 内部用 | 进程内（调 AppleScript / native binding） | macOS 系统应用硬集成 |
| **MCP server** | 接入**外部能力**的标准协议 server（stdio / SSE） | 模型可调（MCP tool 自动注册进 tool registry） | 进程外（子进程或远程） | 可移植 / 跨平台能力扩展 |

**关键区分**：
- Skill ≠ Tool — Skill 是指南，Tool 是接口
- Connector ≠ MCP — 两条独立路径，互不依赖
- Service 是工程层编排，模型不直接感知

---

## 真实调用链路

以"用户说 '整理我的相册'" 为例：

```
1. 用户输入
   │
   ▼
2. Agent Loop (LLM)
   - skillDiscoveryService 把 photo-archive skill 的 prompt 注入 system prompt
   - 模型看到 tools 列表（含 photo_archive、bash、osascript-style 等）
   - 模型决定调 photo_archive 工具
   │
   ▼
3. Tool Registry / Executor
   - 路由到 photoArchiveModule.createHandler()
   - 调 handler.execute({ album, mode })
   │
   ▼
4. photoArchive tool handler
   - 参数校验 + 调 service
   │
   ▼
5. photoLibraryTagger service (archiveAlbum)
   - 编排多个底层调用：
   │
   ├─→ photos connector.execute('export_photos')
   │      └─→ runAppleScript() → osascript → Photos.app 导出到 /tmp/photo-archive-*
   │
   ├─→ 逐张 spawn vision-tagger binary
   │      └─→ macOS Vision Framework (VNDetectFaceRectangles + VNGenerateImageFeaturePrint + VNClassifyImageRequest)
   │
   ├─→ cosineSimilarity + 并查集聚类（纯 TS 计算）
   │
   └─→ db.createMemory(type='photo_archive') × N
   │
   ▼
6. 返回 { processed, faceCount, clusters[], topThemes[], memoryIds[] }
```

**模型只看到 step 2 和 step 6**——它不知道 Service / Connector / binary 的存在，只知道"调 photo_archive 工具，拿到结构化结果"。所有内部编排对模型透明。

---

## 为什么 Photos.app 走 Connector 不走 MCP？

### MCP 适合：跨平台 / 可移植 / 进程外能力

例子：
- `mcp__feishu__send_message`（飞书在 macOS/Windows/Linux 都能用）
- `mcp__github__create_pull_request`（远程 API，平台无关）
- `mcp__obsidian__write_note`（vault 文件可以在任意 OS）

特点：
- 走 stdio / SSE 协议跨进程通信
- 第三方写 MCP server，咱们做 MCP client
- LLM 可以认它是"标准化的外部 tool"

### Connector 适合：绑死 macOS / 状态管理紧密 / 性能要求

例子：
- `calendar`（macOS Calendar.app via AppleScript）
- `mail`（macOS Mail.app via AppleScript）
- `reminders`（macOS Reminders.app via AppleScript）
- `photos`（macOS Photos.app via AppleScript）

特点：
- 进程内调用，无 IPC 开销
- 统一 lifecycle（`unchecked → ready / failed / unavailable`），处理 macOS 首次访问授权弹窗
- 跟 `mail/calendar/reminders` 共享 osascript wrapper、Connector 抽象、错误归一化

### 具体对比：相册导出走两条路的差异

|  | 走 MCP server | 走 Connector |
|---|---|---|
| 跨平台 | ✅ 理论上可移植 | ❌ macOS only |
| 性能 | 中（stdio 序列化开销） | **高（进程内调用）** |
| 授权状态管理 | 弱（每次启动重新探测） | **强（readiness 状态机缓存）** |
| 失败处理 | 协议错误码 | macOS 特定错误码（如 -1743 未授权） |
| 开发复杂度 | 需写独立进程 + 协议适配 | **直接 TS 函数** |
| 维护 | 跟 mail/calendar/reminders 不共享 | **共享 osascript 抽象** |

**结论**：Photos.app 是 macOS 独有能力，走 connector 是综合最优。如果未来要做 Linux 版相册集成，那时候才考虑 MCP——前提是存在跨平台的 photo server 标准。

---

## Skill 的角色边界

Skill **不是工具调用链路的一环**，它是**给模型的指南**。Skill discovery service 在会话启动时把匹配的 skill prompt 注入到 system prompt 里，引导模型：
- 这类场景大概要几步
- 应该按什么顺序调哪些工具
- 有什么注意事项 / 隐私边界 / 错误处理建议

举例 `photo-archive` skill 的内容（节选）：

```markdown
## 推荐路径（首选）：用 photo_archive tool 一站式调用

photo_archive {
  "album": "<相册名>",
  "mode": "all"
}

返回 { processed, faceCount, clusters[], topThemes[], memoryIds[] }

## 备用路径：手动编排（仅在 photo_archive tool 不可用时）

[osascript / vision-tagger / bash 编排步骤]
```

Skill 引导模型**优先选 high-level 的工具**（`photo_archive`），同时提供**降级路径**（手动 osascript + bash 编排）。Skill 不执行任何代码——它只是模型的 prompt 上下文。

### Skill 三种存储位置

1. **Builtin** — 编译进 binary，所有用户开箱即用（`src/main/services/skills/builtinSkills.ts:BUILTIN_SKILLS`）
2. **User-level** — `~/.code-agent/skills/<name>/SKILL.md`，跨项目共享
3. **Project-level** — `<workspace>/.code-agent/skills/<name>/SKILL.md`，项目独享

发现顺序：user → project（按需 scan + 缓存）。Builtin 在启动时一次性注册。

---

## Service 层的设计原则

Service（如 `photoLibraryTagger`）的存在理由：

1. **多步流程封装** — 把"导出 → vision-tagger → 聚类 → 入库 → 清理"打包成单次调用
2. **错误恢复 / 部分失败** — 单张照片处理失败不阻塞整体，记入 `failed` 计数
3. **资源管理** — 临时目录创建/清理、abort signal 传播、CPU/内存节流
4. **共用底层抽象** — 复用 connector / memory repo / binary lookup helper

Service **不直接暴露给模型**（模型不知道有 `archiveAlbum` 函数）；agent 通过 wrapper tool（如 `photo_archive`）间接调用。

### 何时拆 Service vs 直接在 Tool handler 里写？

- 单步操作（如 OCR 一张图）→ 直接在 tool handler 里写（参考 `ocrSearch.ts`）
- 多步编排（如相册批量归档）→ 拆 service（参考 `photoLibraryTagger.ts`）
- Service 能被多个 tool / IPC / UI 共用 → 必然要拆

---

## 何时该选哪种扩展方式

| 需求 | 推荐扩展方式 |
|------|------|
| 用户问"什么时候做 X" → 想引导模型按特定步骤干 | **加 Skill**（不写代码，写 prompt） |
| 模型需要新的原子操作（如 OCR / 截屏 / 文件读） | **加 Tool**（schema + handler） |
| 多步业务流程要打包（如相册归档、PPT 生成） | **加 Service** + 包装 tool |
| 接入 macOS 系统应用（Calendar / Mail / Photos） | **加 Connector** |
| 接入第三方 API（飞书 / GitHub / Obsidian） | **接现成 MCP server** 或 **写新 MCP server** |
| 接入特定文件格式或 CLI 工具（如 jq、ffmpeg）| **直接在 tool 里 spawn binary**，可选加 service 包装 |

---

## 当前所有 Connector 一览

| Connector ID | Native App | Actions |
|---|---|---|
| `calendar` | macOS Calendar.app | get_status, list_calendars, list_events, create_event, update_event, delete_event |
| `mail` | macOS Mail.app | get_status, list_messages, search, send, draft |
| `reminders` | macOS Reminders.app | get_status, list, create, update, delete |
| `photos` | macOS Photos.app | get_status, probe_access, repair_permissions, list_albums, list_photos, export_photos |

注册在 `src/main/connectors/registry.ts:NATIVE_FACTORIES`。统一 base 类型见 `src/main/connectors/base.ts`。

---

## 当前所有 Native Swift Binary 一览

| Binary | 作用 | 框架 | 体积 |
|---|---|---|---|
| `system-audio-capture` | 系统音频采集（ScreenCaptureKit） | ScreenCaptureKit + AVFoundation + CoreMedia | ~120KB |
| `vision-ocr` | 中英文 OCR（VNRecognizeTextRequest） | Vision + AppKit | 95KB |
| `vision-tagger` | 人脸检测 + 特征向量 + 主题分类 | Vision + AppKit | 116KB |

共享 build 流程：`scripts/build-*.sh` 检查 swiftc → 增量编译 → chmod +x；产物加入 `src-tauri/tauri.conf.json:bundle.resources` 自动打包进 DMG。

---

## 速查表：调用链路速记

| "我想让 agent 干 X"，X 是什么类型？ | 经过的元素 |
|------|------|
| 写一段代码 | Agent → Tool(`edit_file`) |
| 整理一个相册 | Agent ← Skill(`photo-archive`) → Tool(`photo_archive`) → Service(`photoLibraryTagger`) → Connector(`photos`) + Binary(`vision-tagger`) → DB |
| 发飞书消息 | Agent → MCP tool(`mcp__feishu__send_message`) → MCP server → 飞书 OpenAPI |
| 用户主 LLM 看图说话 | Agent → Tool(`image_analyze`) → Service(`visionAnalysisService`) → ModelRouter.inferenceWithVision → 用户主 LLM provider |
| OCR 一张截图 | Agent ← Skill(`image-ocr-search`) → Tool(`ocr_search`) → Binary(`vision-ocr`) → DB(memories) |
