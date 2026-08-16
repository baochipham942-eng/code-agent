import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildDshArgs,
  buildDshEnv,
  buildDshResumeArgs,
  parseDshLine,
} from '../../../src/host/services/agentEngine/dshCliAdapter';

/** 事件 sink 的 --patch 恒在最前，模型 patch（如果有）跟在它后面。 */
const SINK_PATCH_INDEX = 3;

describe('DshCliAdapter protocol', () => {
  it('always mounts the event sink and omits the model patch when no model is chosen', () => {
    for (const model of [undefined, 'client_default']) {
      const args = buildDshArgs('read_only', model, 'nonce');
      expect(args.slice(0, 3)).toEqual(['--profile', 'headless', '--patch']);
      expect(args[4]).toBe('nonce');
      // 插件走 file:// URL 下发：dsh 的 loader 把裸包名按它自己的 profile 目录解析，
      // 只有 URL 形态能指到 Neo 的安装目录。
      expect(fs.readFileSync(args[SINK_PATCH_INDEX], 'utf8')).toMatch(
        /^- insert:\n {4}- id: neo-event-sink\n {6}name: 'file:\/\/.*\/resources\/dsh-event-sink\/sink\.mjs'\n$/,
      );
    }
  });

  it('translates a provider/model selection into a second --patch overlay', () => {
    const args = buildDshArgs('read_only', 'deepseek-official/deepseek-v4-pro', 'nonce');
    expect(args.slice(0, 3)).toEqual(['--profile', 'headless', '--patch']);
    expect(args[4]).toBe('--patch');
    expect(args[6]).toBe('nonce');
    // dsh 的 --patch 是整块替换而非深合并，provider 必须和 model 一起写进去。
    expect(fs.readFileSync(args[5], 'utf8')).toBe(
      '- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-v4-pro\n',
    );
  });

  it('refuses a model that carries no provider or smuggles YAML', () => {
    expect(() => buildDshArgs('read_only', 'deepseek-v4-pro', 'nonce')).toThrow(/<provider>\/<model>/);
    expect(() => buildDshArgs('read_only', '/deepseek-v4-pro', 'nonce')).toThrow(/<provider>\/<model>/);
    expect(() => buildDshArgs('read_only', 'p/m\n    task: pwned', 'nonce')).toThrow(/只允许字母/);
  });

  it('refuses to launch when the event sink plugin is missing', () => {
    // 没有 sink 就没有事件流，而 manifest 已经声明了 stream_events——宁可开不起来，
    // 也不要一个「跑通了但什么都没渲染」的会话。
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sink-missing-'));
    const previousCwd = process.cwd();
    const previousOverride = process.env.CODE_AGENT_DSH_EVENT_SINK;
    delete process.env.CODE_AGENT_DSH_EVENT_SINK;
    process.chdir(empty);
    try {
      expect(() => buildDshArgs('read_only', undefined, 'nonce')).toThrow(/事件流插件没找到/);
    } finally {
      process.chdir(previousCwd);
      if (previousOverride !== undefined) process.env.CODE_AGENT_DSH_EVENT_SINK = previousOverride;
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('builds resume args: sink patch first, then a runner-swap patch, task as the positional', () => {
    const args = buildDshResumeArgs({ resumeSessionId: 'session-abc', task: 'what number did I ask you to remember?' });
    expect(args.slice(0, 3)).toEqual(['--profile', 'headless', '--patch']);
    expect(args[4]).toBe('--patch');
    expect(args[6]).toBe('what number did I ask you to remember?');
    expect(args).toHaveLength(7);
    // 恢复的那一轮同样要事件流：sink patch 原样在最前。
    expect(fs.readFileSync(args[SINK_PATCH_INDEX], 'utf8')).toContain('neo-event-sink');
    // resume patch：关掉 shipped runner、换上 Neo 的 runner；headless-startup 不动，
    // task 仍由它解析（!!js），session id 以受限字符集写死在 config 里。
    expect(fs.readFileSync(args[5], 'utf8')).toMatch(
      new RegExp(
        '^- id: headless-runner\n'
        + '  disabled: true\n'
        + '- insert:\n'
        + ' {4}- id: neo-resume-runner\n'
        + " {6}name: 'file://.*/resources/dsh-event-sink/resume-runner\\.mjs'\n"
        + ' {6}inject: \\[headlessStartup\\]\n'
        + ' {6}config:\n'
        + ' {8}task: !!js ctx\\.headlessStartup\\.task\n'
        + " {8}resumeSessionId: 'session-abc'\n$",
      ),
    );
  });

  it('layers the model overlay after the resume patch when a provider/model is chosen', () => {
    const args = buildDshResumeArgs({
      model: 'deepseek-official/deepseek-v4-pro',
      resumeSessionId: 'session-abc',
      task: 'nonce',
    });
    expect(args.filter((value) => value === '--patch')).toHaveLength(3);
    expect(args.at(-1)).toBe('nonce');
    expect(fs.readFileSync(args[7], 'utf8')).toContain('provider: deepseek-official');
  });

  it('refuses a resume session id that smuggles YAML and an empty task', () => {
    expect(() => buildDshResumeArgs({ resumeSessionId: "x'\n- pwned", task: 'nonce' })).toThrow(/只允许字母/);
    expect(() => buildDshResumeArgs({ resumeSessionId: 'session-abc', task: '  ' })).toThrow(/non-empty task/);
  });

  it('refuses to resume when the resume runner plugin is missing', () => {
    // manifest 已声明 resume——少了 runner 只会「新开会话装作恢复」，宁可开不起来。
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runner-missing-'));
    const previousCwd = process.cwd();
    const previousSink = process.env.CODE_AGENT_DSH_EVENT_SINK;
    const previousRunner = process.env.CODE_AGENT_DSH_RESUME_RUNNER;
    // sink 指到真文件，让失败只可能来自 runner 缺失。
    process.env.CODE_AGENT_DSH_EVENT_SINK = path.join(previousCwd, 'resources', 'dsh-event-sink', 'sink.mjs');
    delete process.env.CODE_AGENT_DSH_RESUME_RUNNER;
    process.chdir(empty);
    try {
      expect(() => buildDshResumeArgs({ resumeSessionId: 'session-abc', task: 'nonce' })).toThrow(/resume runner 插件没找到/);
    } finally {
      process.chdir(previousCwd);
      if (previousSink !== undefined) process.env.CODE_AGENT_DSH_EVENT_SINK = previousSink;
      else delete process.env.CODE_AGENT_DSH_EVENT_SINK;
      if (previousRunner !== undefined) process.env.CODE_AGENT_DSH_RESUME_RUNNER = previousRunner;
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('maps the sink NDJSON onto the shared parsed-event shape', () => {
    expect(parseDshLine('{"type":"session","sessionId":"session-abc"}'))
      .toEqual({ externalSessionId: 'session-abc' });
    expect(parseDshLine('{"type":"text","text":"你好"}'))
      .toEqual({ textDelta: '你好', textDeltaSource: 'stream' });
    expect(parseDshLine('{"type":"final","text":"完整答案"}'))
      .toEqual({ finalText: '完整答案' });
    expect(parseDshLine('{"type":"tool_call","name":"read","callId":"call_1"}'))
      .toEqual({ toolName: 'read' });
    expect(parseDshLine('{"type":"turn_end","reason":"completed"}'))
      .toEqual({ status: 'completed' });
    expect(parseDshLine('{"type":"error","message":"quota: exhausted"}'))
      .toEqual({ error: 'quota: exhausted' });
    expect(parseDshLine('{"type":"tool_result","callId":"call_1","error":"E_IO: ReadError"}'))
      .toEqual({ error: 'E_IO: ReadError' });
  });

  it('drops malformed and uninteresting lines instead of rendering them', () => {
    // headless runner 自己在最后还会把最终答案原样打一遍——final 事件已经带了同一段
    // 文本，把这些纯文本行也渲染出来就是重复。
    expect(parseDshLine('probe.txt 里只有一行内容。')).toBeNull();
    expect(parseDshLine('')).toBeNull();
    expect(parseDshLine('   ')).toBeNull();
    // 半行 / 坏 JSON：NDJSON 按行切，进程被杀时最后一行可能是残缺的。
    expect(parseDshLine('{"type":"text","text":"半')).toBeNull();
    expect(parseDshLine('{')).toBeNull();
    // 未知事件类型、以及 Neo 暂不渲染的类型。
    expect(parseDshLine('{"type":"reasoning","text":"想一想"}')).toBeNull();
    expect(parseDshLine('{"type":"某个还没接线的新事件"}')).toBeNull();
    // 字段缺失：不能翻成一条空事件塞进渲染管线。
    expect(parseDshLine('{"type":"text"}')).toBeNull();
    expect(parseDshLine('{"type":"session"}')).toBeNull();
    expect(parseDshLine('{"type":"tool_call","callId":"call_1"}')).toBeNull();
    // 成功的 tool_result 不带 error，本身不产任何 Neo 事件。
    expect(parseDshLine('{"type":"tool_result","callId":"call_1"}')).toBeNull();
  });

  it('pins the read-only sandbox, withholds proxies, and forwards no credentials', () => {
    const previous = {
      key: process.env.OPENAI_API_KEY,
      deepseek: process.env.DEEPSEEK_API_KEY,
      proxy: process.env.HTTPS_PROXY,
    };
    process.env.OPENAI_API_KEY = 'must-not-forward';
    process.env.DEEPSEEK_API_KEY = 'must-not-forward';
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7897';
    try {
      const env = buildDshEnv();
      expect(env.OPENAI_API_KEY).toBeUndefined();
      // 密钥归 dsh 自己的 ~/.dsh 管，Neo 不读不传。
      expect(env.DEEPSEEK_API_KEY).toBeUndefined();
      // dsh 直连 api.deepseek.com，带上本机代理只会打不通。
      expect(env.HTTPS_PROXY).toBeUndefined();
      expect(env.HTTP_PROXY).toBeUndefined();
      // Neo 声明的 read_only 档必须真下发给 dsh 自己的沙箱，否则它默认 workspace-write。
      expect(env.DSH_PERMISSION_MODE).toBe('read-only');
      expect(env.HOME).toBeTruthy();
      expect(env.PATH).toBeTruthy();
    } finally {
      for (const [key, value] of [
        ['OPENAI_API_KEY', previous.key],
        ['DEEPSEEK_API_KEY', previous.deepseek],
        ['HTTPS_PROXY', previous.proxy],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('reuses one patch file per provider/model pair', () => {
    const first = buildDshArgs('read_only', 'deepseek-official/deepseek-v4-flash', 'nonce')[5];
    const second = buildDshArgs('read_only', 'deepseek-official/deepseek-v4-flash', 'nonce')[5];
    expect(second).toBe(first);
  });
});
