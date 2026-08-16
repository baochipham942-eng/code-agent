import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
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
/** Neo 的事件 sink 插件在 dsh 树上的 id，与 `sink.mjs` 的 `name` 同名，`--dump-config` 可见。 */
const DSH_EVENT_SINK_ID = 'neo-event-sink';
/** Neo 的 resume runner 插件在 dsh 树上的 id，与 `resume-runner.mjs` 的 `name` 同名。 */
const DSH_RESUME_RUNNER_ID = 'neo-resume-runner';
/** shipped 的一次性 runner 在 dsh 树上的 id；resume patch 会对它 `disabled: true`。 */
const DSH_HEADLESS_RUNNER_ID = 'headless-runner';
/**
 * dsh 的只读档：shipped headless profile 自己就读这个环境变量
 * （`sandbox-policy.mode = process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`，
 * approval 策略同源），预设表里也已有 `read-only` 条目。真机验证过一次写文件尝试：
 * 沙箱拒绝、升级因无审批通道 fail-closed、文件未创建。
 */
const DSH_READ_ONLY_MODE = 'read-only';
/** provider/model 只允许这个字符集，既是 dsh 的实际 id 形态，也挡住 YAML 注入。 */
const DSH_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

interface DshModelSelection {
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
    '--patch <event-sink-patch>',
    ...(parseDshModelSelection(model) ? ['--patch <model-patch>'] : []),
    '<prompt:redacted>',
  ].join(' '),
};

/**
 * DeepSeek Harness（`@deepseek-ai/dsh`）的 headless profile 自己只往 stdout 打印
 * 最终回答；事件流由 Neo 随包带的 Cordis 插件补上（`resources/dsh-event-sink/sink.mjs`，
 * 通过 `--patch` 挂进 dsh 的插件树）。N-DSH1b 走的是分叉点探测里的路线 C。
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
function parseDshModelSelection(model?: string | null): DshModelSelection | null {
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
function writeDshModelPatch(selection: DshModelSelection): string {
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
    '--patch',
    writeDshEventSinkPatch(),
    ...(selection ? ['--patch', writeDshModelPatch(selection)] : []),
    prompt,
  ];
}

/**
 * 找到随包带的 dsh 插件（sink / resume runner 同一目录同一套候选表）。找不到就抛：
 * 少了 sink 整条事件流会静默变哑，少了 resume runner 恢复只会新开会话丢上下文，
 * 而 Neo 的 manifest 已经声明了 `stream_events` / `resume`，声明与实际必须一起成立。
 */
function resolveDshPluginPath(fileName: string, envOverride: string | undefined, label: string, missingConsequence: string): string {
  const resourcesPath = String((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath || '');
  const candidates = [
    envOverride,
    path.join(process.cwd(), 'resources', 'dsh-event-sink', fileName),
    ...(resourcesPath
      ? [
          path.join(resourcesPath, 'resources', 'dsh-event-sink', fileName),
          path.join(resourcesPath, '_up_', 'resources', 'dsh-event-sink', fileName),
        ]
      : []),
  ].filter((value): value is string => Boolean(value));
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`DeepSeek Harness 的${label}插件没找到（找过：${candidates.join('、')}）。${missingConsequence}`);
  }
  return found;
}

function resolveDshEventSinkPath(): string {
  return resolveDshPluginPath(
    'sink.mjs',
    process.env.CODE_AGENT_DSH_EVENT_SINK,
    '事件流',
    '没有它 dsh 只会打印最终答案，工具调用和流式文本都看不见。',
  );
}

function resolveDshResumeRunnerPath(): string {
  return resolveDshPluginPath(
    'resume-runner.mjs',
    process.env.CODE_AGENT_DSH_RESUME_RUNNER,
    'resume runner ',
    '没有它恢复只会新开一个 dsh 会话、丢掉之前的上下文。',
  );
}

/**
 * 写一份把事件 sink 插进 dsh 插件树的 patch 层，返回它的路径。
 *
 * 名字里带插件路径的哈希：同一个安装位置复用同一份、可重复写入，换了安装位置
 * （dev 工作树 / 打包后的 app）自然换一份，不会读到上一次的旧路径。
 */
function writeDshEventSinkPatch(): string {
  const sinkPath = resolveDshEventSinkPath();
  const patchDir = path.join(tmpdir(), 'agent-neo-dsh-sink-patches');
  mkdirSync(patchDir, { recursive: true });
  const patchPath = path.join(patchDir, `${createHash('sha256').update(sinkPath).digest('hex').slice(0, 16)}.yml`);
  // 插件路径下发成 file:// URL：dsh 的 loader 把裸包名按 profile 目录解析，
  // 只有 URL 形态能指到 Neo 自己的安装目录（`--dump-config` 里能看到这一行）。
  writeFileSync(
    patchPath,
    `- insert:\n    - id: ${DSH_EVENT_SINK_ID}\n      name: '${pathToFileURL(sinkPath).href}'\n`,
    'utf8',
  );
  return patchPath;
}

