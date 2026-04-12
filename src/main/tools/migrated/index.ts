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

  // ── batch 4: vision/ wrapper 模式（7 个，wrappers.ts 单文件聚合 module）─
  // 注：register 要求 schema 立即提供（getSchemas 用），所以这里写完整 schema
  // loader 内 lazy 拉 wrappers.ts 拿对应 module
  registry.register(
    {
      name: 'Browser',
      description: 'Browser facade — list pages, take screenshots, click, type, etc.',
      inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
      category: 'vision',
      permissionLevel: 'execute',
    },
    async () => (await import('./vision/wrappers')).browserModule,
  );
  registry.register(
    {
      name: 'Computer',
      description: 'Computer use facade — screenshot, click, type, key, scroll on the desktop.',
      inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
      category: 'vision',
      permissionLevel: 'execute',
    },
    async () => (await import('./vision/wrappers')).computerModule,
  );
  registry.register(
    {
      name: 'browser_action',
      description: 'Direct browser action sub-tool used by the Browser facade.',
      inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
      category: 'vision',
      permissionLevel: 'execute',
    },
    async () => (await import('./vision/wrappers')).browserActionModule,
  );
  registry.register(
    {
      name: 'browser_navigate',
      description: 'Navigate the browser to a URL or back/forward in history.',
      inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: [] },
      category: 'vision',
      permissionLevel: 'execute',
    },
    async () => (await import('./vision/wrappers')).browserNavigateModule,
  );
  registry.register(
    {
      name: 'computer_use',
      description: 'Direct computer use sub-tool used by the Computer facade.',
      inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
      category: 'vision',
      permissionLevel: 'execute',
    },
    async () => (await import('./vision/wrappers')).computerUseModule,
  );
  registry.register(
    {
      name: 'screenshot',
      description: 'Take a screenshot of the desktop or a specific window/region.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      category: 'vision',
      permissionLevel: 'read',
      readOnly: true,
      allowInPlanMode: true,
    },
    async () => (await import('./vision/wrappers')).screenshotModule,
  );
  registry.register(
    {
      name: 'gui_agent',
      description: 'Run a GUI automation agent task with high-level instructions.',
      inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
      category: 'vision',
      permissionLevel: 'execute',
    },
    async () => (await import('./vision/wrappers')).guiAgentModule,
  );

  // ── batch 5: connectors/ wrapper（11 个 mail/reminders/calendar）─────────
  const minimalConnSchema = (props: Record<string, { type: string }>) => ({
    type: 'object' as const,
    properties: props,
    required: [] as string[],
  });

  registry.register(
    {
      name: 'mail',
      description: 'List/search macOS Mail messages.',
      inputSchema: minimalConnSchema({ action: { type: 'string' } }),
      category: 'mcp',
      permissionLevel: 'read',
      readOnly: true,
      allowInPlanMode: true,
    },
    async () => (await import('./connectors/wrappers')).mailModule,
  );
  registry.register(
    {
      name: 'mail_send',
      description: 'Send a mail message via macOS Mail.app.',
      inputSchema: minimalConnSchema({ to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }),
      category: 'mcp',
      permissionLevel: 'write',
    },
    async () => (await import('./connectors/wrappers')).mailSendModule,
  );
  registry.register(
    {
      name: 'mail_draft',
      description: 'Create a mail draft via macOS Mail.app.',
      inputSchema: minimalConnSchema({ to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }),
      category: 'mcp',
      permissionLevel: 'write',
    },
    async () => (await import('./connectors/wrappers')).mailDraftModule,
  );
  registry.register(
    {
      name: 'reminders',
      description: 'List macOS Reminders items.',
      inputSchema: minimalConnSchema({ action: { type: 'string' } }),
      category: 'mcp',
      permissionLevel: 'read',
      readOnly: true,
      allowInPlanMode: true,
    },
    async () => (await import('./connectors/wrappers')).remindersModule,
  );
  registry.register(
    {
      name: 'reminders_create',
      description: 'Create a new macOS Reminders item.',
      inputSchema: minimalConnSchema({ title: { type: 'string' } }),
      category: 'mcp',
      permissionLevel: 'write',
    },
    async () => (await import('./connectors/wrappers')).remindersCreateModule,
  );
  registry.register(
    {
      name: 'reminders_update',
      description: 'Update an existing macOS Reminders item.',
      inputSchema: minimalConnSchema({ id: { type: 'string' } }),
      category: 'mcp',
      permissionLevel: 'write',
    },
    async () => (await import('./connectors/wrappers')).remindersUpdateModule,
  );
  registry.register(
    {
      name: 'reminders_delete',
      description: 'Delete a macOS Reminders item.',
      inputSchema: minimalConnSchema({ id: { type: 'string' } }),
      category: 'mcp',
      permissionLevel: 'write',
    },
    async () => (await import('./connectors/wrappers')).remindersDeleteModule,
  );
  registry.register(
    {
      name: 'calendar',
      description: 'List macOS Calendar events.',
      inputSchema: minimalConnSchema({ action: { type: 'string' } }),
      category: 'mcp',
      permissionLevel: 'read',
      readOnly: true,
      allowInPlanMode: true,
    },
    async () => (await import('./connectors/wrappers')).calendarModule,
  );
  registry.register(
    {
      name: 'calendar_create_event',
      description: 'Create a new macOS Calendar event.',
      inputSchema: minimalConnSchema({ title: { type: 'string' } }),
      category: 'mcp',
      permissionLevel: 'write',
    },
    async () => (await import('./connectors/wrappers')).calendarCreateEventModule,
  );
  registry.register(
    {
      name: 'calendar_update_event',
      description: 'Update an existing macOS Calendar event.',
      inputSchema: minimalConnSchema({ id: { type: 'string' } }),
      category: 'mcp',
      permissionLevel: 'write',
    },
    async () => (await import('./connectors/wrappers')).calendarUpdateEventModule,
  );
  registry.register(
    {
      name: 'calendar_delete_event',
      description: 'Delete a macOS Calendar event.',
      inputSchema: minimalConnSchema({ id: { type: 'string' } }),
      category: 'mcp',
      permissionLevel: 'write',
    },
    async () => (await import('./connectors/wrappers')).calendarDeleteEventModule,
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
