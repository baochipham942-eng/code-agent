import type { MCPServerConfig } from '../main/mcp/mcpClient';

type WorkspaceSettingsForBootstrap = {
  defaultOpenTarget?: string;
  pinnedDirectory?: string;
  recentDirectories?: string[];
  defaultDirectory?: string;
};

type SupabaseSettingsForBootstrap = {
  url?: string;
  anonKey?: string;
};

export type ConfigServiceForBootstrap = {
  getSettings: () => {
    mcp?: {
      servers?: MCPServerConfig[];
    };
    workspace?: WorkspaceSettingsForBootstrap;
    supabase?: SupabaseSettingsForBootstrap;
  };
};

type LoggerLike = {
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
};

const noopLogger: LoggerLike = {
  info: () => undefined,
  warn: () => undefined,
};

type PluginModule = {
  initPluginSystem: () => Promise<void> | void;
};

export type InitializeWebPluginSystemOptions = {
  importProtocolRegistry?: () => Promise<unknown>;
  importPlugins?: () => Promise<PluginModule>;
  broadcastSSE?: (channel: string, data: unknown) => void;
  logger?: LoggerLike;
};

export async function initializeWebPluginSystem(
  options: InitializeWebPluginSystemOptions = {},
): Promise<void> {
  const importProtocolRegistry = options.importProtocolRegistry
    ?? (() => import('../main/tools/protocolRegistry'));
  const importPlugins = options.importPlugins
    ?? (() => import('../main/plugins') as Promise<PluginModule>);
  const broadcastSSE = options.broadcastSSE ?? (() => undefined);
  const logger = options.logger ?? noopLogger;

  try {
    await importProtocolRegistry();
    const { initPluginSystem } = await importPlugins();
    await initPluginSystem();
    logger.info('Plugin system initialized');
    broadcastSSE('mcp:event', {
      type: 'capabilities_changed',
      data: [{ server: 'plugins' }],
    });
  } catch (error) {
    logger.warn('Plugin system initialization failed (non-blocking):', (error as Error).message);
  }
}

export type WebCapabilityBootstrapOptions = {
  initializeSkills?: (configService: ConfigServiceForBootstrap) => Promise<void>;
  initializeMcp?: (configService: ConfigServiceForBootstrap) => Promise<void>;
  initializePlugins?: () => Promise<void>;
  logger?: LoggerLike;
};

export function startWebCapabilityBootstrap(
  configService: ConfigServiceForBootstrap,
  options: WebCapabilityBootstrapOptions = {},
): void {
  const initializeSkills = options.initializeSkills ?? (async () => undefined);
  const initializeMcp = options.initializeMcp ?? (async () => undefined);
  const initializePlugins = options.initializePlugins ?? (() => initializeWebPluginSystem());
  const logger = options.logger ?? noopLogger;

  void (async () => {
    logger.info('Starting web capability bootstrap in background');
    await initializePlugins();
    await initializeSkills(configService);
    await initializeMcp(configService);
    logger.info('Web capability bootstrap complete');
  })().catch((error) => {
    logger.warn('Web capability bootstrap failed (non-blocking):', (error as Error).message);
  });
}
