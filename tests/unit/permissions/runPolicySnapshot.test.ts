// ============================================================================
// N-PERM-POLICYVERSION ②③ — run 级权限冻结：外部放宽不作用于已开始的 run
// ============================================================================
// 决议（编排 2026-09-30 方案 B）：收紧（任何来源）与用户 UI 放宽立即生效；外部来源
// （config 热重载/hook/plugin/项目设置）的放宽冻结在 run 起点水位线，下个 run 生效。
// 这里按台账 ③ 逐条钉死：run 中途放宽 → 同类调用仍按启动时判决；收紧立即生效。
// ============================================================================
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: async () => null,
}));

import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { getPolicyEngine, resetPolicyEngine, type PolicyRequest, type PolicyResult } from '../../../src/host/permissions/policyEngine';
import { computePolicyHash } from '../../../src/host/permissions/policyHash';
import {
  beginRunPolicy,
  endRunPolicy,
  matchEffectiveExecPolicy,
  resolveEffectivePolicy,
  resolveEffectivePolicyEnforcer,
  resolveEffectivePolicyRules,
  resolveEffectiveSessionMode,
} from '../../../src/host/permissions/runPolicySnapshot';
import { resolveSessionPermissionMode } from '../../../src/host/tools/toolPermissionClassification';
import { getExecPolicyStore, resetExecPolicyStore } from '../../../src/host/security/execPolicy';
import { getPolicyEnforcer, resetPolicyEnforcer } from '../../../src/host/security/policyEnforcer';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';

const SESSION = 'run-policy-freeze';
const RM_COMMAND = 'rm -rf /tmp/neo-freeze-probe';
const DENY_RULE_ID = 'user-deny-Bash(rm *)';

function rmRequest(command = RM_COMMAND): PolicyRequest {
  return {
    tool: 'Bash',
    level: 'execute',
    description: 'probe',
    command,
    sessionId: SESSION,
  };
}

/** 比较两个 evaluate 结果时剥掉 timestamp（两次 Date.now() 可能跨毫秒，与判决无关）。 */
function stable(result: PolicyResult): Omit<PolicyResult, 'timestamp'> {
  const { timestamp: _timestamp, ...rest } = result;
  return rest;
}

/** P1 基线：一条 Bash(rm *) 的用户 deny（loadUserRules 产物，id 形如 user-deny-<规则>）。 */
function loadP1Baseline(): void {
  getPolicyEngine().loadUserRules({ deny: ['Bash(rm *)'] });
}

let tempRoot: string;
let caseCounter = 0;

function freshDataDir(): string {
  const dir = path.join(tempRoot, `case-${Date.now()}-${caseCounter++}`);
  fs.mkdirSync(dir, { recursive: true });
  vi.stubEnv('CODE_AGENT_DATA_DIR', dir);
  resetExecPolicyStore();
  return dir;
}

beforeAll(() => {
  getProtocolRegistry();
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'run-policy-freeze-'));
});

beforeEach(() => {
  freshDataDir();
  resetPolicyEngine();
  getPolicyEngine().setAuditEnabled(false); // 别把测试判决写进操作者审计日志
  resetPermissionModeManager();
  resetPolicyEnforcer();
  // 不重置 run 快照/流水（无对应 reset 导出，见 knip 门）：每个用例自己在结束时
  // endRunPolicy；新 run 的水位线天然隔离此前流水。无快照断言一律用专用 session id。
});

afterEach(() => {
  resetPolicyEnforcer();
  resetExecPolicyStore();
  vi.unstubAllEnvs();
});

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// ----------------------------------------------------------------------------
// ③-a 外部放宽冻结：run 中途删 deny / 加白 / 抬档，本 run 仍按启动时判决
// ----------------------------------------------------------------------------

