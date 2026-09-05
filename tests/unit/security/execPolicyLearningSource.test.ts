// ============================================================================
// N-EVAL-EXECPOLICY-LEAK：评测/机器放行不许被学成用户级 exec-policy 规则
// ============================================================================
// 2026-09-05 真机 ~/.code-agent/exec-policy.json 清出 41 条 source=user 规则，pattern 里
// 全是沙箱临时路径（open/mv/cp/xxd/tesseract + /var/folders/.../code-agent-eval-*、
// code-agent-tool-cancel-*）。真凶是「没自报来源就当真人批准」：评测适配器在没有 scripted
// 策略时回落 `requestPermission: async () => true`（agentAdapter.ts），裸 boolean 经
// normalizePermissionAskResult 后 approvalSource 是 undefined，学习判据把 undefined 当 user。
//
// 这里把评测那条接线原样搭起来（真分类器判真命令，dispatch 打桩所以命令不真跑），
// 两侧都钉死：机器放行不学、真人放行照学。
// ============================================================================
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: async () => null,
}));

import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import type { RequestPermissionResult } from '../../../src/shared/contract/permission';
import type { ToolLedgerOrigin } from '../../../src/shared/constants/toolLedger';
import { getExecPolicyStore, resetExecPolicyStore } from '../../../src/host/security/execPolicy';

/**
 * 分类器对这条判 ask（没有 forcePermissionHandler 也会走到审批处理器），且
 * learnFromApproval 会把 ["mv", "<目标>"] 学成规则——与真机漏出来的那批同形状。
 */
const LEARNABLE_COMMAND = 'mv note.txt note-moved.txt';
const LEARNED_PREFIX = 'mv';

let tempRoot: string;
let workspace: string;

function policyFile(dataDir: string): string {
  return path.join(dataDir, 'exec-policy.json');
}

function readRules(dataDir: string): { pattern: string[]; source: string }[] {
  const file = policyFile(dataDir);
  if (!fs.existsSync(file)) return [];
  return (JSON.parse(fs.readFileSync(file, 'utf8')) as { rules: { pattern: string[]; source: string }[] }).rules;
}

/** 跑一条 Bash 放行，返回学习后的内存规则（内存是同步真相，落盘是 fire-and-forget）。 */
async function runApprovedBash(options: {
  requestPermission: () => Promise<RequestPermissionResult>;
  ledgerOrigin: ToolLedgerOrigin;
  command?: string;
}): Promise<readonly { pattern: string[]; source: string }[]> {
  const executor = new ToolExecutor({
    workingDirectory: workspace,
    requestPermission: options.requestPermission,
    // 评测存量路径：没有 scripted 策略时 forcePermissionHandler 为 false，
    // 只有分类器判 ask 的命令才会走到处理器——正是漏出来的那批命令的形态。
    forcePermissionHandler: false,
    ledgerOrigin: options.ledgerOrigin,
    dispatchTool: async () => ({ success: true, output: 'stubbed' }),
  });
  executor.setAuditEnabled(false);
  await executor.execute('Bash', { command: options.command ?? LEARNABLE_COMMAND }, { sessionId: 'execpolicy-leak' });
  // 落盘是 this.save().catch(...)，给它一个 tick 落地再看文件。
  await new Promise((resolve) => setTimeout(resolve, 50));
  return getExecPolicyStore().getRules();
}

function freshDataDir(name: string): string {
  const dir = path.join(tempRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  vi.stubEnv('CODE_AGENT_DATA_DIR', dir);
  resetExecPolicyStore();
  return dir;
}

beforeAll(() => {
  getProtocolRegistry();
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'execpolicy-leak-'));
  workspace = path.join(tempRoot, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'note.txt'), 'x\n', 'utf8');
});

afterEach(() => {
  resetExecPolicyStore();
  vi.unstubAllEnvs();
});

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('exec-policy 学习只认真人显式放行', () => {
  it('嫌疑一：评测存量 auto-approve（裸 true ⇒ 来源缺省）不学成 source=user 规则', async () => {
    const dataDir = freshDataDir('eval-bare-true');

    const rules = await runApprovedBash({
      requestPermission: async () => true,
      ledgerOrigin: 'eval',
    });

    expect(rules.filter((rule) => rule.pattern[0] === LEARNED_PREFIX)).toEqual([]);
    expect(readRules(dataDir)).toEqual([]);
  }, 60_000);

  it('嫌疑一同形状：生产 blanket 放行处理器（恢复宿主 / MCP server 的裸 true）同样不学', async () => {
    const dataDir = freshDataDir('desktop-bare-true');

    const rules = await runApprovedBash({
      requestPermission: async () => true,
      ledgerOrigin: 'desktop',
    });

    expect(rules.filter((rule) => rule.pattern[0] === LEARNED_PREFIX)).toEqual([]);
    expect(readRules(dataDir)).toEqual([]);
  }, 60_000);

  it('真阴对照：真人在审批界面点允许（approvalSource=user）照常学出规则', async () => {
    const dataDir = freshDataDir('human-allow');

    const rules = await runApprovedBash({
      requestPermission: async () => ({ approved: true, approvalSource: 'user' as const }),
      ledgerOrigin: 'desktop',
    });

    expect(rules.map((rule) => rule.pattern[0])).toContain(LEARNED_PREFIX);
    expect(readRules(dataDir).map((rule) => rule.source)).toContain('user');
  }, 60_000);

  it('评测跑动不改用户策略：ledgerOrigin=eval 时即使自报 user 也不学', async () => {
    const dataDir = freshDataDir('eval-claims-user');

    const rules = await runApprovedBash({
      requestPermission: async () => ({ approved: true, approvalSource: 'user' as const }),
      ledgerOrigin: 'eval',
    });

    expect(rules.filter((rule) => rule.pattern[0] === LEARNED_PREFIX)).toEqual([]);
    expect(readRules(dataDir)).toEqual([]);
  }, 60_000);

  it('嫌疑二：单例建立后再切 CODE_AGENT_DATA_DIR，新规则落新目录、旧目录零新增', async () => {
    const dirA = freshDataDir('slot-a');
    // 先于切换建立单例——评测里这一步可能发生在预热/上一题，之后每题才切目录。
    getExecPolicyStore();

    const dirB = path.join(tempRoot, 'slot-b');
    fs.mkdirSync(dirB, { recursive: true });
    vi.stubEnv('CODE_AGENT_DATA_DIR', dirB);

    await runApprovedBash({
      requestPermission: async () => ({ approved: true, approvalSource: 'user' as const }),
      ledgerOrigin: 'desktop',
    });

    expect(readRules(dirB).map((rule) => rule.pattern[0])).toContain(LEARNED_PREFIX);
    expect(readRules(dirA)).toEqual([]);
  }, 60_000);

  it('双隔离总断言：CODE_AGENT_DATA_DIR 未设时，评测放行不在家目录生成 exec-policy.json', async () => {
    const fakeHome = path.join(tempRoot, 'fake-home');
    fs.mkdirSync(fakeHome, { recursive: true });
    vi.stubEnv('CODE_AGENT_DATA_DIR', '');
    vi.stubEnv('CODE_AGENT_HOME', fakeHome);
    vi.stubEnv('HOME', fakeHome);
    resetExecPolicyStore();

    const rules = await runApprovedBash({
      requestPermission: async () => true,
      ledgerOrigin: 'eval',
    });

    expect(rules.filter((rule) => rule.pattern[0] === LEARNED_PREFIX)).toEqual([]);
    expect(fs.existsSync(path.join(fakeHome, '.code-agent', 'exec-policy.json'))).toBe(false);
  }, 60_000);
});
