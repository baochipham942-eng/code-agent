import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getScriptedRunPermissionHandler,
  requireScriptedRunPermissionHandler,
} from '../../../../src/host/permissions/scriptedRunPermissionPolicy';

const previousPolicy = process.env.NEO_SCRIPTED_APPROVAL_POLICY;
const previousDataDir = process.env.CODE_AGENT_DATA_DIR;
const previousBridge = process.env.CODE_AGENT_EVAL_BRIDGE;
let tempDir: string | undefined;

function installPolicy(policy: unknown): void {
  tempDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'scripted-approval-policy-'));
  const policyPath = path.join(tempDir, 'policy.json');
  fs.writeFileSync(policyPath, JSON.stringify(policy), 'utf8');
  process.env.NEO_SCRIPTED_APPROVAL_POLICY = policyPath;
  process.env.CODE_AGENT_DATA_DIR = path.join(tempDir, '.code-agent-dev3');
}

function restoreEnv(): void {
  if (previousPolicy === undefined) delete process.env.NEO_SCRIPTED_APPROVAL_POLICY;
  else process.env.NEO_SCRIPTED_APPROVAL_POLICY = previousPolicy;
  if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
  else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
  if (previousBridge === undefined) delete process.env.CODE_AGENT_EVAL_BRIDGE;
  else process.env.CODE_AGENT_EVAL_BRIDGE = previousBridge;
}

