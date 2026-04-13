// ============================================================================
// Migrated Tools Registry
//
// 注册所有从 legacy 迁移到 ToolModule 形态的工具到 protocol registry。
// 在 protocolRegistry 单例创建时与 registerPocTools 一起调用。
//
// 全量迁完后，这个文件会被替换为生产 registry 入口，删 legacy。
// ============================================================================

import type { ToolRegistry } from '../registry';

// ── Eager schema imports (P0-7 方案 A — single source of truth) ───────────
// .schema.ts 文件只 type-import ToolSchema，无运行时副作用；可安全 eager 导入。
// 工具实现仍在 registry.register 的 lazy loader 内按需 import，避免拉重依赖。

// file/
import { listDirectorySchema } from './file/listDirectory.schema';
import { multiEditSchema } from './file/multiEdit.schema';
import { notebookEditSchema } from './file/notebookEdit.schema';
import { readClipboardSchema } from './file/readClipboard.schema';
import { readSchema } from './file/read.schema';
import { writeSchema } from './file/write.schema';
import { globSchema } from './file/glob.schema';

// shell/
import { killShellSchema } from './shell/killShell.schema';
import { taskOutputSchema } from './shell/taskOutput.schema';
import { gitDiffSchema } from './shell/gitDiff.schema';
import { gitCommitSchema } from './shell/gitCommit.schema';
import { gitWorktreeSchema } from './shell/gitWorktree.schema';
import { processSchema } from './shell/process.schema';
import { bashSchema } from './shell/bash.schema';
import { grepSchema } from './shell/grep.schema';

// search/
import { toolSearchSchema } from './search/toolSearch.schema';

// skill/
import { skillCreateSchema } from './skill/skillCreate.schema';
import { skillSchema } from './skill/skill.schema';

// lsp/
import { diagnosticsSchema } from './lsp/diagnostics.schema';
import { lspSchema } from './lsp/lsp.schema';

// connectors/
import { mailSchema } from './connectors/mail.schema';
import { mailSendSchema } from './connectors/mailSend.schema';
import { mailDraftSchema } from './connectors/mailDraft.schema';
import { remindersSchema } from './connectors/reminders.schema';
import { remindersCreateSchema } from './connectors/remindersCreate.schema';
import { remindersUpdateSchema } from './connectors/remindersUpdate.schema';
import { remindersDeleteSchema } from './connectors/remindersDelete.schema';
import { calendarSchema } from './connectors/calendar.schema';
import { calendarCreateEventSchema } from './connectors/calendarCreateEvent.schema';
import { calendarUpdateEventSchema } from './connectors/calendarUpdateEvent.schema';
import { calendarDeleteEventSchema } from './connectors/calendarDeleteEvent.schema';

// document/
import { docEditSchema } from './document/docEdit.schema';

// network/
import { httpRequestSchema } from './network/httpRequest.schema';
import { readDocumentSchema } from './network/readDocument.schema';
import { readDocxSchema } from './network/readDocx.schema';
import { readPdfSchema } from './network/readPdf.schema';
import { readXlsxSchema } from './network/readXlsx.schema';
import { chartGenerateSchema } from './network/chartGenerate.schema';
import { mermaidExportSchema } from './network/mermaidExport.schema';
import { qrcodeGenerateSchema } from './network/qrcodeGenerate.schema';
import { jiraSchema } from './network/jira.schema';
import { githubPrSchema } from './network/githubPr.schema';
import { twitterFetchSchema } from './network/twitterFetch.schema';
import { youtubeTranscriptSchema } from './network/youtubeTranscript.schema';
import { academicSearchSchema } from './network/academicSearch.schema';

// lightMemory/
import { memoryReadSchema } from './lightMemory/memoryRead.schema';
import { memoryWriteSchema } from './lightMemory/memoryWrite.schema';

// planning/
import { planModeFacadeSchema } from './planning/planModeFacade.schema';
import { enterPlanModeSchema } from './planning/enterPlanMode.schema';
import { exitPlanModeSchema } from './planning/exitPlanMode.schema';