describe('run 中途的外部放宽不作用于已开始的 run', () => {
  it('外部删除 deny 规则（默认来源，reloadFromDisk 形状）：本 run 仍按 P1 判 deny，下个 run 按 P2', () => {
    loadP1Baseline();
    const engine = getPolicyEngine();
    beginRunPolicy('run-1', SESSION);
    engine.removeRule(DENY_RULE_ID); // 默认 source='external'，外部编辑形状
    expect(engine.evaluate(rmRequest()).action).toBe('prompt'); // 活状态已放宽（P2）
    // 同一调用（同参数）按 run 有效视图判：仍是 P1 的 deny
    expect(engine.evaluate(rmRequest(), resolveEffectivePolicyRules(SESSION)).action).toBe('deny');
    expect(engine.evaluate(rmRequest(), resolveEffectivePolicy('run-1').rules).action).toBe('deny');
    expect(engine.evaluate(rmRequest(), resolveEffectivePolicy(undefined, SESSION).rules).action).toBe('deny');

    endRunPolicy('run-1');
    // 下个 run（beginRunPolicy 重新建档）按 P2 判
    beginRunPolicy('run-2', SESSION);
    expect(engine.evaluate(rmRequest(), resolveEffectivePolicyRules(SESSION)).action).toBe('prompt');
    endRunPolicy('run-2');
  });

  it('外部经 loadUserRules 热重载加白名单（config.json 编辑形状）：本 run 冻结，下个 run 生效', () => {
    beginRunPolicy('run-1', SESSION);
    const engine = getPolicyEngine();
    engine.loadUserRules({ allow: ['Bash(git *)'] }); // 默认 external：reloadFromDisk → applyUserPermissionRules 的形状
    const allowRuleId = 'user-allow-Bash(git *)';
    // 注：overridable 的用户 allow 在 evaluate 里会被 modeAction 收口，所以直接按
    // 「视图里有没有这条规则」断言冻结（视图规则列表就是判决输入）。
    expect(engine.getRules().some((rule) => rule.id === allowRuleId)).toBe(true); // 活状态已加白
    expect(resolveEffectivePolicyRules(SESSION).some((rule) => rule.id === allowRuleId)).toBe(false); // 冻结
    endRunPolicy('run-1');
    beginRunPolicy('run-2', SESSION);
    expect(resolveEffectivePolicyRules(SESSION).some((rule) => rule.id === allowRuleId)).toBe(true); // 下个 run 生效
    endRunPolicy('run-2');
  });

  it('hook/plugin 形状（默认来源 addRule 加 allow 规则）：本 run 冻结', () => {
    beginRunPolicy('run-1', SESSION);
    const engine = getPolicyEngine();
    engine.addRule({
      id: 'plugin-allow-curl',
      name: 'plugin allow curl',
      priority: 500,
      matcher: { tool: 'Bash', toolSpecifier: { toolName: 'Bash', specifier: 'curl *', specifierType: 'command' } },
      action: 'allow',
      overridable: true,
      audit: false,
    });
    expect(engine.getRules().some((rule) => rule.id === 'plugin-allow-curl')).toBe(true); // 活状态放宽
    expect(resolveEffectivePolicyRules(SESSION).some((rule) => rule.id === 'plugin-allow-curl')).toBe(false); // 冻结
    endRunPolicy('run-1');
  });

  it('外部学到的 exec allow 前缀（learnFromApproval 默认来源）：本 run 冻结', () => {
    const store = getExecPolicyStore();
    beginRunPolicy('run-1', SESSION);
    store.learnFromApproval('mv note.txt note-moved.txt'); // 默认 external
    expect(store.getRules().some((rule) => rule.pattern.join(' ') === 'mv note.txt')).toBe(true);
    expect(store.match('mv note.txt note-moved.txt')).toBe('allow'); // 活状态放行
    expect(matchEffectiveExecPolicy('mv note.txt note-moved.txt', SESSION)).toBeNull(); // run 内冻结
    endRunPolicy('run-1');
    beginRunPolicy('run-2', SESSION);
    expect(matchEffectiveExecPolicy('mv note.txt note-moved.txt', SESSION)).toBe('allow'); // 下个 run 生效
    endRunPolicy('run-2');
  });

  it('外部抬档（setSessionMode 默认来源 default→acceptEdits）：本 run 冻结在起点档', () => {
    const manager = getPermissionModeManager();
    manager.initSessionMode(SESSION);
    beginRunPolicy('run-1', SESSION);
    manager.setSessionMode(SESSION, 'acceptEdits'); // 默认 external
    expect(manager.getModeForSession(SESSION)).toBe('acceptEdits'); // 活状态已抬档
    expect(resolveEffectiveSessionMode(SESSION)).toBe('default'); // 冻结
    expect(resolveSessionPermissionMode(undefined, SESSION)).toBe('default'); // E1 同源
    endRunPolicy('run-1');
    beginRunPolicy('run-2', SESSION);
    expect(resolveEffectiveSessionMode(SESSION)).toBe('acceptEdits');
    endRunPolicy('run-2');
  });

  it('档位宽窄序：同宽异档（default→plan）按收紧处理，活状态直接生效', () => {
    const manager = getPermissionModeManager();
    manager.initSessionMode(SESSION);
    beginRunPolicy('run-1', SESSION);
    manager.setSessionMode(SESSION, 'plan'); // 默认 external；plan 不比 default 多免确认任何层级
    expect(resolveEffectiveSessionMode(SESSION)).toBe('plan'); // 不冻结（不可能放宽审批）
    endRunPolicy('run-1');
  });
});

