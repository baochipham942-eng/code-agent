import type { AppSettings } from '../../../shared/contract';
import {
  DEFAULT_PROVIDER,
  DEFAULT_MODELS,
} from '../../../shared/constants';
import { DEFAULT_SPEECH_INPUT_SETTINGS } from '../../../shared/contract/speech';
import {
  createDefaultKeybindingsSettings,
  getKeybindingPlatformFromNodePlatform,
} from '../../../shared/keybindings';

export const DEFAULT_SETTINGS: AppSettings = {
  models: {
    default: DEFAULT_PROVIDER,  // 默认主力 provider
    providers: {
      deepseek: { enabled: true },
      claude: { enabled: true },
      openai: { enabled: false },
      gemini: { enabled: false },
      groq: { enabled: false },
      local: { enabled: true },
      zhipu: { enabled: true },     // 智谱默认启用 (视觉 + 备用语言)
      qwen: { enabled: false },
      moonshot: { enabled: true },  // Kimi K2.5 包月套餐
      minimax: { enabled: false },
      perplexity: { enabled: false },
      grok: { enabled: false },
      openrouter: { enabled: false },
      volcengine: { enabled: false },
      longcat: { enabled: true },   // 默认主力 provider（DEFAULT_PROVIDER，开放平台免费额度）
      xiaomi: { enabled: true },     // 小米 MiMo Token Plan Max 包月套餐
      custom: { enabled: false, baseUrl: undefined, displayName: 'Custom Provider' },
    },
    agentEngines: {},
    // 按用途路由模型 — 引用 DEFAULT_MODELS 常量
    routing: {
      code: { provider: DEFAULT_PROVIDER, model: DEFAULT_MODELS.code },
      // vision 必须配对 xiaomi（DEFAULT_MODELS.vision=mimo-v2-omni；LongCat 无视觉模型）
      vision: { provider: 'xiaomi', model: DEFAULT_MODELS.vision },
      fast: { provider: 'zhipu', model: DEFAULT_MODELS.quick },
      gui: { provider: 'zhipu', model: DEFAULT_MODELS.visionFast },
    },
    taskStrategy: {
      mode: 'auto',
      defaultProfile: 'main',
      profiles: {
        fast: { provider: 'zhipu', model: DEFAULT_MODELS.quick, reasoningEffort: 'low', maxTokens: 4096 },
        main: { provider: DEFAULT_PROVIDER, model: DEFAULT_MODELS.chat, reasoningEffort: 'medium', maxTokens: 16384 },
        // 深度档用 DeepSeek 的推理模型——provider 必须配对 deepseek，避免出现 xiaomi/deepseek-v4-pro 这种错配。
        deep: { provider: 'deepseek', model: DEFAULT_MODELS.reasoning, reasoningEffort: 'high', maxTokens: 32768 },
        // vision 必须配对 xiaomi（LongCat 无视觉模型）
        vision: { provider: 'xiaomi', model: DEFAULT_MODELS.vision, reasoningEffort: 'medium', maxTokens: 4096 },
      },
      fallback: {
        enabled: true,
        preferSameProvider: true,
        allowCrossProvider: true,
      },
      rules: [
        {
          id: 'simple-chat-fast',
          label: '短问答 / 格式整理',
          intent: 'simple_chat',
          enabled: true,
          profile: 'fast',
          reason: '短输入、无文件引用时优先用快速任务模型',
        },
        {
          id: 'code-main',
          label: '代码 / 文件任务',
          intent: 'coding',
          enabled: true,
          profile: 'main',
          reason: '代码、文件和工具任务使用任务主模型',
        },
        {
          id: 'research-deep',
          label: '研究 / 规划 / 重构',
          intent: 'research',
          enabled: true,
          profile: 'deep',
          reason: '复杂规划、研究和重构使用深度任务模型',
        },
        {
          id: 'vision-route',
          label: '图片 / 视觉输入',
          intent: 'vision',
          enabled: true,
          profile: 'vision',
          reason: '包含图片时使用视觉任务模型',
        },
      ],
    },
  },
  workspace: {
    recentDirectories: [],
  },
  permissions: {
    autoApprove: {
      read: true,
      write: false,
      execute: false,
      network: false,
    },
    blockedCommands: [
      'rm -rf /',
      'rm -rf ~',
      'sudo rm',
      ':(){:|:&};:',
    ],
    // SECURITY: devModeAutoApprove only enabled in development
    // In production (packaged app), this is always false
    devModeAutoApprove: false,
  },
  ui: {
    theme: 'system',
    fontSize: 14,
    showToolCalls: true,
    language: 'zh',
    disclosureLevel: 'standard',
  },
  // 云端 Agent 配置
  cloud: {
    enabled: false,
    endpoint: undefined,
    apiKey: undefined,
    warmupOnInit: true,
  },
  // GUI Agent 配置
  guiAgent: {
    enabled: false,
    displayWidth: 1920,
    displayHeight: 1080,
  },
  // 原生连接器默认全关
  connectors: {
    enabledNative: [],
  },
  contextCompression: {
    enabled: true,
    warningThreshold: 0.75,
    criticalThreshold: 0.85,
    preserveRecentCount: 10,
    triggerTokens: 100000,
    compactProvider: 'moonshot',
    compactModel: DEFAULT_MODELS.compact,
    auditEnabled: true,
  },
  appshots: {
    enabled: true,
    targetSession: 'current',
  },
  speech: DEFAULT_SPEECH_INPUT_SETTINGS,
  keybindings: createDefaultKeybindingsSettings(getKeybindingPlatformFromNodePlatform(process.platform)),
};