/**
 * 写一份「关掉 shipped runner、换上 Neo 的 resume runner」的 dsh patch 层，返回它的路径。
 *
 * `headless-startup` 那行留着不动：task 仍走位置参数，由它解析后经 `!!js` 喂给
 * resume runner（空 task 它自己报 usage error，天然挡住空恢复指令）。
 * 文件名带 runner 路径与 session id 的哈希：同一组合复用同一份、可重复写入。
 */
function writeDshResumePatch(resumeSessionId: string): string {
  const normalized = resumeSessionId.trim();
  if (!DSH_ID_PATTERN.test(normalized)) {
    throw new Error(`DeepSeek Harness 会话 id 只允许字母、数字、点、下划线和连字符，收到 "${resumeSessionId}"。`);
  }
  const runnerPath = resolveDshResumeRunnerPath();
  const patchDir = path.join(tmpdir(), 'agent-neo-dsh-resume-patches');
  mkdirSync(patchDir, { recursive: true });
  const digest = createHash('sha256').update(`${runnerPath}\n${normalized}`).digest('hex').slice(0, 16);
  const patchPath = path.join(patchDir, `${digest}.yml`);
  writeFileSync(
    patchPath,
    `- id: ${DSH_HEADLESS_RUNNER_ID}\n`
    + '  disabled: true\n'
    + '- insert:\n'
    + `    - id: ${DSH_RESUME_RUNNER_ID}\n`
    + `      name: '${pathToFileURL(runnerPath).href}'\n`
    + '      inject: [headlessStartup]\n'
    + '      config:\n'
    + '        task: !!js ctx.headlessStartup.task\n'
    + `        resumeSessionId: '${normalized}'\n`,
    'utf8',
  );
  return patchPath;
}

/**
 * 恢复一条 dsh 会话的完整 argv：事件 sink 照常挂（恢复的那一轮同样要逐帧事件 +
 * session 行做身份确认），再叠 resume patch，模型选择与普通跑法同规则。
 */
export function buildDshResumeArgs(input: {
  model?: string | null;
  resumeSessionId: string;
  task: string;
}): string[] {
  if (!input.task.trim()) {
    throw new Error('DeepSeek Harness resume requires a non-empty task.');
  }
  const selection = parseDshModelSelection(input.model);
  return [
    '--profile',
    DSH_PROFILE,
    '--patch',
    writeDshEventSinkPatch(),
    '--patch',
    writeDshResumePatch(input.resumeSessionId),
    ...(selection ? ['--patch', writeDshModelPatch(selection)] : []),
    input.task,
  ];
}

/**
 * 解析事件 sink 吐出来的 NDJSON。
 *
 * 非 JSON 行一律丢弃：headless runner 自己在最后还会把最终答案原样打一遍，
 * 而 `final` 事件里已经带了同一段文本，再渲染一次就是重复。
 * sink 挂不上不会走到这里 —— dsh 的 `assertEntriesActivated` 会让 boot 直接失败、
 * 进程非零退出，Neo 侧呈现为一次失败的 run 而不是空洞的成功。
 */
export function parseDshLine(line: string): ClaudeParsedEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let event: DshSinkEvent;
  try {
    event = JSON.parse(trimmed) as DshSinkEvent;
  } catch {
    return null;
  }
  switch (event.type) {
    case 'session':
      return event.sessionId ? { externalSessionId: event.sessionId } : null;
    case 'text':
      return event.text ? { textDelta: event.text, textDeltaSource: 'stream' } : null;
    case 'final':
      return event.text ? { finalText: event.text } : null;
    case 'tool_call':
      return event.name ? { toolName: event.name } : null;
    case 'tool_result':
      return event.error ? { error: event.error } : null;
    case 'turn_end':
      return event.reason ? { status: event.reason } : null;
    case 'error':
      return event.message ? { error: event.message } : null;
    default:
      // reasoning 等 Neo 暂不渲染的类型走这里；未知类型同样静默丢弃，
      // 因为 sink 与本文件同仓同版本，多出来的类型只可能是还没接线的新事件。
      return null;
  }
}

/** 事件 sink 吐出来的行，字段与 `resources/dsh-event-sink/sink.mjs` 一一对应。 */
interface DshSinkEvent {
  type: string;
  sessionId?: string;
  text?: string;
  name?: string;
  error?: string;
  reason?: string;
  message?: string;
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
