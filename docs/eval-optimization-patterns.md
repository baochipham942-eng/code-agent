# 评测优化模式总结

> 来源：v0.16.31 Excel 评测优化（Case 1/7/10），可扩展到其他场景

## 模式 1：Provider 瞬态重试泛化

### 已实现
`moonshot.ts` 重试条件：`socket hang up | ECONNRESET | ECONNREFUSED | 流式响应无内容 | 503`

### 可扩展
- **zhipu.ts**: 智谱 429 限流已有退避，但缺少 503/ECONNRESET 重试
- **deepseek.ts**: 无瞬态重试逻辑
- **统一方案**: 将重试逻辑提取到 `sseStream.ts` 或独立的 `retryStrategy.ts`，所有 provider 共享

### 参考实现
```typescript
// sseStream.ts 或新文件 retryStrategy.ts
const TRANSIENT_PATTERNS = [
  'socket hang up', 'ECONNRESET', 'ECONNREFUSED',
  'ETIMEDOUT', 'EPIPE', '流式响应无内容',
  '502', '503', '504', '429',
];

export function isTransientError(msg: string): boolean {
  return TRANSIENT_PATTERNS.some(p => msg.includes(p));
}
```

---

## 模式 2：文件扩展名检测泛化

### 已实现
`systemReminders.ts` 中 `extractFileExtensions()` 从 prompt 提取文件扩展名，`.xlsx/.csv` 触发 DATA_PROCESSING 提示词。

### 可扩展

| 扩展名 | 触发提示词 | 当前状态 |
|--------|-----------|---------|
| `.xlsx/.xls/.csv/.tsv/.parquet` | DATA_PROCESSING | ✅ 已实现 |
| `.pptx/.ppt` | PPT_GENERATION | ⬜ 待实现（当前用关键词） |
| `.docx/.doc/.pdf` | DOCUMENT_TASK | ⬜ 待实现（当前用关键词） |
| `.png/.jpg/.svg/.gif` | IMAGE_TASK | ⬜ 待实现（当前用关键词） |
| `.py/.ts/.js/.go` | CODE_REVIEW（若含"看看/检查"） | ⬜ 可探索 |

### 实现思路
在 `detectTaskFeatures()` 中复用 `extractFileExtensions()` + `allExtensions`：
```typescript
const PPT_FILE_EXTENSIONS = ['.pptx', '.ppt'];
const DOC_FILE_EXTENSIONS = ['.docx', '.doc', '.pdf'];
const IMAGE_FILE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.svg', '.gif'];

isPPTTask: allExtensions.some(ext => PPT_FILE_EXTENSIONS.includes(ext)) || pptKeywords.some(...),
isDocumentTask: allExtensions.some(ext => DOC_FILE_EXTENSIONS.includes(ext)) || documentKeywords.some(...),
isImageTask: allExtensions.some(ext => IMAGE_FILE_EXTENSIONS.includes(ext)) || imageKeywords.some(...),
```

### 优势
- 比关键词更客观（"帮我看看这个文件" + `.pptx` 附件 → 自动触发 PPT 提示词）
- Electron 附件场景：`getSystemReminders(prompt, fileExtensions)` 第二参数传入附件扩展名

---

## 模式 3：模糊指令诊断泛化

### 已实现
DATA_PROCESSING 提示词中加了"模糊指令处理"策略：先诊断 → 出报告 → 再一次性处理。

### 可扩展场景

#### 3a. 代码审查/排查
用户说"看看这代码有啥问题"/"帮我检查一下"时：
```
**代码审查诊断流程**：
1. 读取全部相关代码文件
2. 分类检查：语法错误、逻辑错误、安全漏洞、性能问题、代码风格
3. 输出问题清单（按严重程度排序）
4. 对每个问题给出修复建议
5. 如果用户要求修复，一次性修复所有问题
```

#### 3b. 系统排查
用户说"服务器有问题"/"接口报错了"时：
```
**系统排查诊断流程**：
1. 收集症状信息（错误日志、状态码、时间线）
2. 分析可能原因（按概率排序）
3. 逐一验证假设
4. 输出根因分析报告
5. 提供修复方案
```

#### 3c. 数据分析（已实现）
用户说"整理整理"/"看看有啥问题"时：诊断 → 报告 → 清洗

### 统一模式
```
模糊指令 → 检测模糊词（整理/看看/检查/排查） → 注入"诊断先行"提示 → 模型先分析再行动
```

关键：**不用关键词做路由**（之前被否决），用文件类型做路由；**用关键词做行为引导**（在已确定的提示词内部引导"先诊断再行动"）。

---

## 实施优先级

| 改动 | 文件 | 预期效果 | 工作量 |
|------|------|---------|--------|
| P0: 重试逻辑统一 | `sseStream.ts` 或新文件 | 所有 provider 抗干扰 | ~30 行 |
| P1: 扩展名检测覆盖 PPT/文档/图像 | `systemReminders.ts` | 附件场景全覆盖 | ~10 行 |
| P2: 代码审查诊断提示 | `systemReminders.ts` | 代码审查质量提升 | ~15 行 |
| P3: 系统排查诊断提示 | `systemReminders.ts` | 排查类任务质量提升 | ~15 行 |
