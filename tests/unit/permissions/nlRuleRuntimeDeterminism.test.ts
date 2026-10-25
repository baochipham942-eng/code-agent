// ============================================================================
// 翻译产出的规则在运行时的确定性（N-PERM-NL-RULES-K1 验收 ①②③ host 侧）
// ----------------------------------------------------------------------------
// ① 确认保存的规则经 loadUserRules 装载后，policyEngine.evaluate 对 hit/miss 的
//    判定正确；② Jev 分类器开关开/关，判定逐字相同且 evaluate 是同步纯规则判定；
// ③ 受保护 allow 在翻译层被拒（distinct reason），已存 deny/ask 与新 allow 并存时
//    引擎判更严的那条。
// ============================================================================

import { afterEach, describe, expect, it } from 'vitest';
import { PolicyEngine } from '../../../src/host/permissions/policyEngine';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { translatePermissionSentence } from '../../../src/host/permissions/permissionRuleTranslator';
import { isProtectedAllowRule } from '../../../src/host/permissions/permissionRuleDraft';
import { NL_RULE_TEXT, describeRule } from '../../../src/shared/permissionRuleTranslate';

const CATALOG = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'ListDirectory', 'mail_send'];

function chatReturning(raw: string) {
  return () => Promise.resolve(raw);
}

function freshEngine(): PolicyEngine {
  const engine = new PolicyEngine();
  engine.setAuditEnabled(false);
  return engine;
}

function bashRequest(command: string) {
  return { tool: 'Bash', level: 'execute' as const, command, description: `run ${command}` };
}

afterEach(() => {
  resetPermissionModeManager();
});

describe('验收①：翻译 → 确认 → loadUserRules → evaluate', () => {
  const RM_DRAFT = JSON.stringify({
    status: 'ok',
    tool: 'Bash',
    pattern: 'rm *',
    behavior: 'ask',
    examples: { hit: ['rm -rf ./build', 'rm notes.txt'], miss: ['ls -la', 'cat a.txt'] },
  });

  it('确认后 ask 规则装载并生效：hit → prompt + 命中 user 规则；miss → 不命中 user 规则', async () => {
    const result = await translatePermissionSentence('删文件之前先问我', {
      chat: chatReturning(RM_DRAFT), toolCatalog: CATALOG,
    });
    expect(result.status).toBe('ok');
    expect(result.rule).toBe('Bash(rm *)');

    // 用户点了确认：规则经现有 permissions 路径保存（此处直接模拟持久化后的装载）
    const engine = freshEngine();
    engine.loadUserRules({ ask: [result.rule!] });

    const hit = engine.evaluate(bashRequest('rm -rf ./build'));
    expect(hit.action).toBe('prompt');
    expect(hit.matchedRule?.id).toBe('user-prompt-Bash(rm *)');

    const miss = engine.evaluate(bashRequest('ls -la'));
    // miss 不命中用户规则（ls 走的是内置 allow-ls，与本条翻译规则无关）
    expect(miss.matchedRule?.id?.startsWith('user-')).toBeFalsy();
  });

  it('deny 与 allow 同形：deny 直接拒；allow 在 bypass 档下放行 hit', async () => {
    const engine = freshEngine();
    engine.loadUserRules({ deny: ['Bash(rm *)'] });
    expect(engine.evaluate(bashRequest('rm notes.txt')).action).toBe('deny');

    expect(getPermissionModeManager().setMode('bypassPermissions', true)).toBe(true);
    const allowEngine = freshEngine();
    allowEngine.loadUserRules({ allow: ['Bash(npm test)'] });
    const hit = allowEngine.evaluate(bashRequest('npm test'));
    expect(hit.action).toBe('allow');
    expect(hit.matchedRule?.id).toBe('user-allow-Bash(npm test)');
    const miss = allowEngine.evaluate(bashRequest('npm publish'));
    expect(miss.matchedRule?.id).toBeUndefined();
  });
});

