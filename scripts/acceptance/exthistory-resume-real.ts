#!/usr/bin/env npx tsx
// ============================================================================
// N-EXTHISTORY-IMPORT-CHATS-RESUME 真跑验收（③ / ⑥）
// ----------------------------------------------------------------------------
// 导入的 Claude Code 会话 → 发送即 fork 出 Neo 原生子会话 → 用子会话的真实消息
// 组装（database.getMessages(child)，与桌面 forkSession 的 setSessionContext 同源）
// 真调 GLM（ZHIPU_CODING_API_KEY，glm-5.3 @ coding 端点），问「我们之前约定的暗号」，
// 断言回复引用旧对话内容；并断言源会话消息条数 + 内容哈希全程不变、前缀里的工具
// 调用历史（降级为一行文本）不导致 provider 拒绝请求。
//
// 不起 webServer 的原因（任务书允许记录）：fork-on-send 的产品路径是
// SessionForkService.createFork（桌面 forkSession 与 web sessionDomainHandler.forkSession
// 的共同实现，src/web/sessionDomainHandler.ts:130 同款直构），直驱等价；真模型调用
// 走 AgentLoop（与 space-context-tools-real-runtime.ts 同款），避免为一个 fork 断言
// 起整套 renderer + webServer。
//
// Run:
//   env -u HTTPS_PROXY -u HTTP_PROXY npx tsx scripts/acceptance/exthistory-resume-real.ts
// ============================================================================

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const CODEWORD = 'PINEAPPLE-MOON-4711';
const PROVIDER = 'zhipu';
const MODEL = 'glm-5.3';
const CODING_BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4';
const PROMPT = '我们之前约定的暗号（codeword）是什么？只用一行回答暗号本身。';

