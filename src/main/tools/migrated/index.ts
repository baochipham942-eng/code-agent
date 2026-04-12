// ============================================================================
// Migrated Tools Registry
//
// 注册所有从 legacy 迁移到 ToolModule 形态的工具到 protocol registry。
// 在 protocolRegistry 单例创建时与 registerPocTools 一起调用。
//
// 全量迁完后，这个文件会被替换为生产 registry 入口，删 legacy。
// ============================================================================

import type { ToolRegistry } from '../registry';
import type { ToolSchema } from '../../protocol/tools';

export function registerMigratedTools(registry: ToolRegistry): void {
  // ── file/ batch 1 ─────────────────────────────────────────────────────
  registry.register(
    {
      name: 'ListDirectory',
      description: 'List directory contents as a tree structure.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          recursive: { type: 'boolean' },
          max_depth: { type: 'number' },
        },
        required: [],
      },
      category: 'fs',
      permissionLevel: 'read',
      readOnly: true,
      allowInPlanMode: true,
    },
    async () => (await import('./file/listDirectory')).listDirectoryModule,
  );

  // multiEdit registers as 'Edit' (legacy 同名)
  registry.register(
    {
      name: 'Edit',
      description: 'Apply multiple text replacements to a file in one operation.',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          edits: { type: 'array' },
          force: { type: 'boolean' },
        },
        required: ['file_path', 'edits'],
      } as ToolSchema['inputSchema'],
      category: 'fs',
      permissionLevel: 'write',
      readOnly: false,
      allowInPlanMode: false,
    },
    async () => (await import('./file/multiEdit')).editModule,
  );

  registry.register(
    {
      name: 'notebook_edit',
      description: 'Edit Jupyter Notebook cells (replace/insert/delete).',
      inputSchema: {
        type: 'object',
        properties: {
          notebook_path: { type: 'string' },
          cell_id: { type: 'string' },
          new_source: { type: 'string' },
          cell_type: { type: 'string' },
          edit_mode: { type: 'string' },
        },
        required: ['notebook_path', 'new_source'],
      },
      category: 'fs',
      permissionLevel: 'write',
      readOnly: false,
      allowInPlanMode: false,
    },
    async () => (await import('./file/notebookEdit')).notebookEditModule,
  );

  registry.register(
    {
      name: 'read_clipboard',
      description: 'Read the contents of the system clipboard.',
      inputSchema: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['text', 'image', 'auto'] },
        },
        required: [],
      },
      category: 'fs',
      permissionLevel: 'read',
      readOnly: true,
      allowInPlanMode: true,
    },
    async () => (await import('./file/readClipboard')).readClipboardModule,
  );

  // ── shell/ batch 2a ───────────────────────────────────────────────────
  registry.register(
    {
      name: 'kill_shell',
      description: 'Kill a running background bash shell by its task_id.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
        },
        required: ['task_id'],
      },
      category: 'shell',
      permissionLevel: 'execute',
      readOnly: false,
      allowInPlanMode: false,
    },
    async () => (await import('./shell/killShell')).killShellModule,
  );

  registry.register(
    {
      name: 'task_output',
      description: 'Get output from a running or completed background task.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          block: { type: 'boolean' },
          timeout: { type: 'number' },
        },
        required: [],
      },
      category: 'shell',
      permissionLevel: 'read',
      readOnly: true,
      allowInPlanMode: true,
    },
    async () => (await import('./shell/taskOutput')).taskOutputModule,
  );
}