// ----------------------------------------------------------------------------
// ③-b 用户 UI 放宽立即生效（审批卡 always allow / UI 保存的 allow 规则 / 会话档切换）
// ----------------------------------------------------------------------------

describe('用户 UI 来源的放宽对进行中的 run 立即生效', () => {
  it("审批卡 always allow（learnFromApproval 携 'user-ui'）：学到的 allow 立即生效", () => {
    const store = getExecPolicyStore();
    beginRunPolicy('run-1', SESSION);
    store.learnFromApproval('mv note.txt note-moved.txt', 'user-ui');
    expect(matchEffectiveExecPolicy('mv note.txt note-moved.txt', SESSION)).toBe('allow');
    endRunPolicy('run-1');
  });

  it("UI 保存的 allow 规则（loadUserRules/addRule 携 'user-ui'）：立即生效", () => {
    beginRunPolicy('run-1', SESSION);
    const engine = getPolicyEngine();
    engine.loadUserRules({ allow: ['Bash(git *)'] }, 'user-ui'); // updateSettings → applyUserPermissionRules('user-ui') 的形状
    expect(resolveEffectivePolicyRules(SESSION).some((rule) => rule.id === 'user-allow-Bash(git *)')).toBe(true);
    engine.addRule({
      id: 'ui-allow-ls',
      name: 'ui allow ls',
      priority: 500,
      matcher: { tool: 'Bash' },
      action: 'allow',
      overridable: true,
      audit: false,
    }, 'user-ui');
    expect(resolveEffectivePolicyRules(SESSION).some((rule) => rule.id === 'ui-allow-ls')).toBe(true);
    endRunPolicy('run-1');
  });

  it("会话档切换到 acceptEdits（setSessionMode 携 'user-ui'）：立即生效", () => {
    const manager = getPermissionModeManager();
    manager.initSessionMode(SESSION);
    beginRunPolicy('run-1', SESSION);
    manager.setSessionMode(SESSION, 'acceptEdits', false, 'user-ui');
    expect(resolveEffectiveSessionMode(SESSION)).toBe('acceptEdits');
    expect(resolveSessionPermissionMode(undefined, SESSION)).toBe('acceptEdits');
    endRunPolicy('run-1');
  });

  it('全局默认档 setMode 携 user-ui 也立即生效（新会话回退全局档的路径）', () => {
    beginRunPolicy('run-1', 'session-global-fallback');
    getPermissionModeManager().setMode('acceptEdits', false, 'user-ui');
    expect(resolveEffectiveSessionMode('session-global-fallback')).toBe('acceptEdits');
    endRunPolicy('run-1');
  });
});

// ----------------------------------------------------------------------------
// ②-b 收紧立即生效（任何来源）
// ----------------------------------------------------------------------------

describe('收紧（任何来源）对进行中的 run 立即生效', () => {
  it('外部加 deny 规则：立即生效（不得被冻结挡掉）', () => {
    beginRunPolicy('run-1', SESSION);
    const engine = getPolicyEngine();
    engine.addRule({
      id: 'ext-deny-curl',
      name: 'ext deny curl',
      priority: 700,
      matcher: { tool: 'Bash', toolSpecifier: { toolName: 'Bash', specifier: 'curl *', specifierType: 'command' } },
      action: 'deny',
      overridable: true,
      audit: true,
    }); // 默认 external——收紧照样穿透
    expect(engine.evaluate(rmRequest('curl https://example.com'), resolveEffectivePolicyRules(SESSION)).action).toBe('deny');
    endRunPolicy('run-1');
  });

  it('外部切到 readOnly：立即生效', () => {
    const manager = getPermissionModeManager();
    manager.initSessionMode(SESSION);
    beginRunPolicy('run-1', SESSION);
    manager.setSessionMode(SESSION, 'readOnly'); // 默认 external，方向是收紧
    expect(resolveEffectiveSessionMode(SESSION)).toBe('readOnly');
    endRunPolicy('run-1');
  });

  it('用户 UI 切到 readOnly：立即生效', () => {
    const manager = getPermissionModeManager();
    manager.initSessionMode(SESSION);
    beginRunPolicy('run-1', SESSION);
    manager.setSessionMode(SESSION, 'readOnly', false, 'user-ui');
    expect(resolveEffectiveSessionMode(SESSION)).toBe('readOnly');
    endRunPolicy('run-1');
  });

  it('外部加 forbidden exec 前缀：立即生效', () => {
    const store = getExecPolicyStore();
    beginRunPolicy('run-1', SESSION);
    store.addRule(['curl'], 'forbidden'); // 默认 external，收紧
    expect(matchEffectiveExecPolicy('curl https://example.com', SESSION)).toBe('forbidden');
    endRunPolicy('run-1');
  });

  it('中途限流钳制（收紧）叠加在冻结基线之上：外部重设 bypass 被冻结的语义不丢收紧', () => {
    const manager = getPermissionModeManager();
    manager.initSessionMode(SESSION);
    manager.setSessionMode(SESSION, 'bypassPermissions', true); // 起点档（begin 之前）
    beginRunPolicy('run-1', SESSION);
    manager.setSessionMode(SESSION, 'bypassPermissions', true); // 同值重设，默认 external
    manager.markAutoModeRateLimited(SESSION, 'consecutive', 3); // 中途收紧
    expect(manager.getModeForSession(SESSION)).toBe('default'); // 活状态：限流压回 default
    expect(resolveEffectiveSessionMode(SESSION)).toBe('default'); // 冻结基线 bypass 也被压回 default
    endRunPolicy('run-1');
  });
});