function loadEnvIntoProcess(realHome: string): void {
  try {
    const envPath = join(realHome, '.code-agent', '.env');
    for (const raw of readFileSync(envPath, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const separator = line.indexOf('=');
      if (separator < 0) continue;
      const key = line.slice(0, separator).trim();
      let value = line.slice(separator + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // The key is checked explicitly below.
  }
}

interface RequestSummary {
  url: unknown;
  model: unknown;
  messageCount: number;
  roles: string[];
  containsCodeword: boolean;
  containsToolLine: boolean;
  maxTokens: unknown;
}

interface UsageSummary {
  promptTokens: unknown;
  completionTokens: unknown;
  totalTokens: unknown;
}

function fingerprint(rows: Array<Record<string, unknown>>): { count: number; hash: string } {
  const projection = rows.map((row) => [row.id, row.role, row.content, row.timestamp]);
  return {
    count: rows.length,
    hash: createHash('sha256').update(JSON.stringify(projection)).digest('hex'),
  };
}

async function main(): Promise<void> {
  const realHome = process.env.HOME || homedir();
  loadEnvIntoProcess(realHome);
  delete process.env.HTTPS_PROXY;
  delete process.env.HTTP_PROXY;
  delete process.env.https_proxy;
  delete process.env.http_proxy;

  const apiKey = process.env.ZHIPU_CODING_API_KEY;
  if (!apiKey) {
    throw new Error('ZHIPU_CODING_API_KEY is not configured (expected in ~/.code-agent/.env)');
  }

  const root = mkdtempSync(join(tmpdir(), 'exthistory-resume-real-'));
  const dataDir = join(root, 'data');
  const claudeRoot = join(root, 'claude-projects');
  const codexRoot = join(root, 'codex-sessions');
  const workspace = join(root, 'workspace');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(claudeRoot, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  process.env.HOME = root;
  process.env.CODE_AGENT_HOME = root;
  process.env.CODE_AGENT_DATA_DIR = dataDir;
  process.env.CODE_AGENT_E2E = '1';
  // 防 keychain 污染（见错题本 standalone-diag-webmode-keychain-trap）
  process.env.CODE_AGENT_WEB_MODE = 'true';

  const keep = process.argv.includes('--keep');
  const sessionId = 'claude-resume-real';
  const sourcePath = join(claudeRoot, sessionId, `${sessionId}.jsonl`);
  mkdirSync(join(claudeRoot, sessionId), { recursive: true });
  writeFileSync(sourcePath, [
    JSON.stringify({
      type: 'user',
      uuid: 'u-1',
      sessionId,
      timestamp: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString(),
      cwd: workspace,
      message: { content: [{ type: 'text', text: `我们这个项目约定暗号 ${CODEWORD}，先用 Read 工具读一下配置确认。` }] },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'a-1',
      sessionId,
      timestamp: new Date(Date.now() - 3 * 24 * 3600 * 1000 + 1000).toISOString(),
      message: {
        content: [
          { type: 'text', text: '正在读取配置文件确认暗号。' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/project-config.json' } },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      uuid: 'u-2',
      sessionId,
      timestamp: new Date(Date.now() - 3 * 24 * 3600 * 1000 + 2000).toISOString(),
      message: { content: [{ type: 'text', text: '配置里写的是什么？' }] },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'a-2',
      sessionId,
      timestamp: new Date(Date.now() - 3 * 24 * 3600 * 1000 + 3000).toISOString(),
      message: { content: [{ type: 'text', text: `配置确认了暗号就是 ${CODEWORD}。` }] },
    }),
  ].join('\n') + '\n');

  const axios = (await import('axios')).default;
  const requestSummaries: RequestSummary[] = [];
  const usageSummaries: UsageSummary[] = [];
  const rawReplies: string[] = [];
  const requestInterceptor = axios.interceptors.request.use((config) => {
    if (typeof config.data === 'string') {
      try {
        const parsed = JSON.parse(config.data) as {
          model?: unknown;
          messages?: Array<{ role?: string; content?: unknown }>;
          max_tokens?: unknown;
        };
        if (Array.isArray(parsed.messages)) {
          const serialized = JSON.stringify(parsed.messages);
          requestSummaries.push({
            url: config.url,
            model: parsed.model,
            messageCount: parsed.messages.length,
            roles: parsed.messages.map((message) => String(message.role ?? '?')),
            containsCodeword: serialized.includes(CODEWORD),
            containsToolLine: serialized.includes('Read'),
            maxTokens: parsed.max_tokens,
          });
        }
      } catch {
        // Ignore non-JSON bodies.
      }
    }
    return config;
  });
  const responseInterceptor = axios.interceptors.response.use((response) => {
    const data = response.data as {
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
    };
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.trim()) rawReplies.push(content);
    if (data?.usage) {
      usageSummaries.push({
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      });
    }
    return response;
  });

  try {
    const { StandaloneAgentAdapter } = await import('../../src/host/testing/agentAdapter');
    await StandaloneAgentAdapter._ensureElectronMock();
    const { initializeCLIServices } = await import('../../src/cli/bootstrap');
    await initializeCLIServices({ dangerouslySkipPermissions: true });
    const { getConfigService } = await import('../../src/host/services/core/configService');
    const { getDatabase } = await import('../../src/host/services/core/databaseService');
    const { getProjectService } = await import('../../src/host/services/project/projectService');
    const { SessionHistoryAppService } = await import('../../src/host/app/sessionHistoryAppService');
    const { SessionForkService } = await import('../../src/host/services/sessionFork/SessionForkService');
    const { AgentEngineHistoryImportService } = await import('../../src/host/services/agentEngine/agentEngineHistoryImport');
    const { importRecentExternalChats } = await import('../../src/host/externalImport/chatsImport');
    const { resolveExternalEngineLaunch } = await import('../../src/host/services/agentEngine/agentEngineGuards');
    const { resolveSessionDefaultModelConfig } = await import('../../src/host/services/core/sessionDefaults');
    const { AgentLoop } = await import('../../src/host/agent/agentLoop');
    const { ToolExecutor } = await import('../../src/host/tools/toolExecutor');
    const { SYSTEM_PROMPT } = await import('../../src/host/prompts/builder');
    const { LOCAL_SESSION_FORK_OWNER_SCOPE_ID } = await import('../../src/shared/contract/sessionForkPortability');

    const database = getDatabase();
    await database.initialize();

    // 「应用当前默认模型」= zhipu / glm-5.3 @ coding 端点（与用户在模型配置页的写法一致）
    await getConfigService().updateSettings({
      models: {
        default: PROVIDER,
        providers: {
          [PROVIDER]: { enabled: true, model: MODEL, baseUrl: CODING_BASE_URL, apiKey },
        },
        routing: {
          code: { provider: PROVIDER, model: MODEL },
          vision: { provider: PROVIDER, model: MODEL },
          fast: { provider: PROVIDER, model: MODEL },
          gui: { provider: PROVIDER, model: MODEL },
        },
      },
    });

    // ① 导入 fixture（产品路径：importRecentExternalChats → importSessionFork）
    const historyRoots = { claudeProjectsRoot: claudeRoot, codexSessionsRoot: codexRoot };
    const importResults = await importRecentExternalChats({
      ownerScopeId: LOCAL_SESSION_FORK_OWNER_SCOPE_ID,
      historyService: new AgentEngineHistoryImportService({ roots: historyRoots }),
      resolveProject: (cwd, now) => getProjectService().ensureProjectForWorkspace(cwd, now),
      hasExistingImport: () => false,
      importFork: (input) => new SessionHistoryAppService(
        () => undefined as never,
      ).importSessionFork({
        envelope: input.envelope,
        targetProjectId: input.targetProjectId,
        namespace: input.namespace,
      }),
    });
    if (importResults.length !== 1 || importResults[0].status !== 'imported') {
      throw new Error(`fixture import failed: ${JSON.stringify(importResults)}`);
    }

    const raw = database.getDb();
    if (!raw) throw new Error('database handle missing');
    const importedRow = raw.prepare(
      "SELECT * FROM sessions WHERE origin LIKE '%\"kind\":\"import\"%' LIMIT 1",
    ).get() as Record<string, unknown>;
    if (!importedRow) throw new Error('imported session row not found');
    const importedSessionId = String(importedRow.id);

    const sourceMessagesBefore = raw.prepare(
      'SELECT id, role, content, timestamp FROM messages WHERE session_id = ? ORDER BY timestamp ASC, rowid ASC',
    ).all(importedSessionId) as Array<Record<string, unknown>>;
    const sourceBefore = fingerprint(sourceMessagesBefore);
    const sourceEngineBefore = String(importedRow.agent_engine);
    const sourceModelBefore = [importedRow.model_provider, importedRow.model_name];

    // ② 直发闸：导入会话上的外部引擎 launch 必须抛清晰错误（send 路径第一步就会撞上）
    const { rowToSession } = await import('../../src/host/services/core/repositories/sessionRepositoryParsers');
    const importedSession = rowToSession(importedRow);
    let guardMessage = '';
    try {
      resolveExternalEngineLaunch(importedSession, importedSession.engine!);
      throw new Error('guard did not throw for an imported session');
    } catch (error) {
      guardMessage = error instanceof Error ? error.message : String(error);
    }
    if (!/imported read-only history.*never changes/.test(guardMessage)) {
      throw new Error(`unexpected guard message: ${guardMessage}`);
    }

    // ③ fork-on-send（产品路径：SessionForkService.createFork，web forkSession 同款直构）
    const anchorRow = raw.prepare(
      "SELECT id FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY timestamp ASC, rowid ASC",
    ).all(importedSessionId) as Array<{ id: string }>;
    const anchorId = anchorRow[anchorRow.length - 1]?.id;
    if (!anchorId) throw new Error('no assistant anchor in the imported fixture');
    const fork = await new SessionForkService(database, { ownerUserId: null }).createFork({
      sourceSessionId: importedSessionId,
      anchorAssistantMessageId: anchorId,
      idempotencyKey: `exthistory-resume-real:${Date.now()}`,
      workspaceMode: 'shared_current',
    });

    const childRow = raw.prepare('SELECT * FROM sessions WHERE id = ?').get(fork.childSession.id) as Record<string, unknown>;
    const childEngine = JSON.parse(String(childRow.agent_engine)) as Record<string, unknown>;
    if (childEngine.kind !== 'native' || childEngine.origin !== 'manual') {
      throw new Error(`child engine is not native/manual: ${childRow.agent_engine}`);
    }
    if (childRow.model_name === 'claude-history' || childRow.model_provider === 'claude') {
      throw new Error(`child model still the placeholder history model: ${String(childRow.model_provider)}/${String(childRow.model_name)}`);
    }
    if (childRow.model_provider !== PROVIDER || childRow.model_name !== MODEL) {
      throw new Error(`child model is not the app default: ${String(childRow.model_provider)}/${String(childRow.model_name)}`);
    }

    // ④ 真模型：子会话的真实消息组装（与桌面 forkSession setSessionContext 同源）
    const childMessages = database.getMessages(fork.childSession.id);
    if (childMessages.length !== sourceBefore.count) {
      throw new Error(`child prefix not copied: ${childMessages.length} != ${sourceBefore.count}`);
    }
    const messages = [...childMessages];
    const modelConfig = resolveSessionDefaultModelConfig();
    const errors: string[] = [];
    const toolExecutor = new ToolExecutor({
      requestPermission: async () => true,
      workingDirectory: workspace,
    });
    const loop = new AgentLoop({
      sessionId: fork.childSession.id,
      workingDirectory: workspace,
      projectConfigDirectory: workspace,
      systemPrompt: SYSTEM_PROMPT,
      modelConfig: {
        ...modelConfig,
        provider: PROVIDER as 'zhipu',
        model: MODEL,
        apiKey,
        baseUrl: CODING_BASE_URL,
        temperature: 0,
        reasoningEffort: 'low',
        maxTokens: 4096,
      },
      maxIterations: 3,
      enableToolDeferredLoading: false,
      autoApprovePlan: true,
      persistLongTermMemory: false,
      includeRecentConversations: false,
      toolExecutor,
      messages,
      onEvent: (event) => {
        if (event.type === 'error') {
          errors.push(String((event.data as { message?: unknown } | undefined)?.message ?? 'unknown runtime error'));
        }
      },
    });
    messages.push({
      id: `user-real-${Date.now()}`,
      role: 'user',
      content: PROMPT,
      timestamp: Date.now(),
    });
    await loop.run(PROMPT);

    if (errors.length > 0) throw new Error(`agent loop errors: ${errors.join(' | ')}`);
    const replyMessage = [...messages].reverse().find((message) => message.role === 'assistant');
    const reply = replyMessage?.content ?? '';
    if (!reply.includes(CODEWORD)) {
      throw new Error(`model reply did not cite the codeword: ${reply.slice(0, 400)}`);
    }

    // ⑤ 源会话完整性：全程条数 + 哈希不变，engine/model 列不变
    const sourceMessagesAfter = raw.prepare(
      'SELECT id, role, content, timestamp FROM messages WHERE session_id = ? ORDER BY timestamp ASC, rowid ASC',
    ).all(importedSessionId) as Array<Record<string, unknown>>;
    const sourceAfter = fingerprint(sourceMessagesAfter);
    if (sourceAfter.count !== sourceBefore.count || sourceAfter.hash !== sourceBefore.hash) {
      throw new Error(`source session mutated: before=${JSON.stringify(sourceBefore)} after=${JSON.stringify(sourceAfter)}`);
    }
    const importedRowAfter = raw.prepare('SELECT * FROM sessions WHERE id = ?').get(importedSessionId) as Record<string, unknown>;
    if (String(importedRowAfter.agent_engine) !== sourceEngineBefore) {
      throw new Error('source session engine column mutated');
    }
    if (`${importedRowAfter.model_provider}/${importedRowAfter.model_name}` !== `${sourceModelBefore[0]}/${sourceModelBefore[1]}`) {
      throw new Error('source session model columns mutated');
    }

    // ⑥ 工具调用历史不导致 provider 拒绝：请求真的发出且拿到了回复
    const modelRequest = requestSummaries.at(-1);
    if (!modelRequest) throw new Error('no model request was captured');
    if (!modelRequest.containsCodeword) {
      throw new Error('the child prefix (with the codeword) did not reach the provider');
    }
    if (!modelRequest.containsToolLine) {
      throw new Error('the tool-call history line did not reach the provider');
    }

    // tokens：流式响应不带 usage，读 BudgetService 的产品记账（与 UI 成本面板同源）。
    const { getBudgetService } = await import('../../src/host/services/core/budgetService');
    const recordedUsage = getBudgetService().getUsageHistory().at(-1) ?? null;

    console.log('=== EXTHISTORY-RESUME REAL RUN PASS ===');
    console.log(`imported session: ${importedSessionId} (messages=${sourceBefore.count})`);
    console.log(`guard message: ${guardMessage}`);
    console.log(`fork child: ${fork.childSession.id} engine=${childRow.agent_engine} model=${String(childRow.model_provider)}/${String(childRow.model_name)} contextDeliveryMode=${fork.lineage.contextDeliveryMode} copied=${fork.copiedMessageCount}`);
    console.log('--- raw request summary (last model call) ---');
    console.log(JSON.stringify(modelRequest));
    console.log('--- raw reply ---');
    console.log(reply);
    console.log('--- usage (BudgetService record) ---');
    console.log(JSON.stringify(recordedUsage));
    console.log(`source integrity: count=${sourceAfter.count} hash=${sourceAfter.hash} (unchanged)`);
    console.log(`requests captured: ${requestSummaries.length}, raw replies captured: ${rawReplies.length}`);
  } finally {
    axios.interceptors.request.eject(requestInterceptor);
    axios.interceptors.response.eject(responseInterceptor);
    if (!keep) rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('=== EXTHISTORY-RESUME REAL RUN FAIL ===');
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
