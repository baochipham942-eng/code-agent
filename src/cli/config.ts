// ============================================================================
// CLI Config Service - 独立于 Electron 的配置管理
// ============================================================================

import path from 'path';
import fs from 'fs';
import os from 'os';
import * as dotenv from 'dotenv';
import type { AppSettings, GenerationId, ModelProvider, PermissionLevel } from '../shared/types';
import { DEFAULT_MODELS, DEFAULT_PROVIDER, DEFAULT_MODEL, DEFAULT_GENERATION, MODEL_MAX_TOKENS } from '../shared/constants';

// 加载 .env 文件
function loadEnvFile(): void {
  const possiblePaths = [
    path.join(process.cwd(), '.env'),
    path.join(os.homedir(), '.code-agent', '.env'),
  ];

  for (const envPath of possiblePaths) {
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath });
      break;
    }
  }
}

// 初始化时加载 .env
loadEnvFile();

/**
 * CLI 配置服务 - 简化版，不依赖 Electron
 */
export class CLIConfigService {
  private settings: AppSettings;
  private configPath: string;

  constructor() {
    const dataDir = this.getDataDir();
    this.configPath = path.join(dataDir, 'settings.json');
    this.settings = this.loadSettings();
  }

  /**
   * 获取数据目录
   */
  private getDataDir(): string {
    const dataDir = process.env.CODE_AGENT_DATA_DIR || path.join(os.homedir(), '.code-agent');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    return dataDir;
  }

  /**
   * 加载设置
   */
  private loadSettings(): AppSettings {
    const defaults = this.getDefaultSettings();

    if (fs.existsSync(this.configPath)) {
      try {
        const content = fs.readFileSync(this.configPath, 'utf-8');
        const saved = JSON.parse(content);
        return { ...defaults, ...saved };
      } catch {
        return defaults;
      }
    }

    return defaults;
  }

  /**
   * 获取默认设置
   */
  private getDefaultSettings(): AppSettings {
    return {
      models: {
        default: DEFAULT_MODELS.chat,
        defaultProvider: DEFAULT_PROVIDER as ModelProvider,  // Kimi K2.5 使用 moonshot provider
        providers: {
          deepseek: { enabled: true, model: 'deepseek-chat' }, // deepseek provider 自身的默认模型
          openai: { enabled: false },
          claude: { enabled: false },
          zhipu: { enabled: false },
          groq: { enabled: false },
          gemini: { enabled: false },
          local: { enabled: false },
          qwen: { enabled: false },
          moonshot: { enabled: true, model: DEFAULT_MODELS.chat },  // 启用 moonshot
          minimax: { enabled: false },
          perplexity: { enabled: false },
          openrouter: { enabled: false },
        },
        routing: {
          code: { provider: DEFAULT_PROVIDER as ModelProvider, model: DEFAULT_MODELS.chat },
          vision: { provider: 'zhipu' as ModelProvider, model: DEFAULT_MODELS.vision },
          fast: { provider: 'zhipu' as ModelProvider, model: DEFAULT_MODELS.quick },
          gui: { provider: 'zhipu' as ModelProvider, model: DEFAULT_MODELS.visionFast },
        },
      },
      generation: {
        default: DEFAULT_GENERATION,  // 使用最新代际，支持所有工具
      },
      workspace: {
        recentDirectories: [],
      },
      permissions: {
        autoApprove: {
          network: false,
          read: true,
          write: false,
          execute: false,
        } as Record<PermissionLevel, boolean>,
        blockedCommands: [],
        devModeAutoApprove: true, // CLI 模式默认开启自动批准
      },
      ui: {
        theme: 'dark',
        fontSize: 14,
        showToolCalls: true,
        language: 'zh',
      },
      cloud: {
        enabled: false,
        warmupOnInit: false,
      },
      guiAgent: {
        enabled: false,
        displayWidth: 1920,
        displayHeight: 1080,
      },
      session: {
        autoRestore: false, // CLI 模式不需要恢复会话
        maxHistory: 100,
      },
      model: {
        provider: DEFAULT_PROVIDER as ModelProvider,  // Kimi K2.5
        model: DEFAULT_MODELS.chat,
        temperature: 0.7,
        maxTokens: MODEL_MAX_TOKENS.DEFAULT,
      },
    };
  }

  /**
   * 初始化
   */
  async initialize(): Promise<void> {
    // CLI 模式下无需额外初始化
  }

  /**
   * 获取设置
   */
  getSettings(): AppSettings {
    return this.settings;
  }

  /**
   * 获取 API Key
   */
  getApiKey(provider: string): string {
    const envKeys: Record<string, string> = {
      deepseek: 'DEEPSEEK_API_KEY',
      openai: 'OPENAI_API_KEY',
      zhipu: 'ZHIPU_API_KEY',
      anthropic: 'ANTHROPIC_API_KEY',
      groq: 'GROQ_API_KEY',
      google: 'GOOGLE_API_KEY',
      moonshot: 'KIMI_K25_API_KEY',  // Kimi K2.5
    };

    const envKey = envKeys[provider.toLowerCase()];
    if (envKey && process.env[envKey]) {
      return process.env[envKey] as string;
    }

    return '';
  }

  /**
   * 获取服务 API Key
   */
  getServiceApiKey(service: string): string {
    const envKeys: Record<string, string> = {
      langfuse_public: 'LANGFUSE_PUBLIC_KEY',
      langfuse_secret: 'LANGFUSE_SECRET_KEY',
    };

    const envKey = envKeys[service];
    if (envKey && process.env[envKey]) {
      return process.env[envKey] as string;
    }

    return '';
  }
}

// 单例
let configService: CLIConfigService | null = null;

export function getCLIConfigService(): CLIConfigService {
  if (!configService) {
    configService = new CLIConfigService();
  }
  return configService;
}
