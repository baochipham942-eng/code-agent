// Schema-only file (P0-7 方案 A — single source of truth)
// ppt_edit — legacy 9 action 编辑器，inputSchema 与字段需 1:1 复刻 legacy
import type { ToolSchema } from '../../../protocol/tools';

export const pptEditSchema: ToolSchema = {
  name: 'ppt_edit',
  description: `编辑已有的 PPTX 文件。

**8 种操作：**
- replace_title: 替换指定页的标题
- replace_content: 替换指定页的正文内容
- replace_slide: 用新内容替换整张幻灯片
- delete_slide: 删除指定页
- insert_slide: 在指定位置插入新页（建议用 /ppt 重新生成）
- extract_style: 提取 PPTX 的主题样式
- reorder_slides: 调整幻灯片顺序（order: [2,0,1,3]）
- update_notes: 更新指定页的演讲者备注
- analyze: 分析 PPTX 结构（slide 数量/布局/主题色/字体/内容摘要）

每次编辑前自动创建快照（可回滚）。`,
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: '要编辑的 PPTX 文件路径',
      },
      action: {
        type: 'string',
        enum: ['replace_title', 'replace_content', 'replace_slide', 'delete_slide', 'insert_slide', 'extract_style', 'reorder_slides', 'update_notes', 'analyze'],
        description: '编辑操作类型',
      },
      slide_index: {
        type: 'number',
        description: '目标幻灯片索引（从 0 开始）',
      },
      content: {
        type: 'string',
        description: '替换的文本内容',
      },
      title: {
        type: 'string',
        description: '新标题（用于 replace_title 和 insert_slide）',
      },
      points: {
        type: 'array',
        items: { type: 'string' },
        description: '要点列表（用于 replace_content、replace_slide、insert_slide）',
      },
      order: {
        type: 'array',
        items: { type: 'number' },
        description: '幻灯片新顺序（用于 reorder_slides，如 [2,0,1,3]）',
      },
      notes: {
        type: 'string',
        description: '演讲者备注文本（用于 update_notes）',
      },
    },
    required: ['file_path', 'action'],
  },
  category: 'network',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
};
