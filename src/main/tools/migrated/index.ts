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

  // ── batch 6: multiagent/ wrapper（9 个，验证 ctx.legacyToolRegistry/modelConfig）─
  const minimalMASchema = (props: Record<string, { type: string }>, required: string[] = []) => ({
    type: 'object' as const,
    properties: props,
    required,
  });

  registry.register(
    {
      name: 'Task',
      description: 'Spawn a sub-agent to handle a focused task with its own tool loop.',
      inputSchema: minimalMASchema({ description: { type: 'string' }, prompt: { type: 'string' } }, ['description', 'prompt']),
      category: 'multiagent',
      permissionLevel: 'execute',
    },
    async () => (await import('./multiagent/wrappers')).taskModule,
  );
  registry.register(
    {
      name: 'teammate',
      description: 'Send a message to a named teammate agent in the active swarm.',
      inputSchema: minimalMASchema({ to: { type: 'string' }, message: { type: 'string' } }, ['to', 'message']),
      category: 'multiagent',
      permissionLevel: 'execute',
    },
    async () => (await import('./multiagent/wrappers')).teammateModule,
  );
  registry.register(
    {
      name: 'spawn_agent',
      description: 'Spawn a long-running background agent (CLI subprocess).',
      inputSchema: minimalMASchema({ command: { type: 'string' } }, ['command']),
      category: 'multiagent',
      permissionLevel: 'execute',
    },
    async () => (await import('./multiagent/wrappers')).spawnAgentModule,
  );
  registry.register(
    {
      name: 'wait_agent',
      description: 'Wait for a spawned agent to complete and return its output.',
      inputSchema: minimalMASchema({ agent_id: { type: 'string' } }, ['agent_id']),
      category: 'multiagent',
      permissionLevel: 'read',
      readOnly: true,
      allowInPlanMode: true,
    },
    async () => (await import('./multiagent/wrappers')).waitAgentModule,
  );
  registry.register(
    {
      name: 'close_agent',
      description: 'Close a spawned agent and clean up its resources.',
      inputSchema: minimalMASchema({ agent_id: { type: 'string' } }, ['agent_id']),
      category: 'multiagent',
      permissionLevel: 'execute',
    },
    async () => (await import('./multiagent/wrappers')).closeAgentModule,
  );
  registry.register(
    {
      name: 'send_input',
      description: 'Send input to a running spawned agent.',
      inputSchema: minimalMASchema({ agent_id: { type: 'string' }, input: { type: 'string' } }, ['agent_id', 'input']),
      category: 'multiagent',
      permissionLevel: 'execute',
    },
    async () => (await import('./multiagent/wrappers')).sendInputModule,
  );
  registry.register(
    {
      name: 'agent_message',
      description: 'Send a structured message between agents in a swarm.',
      inputSchema: minimalMASchema({ to: { type: 'string' }, payload: { type: 'object' } }, ['to', 'payload']),
      category: 'multiagent',
      permissionLevel: 'execute',
    },
    async () => (await import('./multiagent/wrappers')).agentMessageModule,
  );
  registry.register(
    {
      name: 'workflow_orchestrate',
      description: 'Run a multi-step workflow across agents (DAG orchestration).',
      inputSchema: minimalMASchema({ workflow: { type: 'object' } }, ['workflow']),
      category: 'multiagent',
      permissionLevel: 'execute',
    },
    async () => (await import('./multiagent/wrappers')).workflowOrchestrateModule,
  );
  registry.register(
    {
      name: 'plan_review',
      description: 'Review a plan or proposal from another agent before execution.',
      inputSchema: minimalMASchema({ plan: { type: 'string' } }, ['plan']),
      category: 'multiagent',
      permissionLevel: 'read',
      readOnly: true,
      allowInPlanMode: true,
    },
    async () => (await import('./multiagent/wrappers')).planReviewModule,
  );

  // ── batch 7: mcp/document/excel/planning（21 个）─────────────────────────
  const minSchema = (props: Record<string, { type: string }> = {}, required: string[] = []) => ({
    type: 'object' as const,
    properties: props,
    required,
  });

  // mcp (3)
  registry.register(
    { name: 'mcp', description: 'Direct MCP tool invocation.', inputSchema: minSchema({ server: { type: 'string' }, tool: { type: 'string' } }), category: 'mcp', permissionLevel: 'network' },
    async () => (await import('./mcp/wrappers')).mcpModule,
  );
  registry.register(
    { name: 'MCPUnified', description: 'Unified MCP facade for cross-server tool calls.', inputSchema: minSchema({ action: { type: 'string' } }), category: 'mcp', permissionLevel: 'network' },
    async () => (await import('./mcp/wrappers')).mcpUnifiedModule,
  );
  registry.register(
    { name: 'mcp_add_server', description: 'Register a new MCP server.', inputSchema: minSchema({ name: { type: 'string' }, command: { type: 'string' } }), category: 'mcp', permissionLevel: 'write' },
    async () => (await import('./mcp/wrappers')).mcpAddServerModule,
  );

  // document (1)
  registry.register(
    { name: 'DocEdit', description: 'Edit DOCX/RTF documents (insert/replace/delete sections).', inputSchema: minSchema({ file_path: { type: 'string' }, action: { type: 'string' } }), category: 'document', permissionLevel: 'write' },
    async () => (await import('./document/wrappers')).docEditModule,
  );

  // excel (1)
  registry.register(
    { name: 'ExcelAutomate', description: 'Automate Excel workbook operations (read/write cells, formulas, sheets).', inputSchema: minSchema({ file_path: { type: 'string' }, action: { type: 'string' } }), category: 'excel', permissionLevel: 'write' },
    async () => (await import('./excel/wrappers')).excelAutomateModule,
  );

  // planning (16)
  registry.register(
    { name: 'plan_read', description: 'Read the current persistent plan.', inputSchema: minSchema(), category: 'planning', permissionLevel: 'read', readOnly: true, allowInPlanMode: true },
    async () => (await import('./planning/wrappers')).planReadModule,
  );
  registry.register(
    { name: 'plan_recover_recent_work', description: 'Recover recent uncommitted work into a plan.', inputSchema: minSchema(), category: 'planning', permissionLevel: 'read', readOnly: true, allowInPlanMode: true },
    async () => (await import('./planning/wrappers')).planRecoverRecentWorkModule,
  );
  registry.register(
    { name: 'plan_update', description: 'Update the persistent plan (add/edit/complete tasks).', inputSchema: minSchema({ updates: { type: 'object' } }), category: 'planning', permissionLevel: 'write', allowInPlanMode: true },
    async () => (await import('./planning/wrappers')).planUpdateModule,
  );
  registry.register(
    { name: 'findings_write', description: 'Persist research findings into the plan.', inputSchema: minSchema({ findings: { type: 'string' } }), category: 'planning', permissionLevel: 'write', allowInPlanMode: true },
    async () => (await import('./planning/wrappers')).findingsWriteModule,
  );
  registry.register(
    { name: 'Plan', description: 'Plan tool facade — read/write/update plans.', inputSchema: minSchema({ action: { type: 'string' } }), category: 'planning', permissionLevel: 'write', allowInPlanMode: true },
    async () => (await import('./planning/wrappers')).planModule,
  );
  registry.register(
    { name: 'PlanMode', description: 'Plan mode toggle facade (enter/exit/status).', inputSchema: minSchema({ action: { type: 'string' } }), category: 'planning', permissionLevel: 'write', allowInPlanMode: true },
    async () => (await import('./planning/wrappers')).planModeModule,
  );
  registry.register(
    { name: 'enter_plan_mode', description: 'Enter plan mode (read-only tools allowed).', inputSchema: minSchema(), category: 'planning', permissionLevel: 'write', allowInPlanMode: true },
    async () => (await import('./planning/wrappers')).enterPlanModeModule,
  );
  registry.register(
    { name: 'exit_plan_mode', description: 'Exit plan mode and resume normal execution.', inputSchema: minSchema(), category: 'planning', permissionLevel: 'write', allowInPlanMode: true },
    async () => (await import('./planning/wrappers')).exitPlanModeModule,
  );
  registry.register(
    { name: 'task_list', description: 'List all session todos.', inputSchema: minSchema(), category: 'planning', permissionLevel: 'read', readOnly: true, allowInPlanMode: true },
    async () => (await import('./planning/wrappers')).taskListModule,
  );
  registry.register(
    { name: 'task_get', description: 'Get a specific todo by id.', inputSchema: minSchema({ id: { type: 'string' } }), category: 'planning', permissionLevel: 'read', readOnly: true, allowInPlanMode: true },
    async () => (await import('./planning/wrappers')).taskGetModule,
  );
  registry.register(
    { name: 'task_create', description: 'Create a new todo.', inputSchema: minSchema({ content: { type: 'string' } }), category: 'planning', permissionLevel: 'write', allowInPlanMode: true },
    async () => (await import('./planning/wrappers')).taskCreateModule,
  );
  registry.register(
    { name: 'task_update', description: 'Update a todo (status, content).', inputSchema: minSchema({ id: { type: 'string' }, status: { type: 'string' } }), category: 'planning', permissionLevel: 'write', allowInPlanMode: true },
    async () => (await import('./planning/wrappers')).taskUpdateModule,
  );
  registry.register(
    { name: 'TaskManager', description: 'Task manager facade for todos (list/create/update/get).', inputSchema: minSchema({ action: { type: 'string' } }), category: 'planning', permissionLevel: 'write', allowInPlanMode: true },
    async () => (await import('./planning/wrappers')).taskManagerModule,
  );
  registry.register(
    { name: 'AskUserQuestion', description: 'Ask the user a clarifying question and wait for their answer.', inputSchema: minSchema({ question: { type: 'string' } }, ['question']), category: 'planning', permissionLevel: 'execute' },
    async () => (await import('./planning/wrappers')).askUserQuestionModule,
  );
  registry.register(
    { name: 'confirm_action', description: 'Ask the user to confirm an upcoming action.', inputSchema: minSchema({ action: { type: 'string' } }, ['action']), category: 'planning', permissionLevel: 'execute' },
    async () => (await import('./planning/wrappers')).confirmActionModule,
  );
  registry.register(
    { name: 'Explore', description: 'Spawn an explorer sub-agent to gather context.', inputSchema: minSchema({ prompt: { type: 'string' } }, ['prompt']), category: 'planning', permissionLevel: 'execute' },
    async () => (await import('./planning/wrappers')).exploreModule,
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
