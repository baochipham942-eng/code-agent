import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import type { AgentEnginePermissionProfile } from '../../../shared/contract/agentEngine';
import { getShellPath } from '../infra/shellEnvironment';
import {
  ClaudeCodeAdapter,
  type ClaudeParsedEvent,
  type ClaudeProtocolCliConfig,
} from './claudeCodeAdapter';

/** dsh 的一次性任务 profile：接一条任务、打印最终回答、退出。 */
const DSH_PROFILE = 'headless';
/** 不下发模型时的哨兵值，与 WorkBuddy 同形态：让 dsh 用它自己配置的默认 provider/model。 */
const CLIENT_DEFAULT_MODEL = 'client_default';
/** dsh 侧承载默认 provider/model 的插件 id（`dsh --profile headless --dump-config` 可见）。 */
const DEFAULT_MODEL_PLUGIN_ID = 'agent-default-model';
/**
 * dsh 的只读档：shipped headless profile 自己就读这个环境变量
 * （`sandbox-policy.mode = process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`，
 * approval 策略同源），预设表里也已有 `read-only` 条目。真机验证过一次写文件尝试：
 * 沙箱拒绝、升级因无审批通道 fail-closed、文件未创建。
 */
const DSH_READ_ONLY_MODE = 'read-only';
/** provider/model 只允许这个字符集，既是 dsh 的实际 id 形态，也挡住 YAML 注入。 */
const DSH_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface DshModelSelection {
  provider: string;
  model: string;
}

const DSH_CONFIG: ClaudeProtocolCliConfig = {
  kind: 'dsh_cli',
  label: 'DeepSeek Harness',
  runPrefix: 'dsh',
  logSlug: 'dsh',
  errorCode: 'DSH_CLI_FAILED',
  promptTransport: 'argv',
  buildArgs: buildDshArgs,
  buildEnv: buildDshEnv,
  parseJsonLine: parseDshLine,
  commandSummary: (model) => [
    `DSH_PERMISSION_MODE=${DSH_READ_ONLY_MODE} dsh --profile ${DSH_PROFILE}`,
    ...(parseDshModelSelection(model) ? ['--patch <model-patch>'] : []),
    '<prompt:redacted>',
  ].join(' '),
};

/**
 * DeepSeek Harness（`@deepseek-ai/dsh`）的 headless profile 只往 stdout 打印最终
 * 回答，没有 JSON 事件流可解析（N-DSH1 分叉点探测：`--profile headless --help`
 * 只有 `-h`，`dsh-headless/lib/index.js` 只有一句 `io.stdout.write(outcome.text)`）。
 * 事件流渲染与 durable 恢复要等 dsh 侧的事件 sink 插件，见 N-DSH1b。
 */
export class DshCliAdapter extends ClaudeCodeAdapter {
  constructor() {
    super(DSH_CONFIG);
  }
}

/**
 * 把 Neo 侧的模型选择翻译成 dsh 认的 `provider/model`。
 *
 * dsh 的 `--patch` 对同一 plugin id 的 config 是**整块替换**而非深合并（实测：
 * 只给 `model` 会把 `provider: deepseek-official` 一起抹掉），所以两者必须成对下发，
 * 只给模型名无法安全翻译。
 */
export function parseDshModelSelection(model?: string | null): DshModelSelection | null {
  const trimmed = model?.trim();
  if (!trimmed || trimmed === CLIENT_DEFAULT_MODEL) return null;
  const separator = trimmed.indexOf('/');
  if (separator <= 0 || separator === trimmed.length - 1) {
    throw new Error(
      `DeepSeek Harness 模型必须写成 "<provider>/<model>"（例如 deepseek-official/deepseek-v4-pro），收到 "${trimmed}"。`,
    );
  }
  const provider = trimmed.slice(0, separator);
  const modelId = trimmed.slice(separator + 1);
  if (!DSH_ID_PATTERN.test(provider) || !DSH_ID_PATTERN.test(modelId)) {
    throw new Error(`DeepSeek Harness provider/model 只允许字母、数字、点、下划线和连字符，收到 "${trimmed}"。`);
  }
  return { provider, model: modelId };
}

/**
 * 写一份只覆盖默认 provider/model 的 dsh patch 层，返回它的路径。
 *
 * 文件名由 provider/model 决定，因此同一组合复用同一份、可重复写入，不需要按 run 清理；
 * 内容是两个受限字符集的 id，既非机密也完全由所选模型决定，所以落临时目录即可，不引 YAML 库。
 */
export function writeDshModelPatch(selection: DshModelSelection): string {
  const patchDir = path.join(tmpdir(), 'agent-neo-dsh-model-patches');
  mkdirSync(patchDir, { recursive: true });
  const patchPath = path.join(patchDir, `${selection.provider}__${selection.model}.yml`);
  writeFileSync(
    patchPath,
    `- id: ${DEFAULT_MODEL_PLUGIN_ID}\n  config:\n    provider: ${selection.provider}\n    model: ${selection.model}\n`,
    'utf8',
  );
  return patchPath;
}

export function buildDshArgs(
  _profile: AgentEnginePermissionProfile,
  model?: string | null,
  prompt?: string,
): string[] {
  if (!prompt?.trim()) {
    throw new Error('DeepSeek Harness requires a non-empty prompt.');
  }
  const selection = parseDshModelSelection(model);
  return [
    '--profile',
    DSH_PROFILE,
    ...(selection ? ['--patch', writeDshModelPatch(selection)] : []),
    prompt,
  ];
}

/**
 * dsh headless 的 stdout 只有最终回答本身，一个事件都没有，所以每一行就是真文本。
 * 空行照样下发（`'\n'`），否则回答里的段落分隔会在渲染时丢掉。
 */
export function parseDshLine(line: string): ClaudeParsedEvent | null {
  return { textDelta: `${line}\n`, textDeltaSource: 'stream' };
}

export function buildDshEnv(): NodeJS.ProcessEnv {
  // 代理变量不在白名单里：dsh 直连 api.deepseek.com，走本机 Claude 网关只会打不通。
  const allowed = new Set([
    'HOME',
    'PATH',
    'SHELL',
    'TERM',
    'TMPDIR',
    'USER',
    'LOGNAME',
    'LANG',
    'NO_PROXY',
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (allowed.has(key) || key.startsWith('LC_') || key.startsWith('XDG_')) {
      env[key] = value;
    }
  }
  env.HOME = env.HOME || homedir();
  env.PATH = getShellPath();
  // 基类的 assertReadOnlyExternalProfile 已把权限档钉死在 read_only，这里把同一条
  // 约束下发给 dsh 自己的沙箱，否则它默认是 workspace-write，会真往工作区写文件。
  env.DSH_PERMISSION_MODE = DSH_READ_ONLY_MODE;
  // 密钥归 dsh 自己的 ~/.dsh/.credentials.yaml 管，Neo 不读不传（实测不带任何
  // DEEPSEEK_API_KEY 也能跑通），DSH_HOME 只在用户显式指定时透传。
  const dshHome = process.env.DSH_HOME?.trim();
  if (dshHome) env.DSH_HOME = dshHome;
  return env;
}
