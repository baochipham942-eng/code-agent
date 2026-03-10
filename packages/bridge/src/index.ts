import { loadConfig, ensureAuthToken, getConfigPath, updateConfig } from './config';
import path from 'node:path';
import { createBridgeServer } from './server';
import { fileReadTool } from './tools/fileRead';
import { fileGlobTool } from './tools/fileGlob';
import { fileGrepTool } from './tools/fileGrep';
import { directoryListTool } from './tools/directoryList';
import { clipboardReadTool } from './tools/clipboardRead';
import { systemInfoTool } from './tools/systemInfo';
import { fileWriteTool } from './tools/fileWrite';
import { fileEditTool } from './tools/fileEdit';
import { fileDownloadTool } from './tools/fileDownload';
import { openFileTool } from './tools/openFile';
import { shellExecTool } from './tools/shellExec';
import { processManageTool } from './tools/processManage';
import type { BridgeConfig, ToolDefinition } from './types';

const VERSION = '0.16.50';

function parseArgs(argv: string[]): { configPath?: string; overrides: Partial<BridgeConfig> } {
  const overrides: Partial<BridgeConfig> = {};
  let configPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--port' && next) {
      overrides.port = Number(next);
      index += 1;
    } else if (arg === '--working-dir' && next) {
      overrides.workingDirectories = [...(overrides.workingDirectories ?? []), next];
      index += 1;
    } else if (arg === '--security-level' && next) {
      overrides.securityLevel = next as BridgeConfig['securityLevel'];
      index += 1;
    } else if (arg === '--config' && next) {
      configPath = next;
      index += 1;
    }
  }
  return { configPath, overrides };
}

async function main(): Promise<void> {
  const { configPath = getConfigPath(), overrides } = parseArgs(process.argv.slice(2));
  const loadedConfig = await loadConfig(configPath);
  const config = {
    ...loadedConfig,
    ...overrides,
    workingDirectories: (overrides.workingDirectories ?? loadedConfig.workingDirectories).map((item) =>
      path.resolve(item)
    ),
  };
  const token = await ensureAuthToken();
  const tools = new Map<string, ToolDefinition>(
    [
      fileReadTool,
      fileGlobTool,
      fileGrepTool,
      directoryListTool,
      clipboardReadTool,
      systemInfoTool,
      fileWriteTool,
      fileEditTool,
      fileDownloadTool,
      openFileTool,
      shellExecTool,
      processManageTool,
    ].map((tool) => [tool.name, tool])
  );

  const server = await createBridgeServer({
    config,
    token,
    version: VERSION,
    tools,
    onConfigUpdate: (next) => updateConfig(next, configPath),
  });

  await server.listen();
  process.stdout.write(`code-agent-bridge listening on http://127.0.0.1:${config.port}\n`);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