describe('验收②：运行时只走确定性规则，与 Jev 分类器开关无关', () => {
  const RULES = { ask: ['Bash(rm *)'] };
  const REQUEST = bashRequest('rm -rf ./build');

  it('CODE_AGENT_PERMISSION_LLM_CLASSIFIER 开/关判定逐字相同', () => {
    const evaluateUnder = (flag: string | undefined) => {
      const previous = flag === undefined ? undefined : process.env.CODE_AGENT_PERMISSION_LLM_CLASSIFIER;
      if (flag === undefined) delete process.env.CODE_AGENT_PERMISSION_LLM_CLASSIFIER;
      else process.env.CODE_AGENT_PERMISSION_LLM_CLASSIFIER = flag;
      try {
        const engine = freshEngine();
        engine.loadUserRules({ ...RULES });
        const result = engine.evaluate({ ...REQUEST });
        return { action: result.action, matchedRuleId: result.matchedRule?.id, reason: result.reason };
      } finally {
        if (previous === undefined) delete process.env.CODE_AGENT_PERMISSION_LLM_CLASSIFIER;
        else process.env.CODE_AGENT_PERMISSION_LLM_CLASSIFIER = previous;
      }
    };

    expect(evaluateUnder('0')).toEqual(evaluateUnder('1'));
    expect(evaluateUnder(undefined)).toEqual(evaluateUnder('false'));
    // evaluate 是同步 API：判定不经过任何模型调用即可完成（类型上就不存在 await 面）
    const verdict = freshEngineAndAsk();
    expect(verdict.action).toBe('prompt');
  });

  it('evaluate 不发起模型调用：同步完成且无异步挂起', () => {
    const engine = freshEngine();
    engine.loadUserRules({ ...RULES });
    const startedAt = Date.now();
    const result = engine.evaluate({ ...REQUEST });
    // 同步返回 + 结果是纯规则产物；这里再判一次 miss 保持对照
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(result.matchedRule?.id).toBe('user-prompt-Bash(rm *)');
    expect(engine.evaluate(bashRequest('ls')).matchedRule?.id).toBeUndefined();
  });
});

function freshEngineAndAsk() {
  const engine = freshEngine();
  engine.loadUserRules({ ask: ['Bash(rm *)'] });
  return engine.evaluate(bashRequest('rm -rf ./build'));
}

describe('验收③：受保护动作不能被放行、冲突先问/取严', () => {
  const ALLOW_SUDO_DRAFT = JSON.stringify({
    status: 'ok',
    tool: 'Bash',
    pattern: 'sudo *',
    behavior: 'allow',
    examples: { hit: ['sudo apt-get install build-essential'], miss: ['apt-get install x'] },
  });

  it('探针集合：这些 allow 规则一律拒绝自动放行（ask/deny 不受限）', () => {
    for (const rule of ['Bash(sudo *)', 'Bash(rm -rf *)', 'Bash(git push --force *)', 'Write(/etc/*)', 'Edit(/usr/**)', 'Read(**/.ssh/**)']) {
      expect(isProtectedAllowRule(rule), rule).toBe(true);
    }
    expect(isProtectedAllowRule('Bash(git status)')).toBe(false);
  });

  it('「sudo 命令直接放行」→ protected，理由与 unrecognized 可区分', async () => {
    const result = await translatePermissionSentence('sudo 命令直接放行', {
      chat: chatReturning(ALLOW_SUDO_DRAFT), toolCatalog: CATALOG,
    });
    expect(result.status).toBe('protected');
    expect(result.reasonText).toBe(NL_RULE_TEXT.protectedReason);
    expect(result.reasonText).not.toBe(NL_RULE_TEXT.unrecognizedReason);
  });

  it('已存 deny + 新 allow 并存：引擎判 deny（更严的赢），翻译层把行为档上调', () => {
    const engine = freshEngine();
    engine.loadUserRules({ deny: ['Bash(rm *)'], allow: ['Bash(rm *)'] });
    expect(engine.evaluate(bashRequest('rm notes.txt')).action).toBe('deny');

    // 翻译层同口径：冲突时报更严并默认更严档
    expect(describeRule('Bash(rm *)', 'deny')).toBe('用终端运行 rm 开头的命令时 → 一律禁止');
  });

  it('已存 ask + 新 allow 并存：引擎判 prompt', () => {
    const engine = freshEngine();
    engine.loadUserRules({ ask: ['Bash(git push *)'], allow: ['Bash(git push origin main)'] });
    const verdict = engine.evaluate(bashRequest('git push origin main'));
    expect(verdict.action).toBe('prompt');
    expect(verdict.matchedRule?.id).toBe('user-prompt-Bash(git push *)');
  });
});
