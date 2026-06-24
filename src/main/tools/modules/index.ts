// ============================================================================
// Migrated Tools Registry
//
// 注册所有从 legacy 迁移到 ToolModule 形态的工具到 protocol registry。
// 在 protocolRegistry 单例创建时调用。
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
import { appendSchema } from './file/append.schema';
import { globSchema } from './file/glob.schema';
import { blobSchema } from './file/blob.schema';

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

// multiagent/
import { taskSchema } from './multiagent/task.schema';
import { teammateSchema } from './multiagent/teammate.schema';
import { spawnAgentSchema, agentSpawnSchema } from './multiagent/spawnAgent.schema';
import { waitAgentSchema } from './multiagent/waitAgent.schema';
import { collectAgentSchema } from './multiagent/collectAgent.schema';
import { closeAgentSchema } from './multiagent/closeAgent.schema';
import { sendInputSchema } from './multiagent/sendInput.schema';
import { agentMessageSchema } from './multiagent/agentMessage.schema';
import { workflowOrchestrateSchema } from './multiagent/workflowOrchestrate.schema';
import { workflowSchema } from './multiagent/workflow.schema';
import { planReviewSchema } from './multiagent/planReview.schema';
import { sessionManagerSchema } from './session/sessionManager.schema';

// excel/
import { excelAutomateSchema } from './excel/excelAutomate.schema';

// mcp/
import { mcpInvokeSchema } from './mcp/mcpInvoke.schema';
import { mcpAddServerSchema } from './mcp/mcpAddServer.schema';
import { mcpUnifiedSchema } from './mcp/mcpUnified.schema';

// network/
import { webFetchSchema } from './network/webFetch.schema';
import { webFetchUnifiedSchema } from './network/webFetchUnified.schema';
import { webSearchSchema } from './network/webSearch.schema';
import { httpRequestSchema } from './network/httpRequest.schema';
import { readDocumentSchema } from './network/readDocument.schema';
import { readDocxSchema } from './network/readDocx.schema';
import { readPdfSchema } from './network/readPdf.schema';
import { readXlsxSchema } from './network/readXlsx.schema';
import { chartGenerateSchema } from './network/chartGenerate.schema';
import { mermaidExportSchema } from './network/mermaidExport.schema';
import { qrcodeGenerateSchema } from './network/qrcodeGenerate.schema';
import { docxGenerateSchema } from './network/docxGenerate.schema';
import { excelGenerateSchema } from './network/excelGenerate.schema';
import { xlwingsExecuteSchema } from './network/xlwingsExecute.schema';
import { pdfGenerateSchema } from './network/pdfGenerate.schema';
import { pdfCompressSchema } from './network/pdfCompress.schema';
import { pdfAutomateSchema } from './network/pdfAutomate.schema';
import { screenshotPageSchema } from './network/screenshotPage.schema';
import { localSpeechToTextSchema } from './network/localSpeechToText.schema';
import { imageAnalyzeSchema } from './network/imageAnalyze.schema';
import { jiraSchema } from './network/jira.schema';
import { githubPrSchema } from './network/githubPr.schema';
import { twitterFetchSchema } from './network/twitterFetch.schema';
import { youtubeTranscriptSchema } from './network/youtubeTranscript.schema';
import { academicSearchSchema } from './network/academicSearch.schema';
import { pptGenerateSchema } from './network/pptGenerate.schema';
import { pptEditSchema } from './network/pptEdit.schema';

// vision/
// browser / browserAction / browserNavigate / validateHtmlInApp 已剥离到
// builtin plugin `builtin.browserControl`（PR #155），此处不再注册。
// Computer / computer_use / screenshot / gui_agent / ocr_search 已剥离到
// builtin plugin `builtin.computerUse`（Step 6 PR #2），此处不再注册。
// photo_archive 已剥离到 builtin plugin `builtin.photoArchive`
// （Step 6 PR #3），此处不再注册。
import { visualEditSchema } from './vision/visualEdit.schema';
// exploreTool 已迁移到 native (planning/explore.ts)，不再从 multiagentTools 导入

