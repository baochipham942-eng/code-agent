// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const academicSearchSchema: ToolSchema = {
  name: 'academic_search',
  description: `搜索学术论文和研究文献。

支持多个学术数据源：
- arXiv (默认): 预印本论文，涵盖物理、数学、计算机科学等
- Semantic Scholar: 广泛的学术数据库

**使用示例：**
\`\`\`
academic_search { "query": "transformer attention mechanism" }
academic_search { "query": "大语言模型", "limit": 10, "source": "arxiv" }
\`\`\`

**返回信息**：
- 论文标题
- 作者列表
- 发表日期
- 引用数（如有）
- 摘要
- PDF 链接（如有）`,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '搜索关键词或论文主题',
      },
      limit: {
        type: 'number',
        description: '返回结果数量（默认: 10，最大: 30）',
      },
      source: {
        type: 'string',
        enum: ['arxiv', 'all'],
        description: '数据源: arxiv（仅 arXiv）或 all（多源）',
      },
      sort_by: {
        type: 'string',
        enum: ['relevance', 'date'],
        description: '排序方式: relevance（相关度）或 date（日期）',
      },
      year_from: {
        type: 'number',
        description: '起始年份（可选）',
      },
      year_to: {
        type: 'number',
        description: '结束年份（可选）',
      },
    },
    required: ['query'],
  },
  category: 'network',
  permissionLevel: 'network',
  readOnly: true,
  allowInPlanMode: true,
};
