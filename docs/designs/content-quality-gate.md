# 内容质量门禁（Content Quality Gate）设计文档

> v1.0 — 2026-02-10

## 背景

Code Agent 在 Excel 数据处理 benchmark 中得分 151/200（第3名），短板集中在时序分析（5分）、模糊指令（8分）、迭代报表（10分）。根因：验证框架已有（codeVerifier/pptVerifier/searchVerifier/genericVerifier），但主流程 agentLoop 未接入，且缺少数据质量验证。

**行业调研结论**：没有任何主流 Agent 产品针对数据/PPT/文档等内容类型做过 post-generation 质量验证，这是差异化机会。

## 行业调研

### 5 大内容类型的 SOTA 做法

| 内容类型 | 行业现状 | 代表产品 |
|----------|---------|---------|
| 代码 | 有成熟验证（lint/typecheck/test） | Claude Code、Cursor、Copilot |
| 数据/Excel | 仅人工检查或 Great Expectations 等独立工具 | 无 Agent 集成 |
| PPT | 无验证，仅人工审查 | Claude in PowerPoint、Gamma |
| 文档 | 无结构化验证 | ChatGPT、Claude |
| 图像 | 仅格式验证，无内容质量 | Midjourney、DALL-E |

### 关键发现

1. **Great Expectations** 为数据质量验证提供了声明式验证范式（expectations → validation → feedback）
2. **Claude Code** 验证器架构（typecheck + test_pass）已被证明是提升自主代理可靠性的关键
3. **无竞品** 在 Agent 层面实现 post-generation 内容质量门禁

## 架构设计

### 两层门禁模型

```
                    ┌─────────────────────────────────┐
                    │       Content Quality Gate       │
                    │                                  │
                    │  ┌──────────────────────────┐    │
                    │  │  Tier 1: 确定性检查        │    │
                    │  │  - 文件存在、格式正确       │    │
                    │  │  - 数据完整性（空列、空行）  │    │
                    │  │  - 结构检查（标题、段落）    │    │
                    │  │  ★ 必跑，失败注入修正反馈   │    │
                    │  └──────────────────────────┘    │
                    │                                  │
                    │  ┌──────────────────────────┐    │
                    │  │  Tier 2: 概率性检查（预留） │    │
                    │  │  - LLM 评估内容质量         │    │
                    │  │  - 语义一致性检查            │    │
                    │  │  ★ 仅警告，不阻断           │    │
                    │  └──────────────────────────┘    │
                    └─────────────────────────────────┘
```

本次实现 **Tier 1** 全部检查项。Tier 2 预留扩展点。

### 路由策略

```
用户指令 → taskRouter.analyzeTask()
          → TaskType: data | ppt | document | image | code | ...
          → VerifierRegistry.findVerifier(taskAnalysis)
          → 匹配的 Verifier.verify(context)
```

新增任务类型检测规则（按优先级从低到高）：
1. `data`: excel/xlsx/csv/数据/分析/清洗/透视/聚合/统计/dataframe/pandas
2. `ppt`: ppt/pptx/幻灯片/演示/slide/presentation
3. `document`: 文章/报告/文档/撰写/write article/write report
4. `image`: 生成图/画图/image/draw/generate image

### 反馈注入

验证失败时通过 `AgentLoop.injectSystemMessage()` 注入结构化反馈：

```xml
<content-quality-warning>
输出质量检查未通过（得分: 0.40/1.0）:
- output_file_exists: Output file too small: result.xlsx (512 bytes)
- no_all_null_columns: Found 3 all-null column(s): colA, colB, colC
Fix: output_file_exists — Output file too small
Fix: no_all_null_columns — Found 3 all-null columns
请检查并修正上述问题。
</content-quality-warning>
```

最多注入 **2 次**验证反馈（避免死循环），key 为 `toolCall.name:toolCall.id`。

### 触发条件

不是每个工具调用都触发验证，仅在"内容生成完成信号"时触发：
- `write_file` 成功且文件扩展名为内容类型
- `bash` 成功且输出中包含内容类型文件路径
- `ppt_generate` 成功

## 验证器检查项

### DataVerifier（数据验证器）

借鉴 Great Expectations 声明式验证。

| # | 检查项 | Tier | 说明 |
|---|--------|------|------|
| 1 | `output_file_exists` | T1 | 输出文件存在且 >1KB |
| 2 | `file_readable` | T1 | 文件可正常解析（pandas read_excel/read_csv） |
| 3 | `no_all_null_columns` | T1 | 无全空列 |
| 4 | `row_count_sanity` | T1 | 输出行数 >0 且合理 |
| 5 | `no_empty_result_columns` | T1 | 数值列不全为 0/NaN（>50% 零列报警） |
| 6 | `output_describes_results` | T1 | Agent 输出文本描述了数据结果 |

**实现方式**：通过 `child_process.execSync` 执行 Python pandas 单行脚本验证。

### PPTVerifier（PPT 验证器）

| # | 检查项 | Tier | 说明 |
|---|--------|------|------|
| 1 | `file_created` | T1 | .pptx 文件存在且 >10KB |
| 2 | `slide_count_match` | T1 | 页数与需求匹配（±20%） |
| 3 | `content_populated` | T1 | 输出描述了幻灯片内容 |
| 4 | `theme_applied` | T1 | 主题被正确应用 |

**修复**：`canVerify` 原 bug（永远返回 false）已修复为 `taskType === 'ppt'`。

### DocumentVerifier（文档验证器）

| # | 检查项 | Tier | 说明 |
|---|--------|------|------|
| 1 | `output_not_empty` | T1 | 输出 >100 字符 |
| 2 | `no_placeholder_text` | T1 | 无 [TODO]/[待填写]/lorem ipsum |
| 3 | `has_structure` | T1 | 有标题层级/列表/段落 |
| 4 | `reasonable_length` | T1 | 长度与任务复杂度匹配 |

### ImageVerifier（图像验证器）

| # | 检查项 | Tier | 说明 |
|---|--------|------|------|
| 1 | `file_created` | T1 | 图片文件存在 |
| 2 | `file_not_empty` | T1 | 文件 >1KB |
| 3 | `file_readable` | T1 | magic bytes 匹配格式（PNG/JPEG/GIF/WebP/SVG） |

## 文件变更清单

### 修改

| 文件 | 改动 |
|------|------|
| `src/main/agent/verifier/verifierRegistry.ts` | TaskType 新增 `data \| document \| image` |
| `src/main/agent/verifier/pptVerifier.ts` | `canVerify` bug 修复 |
| `src/main/agent/verifier/index.ts` | 注册 3 个新验证器 |
| `src/main/agent/hybrid/taskRouter.ts` | 新增 4 个任务类型检测规则 |
| `src/main/agent/agentLoop.ts` | E7 内容质量门禁集成 |

### 新增

| 文件 | 行数 | 功能 |
|------|------|------|
| `src/main/agent/verifier/dataVerifier.ts` | ~290 | 数据验证器 |
| `src/main/agent/verifier/documentVerifier.ts` | ~160 | 文档验证器 |
| `src/main/agent/verifier/imageVerifier.ts` | ~200 | 图像验证器 |
| `docs/designs/content-quality-gate.md` | ~170 | 本设计文档 |

## 参考

- [Great Expectations](https://greatexpectations.io/) — 声明式数据质量验证
- [Anthropic: Building a C compiler with parallel Claudes](https://www.anthropic.com/engineering) — 验证器决定自主代理可靠性
- [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code) — typecheck + test_pass 验证模式