// lightMemory/
import { memoryReadSchema } from './lightMemory/memoryRead.schema';
import { memoryWriteSchema } from './lightMemory/memoryWrite.schema';
import { episodicRecallSchema } from './lightMemory/episodicRecall.schema';
import { historySchema } from './lightMemory/history.schema';
import { proposeRoleSchema } from './roleAuthoring/proposeRole.schema';

// planning/
import { planModeFacadeSchema } from './planning/planModeFacade.schema';
import { enterPlanModeSchema } from './planning/enterPlanMode.schema';
import { exitPlanModeSchema } from './planning/exitPlanMode.schema';
import { planReadSchema } from './planning/planRead.schema';
import { planRecoverRecentWorkSchema } from './planning/planRecoverRecentWork.schema';
import { planUpdateSchema } from './planning/planUpdate.schema';
import { findingsWriteSchema } from './planning/findingsWrite.schema';
import { planFacadeSchema } from './planning/planFacade.schema';
import { taskListSchema } from './planning/taskList.schema';
import { taskGetSchema } from './planning/taskGet.schema';
import { taskCreateSchema } from './planning/taskCreate.schema';
import { taskUpdateSchema } from './planning/taskUpdate.schema';
import { taskManagerSchema } from './planning/taskManager.schema';
import { askUserQuestionSchema } from './planning/askUserQuestion.schema';
import { confirmActionSchema } from './planning/confirmAction.schema';
import { proposeCanvasOpsSchema } from './design/proposeCanvasOps.schema';
import { proposeVideoOpsSchema } from './design/proposeVideoOps.schema';
import { requestDesignAutonomySchema } from './design/requestDesignAutonomy.schema';
import { exploreSchema } from './planning/explore.schema';
import { recommendCapabilitySchema } from './planning/recommendCapability.schema';
import { attemptCompletionSchema } from './planning/attemptCompletion.schema';