// ----------------------------------------------------------------------------
// E6 子代理映射：sessionId → 本会话活跃 run 的快照
// ----------------------------------------------------------------------------

describe('子代理路径按 sessionId 解析到父 run 的快照', () => {
  it('同会话并发 run：最新活跃 run 的基线生效，结束后回落到仍活跃的 run', () => {
    loadP1Baseline();
    const engine = getPolicyEngine();
    beginRunPolicy('run-parent', SESSION);
    engine.removeRule(DENY_RULE_ID); // 外部放宽
    expect(engine.evaluate(rmRequest(), resolveEffectivePolicy(undefined, SESSION).rules).action).toBe('deny');
    // 子代理/辅助 run（同会话）后来 begin：基线取当下活状态（P2）
    beginRunPolicy('run-child', SESSION);
    expect(engine.evaluate(rmRequest(), resolveEffectivePolicy(undefined, SESSION).rules).action).toBe('prompt');
    // 子 run 结束，回落到父 run 的冻结基线
    endRunPolicy('run-child');
    expect(engine.evaluate(rmRequest(), resolveEffectivePolicy(undefined, SESSION).rules).action).toBe('deny');
    endRunPolicy('run-parent');
    // 全部结束：活状态
    expect(engine.evaluate(rmRequest(), resolveEffectivePolicyRules(SESSION)).action).toBe('prompt');
  });

  it('无快照路径 === 活状态（表格对照，JSON.stringify 逐项相等）', () => {
    const identitySession = 'identity-no-snapshot'; // 专用会话：保证本用例无活跃快照
    const engine = getPolicyEngine();
    const manager = getPermissionModeManager();
    const store = getExecPolicyStore();
    engine.addRule({
      id: 'live-deny-rm',
      name: 'live deny rm',
      priority: 700,
      matcher: { tool: 'Bash', toolSpecifier: { toolName: 'Bash', specifier: 'rm *', specifierType: 'command' } },
      action: 'deny',
      overridable: true,
      audit: true,
    });
    engine.loadUserRules({ allow: ['Bash(git *)'] });
    store.addRule(['mv', 'note.txt'], 'allow');
    manager.setMode('default');
    manager.setSessionMode(identitySession, 'acceptEdits', false, 'user-ui');

    const commands = [
      'rm -rf /tmp/x',
      'git push origin main',
      'curl https://example.com',
      'mv note.txt note-moved.txt',
      'ls -la',
      'npm install lodash',
      'echo hi',
      'find . -name x -delete',
      'sudo rm /etc/hosts',
      'git push --force origin main',
      'mv note.txt elsewhere.txt',
      'cat ~/.ssh/id_rsa',
    ];
    expect(commands.length).toBeGreaterThanOrEqual(12);
    for (const command of commands) {
      const view = engine.evaluate(rmRequest(command), resolveEffectivePolicyRules(identitySession));
      const live = engine.evaluate(rmRequest(command));
      expect(JSON.stringify(stable(view))).toBe(JSON.stringify(stable(live)));
      expect(matchEffectiveExecPolicy(command, identitySession)).toBe(store.match(command));
    }
    expect(resolveEffectiveSessionMode(identitySession)).toBe(manager.getModeForSession(identitySession));
    expect(resolveSessionPermissionMode(undefined, identitySession)).toBe(manager.getModeForSession(identitySession));
    expect(resolveEffectivePolicyRules(identitySession)).toEqual(engine.getRules());
  });
});

