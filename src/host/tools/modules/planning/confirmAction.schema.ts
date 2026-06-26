// Schema-only file (P1 Wave 3 — planning native migration)
//
// IMPORTANT: This schema is read by both the LLM (via inputSchema) and renderer
// (via IPC channel CONFIRM_ACTION_ASK). Keep field names / required aligned
// with the legacy renderer expectations.
import type { ToolSchema } from '../../../protocol/tools';

export const confirmActionSchema: ToolSchema = {
  name: 'confirm_action',
  description: `Show a confirmation dialog to the user before executing a dangerous or irreversible action.

USE THIS TOOL when:
- Deleting files or directories
- Modifying system settings
- Executing potentially destructive commands
- Any action that cannot be easily undone

The dialog will display:
- A title describing the action
- A detailed message explaining what will happen
- Action type (danger, warning, info)
- Confirm and Cancel buttons

Returns: "confirmed" if user clicked confirm, "cancelled" if user clicked cancel or closed the dialog.

Example:
  confirm_action({
    title: "删除文件",
    message: "确定要删除以下 5 个文件吗？\\n\\n- file1.txt\\n- file2.txt\\n...",
    type: "danger",
    confirmText: "删除",
    cancelText: "取消"
  })`,
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Dialog title (e.g., "删除文件", "执行命令")',
      },
      message: {
        type: 'string',
        description: 'Detailed message explaining the action and its consequences',
      },
      type: {
        type: 'string',
        enum: ['danger', 'warning', 'info'],
        description: 'Action type: "danger" for destructive actions (red), "warning" for caution (yellow), "info" for informational (blue)',
      },
      confirmText: {
        type: 'string',
        description: 'Text for the confirm button (default: "确认")',
      },
      cancelText: {
        type: 'string',
        description: 'Text for the cancel button (default: "取消")',
      },
    },
    required: ['title', 'message'],
  },
  category: 'planning',
  permissionLevel: 'execute',
};