// 文件级清理：本文件里不止一个 describe 会改这三个环境变量并建临时目录，
// 钩子挂在某一个 describe 里，别的组跑完就把它们留给了后面的测试文件（#1670 ai-review Nit）。
afterEach(() => {
  restoreEnv();
  vi.unstubAllEnvs();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('scripted run permission policy', () => {

  it('returns undefined when no eval policy path is configured', () => {
    delete process.env.NEO_SCRIPTED_APPROVAL_POLICY;
    expect(getScriptedRunPermissionHandler()).toBeUndefined();
    expect(() => requireScriptedRunPermissionHandler()).toThrow(/审批策略/);
  });

  it('ignores a configured policy outside a dev data slot', () => {
    process.env.NEO_SCRIPTED_APPROVAL_POLICY = '/tmp/policy.json';
    process.env.CODE_AGENT_DATA_DIR = path.join('/tmp', '.code-agent');
    expect(getScriptedRunPermissionHandler()).toBeUndefined();
  });

  it('accepts an explicit real-eval policy outside a named dev slot', () => {
    installPolicy({ version: 1, rules: [] });
    process.env.CODE_AGENT_DATA_DIR = path.join(tempDir!, 'isolated-data');
    delete process.env.CODE_AGENT_EVAL_BRIDGE;

    expect(requireScriptedRunPermissionHandler()).toBeTypeOf('function');
  });

  it('lets the repository policy use local file and safe shell tools while denying side-effect surfaces', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scripted-approval-policy-'));
    process.env.NEO_SCRIPTED_APPROVAL_POLICY = path.resolve('.claude/eval-approval-policy.json');
    process.env.CODE_AGENT_DATA_DIR = path.join(tempDir, 'isolated-data');
    process.env.CODE_AGENT_EVAL_BRIDGE = '1';
    const handler = requireScriptedRunPermissionHandler();

    await expect(handler({ type: 'file_read', tool: 'Read', details: { path: '/tmp/eval/input.txt' } }))
      .resolves.toMatchObject({ approved: true });
    await expect(handler({ type: 'file_write', tool: 'write_file', details: { path: '/tmp/eval/output.txt' } }))
      .resolves.toMatchObject({ approved: true });
    await expect(handler({ type: 'command', tool: 'Bash', details: { command: 'npm test' } }))
      .resolves.toMatchObject({ approved: true });
    await expect(handler({ type: 'dangerous_command', tool: 'Bash', details: { command: 'sudo reboot' } }))
      .resolves.toMatchObject({ approved: false });
    await expect(handler({ type: 'network', tool: 'WebSearch', details: { query: 'secret' } }))
      .resolves.toMatchObject({ approved: false });
    await expect(handler({ type: 'file_write', tool: 'mail_send', details: {} }))
      .resolves.toMatchObject({ approved: false });
    await expect(handler({ type: 'directory_access', tool: 'request_directory', details: { path: '/Users' } }))
      .resolves.toMatchObject({ approved: false });
  });

  // N-EVAL-ORCHARM-REALCASE：扇出实验臂的第三道闸。Task/spawn_agent 的 permissionLevel
  // 是 'execute' ⇒ requestType 'command'，但策略按 tool 精确匹配，Bash 的 command 规则
  // 盖不到它们；缺覆盖即拒 ⇒ 两臂模型都拉到了 Task 却一次也扇不出去，
  // subagentSpawns 恒 0，编排维度的实验臂等于没接线。
  // 摘掉这两条规则本用例立刻红。
  it('lets the repository policy delegate to subagents so the fan-out arm has a signal', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scripted-approval-policy-'));
    process.env.NEO_SCRIPTED_APPROVAL_POLICY = path.resolve('.claude/eval-approval-policy.json');
    process.env.CODE_AGENT_DATA_DIR = path.join(tempDir, 'isolated-data');
    process.env.CODE_AGENT_EVAL_BRIDGE = '1';
    const handler = requireScriptedRunPermissionHandler();

    await expect(handler({ type: 'command', tool: 'Task', details: { subagent_type: 'reviewer', prompt: 'audit dir' } }))
      .resolves.toMatchObject({ approved: true, approvalSource: 'scripted' });
    await expect(handler({ type: 'command', tool: 'spawn_agent', details: { agentType: 'explore' } }))
      .resolves.toMatchObject({ approved: true, approvalSource: 'scripted' });
    // 放行的只是「派子代理」这一下：子代理自己的工具调用回到同一个 handler 重判，
    // 没有 allow 规则的工具面照旧拒。
    await expect(handler({ type: 'network', tool: 'WebFetch', details: { url: 'https://example.com' } }))
      .resolves.toMatchObject({ approved: false });
  });

  it('allows a matching tool and path with scripted attribution', async () => {
    installPolicy({
      version: 1,
      rules: [{
        id: 'allow-eval-sandbox-write',
        effect: 'allow',
        tool: 'Write',
        match: { pathPrefix: '/tmp/code-agent-eval-' },
      }],
    });
    const handler = getScriptedRunPermissionHandler();
    expect(handler).toBeTypeOf('function');
    await expect(handler!({
      type: 'file_write',
      tool: 'Write',
      details: { path: '/tmp/code-agent-eval-123/output.txt' },
    })).resolves.toEqual({
      approved: true,
      approvalSource: 'scripted',
    });
  });

  it('denies a matching tool and command with scripted attribution', async () => {
    installPolicy({
      version: 1,
      rules: [{
        id: 'deny-outside-write',
        effect: 'deny',
        tool: 'Bash',
        match: { commandPrefix: 'printf probe > /Users/' },
      }],
    });
    const handler = getScriptedRunPermissionHandler()!;
    await expect(handler({
      type: 'command',
      tool: 'Bash',
      details: { command: 'printf probe > /Users/linchen/probe.txt' },
    })).resolves.toEqual({
      approved: false,
      denialSource: 'scripted',
    });
  });

  it('denies an uncovered request by default', async () => {
    installPolicy({ version: 1, rules: [] });
    const handler = getScriptedRunPermissionHandler()!;
    await expect(handler({
      type: 'file_write',
      tool: 'Write',
      details: { path: '/tmp/uncovered.txt' },
    })).resolves.toEqual({ approved: false, denialSource: 'scripted' });
  });

  it('installs a deny-all handler when the policy file is malformed', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scripted-approval-policy-'));
    const policyPath = path.join(tempDir, 'broken.json');
    fs.writeFileSync(policyPath, '{not-json', 'utf8');
    process.env.NEO_SCRIPTED_APPROVAL_POLICY = policyPath;
    process.env.CODE_AGENT_DATA_DIR = path.join(tempDir, '.code-agent-dev3');

    const handler = getScriptedRunPermissionHandler();
    expect(handler).toBeTypeOf('function');
    await expect(handler!({
      type: 'file_write',
      tool: 'Write',
      details: { path: '/tmp/probe.txt' },
    })).resolves.toEqual({ approved: false, denialSource: 'scripted' });
    expect(() => requireScriptedRunPermissionHandler()).toThrow(/无法读取/);
  });

  it('installs a deny-all handler when the policy file is missing', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scripted-approval-policy-'));
    process.env.NEO_SCRIPTED_APPROVAL_POLICY = path.join(tempDir, 'missing.json');
    process.env.CODE_AGENT_DATA_DIR = path.join(tempDir, '.code-agent-dev3');

    const handler = getScriptedRunPermissionHandler();
    expect(handler).toBeTypeOf('function');
    await expect(handler!({
      type: 'command',
      tool: 'Bash',
      details: { command: 'echo unsafe' },
    })).resolves.toEqual({ approved: false, denialSource: 'scripted' });
    expect(() => requireScriptedRunPermissionHandler()).toThrow(/读取/);
  });

  it('rejects wildcard allow rules by failing closed', async () => {
    installPolicy({
      version: 1,
      rules: [{ id: 'forbidden', effect: 'allow', tool: '*', match: { pathPrefix: '/' } }],
    });
    const handler = getScriptedRunPermissionHandler()!;
    await expect(handler({
      type: 'file_write',
      tool: 'Write',
      details: { path: '/tmp/probe.txt' },
    })).resolves.toEqual({ approved: false, denialSource: 'scripted' });
  });
});

import { permissionRequestTypeForLevel } from '../../../../src/host/tools/permissionRequestType';

/**
 * 枚举 builtin 插件**可能注册**的全部工具：直接从磁盘上的 `*.schema.ts` 取，不走 activate()。
 *
 * 为什么不走 activate()：computerUse 的注册在 `isCuaStateV2Enabled()` 上分叉，测试环境只会走到
 * 其中一支 —— 09-06 实测 activate 只枚举到 13 个，摘掉另一支那个工具的规则测试照样绿，
 * 门对它结构性失明。策略要守的不变量是「任何一支分支下能被注册的工具都得有裁决规则」，
 * 所以真源取所有分支的并集 = 全部 schema 文件；新增一个 schema 文件这道门自动看得见。
 */
