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

  // ── shell/ batch 2c: git 三件套 ───────────────────────────────────────
  registry.register(
    {
      name: 'git_diff',
      description: 'Git 差异分析: diff (未暂存) | diff_staged | diff_branch | show.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['diff', 'diff_staged', 'diff_branch', 'show'] },
          files: { type: 'array', items: { type: 'string' } },
          stat_only: { type: 'boolean' },
          base: { type: 'string' },
          head: { type: 'string' },
          commit: { type: 'string' },
        },
        required: ['action'],
      },
      category: 'shell',
      permissionLevel: 'execute',
      readOnly: true,
      allowInPlanMode: true,
    },
    async () => (await import('./shell/gitDiff')).gitDiffModule,
  );

  registry.register(
    {
      name: 'git_commit',
      description: 'Git 提交管理: status | add | commit | push | log.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'add', 'commit', 'push', 'log'] },
          files: { type: 'array', items: { type: 'string' } },
          all: { type: 'boolean' },
          message: { type: 'string' },
          amend: { type: 'boolean' },
          remote: { type: 'string' },
          branch: { type: 'string' },
          set_upstream: { type: 'boolean' },
          limit: { type: 'number' },
          oneline: { type: 'boolean' },
        },
        required: ['action'],
      },
      category: 'shell',
      permissionLevel: 'execute',
      readOnly: false,
      allowInPlanMode: false,
    },
    async () => (await import('./shell/gitCommit')).gitCommitModule,
  );

  registry.register(
    {
      name: 'git_worktree',
      description: 'Git 工作树管理: list | add | remove | prune.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'add', 'remove', 'prune'] },
          path: { type: 'string' },
          branch: { type: 'string' },
          new_branch: { type: 'string' },
          base: { type: 'string' },
          force: { type: 'boolean' },
        },
        required: ['action'],
      },
      category: 'shell',
      permissionLevel: 'execute',
      readOnly: false,
      allowInPlanMode: false,
    },
    async () => (await import('./shell/gitWorktree')).gitWorktreeModule,
  );

  // ── batch 3: search/skill/lsp wrapper 模式 ────────────────────────────
  registry.register(
    {
      name: 'ToolSearch',
      description: 'Search for or select deferred tools to make them available.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          max_results: { type: 'number' },
        },
        required: ['query'],
      },
      category: 'fs',
      permissionLevel: 'read',
      readOnly: true,
      allowInPlanMode: true,
    },
    async () => (await import('./search/toolSearch')).toolSearchModule,
  );

  registry.register(
    {
      name: 'SkillCreate',
      description: '创建新的可复用 skill。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          content: { type: 'string' },
          scope: { type: 'string' },
          allowedTools: { type: 'string' },
        },
        required: ['name', 'description', 'content'],
      },
      category: 'skill',
      permissionLevel: 'write',
      readOnly: false,
      allowInPlanMode: false,
    },
    async () => (await import('./skill/skillCreate')).skillCreateModule,
  );

  registry.register(
    {
      name: 'Skill',
      description: '执行已注册的 skill',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          args: { type: 'string' },
        },
        required: ['command'],
      },
      category: 'skill',
      permissionLevel: 'read',
      readOnly: false,
      allowInPlanMode: false,
    },
    async () => (await import('./skill/skill')).skillModule,
  );

  registry.register(
    {
      name: 'diagnostics',
      description: 'Query LSP diagnostics for a file or the entire project.',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          severity_filter: { type: 'string', enum: ['error', 'warning', 'all'] },
        },
        required: [],
      },
      category: 'lsp',
      permissionLevel: 'read',
      readOnly: true,
      allowInPlanMode: true,
    },
    async () => (await import('./lsp/diagnostics')).diagnosticsModule,
  );

  registry.register(
    {
      name: 'lsp',
      description: 'LSP code intelligence operations (goToDefinition, findReferences, hover, ...).',
      inputSchema: {
        type: 'object',
        properties: {
          operation: { type: 'string' },
          file_path: { type: 'string' },
          line: { type: 'number' },
          character: { type: 'number' },
        },
        required: ['operation', 'file_path', 'line', 'character'],
      },
      category: 'lsp',
      permissionLevel: 'read',
      readOnly: true,
      allowInPlanMode: true,
    },
    async () => (await import('./lsp/lsp')).lspModule,
  );

  // ── shell/ batch 2b: Process facade（合并 6 个 process_* 子工具）─────────
  registry.register(
    {
      name: 'Process',
      description: 'Unified process management: list/poll/log/write/submit/kill/output background tasks and PTY sessions.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'poll', 'log', 'write', 'submit', 'kill', 'output'] },
          filter: { type: 'string', enum: ['all', 'running', 'completed', 'failed', 'pty', 'background'] },
          session_id: { type: 'string' },
          task_id: { type: 'string' },
          block: { type: 'boolean' },
          timeout: { type: 'number' },
          tail: { type: 'number' },
          data: { type: 'string' },
          input: { type: 'string' },
        },
        required: ['action'],
      },
      category: 'shell',
      permissionLevel: 'execute',
      readOnly: false,
      allowInPlanMode: false,
    },
    async () => (await import('./shell/process')).processModule,
  );
}