// ----------------------------------------------------------------------------
// ⑤ 账本哈希覆盖有效视图（记下的是实际参与判决的策略，不是被冻结挡掉的活状态）
// ----------------------------------------------------------------------------

describe('computePolicyHash 覆盖 run 有效视图', () => {
  it('外部放宽后：run 内哈希 = 冻结视图的哈希（≠ 活状态哈希），跨调用稳定', () => {
    loadP1Baseline();
    const engine = getPolicyEngine();
    beginRunPolicy('run-1', SESSION);
    engine.removeRule(DENY_RULE_ID); // 外部放宽
    const inRun = computePolicyHash(SESSION);
    expect(inRun).toMatch(/^[a-f0-9]{64}$/);
    expect(computePolicyHash(SESSION, 'run-1')).toBe(inRun); // runId 显式传入同值
    expect(computePolicyHash(SESSION)).not.toBe(computePolicyHash('another-session')); // 无快照会话 → 活状态
    endRunPolicy('run-1');
    expect(computePolicyHash(SESSION)).not.toBe(inRun); // run 结束 → 活状态哈希
  });

  it('E5 的 toolExecutor 接线：审批卡真人放行学到的 allow 前缀对进行中的 run 立即生效', async () => {
    const workspace = path.join(tempRoot, 'executor-e2e');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'note.txt'), 'x\n', 'utf8');
    const command = 'mv note.txt note-moved.txt';
    beginRunPolicy('run-exec', SESSION);
    const executor = new ToolExecutor({
      workingDirectory: workspace,
      requestPermission: async () => ({ approved: true, approvalSource: 'user' }),
      dispatchTool: async () => ({ success: true, output: 'stubbed' }),
    });
    executor.setAuditEnabled(false);
    await executor.execute('Bash', { command }, { sessionId: SESSION });
    // 学习发生在 run 起点之后；site 传的是 'user-ui' → 必须立即生效（漏传会被冻结 → 红）
    expect(matchEffectiveExecPolicy(command, SESSION)).toBe('allow');
    endRunPolicy('run-exec');
  });
});

// ----------------------------------------------------------------------------
// E4：PolicyEnforcer（code-agent-policy.toml）冻结
// ----------------------------------------------------------------------------

describe('E4 PolicyEnforcer（toml）冻结', () => {
  it('run 起点捕获到 enforcer 后，活实例上放宽的维度按起点回填', () => {
    const projectDir = path.join(tempRoot, 'enforcer-project');
    fs.mkdirSync(projectDir, { recursive: true });
    // 探针路径必须在项目目录内：writable_paths 缺省是 ./**（项目内），路径在项目外会
    // 被「not in writable paths」挡住，与 denied_paths 无关。
    const probe = path.join(projectDir, 'secret', 'hosts');
    const denied = `"${path.join(projectDir, 'secret')}/**"`;
    const writePolicy = (deniedPaths: string): void => {
      fs.writeFileSync(path.join(projectDir, 'code-agent-policy.toml'), [
        '[filesystem]',
        `denied_paths = [${deniedPaths}]`,
        '',
        '[execution]',
        'allow_shell = true',
        '',
      ].join('\n'), 'utf8');
    };
    writePolicy(denied);
    const live = getPolicyEnforcer(projectDir);
    expect(live?.isActive).toBe(true);
    expect(live?.checkFilePath(probe, 'write').allowed).toBe(false);

    beginRunPolicy('run-1', SESSION);
    writePolicy(''); // 外部放宽形状：重绑前把 deny 清空（denied 与默认清单并集，探针掉出）
    resetPolicyEnforcer();
    const loosened = getPolicyEnforcer(projectDir);
    expect(loosened?.checkFilePath(probe, 'write').allowed).toBe(true); // 活状态放宽
    const effective = resolveEffectivePolicyEnforcer(loosened, SESSION);
    expect(effective?.checkFilePath(probe, 'write').allowed).toBe(false); // 冻结回起点
    endRunPolicy('run-1');
  });

  it('run 起点没有 enforcer（null 基线）：保持活状态（与 origin/main 行为一致）', () => {
    beginRunPolicy('run-1', SESSION);
    expect(resolveEffectivePolicyEnforcer(null, SESSION)).toBeNull();
    endRunPolicy('run-1');
  });
});