async function getBuiltinPluginToolDefinitions(): Promise<readonly { name: string; permissionLevel: string }[]> {
  const builtinRoot = path.resolve('src/host/plugins/builtin');
  const schemaFiles: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.schema.ts')) schemaFiles.push(full);
    }
  };
  walk(builtinRoot);
  expect(schemaFiles.length).toBeGreaterThan(0);
  const byName = new Map<string, { name: string; permissionLevel: string }>();
  for (const file of schemaFiles.sort()) {
    const module = await import(pathToFileURL(file).href) as Record<string, unknown>;
    for (const value of Object.values(module)) {
      if (!value || typeof value !== 'object') continue;
      const schema = value as { name?: unknown; permissionLevel?: unknown };
      if (typeof schema.name === 'string' && typeof schema.permissionLevel === 'string') {
        byName.set(schema.name, { name: schema.name, permissionLevel: schema.permissionLevel });
      }
    }
  }
  return [...byName.values()];
}

describe('builtin plugin scripted policy coverage', () => {
  it('has a matching allow or deny rule for every registered builtin tool', async () => {
    const policy = JSON.parse(fs.readFileSync('.claude/eval-approval-policy.json', 'utf8')) as {
      rules: Array<{ effect: string; tool: string; match?: { requestType?: string } }>;
    };
    const rulesByTool = new Map(policy.rules.map((rule) => [rule.tool, rule]));
    const tools = await getBuiltinPluginToolDefinitions();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      const rule = rulesByTool.get(tool.name);
      expect(rule, `missing scripted policy rule for ${tool.name}`).toBeDefined();
      if (rule?.effect === 'allow') {
        expect(rule.match?.requestType).toBe(permissionRequestTypeForLevel(tool.permissionLevel));
      }
    }
  });
});

import { ToolExecutor } from '../../../../src/host/tools/toolExecutor';
import { validateHtmlInAppModule } from '../../../../src/host/plugins/builtin/browserControl/validateHtmlInApp';

describe('builtin plugin request chain', () => {
  it('builds validate_html_in_app permission data through ToolExecutor and scripted policy', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scripted-approval-policy-'));
    process.env.NEO_SCRIPTED_APPROVAL_POLICY = path.resolve('.claude/eval-approval-policy.json');
    process.env.CODE_AGENT_DATA_DIR = path.join(tempDir, 'isolated-data');
    process.env.CODE_AGENT_EVAL_BRIDGE = '1';
    const handler = requireScriptedRunPermissionHandler()!;
    const executor = new ToolExecutor({
      requestPermission: handler,
      workingDirectory: process.cwd(),
      forcePermissionHandler: true,
    });
    const request = (executor as unknown as { buildPermissionRequest: (...args: any[]) => any }).buildPermissionRequest(
      { name: validateHtmlInAppModule.schema.name, permissionLevel: validateHtmlInAppModule.schema.permissionLevel },
      { url: 'http://localhost:3000' },
    );
    expect(request).toMatchObject({ type: 'command', tool: 'validate_html_in_app' });
    await expect(handler(request)).resolves.toMatchObject({ approved: true, approvalSource: 'scripted' });
  });

  // #1670 ai-review：browser_action / Browser 的参数面里有 analyze:true（截图上传云端视觉模型），
  // image_process 的 output_path 直接进 sharp.toFile() 没有工作区边界（能覆盖沙箱外的真实文件）——
  // （browserAction.ts 的 analyzeImageWithVision）。策略只按 (tool, requestType) 裁决、表达不了参数级，
  // 所以整条 deny；这条断言钉住"别哪天顺手把它放回 allow"。
  it('denies browser_action: its parameter surface reaches cloud vision (analyze:true)', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scripted-approval-policy-'));
    process.env.NEO_SCRIPTED_APPROVAL_POLICY = path.resolve('.claude/eval-approval-policy.json');
    process.env.CODE_AGENT_DATA_DIR = path.join(tempDir, 'isolated-data');
    process.env.CODE_AGENT_EVAL_BRIDGE = '1';
    const handler = requireScriptedRunPermissionHandler()!;
    // 请求类型必须跟产品真实映射一致（permissionLevel → requestType），否则规则改成 allow
    // 也匹配不上、测试照样绿——这条断言就成了摆设（#1670 第四轮 ai-review Nit）。
    const cases = [
      { tool: 'browser_action', level: 'execute', details: { action: 'screenshot', analyze: true } },
      { tool: 'Browser', level: 'execute', details: { action: 'screenshot', analyze: true } },
      { tool: 'image_process', level: 'write', details: { output_path: '/tmp/outside-sandbox.png' } },
    ] as const;
    for (const { tool, level, details } of cases) {
      await expect(handler({
        type: permissionRequestTypeForLevel(level), tool, details,
      } as never)).resolves.toMatchObject({ approved: false, denialSource: 'scripted' });
    }
  });
});
