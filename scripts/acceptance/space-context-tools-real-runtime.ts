#!/usr/bin/env npx tsx
// ============================================================================
// Collaboration space context + space_create real-runtime acceptance.
//
// Uses an isolated data directory, a real Xiaomi model request, and the
// production AgentLoop/ToolExecutor/ProjectService path. An axios request
// interceptor inspects the serialized request body immediately before it is
// sent, without logging credentials or unrelated conversation content.
//
// Run:
//   env -u HTTPS_PROXY -u HTTP_PROXY npx tsx \
//     scripts/acceptance/space-context-tools-real-runtime.ts
// ============================================================================

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

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
    // A configured provider key is checked explicitly below.
  }
}

function extractSpaceContext(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return null;
  const serialized = JSON.stringify(messages);
  const start = serialized.indexOf('<collaboration_space_context>');
  const endMarker = '</collaboration_space_context>';
  const end = serialized.indexOf(endMarker, start);
  if (start < 0 || end < 0) return null;
  return serialized.slice(start, end + endMarker.length).replaceAll('\\n', '\n');
}

async function main(): Promise<void> {
  const realHome = process.env.HOME || homedir();
  loadEnvIntoProcess(realHome);
  delete process.env.HTTPS_PROXY;
  delete process.env.HTTP_PROXY;
  delete process.env.https_proxy;
  delete process.env.http_proxy;

  const root = mkdtempSync(join(tmpdir(), 'space-real-runtime-'));
  const dataDir = join(root, 'data');
  const sourceWorkspace = join(root, 'source-workspace');
  const createdWorkspace = join(root, 'model-created-workspace');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(sourceWorkspace, { recursive: true });
  mkdirSync(createdWorkspace, { recursive: true });
  process.env.HOME = root;
  process.env.CODE_AGENT_HOME = root;
  process.env.CODE_AGENT_DATA_DIR = dataDir;
  process.env.CODE_AGENT_E2E = '1';
  process.env.CODE_AGENT_DISABLE_RECENT_CONVERSATIONS = 'true';
  const provider = process.env.SPACE_ACCEPTANCE_PROVIDER || 'deepseek';
  const model = process.env.SPACE_ACCEPTANCE_MODEL || 'deepseek-chat';

  const axios = (await import('axios')).default;
  const capturedBodies: unknown[] = [];
  const interceptorId = axios.interceptors.request.use((config) => {
    if (typeof config.data === 'string') {
      try {
        const parsed = JSON.parse(config.data) as unknown;
        if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { messages?: unknown }).messages)) {
          capturedBodies.push(parsed);
        }
      } catch {
        // Ignore non-JSON requests.
      }
    }
    return config;
  });

  try {
    const { initializeCLIServices } = await import('../../src/cli/bootstrap');
    const { getConfigService } = await import('../../src/host/services/core/configService');
    const { getDatabase } = await import('../../src/host/services/core/databaseService');
    const { resolveSessionDefaultModelConfig } = await import('../../src/host/services/core/sessionDefaults');
    const { getProjectService } = await import('../../src/host/services/project/projectService');
    const { getProjectSkillPreferenceStore } = await import('../../src/host/services/skills/projectSkillPreferenceService');
    const { installBuiltinRoles } = await import('../../src/host/services/roleAssets');
    const { initAgentRegistry, disposeAgentRegistry } = await import('../../src/host/agent/agentRegistry');
    const { getCronService } = await import('../../src/host/cron/cronService');
    const { AgentLoop } = await import('../../src/host/agent/agentLoop');
    const { ToolExecutor } = await import('../../src/host/tools/toolExecutor');
    const { getAllToolDefinitions } = await import('../../src/host/tools/dispatch/toolDefinitions');
    const { SYSTEM_PROMPT } = await import('../../src/host/prompts/builder');
    const { evaluateFolderTrust } = await import('../../src/host/security/folderTrustService');
    const { estimateTokens } = await import('../../src/host/context/tokenEstimator');

    await initializeCLIServices({ dangerouslySkipPermissions: true });
    const database = getDatabase();
    await database.initialize();
    await installBuiltinRoles();
    await initAgentRegistry(sourceWorkspace);

    const modelConfig = resolveSessionDefaultModelConfig({ provider, model });
    const configuredKey = getConfigService().getApiKey(provider) || modelConfig.apiKey;
    if (!configuredKey) {
      throw new Error(`${provider}/${model} apiKey is not configured`);
    }

    const projectService = getProjectService();
    const now = Date.now();
    const sourceSpace = await projectService.createSpace({
      name: '真实验收上下文空间',
      description: '验证模型请求载荷中的空间配置',
      workspacePath: sourceWorkspace,
    }, now);
    projectService.addRole(sourceSpace.id, '数据分析师', now + 1);
    projectService.selectCapability(sourceSpace.id, 'connector', 'mail', now + 2);
    getProjectSkillPreferenceStore(sourceWorkspace).setOverride('data-analysis-helper', true);

    const cron = getCronService();
    await cron.initialize();
    await cron.createJob({
      name: '空间日报验收',
      description: 'real-runtime acceptance fixture',
      scheduleType: 'every',
      schedule: { type: 'every', interval: 1, unit: 'days' },
      action: {
        type: 'agent',
        agentType: 'general',
        prompt: '生成空间日报',
        libraryProjectId: sourceSpace.id,
      },
      enabled: false,
    });

    const workspaceScope = projectService.getWorkspaceScope(sourceSpace.id);
    if (!workspaceScope) throw new Error('source collaboration space has no workspace scope');

    const sessionId = `space-real-runtime-${now}`;
    const authorUserId = 'member-real-runtime';
    database.createSessionWithId(sessionId, {
      title: '协作空间真实验收',
      userId: 'owner-real-runtime',
      modelConfig: { provider: provider as 'deepseek', model },
      workingDirectory: sourceWorkspace,
      projectId: sourceSpace.id,
      type: 'chat',
    });
    database.addMessage(sessionId, {
      id: `author-${now}`,
      role: 'user',
      content: '准备创建另一个协作空间',
      timestamp: now,
    });
    database.getDb()?.prepare(
      'UPDATE messages SET author_user_id = ? WHERE id = ?',
    ).run(authorUserId, `author-${now}`);

    const targetName = `模型创建验收空间-${now}`;
    const prompt = [
      '请调用 space_create 工具创建一个新的协作空间。',
      `名称必须是：${targetName}`,
      '描述必须是：真实模型工具链验收',
      `workspacePath 必须是：${createdWorkspace}`,
      '必须实际调用工具，完成后只简短确认。',
    ].join('\n');
    const messages = [{
      id: `user-${now}`,
      role: 'user' as const,
      content: prompt,
      timestamp: now + 1,
    }];
    const toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
    const toolResults: Array<{ name: string; success: boolean }> = [];
    const errors: string[] = [];
    const toolExecutor = new ToolExecutor({
      requestPermission: async () => true,
      workingDirectory: sourceWorkspace,
    });
    const deniedToolNames = getAllToolDefinitions()
      .map((definition) => definition.name)
      .filter((name) => name !== 'space_create');
    const loop = new AgentLoop({
      sessionId,
      workingDirectory: sourceWorkspace,
      projectConfigDirectory: sourceWorkspace,
      workspaceScope,
      systemPrompt: SYSTEM_PROMPT,
      modelConfig: {
        ...modelConfig,
        provider: provider as 'deepseek',
        model,
        apiKey: configuredKey,
        temperature: 0,
        reasoningEffort: 'low',
        maxTokens: 2048,
      },
      maxIterations: 5,
      enableToolDeferredLoading: false,
      deniedToolNames,
      autoApprovePlan: true,
      toolExecutor,
      messages,
      onEvent: (event) => {
        if (event.type === 'tool_call_start') {
          toolCalls.push({
            id: event.data.id,
            name: event.data.name,
            args: event.data.arguments || {},
          });
        } else if (event.type === 'tool_call_end') {
          const call = toolCalls.find((candidate) => candidate.id === event.data.toolCallId);
          toolResults.push({
            name: call?.name || 'unknown',
            success: event.data.success,
          });
        } else if (event.type === 'error') {
          errors.push(event.data?.message || 'unknown runtime error');
        }
      },
    });

    await loop.run(prompt);

    const contextBlock = capturedBodies
      .map(extractSpaceContext)
      .find((candidate): candidate is string => Boolean(candidate));
    if (!contextBlock) throw new Error('actual model request did not contain collaboration space context');

    const expectedContextFragments = [
      `space_id: ${sourceSpace.id}`,
      'space_name: 真实验收上下文空间',
      'space_description: 验证模型请求载荷中的空间配置',
      `initiating_user_id: ${authorUserId}`,
      'selected_experts: 知微 · 数据分析师',
      'selected_skills: data-analysis-helper',
      'selected_connectors: mail',
      'selected_automations: 空间日报验收',
      'treat produced artifacts as belonging to this space',
    ];
    const missingFragments = expectedContextFragments.filter(
      (fragment) => !contextBlock.includes(fragment),
    );
    if (missingFragments.length > 0) {
      throw new Error(`actual request context is missing: ${missingFragments.join(' | ')}`);
    }

    const created = projectService.listProjectsWithActivity(false, true)
      .find((project) => project.name === targetName);
    const createCall = toolCalls.find((call) => call.name === 'space_create');
    const createSucceeded = toolResults.some(
      (result) => result.name === 'space_create' && result.success,
    );
    if (!createCall || !createSucceeded || !created) {
      throw new Error(
        `model space_create chain failed: called=${Boolean(createCall)} success=${createSucceeded} persisted=${Boolean(created)}`,
      );
    }
    const trust = await evaluateFolderTrust(createdWorkspace);
    if (trust.state !== 'trusted') {
      throw new Error(`model-created workspace is not trusted: ${trust.state}`);
    }

    console.log('=== REAL-RUNTIME PASS ===');
    console.log(`provider: ${provider}/${model}`);
    console.log(`captured model requests: ${capturedBodies.length}`);
    console.log(`context chars: ${contextBlock.length}`);
    console.log(`context estimated tokens: ${estimateTokens(contextBlock)}`);
    console.log('cache impact: dynamic-tail-only');
    console.log(`context fields verified: ${expectedContextFragments.length}/${expectedContextFragments.length}`);
    console.log(`tool sequence: ${toolCalls.map((call) => call.name).join(' -> ')}`);
    console.log(`space_create persisted: ${created.id}`);
    console.log(`workspace trust: ${trust.state}`);
    console.log(`runtime errors: ${errors.length}`);

    await cron.shutdown();
    await disposeAgentRegistry();
    database.close();
  } finally {
    axios.interceptors.request.eject(interceptorId);
    rmSync(root, { recursive: true, force: true });
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('REAL-RUNTIME FAIL:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
