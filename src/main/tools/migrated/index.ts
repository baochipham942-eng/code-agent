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

  // ── connectors（mail / reminders / calendar）— 全部 native ─────────────
  registry.register(
    {
      name: 'mail',
      description: 'Read local macOS Mail data via the native connector.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['get_status', 'list_accounts', 'list_mailboxes', 'list_messages', 'read_message'],
            description: 'Mail action to perform.',
          },
          account: { type: 'string', description: 'Optional account name.' },
          mailbox: { type: 'string', description: 'Mailbox name for list_messages/read_message.' },
          query: { type: 'string', description: 'Optional subject/sender filter.' },
          limit: { type: 'number', description: 'Max messages to return. Default: 10.' },
          scan_limit: { type: 'number', description: 'Max messages to scan before filter.' },
          message_id: { type: 'number', description: 'Message id for read_message.' },
        },
        required: ['action'],
      },
      category: 'mcp',
      permissionLevel: 'read',
      readOnly: true,
      allowInPlanMode: true,
    },
    async () => (await import('./connectors/mail')).mailModule,
  );
  registry.register(
    {
      name: 'mail_send',
      description: 'Send a real email via local macOS Mail.',
      inputSchema: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: 'Email subject.' },
          to: { type: 'array', items: { type: 'string' }, description: 'Primary recipients.' },
          cc: { type: 'array', items: { type: 'string' }, description: 'CC recipients.' },
          bcc: { type: 'array', items: { type: 'string' }, description: 'BCC recipients.' },
          content: { type: 'string', description: 'Email body content.' },
          attachments: { type: 'array', items: { type: 'string' }, description: 'Attachment file paths.' },
        },
        required: ['subject', 'to'],
      },
      category: 'mcp',
      permissionLevel: 'write',
    },
    async () => (await import('./connectors/mailSend')).mailSendModule,
  );
  registry.register(
    {
      name: 'mail_draft',
      description: 'Create a draft in local macOS Mail via the native connector.',
      inputSchema: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: 'Draft subject.' },
          to: { type: 'array', items: { type: 'string' }, description: 'Primary recipients.' },
          cc: { type: 'array', items: { type: 'string' }, description: 'CC recipients.' },
          bcc: { type: 'array', items: { type: 'string' }, description: 'BCC recipients.' },
          content: { type: 'string', description: 'Draft body content.' },
          attachments: { type: 'array', items: { type: 'string' }, description: 'Attachment file paths.' },
        },
        required: ['subject', 'to'],
      },
      category: 'mcp',
      permissionLevel: 'write',
    },
    async () => (await import('./connectors/mailDraft')).mailDraftModule,
  );
  registry.register(
    {
      name: 'reminders',
      description: 'Read macOS Reminders data via a native connector.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['get_status', 'list_lists', 'list_reminders'],
            description: 'Reminders action to perform.',
          },
          list: { type: 'string', description: 'Optional reminder list name for list_reminders.' },
          include_completed: { type: 'boolean', description: 'Whether to include completed reminders.' },
          limit: { type: 'number', description: 'Maximum number of reminders to return. Default: 20.' },
        },
        required: ['action'],
      },
      category: 'mcp',
      permissionLevel: 'read',
      readOnly: true,
      allowInPlanMode: true,
    },
    async () => (await import('./connectors/reminders')).remindersModule,
  );
  registry.register(
    {
      name: 'reminders_create',
      description: 'Create a new reminder in macOS Reminders via the native connector.',
      inputSchema: {
        type: 'object',
        properties: {
          list: { type: 'string', description: 'Target reminder list name.' },
          title: { type: 'string', description: 'Reminder title.' },
          notes: { type: 'string', description: 'Optional reminder notes/body.' },
          remind_at_ms: { type: 'number', description: 'Optional reminder time in Unix milliseconds.' },
        },
        required: ['list', 'title'],
      },
      category: 'mcp',
      permissionLevel: 'write',
    },
    async () => (await import('./connectors/remindersCreate')).remindersCreateModule,
  );
  registry.register(
    {
      name: 'reminders_update',
      description: 'Update an existing reminder in macOS Reminders via the native connector.',
      inputSchema: {
        type: 'object',
        properties: {
          list: { type: 'string', description: 'Target reminder list name.' },
          reminder_id: { type: 'string', description: 'Stable reminder id.' },
          title: { type: 'string', description: 'Optional updated reminder title.' },
          notes: { type: 'string', description: 'Optional updated notes. Pass an empty string to clear it.' },
          remind_at_ms: { type: 'number', description: 'Optional updated reminder time in Unix milliseconds.' },
          clear_remind_at: { type: 'boolean', description: 'Set true to clear an existing reminder time.' },
          completed: { type: 'boolean', description: 'Set true to mark complete, false to reopen.' },
        },
        required: ['list', 'reminder_id'],
      },
      category: 'mcp',
      permissionLevel: 'write',
    },
    async () => (await import('./connectors/remindersUpdate')).remindersUpdateModule,
  );
  registry.register(
    {
      name: 'reminders_delete',
      description: 'Delete an existing reminder from macOS Reminders.',
      inputSchema: {
        type: 'object',
        properties: {
          list: { type: 'string', description: 'Target reminder list name.' },
          reminder_id: { type: 'string', description: 'Stable reminder id.' },
        },
        required: ['list', 'reminder_id'],
      },
      category: 'mcp',
      permissionLevel: 'write',
    },
    async () => (await import('./connectors/remindersDelete')).remindersDeleteModule,
  );
  registry.register(
    {
      name: 'calendar',
      description: 'Read macOS Calendar data via a native connector.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['get_status', 'list_calendars', 'list_events'],
            description: 'Calendar action to perform.',
          },
          calendar: { type: 'string', description: 'Optional calendar name for list_events.' },
          from_ms: { type: 'number', description: 'Optional inclusive start timestamp in Unix milliseconds.' },
          to_ms: { type: 'number', description: 'Optional inclusive end timestamp in Unix milliseconds.' },
          limit: { type: 'number', description: 'Maximum number of events to return. Default: 20.' },
        },
        required: ['action'],
      },
      category: 'mcp',
      permissionLevel: 'read',
      readOnly: true,
      allowInPlanMode: true,
    },
    async () => (await import('./connectors/calendar')).calendarModule,
  );
  registry.register(
    {
      name: 'calendar_create_event',
      description: 'Create a new event in macOS Calendar via the native connector.',
      inputSchema: {
        type: 'object',
        properties: {
          calendar: { type: 'string', description: 'Target calendar name.' },
          title: { type: 'string', description: 'Event title.' },
          start_ms: { type: 'number', description: 'Event start time in Unix milliseconds.' },
          end_ms: { type: 'number', description: 'Event end time in Unix milliseconds. Defaults to start + 30 minutes.' },
          location: { type: 'string', description: 'Optional event location.' },
        },
        required: ['calendar', 'title', 'start_ms'],
      },
      category: 'mcp',
      permissionLevel: 'write',
    },
    async () => (await import('./connectors/calendarCreateEvent')).calendarCreateEventModule,
  );
  registry.register(
    {
      name: 'calendar_update_event',
      description: 'Update an existing event in macOS Calendar via the native connector.',
      inputSchema: {
        type: 'object',
        properties: {
          calendar: { type: 'string', description: 'Target calendar name.' },
          event_uid: { type: 'string', description: 'Stable Calendar event uid.' },
          title: { type: 'string', description: 'Optional updated title.' },
          start_ms: { type: 'number', description: 'Optional updated start time in Unix milliseconds.' },
          end_ms: { type: 'number', description: 'Optional updated end time in Unix milliseconds.' },
          location: { type: 'string', description: 'Optional updated location. Pass an empty string to clear it.' },
        },
        required: ['calendar', 'event_uid'],
      },
      category: 'mcp',
      permissionLevel: 'write',
    },
    async () => (await import('./connectors/calendarUpdateEvent')).calendarUpdateEventModule,
  );
  registry.register(
    {
      name: 'calendar_delete_event',
      description: 'Delete an existing event from macOS Calendar.',
      inputSchema: {
        type: 'object',
        properties: {
          calendar: { type: 'string', description: 'Target calendar name.' },
          event_uid: { type: 'string', description: 'Stable Calendar event uid.' },
        },
        required: ['calendar', 'event_uid'],
      },
      category: 'mcp',
      permissionLevel: 'write',
    },
    async () => (await import('./connectors/calendarDeleteEvent')).calendarDeleteEventModule,
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
      name: 'AgentSpawn',
      description: 'Advanced agent creation with full control (PascalCase alias for SDK compatibility).',
      inputSchema: minimalMASchema({ command: { type: 'string' } }, ['command']),
      category: 'multiagent',
      permissionLevel: 'execute',
    },
    async () => (await import('./multiagent/wrappers')).agentSpawnModule,
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
    {
      name: 'PlanMode',
      description: 'Plan mode toggle facade (enter/exit).',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['enter', 'exit'] },
          reason: { type: 'string' },
          plan: { type: 'string' },
        },
        required: ['action'],
      },
      category: 'planning',
      permissionLevel: 'write',
      allowInPlanMode: true,
    },
    async () => (await import('./planning/planModeFacade')).planModeFacadeModule,
  );
  registry.register(
    {
      name: 'enter_plan_mode',
      description: 'Enter plan mode (read-only tools allowed).',
      inputSchema: {
        type: 'object',
        properties: {
          reason: { type: 'string' },
        },
      },
      category: 'planning',
      permissionLevel: 'write',
      allowInPlanMode: true,
    },
    async () => (await import('./planning/enterPlanMode')).enterPlanModeModule,
  );
  registry.register(
    {
      name: 'exit_plan_mode',
      description: 'Exit plan mode and resume normal execution.',
      inputSchema: {
        type: 'object',
        properties: {
          plan: { type: 'string' },
        },
        required: ['plan'],
      },
      category: 'planning',
      permissionLevel: 'write',
      allowInPlanMode: true,
    },
    async () => (await import('./planning/exitPlanMode')).exitPlanModeModule,
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

  // ── batch 8: network/ wrapper（31 个，最终批）────────────────────────────
  // 全部用最小 schema 占位，真实 schema 由 ToolModule.schema 提供（resolve 时校验）
  // 但 register 接口要求 schema 立即提供，所以这里给最小化的兼容定义
  const netSchema = (props: Record<string, { type: string }> = {}, required: string[] = []) => ({
    type: 'object' as const,
    properties: props,
    required,
  });
  const REGISTER_NET = (
    name: string,
    desc: string,
    perm: 'read' | 'write' | 'network',
    importFn: import('../../protocol/tools').ToolLoader,
    readOnly = false,
  ) => {
    registry.register(
      {
        name,
        description: desc,
        inputSchema: netSchema(),
        category: 'network',
        permissionLevel: perm,
        readOnly,
        allowInPlanMode: readOnly,
      },
      importFn,
    );
  };

  // HTTP / Web fetching (4)
  REGISTER_NET('web_fetch', 'Fetch a URL and extract content via AI.', 'network',
    async () => (await import('./network/wrappers')).webFetchModule, true);
  REGISTER_NET('WebFetch', 'Unified web fetch facade (action: fetch | request).', 'network',
    async () => (await import('./network/wrappers')).webFetchUnifiedModule, true);
  REGISTER_NET('WebSearch', 'Search the web via Perplexity/Exa/Tavily.', 'network',
    async () => (await import('./network/wrappers')).webSearchModule, true);
  REGISTER_NET('http_request', 'Generic HTTP request (GET/POST/PUT/DELETE).', 'network',
    async () => (await import('./network/wrappers')).httpRequestModule, false);

  // Document reading (4)
  REGISTER_NET('ReadDocument', 'Unified document reader facade (PDF/DOCX/XLSX).', 'read',
    async () => (await import('./network/wrappers')).readDocumentModule, true);
  REGISTER_NET('read_docx', 'Read text content from a .docx file.', 'read',
    async () => (await import('./network/wrappers')).readDocxModule, true);
  REGISTER_NET('read_pdf', 'Read text content from a .pdf file.', 'read',
    async () => (await import('./network/wrappers')).readPdfModule, true);
  REGISTER_NET('read_xlsx', 'Read tabular data from a .xlsx file.', 'read',
    async () => (await import('./network/wrappers')).readXlsxModule, true);

  // Document generation (6)
  REGISTER_NET('docx_generate', 'Generate a .docx document.', 'write',
    async () => (await import('./network/wrappers')).docxGenerateModule, false);
  REGISTER_NET('excel_generate', 'Generate a .xlsx spreadsheet.', 'write',
    async () => (await import('./network/wrappers')).excelGenerateModule, false);
  REGISTER_NET('pdf_generate', 'Generate a .pdf document.', 'write',
    async () => (await import('./network/wrappers')).pdfGenerateModule, false);
  REGISTER_NET('pdf_compress', 'Compress an existing PDF.', 'write',
    async () => (await import('./network/wrappers')).pdfCompressModule, false);
  REGISTER_NET('PdfAutomate', 'Unified PDF facade (generate/compress/read/merge/split/extract_tables/convert_to_docx).', 'write',
    async () => (await import('./network/wrappers')).pdfAutomateModule, false);
  REGISTER_NET('xlwings_execute', 'Run xlwings Python script against a workbook.', 'write',
    async () => (await import('./network/wrappers')).xlwingsExecuteModule, false);

  // Media (8)
  REGISTER_NET('image_generate', 'Generate an image (DALL-E / Stable Diffusion / etc.).', 'network',
    async () => (await import('./network/wrappers')).imageGenerateModule, false);
  REGISTER_NET('image_process', 'Process an image (resize/crop/rotate/format).', 'write',
    async () => (await import('./network/wrappers')).imageProcessModule, false);
  REGISTER_NET('image_analyze', 'Analyze an image with vision models.', 'network',
    async () => (await import('./network/wrappers')).imageAnalyzeModule, true);
  REGISTER_NET('image_annotate', 'Annotate an image (boxes, arrows, text).', 'write',
    async () => (await import('./network/wrappers')).imageAnnotateModule, false);
  REGISTER_NET('video_generate', 'Generate a video clip from prompt.', 'network',
    async () => (await import('./network/wrappers')).videoGenerateModule, false);
  REGISTER_NET('text_to_speech', 'Convert text to speech audio.', 'network',
    async () => (await import('./network/wrappers')).textToSpeechModule, false);
  REGISTER_NET('speech_to_text', 'Transcribe audio to text via cloud ASR.', 'network',
    async () => (await import('./network/wrappers')).speechToTextModule, true);
  REGISTER_NET('local_speech_to_text', 'Transcribe audio to text via local ASR.', 'read',
    async () => (await import('./network/wrappers')).localSpeechToTextModule, true);

  // Visual helpers (4)
  REGISTER_NET('chart_generate', 'Generate a chart image (bar/line/pie/scatter).', 'write',
    async () => (await import('./network/wrappers')).chartGenerateModule, false);
  REGISTER_NET('mermaid_export', 'Export a Mermaid diagram to SVG/PNG.', 'write',
    async () => (await import('./network/wrappers')).mermaidExportModule, false);
  REGISTER_NET('qrcode_generate', 'Generate a QR code image.', 'write',
    async () => (await import('./network/wrappers')).qrcodeGenerateModule, false);
  REGISTER_NET('screenshot_page', 'Take a screenshot of a webpage.', 'network',
    async () => (await import('./network/wrappers')).screenshotPageModule, true);

  // External integrations (5)
  REGISTER_NET('jira', 'Jira integration (search/create/update/comment).', 'network',
    async () => (await import('./network/wrappers')).jiraModule, false);
  REGISTER_NET('github_pr', 'GitHub PR management (create/view/list/comment/review/merge).', 'network',
    async () => (await import('./network/wrappers')).githubPrModule, false);
  REGISTER_NET('twitter_fetch', 'Fetch tweets / threads / user timelines.', 'network',
    async () => (await import('./network/wrappers')).twitterFetchModule, true);
  REGISTER_NET('youtube_transcript', 'Fetch transcript of a YouTube video.', 'network',
    async () => (await import('./network/wrappers')).youtubeTranscriptModule, true);
  REGISTER_NET('academic_search', 'Search academic papers (arxiv/openalex/semanticscholar).', 'network',
    async () => (await import('./network/wrappers')).academicSearchModule, true);

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

  // ── P0-6.2: legacy core tool wrappers (Bash/Read/Write/Glob/Grep/ppt/memory) ──
  // 这批 tool 迁移前只在 legacy toolRegistry 里注册，dispatch 走 fallback 分支。
  // P0-6.2 删 legacy 前必须把它们 wrap 进 protocol registry，让 isProtocolToolName
  // 覆盖所有 runtime 必须的 tool。

  // file (3): Read / Write / Glob (P0-6.3 Batch 1 — native ToolModule)
  registry.register(
    {
      name: 'Read',
      description:
        'Reads a file from the local filesystem. Supports offset/limit for line ranges.',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Absolute path to the file. Supports ~ for home directory.',
          },
          offset: {
            type: 'number',
            description: 'Line number to start reading from (1-indexed). Default: 1.',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of lines to read. Default: 2000.',
          },
        },
        required: ['file_path'],
      },
      category: 'fs',
      permissionLevel: 'read',
      readOnly: true,
      allowInPlanMode: true,
    },
    async () => (await import('./file/read')).readModule,
  );
  registry.register(
    {
      name: 'Write',
      description:
        'Writes a file to the local filesystem. Overwrites existing files; creates parent directories.',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Absolute path where the file will be created or overwritten.',
          },
          content: {
            type: 'string',
            description: 'The complete file content to write (replaces entire file).',
          },
        },
        required: ['file_path', 'content'],
      },
      category: 'fs',
      permissionLevel: 'write',
      readOnly: false,
      allowInPlanMode: false,
    },
    async () => (await import('./file/write')).writeModule,
  );
  registry.register(
    {
      name: 'Glob',
      description:
        'Fast file pattern matching. Use to find files by name pattern (e.g. "**/*.ts").',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Glob pattern (e.g. "**/*.ts", "src/**/*.tsx").',
          },
          path: {
            type: 'string',
            description: 'Directory to search in. Default: working directory.',
          },
        },
        required: ['pattern'],
      },
      category: 'fs',
      permissionLevel: 'read',
      readOnly: true,
      allowInPlanMode: true,
    },
    async () => (await import('./file/glob')).globModule,
  );

  // shell (2): Bash / Grep
  registry.register(
    {
      name: 'Bash',
      description: `Executes a bash command and returns its output. Use for system commands, running scripts, git operations, and terminal tasks. Working directory persists between calls.

IMPORTANT: Avoid using this tool to run \`find\`, \`grep\`, \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\` commands. Instead, use the appropriate dedicated tool as this will be much faster and more reliable:
- File search: Use Glob (NOT find or ls)
- Content search: Use Grep (NOT grep or rg)
- Read files: Use Read (NOT cat/head/tail/sed -n/awk/python3 file reads)
- Edit files: Use Edit (NOT sed/awk)
- Write files: Use Write (NOT echo >/cat <<EOF)

Reserve Bash exclusively for: running scripts, git commands, installing packages, compilation, and other system operations that genuinely require shell execution. If you are unsure, default to the dedicated tool.

Git: NEVER --force push or --no-verify unless explicitly requested.`,
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command to execute' },
          timeout: { type: 'number', description: 'Timeout in milliseconds (default: 120000, max: 600000)' },
          working_directory: { type: 'string', description: 'Working directory for the command' },
          run_in_background: { type: 'boolean', description: 'Run command in background and return immediately with task_id' },
          pty: { type: 'boolean', description: 'Use PTY (pseudo-terminal) for interactive commands like vim, ssh, etc.' },
          cols: { type: 'number', description: 'Terminal columns for PTY mode (default: 80)' },
          rows: { type: 'number', description: 'Terminal rows for PTY mode (default: 24)' },
          wait_for_completion: { type: 'boolean', description: 'For PTY mode: wait for command to complete before returning (default: false)' },
          description: { type: 'string', description: 'Short description of what this command does (for logging)' },
        },
        required: ['command'],
      },
      category: 'shell',
      permissionLevel: 'execute',
      readOnly: false,
      allowInPlanMode: false,
    },
    async () => (await import('./shell/bash')).bashModule,
  );
  registry.register(
    {
      name: 'Grep',
      description:
        'Searches file contents using regex patterns. Use this instead of Bash grep or rg. ' +
        'Supports regex syntax, file type filtering, glob patterns, and context lines. ' +
        'Use context params (before_context/after_context/context) to see surrounding lines. ' +
        'Use head_limit + offset for pagination by match group.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string' },
          include: { type: 'string' },
          case_insensitive: { type: 'boolean' },
          type: { type: 'string' },
          before_context: { type: 'number' },
          after_context: { type: 'number' },
          context: { type: 'number' },
          head_limit: { type: 'number' },
          offset: { type: 'number' },
        },
        required: ['pattern'],
      },
      category: 'fs',
      permissionLevel: 'read',
      readOnly: true,
      allowInPlanMode: true,
    },
    async () => (await import('./shell/grep')).grepModule,
  );

  // lightMemory (2): MemoryRead / MemoryWrite (P0-6.3 Batch 3 — native ToolModule)
  registry.register(
    {
      name: 'MemoryRead',
      description:
        'Read a memory detail file from the persistent file-based memory system.',
      inputSchema: {
        type: 'object',
        properties: {
          filename: { type: 'string' },
        },
        required: ['filename'],
      },
      category: 'fs',
      permissionLevel: 'read',
      readOnly: true,
      allowInPlanMode: true,
    },
    async () => (await import('./lightMemory/memoryRead')).memoryReadModule,
  );
  registry.register(
    {
      name: 'MemoryWrite',
      description:
        'Write, update, or delete a memory file; auto-maintains INDEX.md.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['write', 'delete'] },
          filename: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          type: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'] },
          content: { type: 'string' },
        },
        required: ['action', 'filename'],
      },
      category: 'fs',
      permissionLevel: 'write',
      readOnly: false,
      allowInPlanMode: true,
    },
    async () => (await import('./lightMemory/memoryWrite')).memoryWriteModule,
  );

  // network (2): ppt_generate / ppt_edit
  registry.register(
    {
      name: 'ppt_generate',
      description: 'Generate a PowerPoint presentation from an outline or topic.',
      inputSchema: netSchema({ topic: { type: 'string' }, outline: { type: 'string' } }),
      category: 'network',
      permissionLevel: 'network',
      readOnly: false,
      allowInPlanMode: false,
    },
    async () => (await import('./network/wrappers')).pptGenerateModule,
  );
  registry.register(
    {
      name: 'ppt_edit',
      description: 'Edit an existing PowerPoint presentation (insert/replace/delete slides or text).',
      inputSchema: netSchema({ file_path: { type: 'string' }, action: { type: 'string' } }),
      category: 'network',
      permissionLevel: 'write',
      readOnly: false,
      allowInPlanMode: false,
    },
    async () => (await import('./network/wrappers')).pptEditModule,
  );
}