export function registerMigratedTools(registry: ToolRegistry): void {
  // ── file/ batch 1 ─────────────────────────────────────────────────────
  registry.register(
    listDirectorySchema,
    async () => (await import('./file/listDirectory')).listDirectoryModule,
  );

  // multiEdit registers as 'Edit' (legacy 同名)
  registry.register(
    multiEditSchema,
    async () => (await import('./file/multiEdit')).editModule,
  );

  registry.register(
    notebookEditSchema,
    async () => (await import('./file/notebookEdit')).notebookEditModule,
  );

  registry.register(
    readClipboardSchema,
    async () => (await import('./file/readClipboard')).readClipboardModule,
  );

  // ── shell/ batch 2a ───────────────────────────────────────────────────
  registry.register(
    killShellSchema,
    async () => (await import('./shell/killShell')).killShellModule,
  );

  registry.register(
    taskOutputSchema,
    async () => (await import('./shell/taskOutput')).taskOutputModule,
  );

  // ── shell/ batch 2c: git 三件套 ───────────────────────────────────────
  registry.register(
    gitDiffSchema,
    async () => (await import('./shell/gitDiff')).gitDiffModule,
  );

  registry.register(
    gitCommitSchema,
    async () => (await import('./shell/gitCommit')).gitCommitModule,
  );

  registry.register(
    gitWorktreeSchema,
    async () => (await import('./shell/gitWorktree')).gitWorktreeModule,
  );

  // ── batch 3: search/skill/lsp wrapper 模式 ────────────────────────────
  registry.register(
    toolSearchSchema,
    async () => (await import('./search/toolSearch')).toolSearchModule,
  );

  registry.register(
    skillCreateSchema,
    async () => (await import('./skill/skillCreate')).skillCreateModule,
  );

  registry.register(
    skillSchema,
    async () => (await import('./skill/skill')).skillModule,
  );

  registry.register(
    diagnosticsSchema,
    async () => (await import('./lsp/diagnostics')).diagnosticsModule,
  );

  registry.register(
    lspSchema,
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
    mailSchema,
    async () => (await import('./connectors/mail')).mailModule,
  );
  registry.register(
    mailSendSchema,
    async () => (await import('./connectors/mailSend')).mailSendModule,
  );
  registry.register(
    mailDraftSchema,
    async () => (await import('./connectors/mailDraft')).mailDraftModule,
  );
  registry.register(
    remindersSchema,
    async () => (await import('./connectors/reminders')).remindersModule,
  );
  registry.register(
    remindersCreateSchema,
    async () => (await import('./connectors/remindersCreate')).remindersCreateModule,
  );
  registry.register(
    remindersUpdateSchema,
    async () => (await import('./connectors/remindersUpdate')).remindersUpdateModule,
  );
  registry.register(
    remindersDeleteSchema,
    async () => (await import('./connectors/remindersDelete')).remindersDeleteModule,
  );
  registry.register(
    calendarSchema,
    async () => (await import('./connectors/calendar')).calendarModule,
  );
  registry.register(
    calendarCreateEventSchema,
    async () => (await import('./connectors/calendarCreateEvent')).calendarCreateEventModule,
  );
  registry.register(
    calendarUpdateEventSchema,
    async () => (await import('./connectors/calendarUpdateEvent')).calendarUpdateEventModule,
  );
  registry.register(
    calendarDeleteEventSchema,
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
    docEditSchema,
    async () => (await import('./document/docEdit')).docEditModule,
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
    planModeFacadeSchema,
    async () => (await import('./planning/planModeFacade')).planModeFacadeModule,
  );
  registry.register(
    enterPlanModeSchema,
    async () => (await import('./planning/enterPlanMode')).enterPlanModeModule,
  );
  registry.register(
    exitPlanModeSchema,
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
  // http_request → native ToolModule
  registry.register(
    httpRequestSchema,
    async () => (await import('./network/httpRequest')).httpRequestModule,
  );

  // Document reading (4) — all native
  registry.register(
    readDocumentSchema,
    async () => (await import('./network/readDocument')).readDocumentModule,
  );
  registry.register(
    readDocxSchema,
    async () => (await import('./network/readDocx')).readDocxModule,
  );
  registry.register(
    readPdfSchema,
    async () => (await import('./network/readPdf')).readPdfModule,
  );
  registry.register(
    readXlsxSchema,
    async () => (await import('./network/readXlsx')).readXlsxModule,
  );

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

  // Visual helpers (4) — chart/mermaid/qrcode 已迁移为 native，带完整 schema
  registry.register(
    chartGenerateSchema,
    async () => (await import('./network/chartGenerate')).chartGenerateModule,
  );
  registry.register(
    mermaidExportSchema,
    async () => (await import('./network/mermaidExport')).mermaidExportModule,
  );
  registry.register(
    qrcodeGenerateSchema,
    async () => (await import('./network/qrcodeGenerate')).qrcodeGenerateModule,
  );
  REGISTER_NET('screenshot_page', 'Take a screenshot of a webpage.', 'network',
    async () => (await import('./network/wrappers')).screenshotPageModule, true);

  // External integrations (5) — all native ToolModule with real schemas
  registry.register(
    jiraSchema,
    async () => (await import('./network/jira')).jiraModule,
  );
  registry.register(
    githubPrSchema,
    async () => (await import('./network/githubPr')).githubPrModule,
  );
  registry.register(
    twitterFetchSchema,
    async () => (await import('./network/twitterFetch')).twitterFetchModule,
  );
  registry.register(
    youtubeTranscriptSchema,
    async () => (await import('./network/youtubeTranscript')).youtubeTranscriptModule,
  );
  registry.register(
    academicSearchSchema,
    async () => (await import('./network/academicSearch')).academicSearchModule,
  );

  // ── shell/ batch 2b: Process facade（合并 6 个 process_* 子工具）─────────
  registry.register(
    processSchema,
    async () => (await import('./shell/process')).processModule,
  );

  // ── P0-6.2: legacy core tool wrappers (Bash/Read/Write/Glob/Grep/ppt/memory) ──
  // 这批 tool 迁移前只在 legacy toolRegistry 里注册，dispatch 走 fallback 分支。
  // P0-6.2 删 legacy 前必须把它们 wrap 进 protocol registry，让 isProtocolToolName
  // 覆盖所有 runtime 必须的 tool。

  // file (3): Read / Write / Glob (P0-6.3 Batch 1 — native ToolModule)
  registry.register(
    readSchema,
    async () => (await import('./file/read')).readModule,
  );
  registry.register(
    writeSchema,
    async () => (await import('./file/write')).writeModule,
  );
  registry.register(
    globSchema,
    async () => (await import('./file/glob')).globModule,
  );

  // shell (2): Bash / Grep
  registry.register(
    bashSchema,
    async () => (await import('./shell/bash')).bashModule,
  );
  registry.register(
    grepSchema,
    async () => (await import('./shell/grep')).grepModule,
  );

  // lightMemory (2): MemoryRead / MemoryWrite (P0-6.3 Batch 3 — native ToolModule)
  registry.register(
    memoryReadSchema,
    async () => (await import('./lightMemory/memoryRead')).memoryReadModule,
  );
  registry.register(
    memoryWriteSchema,
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