export function registerMigratedTools(
  registry: ToolRegistry,
  platform: NodeJS.Platform = process.platform,
): void {
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

  // ── batch 4: vision/ Level 1 native (schema 抽出 + wrapper-mode 委托 legacy)─
  // browser / browser_action / browser_navigate / validate_html_in_app 已剥离到
  // builtin plugin `builtin.browserControl`（PR #155），由 pluginRegistry 注册。
  // Computer / computer_use / screenshot / gui_agent / ocr_search 已剥离到
  // builtin plugin `builtin.computerUse`（Step 6 PR #2），由 pluginRegistry 注册。
  // photo_archive 已剥离到 builtin plugin `builtin.photoArchive`
  // （Step 6 PR #3），由 pluginRegistry 注册。

  // visual_edit — Live Preview 点击元素 → 视觉 LLM 产 diff → 原子落盘
  registry.register(
    visualEditSchema,
    async () => (await import('./vision/visualEdit')).visualEditModule,
  );

  // ── connectors（mail / reminders / calendar）— 全部 native ─────────────
  // 全组走 AppleScript，仅 macOS 注册；Windows 工具列表不出现注定 unavailable 的项，
  // 省 LLM 无效调用轮次（windows-support.md §1.5 降级面决策）。
  if (platform === 'darwin') {
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
  }

  // ── batch 6: multiagent/ — 9 工具全部 native（Wave 3 完成，wrappers.ts 已删除）─
  registry.register(
    taskSchema,
    async () => (await import('./multiagent/task')).taskModule,
  );
  registry.register(
    teammateSchema,
    async () => (await import('./multiagent/teammate')).teammateModule,
  );
  registry.register(
    spawnAgentSchema,
    async () => (await import('./multiagent/spawnAgent')).spawnAgentModule,
  );
  registry.register(
    agentSpawnSchema,
    async () => (await import('./multiagent/spawnAgent')).agentSpawnModule,
  );
  registry.register(
    waitAgentSchema,
    async () => (await import('./multiagent/waitAgent')).waitAgentModule,
  );
  registry.register(
    collectAgentSchema,
    async () => (await import('./multiagent/collectAgent')).collectAgentModule,
  );
  registry.register(
    closeAgentSchema,
    async () => (await import('./multiagent/closeAgent')).closeAgentModule,
  );
  registry.register(
    sendInputSchema,
    async () => (await import('./multiagent/sendInput')).sendInputModule,
  );
  registry.register(
    agentMessageSchema,
    async () => (await import('./multiagent/agentMessage')).agentMessageModule,
  );
  registry.register(
    workflowOrchestrateSchema,
    async () => (await import('./multiagent/workflowOrchestrate')).workflowOrchestrateModule,
  );
  registry.register(
    workflowSchema,
    async () => (await import('./multiagent/workflow')).workflowModule,
  );
  registry.register(
    planReviewSchema,
    async () => (await import('./multiagent/planReview')).planReviewModule,
  );

  registry.register(
    sessionManagerSchema,
    async () => (await import('./session/sessionManager')).sessionManagerModule,
  );

  // ── batch 7: mcp/document/excel/planning（21 个）─────────────────────────

  // mcp (3)
  registry.register(
    mcpInvokeSchema,
    async () => (await import('./mcp/mcpInvoke')).mcpInvokeModule,
  );
  registry.register(
    mcpUnifiedSchema,
    async () => (await import('./mcp/mcpUnified')).mcpUnifiedModule,
  );
  registry.register(
    mcpAddServerSchema,
    async () => (await import('./mcp/mcpAddServer')).mcpAddServerModule,
  );

  // document (1)
  registry.register(
    docEditSchema,
    async () => (await import('./document/docEdit')).docEditModule,
  );

  // excel (1)
  registry.register(
    excelAutomateSchema,
    async () => (await import('./excel/excelAutomate')).excelAutomateModule,
  );

  // planning (16)
  registry.register(
    planReadSchema,
    async () => (await import('./planning/planRead')).planReadModule,
  );
  registry.register(
    planRecoverRecentWorkSchema,
    async () => (await import('./planning/planRecoverRecentWork')).planRecoverRecentWorkModule,
  );
  registry.register(
    planUpdateSchema,
    async () => (await import('./planning/planUpdate')).planUpdateModule,
  );
  registry.register(
    findingsWriteSchema,
    async () => (await import('./planning/findingsWrite')).findingsWriteModule,
  );
  registry.register(
    planFacadeSchema,
    async () => (await import('./planning/planFacade')).planFacadeModule,
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
    taskListSchema,
    async () => (await import('./planning/taskList')).taskListModule,
  );
  registry.register(
    taskGetSchema,
    async () => (await import('./planning/taskGet')).taskGetModule,
  );
  registry.register(
    taskCreateSchema,
    async () => (await import('./planning/taskCreate')).taskCreateModule,
  );
  registry.register(
    taskUpdateSchema,
    async () => (await import('./planning/taskUpdate')).taskUpdateModule,
  );
  registry.register(
    taskManagerSchema,
    async () => (await import('./planning/taskManager')).taskManagerModule,
  );
  registry.register(
    askUserQuestionSchema,
    async () => (await import('./planning/askUserQuestion')).askUserQuestionModule,
  );
  registry.register(
    confirmActionSchema,
    async () => (await import('./planning/confirmAction')).confirmActionModule,
  );
  registry.register(
    proposeCanvasOpsSchema,
    async () => (await import('./design/proposeCanvasOps')).proposeCanvasOpsModule,
  );
  registry.register(
    proposeVideoOpsSchema,
    async () => (await import('./design/proposeVideoOps')).proposeVideoOpsModule,
  );
  registry.register(
    requestDesignAutonomySchema,
    async () => (await import('./design/requestDesignAutonomy')).requestDesignAutonomyModule,
  );
  registry.register(
    exploreSchema,
    async () => (await import('./planning/explore')).exploreModule,
  );
  registry.register(
    recommendCapabilitySchema,
    async () => (await import('./planning/recommendCapability')).recommendCapabilityModule,
  );
  registry.register(
    attemptCompletionSchema,
    async () => (await import('./planning/attemptCompletion')).attemptCompletionModule,
  );

  // ── batch 8: network/ — all native modules ────────────────────────────
  // HTTP / Web fetching (4)
  registry.register(
    webFetchSchema,
    async () => (await import('./network/webFetch')).webFetchModule,
  );
  registry.register(
    webFetchUnifiedSchema,
    async () => (await import('./network/webFetchUnified')).webFetchUnifiedModule,
  );
  registry.register(
    webSearchSchema,
    async () => (await import('./network/webSearch')).webSearchModule,
  );
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
  registry.register(
    docxGenerateSchema,
    async () => (await import('./network/docxGenerate')).docxGenerateModule,
  );
  registry.register(
    excelGenerateSchema,
    async () => (await import('./network/excelGenerate')).excelGenerateModule,
  );
  registry.register(
    pdfGenerateSchema,
    async () => (await import('./network/pdfGenerate')).pdfGenerateModule,
  );
  registry.register(
    pdfCompressSchema,
    async () => (await import('./network/pdfCompress')).pdfCompressModule,
  );
  registry.register(
    pdfAutomateSchema,
    async () => (await import('./network/pdfAutomate')).pdfAutomateModule,
  );
  registry.register(
    xlwingsExecuteSchema,
    async () => (await import('./network/xlwingsExecute')).xlwingsExecuteModule,
  );

  // Media (2) — imageProcess + speech_to_text + text_to_speech + video_generate + image_generate + image_annotate 已剥离为 builtin plugin
  // （src/main/plugins/builtin/imageProcess/、audioProcessing/、videoGeneration/、imageCreation/）
  registry.register(
    imageAnalyzeSchema,
    async () => (await import('./network/imageAnalyze')).imageAnalyzeModule,
  );
  registry.register(
    localSpeechToTextSchema,
    async () => (await import('./network/localSpeechToText')).localSpeechToTextModule,
  );

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
  registry.register(
    screenshotPageSchema,
    async () => (await import('./network/screenshotPage')).screenshotPageModule,
  );

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
    appendSchema,
    async () => (await import('./file/append')).appendModule,
  );
  registry.register(
    globSchema,
    async () => (await import('./file/glob')).globModule,
  );
  registry.register(
    blobSchema,
    async () => (await import('./file/blob')).blobModule,
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

  // lightMemory (3): MemoryRead / MemoryWrite / EpisodicRecall
  registry.register(
    memoryReadSchema,
    async () => (await import('./lightMemory/memoryRead')).memoryReadModule,
  );
  registry.register(
    memoryWriteSchema,
    async () => (await import('./lightMemory/memoryWrite')).memoryWriteModule,
  );
  registry.register(
    episodicRecallSchema,
    async () => (await import('./lightMemory/episodicRecall')).episodicRecallModule,
  );
  registry.register(
    historySchema,
    async () => (await import('./lightMemory/history')).historyModule,
  );

  // roleAuthoring (1): propose_role —— 对话式建角色起草
  registry.register(
    proposeRoleSchema,
    async () => (await import('./roleAuthoring/proposeRole')).proposeRoleModule,
  );

  // network (2): ppt_generate / ppt_edit
  registry.register(
    pptGenerateSchema,
    async () => (await import('./network/pptGenerate')).pptGenerateModule,
  );
  registry.register(
    pptEditSchema,
    async () => (await import('./network/pptEdit')).pptEditModule,
  );
}
