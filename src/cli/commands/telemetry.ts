// ============================================================================
// Telemetry CLI — `neo telemetry status` / `neo telemetry preview`
// ============================================================================
//
// 轻量路由（见 src/cli/index.ts）：只读配置文件 + 纯函数，不发网络请求，不写数据库。
// 设置文件与 ConfigService 相同：<userData>/config.json。
// userData = CODE_AGENT_DATA_DIR，否则 <homedir>/.code-agent。这里不走 getUserDataPath，
// 那个函数会缓存第一次的结果，CLI 必须看本次进程的环境变量。

import { Command } from 'commander';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CONFIG_DIR_NEW } from '../../shared/constants/configDir';
import {
  explainPrivacyFlags,
  type PrivacyFlagSource,
  type PrivacyResolution,
} from '../../shared/observability/privacyFlags';
import {
  TELEMETRY_PREVIEW_SESSION_ID,
  TELEMETRY_PREVIEW_USER_ID,
  buildTelemetryPreviewTurn,
  buildTelemetryTurnUploadRow,
} from '../../host/telemetry/telemetryUploadRow';

const CHANNELS = ['posthog', 'cloudUpload', 'langfuse', 'crashReporting'] as const;

interface JsonOption {
  json?: boolean;
}

function wantsJson(options: JsonOption): boolean {
  return Boolean(options.json) || process.argv.includes('--json');
}

function userConfigPath(env: NodeJS.ProcessEnv): string {
  const explicit = env.CODE_AGENT_DATA_DIR?.trim();
  const dataDir = explicit ? explicit : path.join(os.homedir(), CONFIG_DIR_NEW);
  return path.join(dataDir, 'config.json');
}

function readUserSettings(env: NodeJS.ProcessEnv): unknown {
  try {
    return JSON.parse(fs.readFileSync(userConfigPath(env), 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function formatStatus(resolution: PrivacyResolution, json: boolean): string {
  if (json) return `${JSON.stringify(resolution, null, 2)}\n`;
  const lines = ['telemetry status'];
  for (const channel of CHANNELS) {
    const decision = resolution[channel];
    const value = decision.enabled ? 'on' : 'off';
    const source: PrivacyFlagSource = decision.source;
    lines.push(`  ${channel.padEnd(16)} ${value.padEnd(5)} source=${source}`);
  }
  return `${lines.join('\n')}\n`;
}

const statusCommand = new Command('status')
  .description('打印每个遥测通道的生效值和来源（只读，不联网）')
  .option('--json', 'JSON 格式输出')
  .action((options: JsonOption) => {
    const resolution = explainPrivacyFlags(readUserSettings(process.env), process.env);
    process.stdout.write(formatStatus(resolution, wantsJson(options)));
  });

const previewCommand = new Command('preview')
  .description('用真实上传构造器打印一条合成信封，不发送请求')
  .option('--json', 'JSON 格式输出')
  .action((options: JsonOption) => {
    const homeDir = os.homedir();
    const turn = buildTelemetryPreviewTurn(homeDir);
    const envelope = buildTelemetryTurnUploadRow(
      turn,
      TELEMETRY_PREVIEW_SESSION_ID,
      TELEMETRY_PREVIEW_USER_ID,
      homeDir,
    );
    const body = wantsJson(options)
      ? JSON.stringify(envelope)
      : JSON.stringify(envelope, null, 2);
    process.stdout.write(`${body}\n`);
  });

export const telemetryCommand = new Command('telemetry')
  .description('查看遥测开关状态，或预览一条不会发出的上传信封')
  .addCommand(statusCommand)
  .addCommand(previewCommand);
