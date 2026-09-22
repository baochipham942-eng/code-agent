// ============================================================================
// PermissionClassifier × Jev（TypeSafe System One）—— 权限线 w12
// ----------------------------------------------------------------------------
// 覆盖：开关默认关零调用、放行判据与五个阈值边界、报错/超时回落 ask、
// state 出境脱敏（家目录/密钥）、以及用 tests/fixtures/jev-permclass-samples.json
// 跑真分类器的两条反向变异（恒 destructive ⇒ 0 放行；恒抛错 ⇒ 全 ask）。
// Jev 经 ClassifierConfig.jevSystemOne 注入桩函数——不 mock 网络。
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { PermissionClassifier } from '../../../src/host/tools/permissionClassifier';
import type { JevSystemOneCall } from '../../../src/shared/constants/jevQuestions';

/** 真实生产样本里走到 fallback 的探针命令（基线验证过 rules → null）。 */
const FALLBACK_COMMAND = 'python3 -c "import pptx; print(pptx.__version__)"';

interface StubAnswers {
  riskChoice?: string;
  riskConfidence?: number;
  needsHuman?: number;
  secrets?: number;
  configAccess?: number;
  beyondScope?: number;
}

function stubSystemOne(overrides: StubAnswers = {}): JevSystemOneCall & { calls: unknown[] } {
  const calls: unknown[] = [];
  const fn = vi.fn(async (state: unknown) => {
    calls.push(state);
    return {
      risk: { choice: overrides.riskChoice ?? 'read_only', confidence: overrides.riskConfidence ?? 0.95 },
      needs_human: { noul: overrides.needsHuman ?? 0.1 },
      touches_secrets: { noul: overrides.secrets ?? 0.05 },
      config_or_credential_access: { noul: overrides.configAccess ?? 0.1 },
      beyond_scope: { noul: overrides.beyondScope ?? 0.1 },
    };
  }) as unknown as JevSystemOneCall & { calls: unknown[] };
  fn.calls = calls;
  return fn;
}

function throwingSystemOne(error: Error): JevSystemOneCall {
  return vi.fn(async () => {
    throw error;
  }) as unknown as JevSystemOneCall;
}

function newClassifier(jevSystemOne: JevSystemOneCall, enableLlm = true): PermissionClassifier {
  return new PermissionClassifier({ enableLlm, jevSystemOne });
}

async function classifyBash(
  classifier: PermissionClassifier,
  command: string,
): Promise<ReturnType<PermissionClassifier['classify']>> {
  return classifier.classify('Bash', { command }, { workingDirectory: '/tmp' });
}

describe('PermissionClassifier Jev（LLM classifier）', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('enableLlm=false ⇒ systemOne 零调用，维持 fallback ask', async () => {
    const stub = stubSystemOne();
    const classifier = newClassifier(stub, false);
    const result = await classifyBash(classifier, FALLBACK_COMMAND);

    expect(result.decision).toBe('ask');
    expect(result.riskUnknown).toBe(true);
    expect(result.traceStep?.rule).toBe('fallback');
    expect(stub.calls.length).toBe(0);
  });

  it('默认（不传 config）开关关闭：环境变量未设时不调 systemOne', async () => {
    const stub = stubSystemOne();
    // 显式传 jevSystemOne 但 enableLlm 缺省 → 环境变量未设 → 关
    const classifier = new PermissionClassifier({ jevSystemOne: stub });
    const result = await classifyBash(classifier, FALLBACK_COMMAND);

    expect(result.decision).toBe('ask');
    expect(stub.calls.length).toBe(0);
  });

  it('环境变量 CODE_AGENT_PERMISSION_LLM_CLASSIFIER=1 打开默认开关', async () => {
    vi.stubEnv('CODE_AGENT_PERMISSION_LLM_CLASSIFIER', '1');
    const stub = stubSystemOne();
    const classifier = new PermissionClassifier({ jevSystemOne: stub });
    const result = await classifyBash(classifier, FALLBACK_COMMAND);

    expect(result.decision).toBe('approve');
    expect(stub.calls.length).toBe(1);
  });

  it('满足判据 ⇒ approve + trace jev_approve + 结果进缓存', async () => {
    const stub = stubSystemOne();
    const classifier = newClassifier(stub);
    const first = await classifyBash(classifier, FALLBACK_COMMAND);

    expect(first.decision).toBe('approve');
    expect(first.confidence).toBe(0.95);
    expect(first.traceStep?.layer).toBe('permission_classifier');
    expect(first.traceStep?.rule).toBe('jev_approve');
    expect(first.traceStep?.result).toBe('allow');
    expect(first.reason).toContain('read_only');
    expect(first.reason).toContain('needs_human=0.10');
    expect(first.hostReason).toBeTruthy();

    const second = await classifyBash(classifier, FALLBACK_COMMAND);
    expect(second.decision).toBe('approve');
    expect(second.cached).toBe(true);
    expect(stub.calls.length).toBe(1);
  });

  describe('五个阈值边界各一 ⇒ 全部回落 fallback ask', () => {
    const cases: Array<{ name: string; overrides: StubAnswers }> = [
      { name: 'risk.confidence 0.79（< minRiskConfidence 0.8）', overrides: { riskConfidence: 0.79 } },
      { name: 'needs_human 0.2（不小于 maxNeedsHuman 0.2）', overrides: { needsHuman: 0.2 } },
      { name: 'touches_secrets 0.3（不小于 maxTouchesSecrets 0.3）', overrides: { secrets: 0.3 } },
      { name: 'config_access 0.5（不小于 maxConfigAccess 0.5）', overrides: { configAccess: 0.5 } },
      { name: 'risk=destructive（档位不在 tiers）', overrides: { riskChoice: 'destructive', riskConfidence: 0.99 } },
    ];

    for (const { name, overrides } of cases) {
      it(name, async () => {
        const classifier = newClassifier(stubSystemOne(overrides));
        const result = await classifyBash(classifier, FALLBACK_COMMAND);

        expect(result.decision).toBe('ask');
        expect(result.riskUnknown).toBe(true);
        expect(result.traceStep?.rule).toBe('fallback');
      });
    }

    it('risk=reversible_write（写档已收窄）也不放行', async () => {
      const classifier = newClassifier(stubSystemOne({ riskChoice: 'reversible_write', riskConfidence: 0.99 }));
      const result = await classifyBash(classifier, FALLBACK_COMMAND);

      expect(result.decision).toBe('ask');
      expect(result.traceStep?.rule).toBe('fallback');
    });
  });

  it('systemOne 抛错（含超时/中止形状）⇒ ask，不抛出', async () => {
    for (const error of [
      Object.assign(new Error('[typesafe] systemOne 超时（5000ms）或被外部中止'), { code: 'TYPESAFE_TIMEOUT' }),
      Object.assign(new Error('[typesafe] systemOne HTTP 429'), { code: 'TYPESAFE_HTTP_ERROR' }),
      new Error('network boom'),
    ]) {
      const classifier = newClassifier(throwingSystemOne(error));
      const result = await classifyBash(classifier, FALLBACK_COMMAND);

      expect(result.decision).toBe('ask');
      expect(result.riskUnknown).toBe(true);
      expect(result.traceStep?.rule).toBe('fallback');
    }
  });

  it('systemOne 回答形状不对（缺问/缺字段）⇒ ask', async () => {
    const broken = vi.fn(async () => ({ needs_human: { noul: 0.1 } })) as unknown as JevSystemOneCall;
    const classifier = newClassifier(broken);
    const result = await classifyBash(classifier, FALLBACK_COMMAND);

    expect(result.decision).toBe('ask');
    expect(result.traceStep?.rule).toBe('fallback');
  });

  it.each([
    { name: 'needs_human.noul=-1', overrides: { needsHuman: -1 } },
    { name: 'risk.confidence=NaN', overrides: { riskConfidence: Number.NaN } },
    { name: 'needs_human.noul=2', overrides: { needsHuman: 2 } },
  ])('数值越界视为形状不对 ⇒ ask（$name）', async ({ overrides }) => {
    const classifier = newClassifier(stubSystemOne(overrides));
    const result = await classifyBash(classifier, FALLBACK_COMMAND);

    expect(result.decision).toBe('ask');
    expect(result.riskUnknown).toBe(true);
    expect(result.traceStep?.rule).toBe('fallback');
  });

  it('state 出境前脱敏：无家目录原文、无密钥形状', async () => {
    const stub = stubSystemOne();
    const classifier = newClassifier(stub);
    const secretPath = path.join(os.homedir(), 'secret-notes.txt');
    const fakeKey = 'sk-' + '1'.repeat(24);
    const command = `python3 -c "print(open('${secretPath}').read()); print('${fakeKey}')"`;
    const result = await classifyBash(classifier, command);

    expect(stub.calls.length).toBe(1);
    const stateText = JSON.stringify(stub.calls[0]);
    expect(stateText).not.toContain(os.homedir());
    expect(stateText).not.toContain(fakeKey);
    expect(stateText).toContain('~/secret-notes.txt');
    // 脱敏不改判：命令本身仍走 Jev 判定
    expect(result.decision).toBe('approve');
  });

  it('非 Bash 工具 ⇒ systemOne 零调用、ask', async () => {
    const stub = stubSystemOne();
    const classifier = newClassifier(stub);
    for (const toolName of ['terminal_write', 'mcp', 'propose_team_recipe']) {
      const result = await classifier.classify(toolName, { text: 'x'.repeat(400) }, { workingDirectory: '/tmp' });
      expect(result.decision).toBe('ask');
      expect(result.riskUnknown).toBe(true);
      expect(result.traceStep?.rule).toBe('fallback');
    }
    expect(stub.calls.length).toBe(0);
  });

  it('扩桶工具走 Jev，并要求 beyond_scope 低于阈值', async () => {
    const stub = stubSystemOne();
    const classifier = newClassifier(stub);
    const result = await classifier.classify(
      'pdf_generate',
      { file_path: '/tmp/report.pdf', content: 'private text must not leave the machine' },
      { workingDirectory: '/tmp' },
    );

    expect(result.decision).toBe('approve');
    expect(stub.calls.length).toBe(1);
    const state = JSON.stringify(stub.calls[0]);
    expect(state).toContain('file_path=/tmp/report.pdf');
    expect(state).toContain('content=<omitted>');
    expect(state).not.toContain('private text must not leave the machine');
  });

  it('扩桶工具的 Jev 放行不进缓存：同目录同长度参数也逐次问 Jev', async () => {
    const stub = stubSystemOne();
    const classifier = newClassifier(stub);
    // buildCacheKey 对非 Bash 把 file_path 折叠成 dirname、超 100 字符的串折叠成
    // <string:len>——这两条 key 相同（同目录 + <string:150>），若 Jev 放行进缓存，
    // 第二条会命中缓存绕过 Jev（反向变异实证：删掉 bypassCache 后本测试红）。
    const first = await classifier.classify(
      'pdf_generate',
      { file_path: '/tmp/report-a.pdf', title: 'x'.repeat(150) },
      { workingDirectory: '/tmp' },
    );
    const second = await classifier.classify(
      'pdf_generate',
      { file_path: '/tmp/report-b.pdf', title: 'y'.repeat(150) },
      { workingDirectory: '/tmp' },
    );

    expect(first.decision).toBe('approve');
    expect(first.cached).toBe(false);
    expect(second.decision).toBe('approve');
    expect(second.cached).toBe(false);
    expect(stub.calls.length).toBe(2);
  });

  it('扩桶工具缺失 beyond_scope 或越界时保持 ask', async () => {
    const missing = vi.fn(async () => ({
      risk: { choice: 'read_only', confidence: 0.95 },
      needs_human: { noul: 0.1 },
      touches_secrets: { noul: 0.05 },
      config_or_credential_access: { noul: 0.1 },
    })) as unknown as JevSystemOneCall;
    const missingResult = await newClassifier(missing).classify(
      'image_analyze', { path: '/tmp/input.png' }, { workingDirectory: '/tmp' },
    );
    expect(missingResult.decision).toBe('ask');

    const outside = stubSystemOne({ beyondScope: 0.3 });
    const outsideResult = await newClassifier(outside).classify(
      'image_analyze', { path: '/tmp/input.png' }, { workingDirectory: '/tmp' },
    );
    expect(outsideResult.decision).toBe('ask');
  });

  it('字符串数组参数逐项进 state，不压成 <array>', async () => {
    const stub = stubSystemOne();
    const classifier = newClassifier(stub);
    await classifier.classify(
      'image_analyze',
      { paths: ['/tmp/batch-a.png', '/tmp/batch-b.png'] },
      { workingDirectory: '/tmp' },
    );

    expect(stub.calls.length).toBe(1);
    const state = JSON.stringify(stub.calls[0]);
    expect(state).toContain('/tmp/batch-a.png');
    expect(state).toContain('/tmp/batch-b.png');
    expect(state).not.toContain('paths=<array>');
  });

  it('路径形参数命中凭据目录 ⇒ 确定性 ask，systemOne 零调用（ai-review R1）', async () => {
    const stub = stubSystemOne();
    const classifier = newClassifier(stub);
    const homeSecret = `${os.homedir()}/.ssh/id_rsa.png`;

    const singleResult = await classifier.classify(
      'image_analyze', { path: homeSecret }, { workingDirectory: '/tmp' },
    );
    expect(singleResult.decision).toBe('ask');

    // 批量数组里混一条敏感路径同样整体 ask——不得随同批正常路径一起放行
    const batchResult = await classifier.classify(
      'image_analyze',
      { paths: ['/tmp/normal.png', '~/.ssh/leak.png'] },
      { workingDirectory: '/tmp' },
    );
    expect(batchResult.decision).toBe('ask');
    expect(stub.calls.length).toBe(0);
  });

  it('output_path 命中受保护写路径（.git/config / .code-agent/settings.json）⇒ 确定性 ask，systemOne 零调用（ai-review R3）', async () => {
    const stub = stubSystemOne();
    const classifier = newClassifier(stub);

    const gitConfig = await classifier.classify(
      'pdf_generate',
      { output_path: '.git/config', overwrite: true },
      { workingDirectory: '/tmp/work' },
    );
    expect(gitConfig.decision).toBe('ask');

    const agentSettings = await classifier.classify(
      'docx_generate',
      { output_path: '/tmp/work/.code-agent/settings.json' },
      { workingDirectory: '/tmp/work' },
    );
    expect(agentSettings.decision).toBe('ask');
    expect(stub.calls.length).toBe(0);
  });

  it('嵌套对象数组里的路径也过预检（ppt images[].image_path）', async () => {
    const stub = stubSystemOne();
    const classifier = newClassifier(stub);

    const result = await classifier.classify(
      'ppt_generate',
      { output_path: '/tmp/deck.pptx', images: [{ image_path: '~/.ssh/leak.png' }] },
      { workingDirectory: '/tmp' },
    );
    expect(result.decision).toBe('ask');
    expect(stub.calls.length).toBe(0);
  });

  it('image_generate / video_generate 是付费远端生成，不进扩桶白名单 ⇒ ask，systemOne 零调用', async () => {
    const stub = stubSystemOne();
    const classifier = newClassifier(stub);

    for (const tool of ['image_generate', 'video_generate']) {
      const result = await classifier.classify(
        tool, { output_path: '/tmp/out', prompt: 'a cat' }, { workingDirectory: '/tmp' },
      );
      expect(result.decision).toBe('ask');
    }
    expect(stub.calls.length).toBe(0);
  });

  it('glob 模式路径无法静态判定 ⇒ 确定性 ask，systemOne 零调用（ai-review R6）', async () => {
    const stub = stubSystemOne();
    const classifier = newClassifier(stub);
    const result = await classifier.classify(
      'image_analyze', { paths: ['*.png'] }, { workingDirectory: '/tmp' },
    );
    expect(result.decision).toBe('ask');
    expect(stub.calls.length).toBe(0);
  });

  it('正文 key 的长文本含斜杠不进文件系统解析，分类器不抛错（ai-review R6）', async () => {
    const stub = stubSystemOne();
    const classifier = newClassifier(stub);
    // 300 字符单段 + '/': 若被当路径逐段 lstat 会 ENAMETOOLONG
    const longSegment = 'a'.repeat(300);
    const result = await classifier.classify(
      'pdf_generate',
      { output_path: '/tmp/report.pdf', content: `see https://example.com/${longSegment}/details` },
      { workingDirectory: '/tmp' },
    );
    expect(result.decision).toBe('approve');
    expect(stub.calls.length).toBe(1);
  });

  it('工作区内的符号链接指向区外 ⇒ 按真实路径判，确定性 ask（ai-review R5）', async () => {
    const stub = stubSystemOne();
    const classifier = newClassifier(stub);
    // 用 /private/tmp 避开 macOS /tmp→/private/tmp 的符号链接歧义——否则预检
    // 不规范化候选路径时也会因根目录不匹配而 ask，钉不住符号链接这条语义。
    const workDir = fs.mkdtempSync(path.join('/private/tmp/', 'jev-symlink-'));
    // “区外”文件必须落在临时目录之外（临时目录本身是允许写根）——放 home 下的临时目录
    const outsideDir = fs.mkdtempSync(path.join(os.homedir(), '.jev-outside-'));
    const outsideFile = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(outsideFile, 'x');
    fs.symlinkSync(outsideFile, path.join(workDir, 'evil.pdf'));

    const result = await classifier.classify(
      'pdf_generate',
      { output_path: 'evil.pdf', overwrite: true },
      { workingDirectory: workDir },
    );
    fs.rmSync(outsideDir, { recursive: true, force: true });
    expect(result.decision).toBe('ask');
    expect(stub.calls.length).toBe(0);
  });

  it('写到工作目录与临时目录之外 ⇒ 确定性 ask 不外包 Jev；工作目录内照常放行（ai-review R4）', async () => {
    const outsideStub = stubSystemOne();
    const outside = await newClassifier(outsideStub).classify(
      'excel_generate',
      { output_path: '~/Documents/finance.xlsx', overwrite: true },
      { workingDirectory: '/tmp/work' },
    );
    expect(outside.decision).toBe('ask');
    expect(outsideStub.calls.length).toBe(0);

    const insideStub = stubSystemOne();
    const inside = await newClassifier(insideStub).classify(
      'excel_generate',
      { output_path: '/tmp/work/reports/finance.xlsx', overwrite: true },
      { workingDirectory: '/tmp/work' },
    );
    expect(inside.decision).toBe('approve');
    expect(insideStub.calls.length).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 反向变异（跑真代码）：桩模拟「被带偏/故障的 Jev」，分类器必须不放大损害。
  // 夹具 = tests/fixtures/jev-permclass-samples.json（20 放行 + 8 拒绝 + 5 destructive）。
  // ---------------------------------------------------------------------------

  interface FixtureSample {
    id: number;
    tool_name: string;
    summary: string;
    history_outcome: string;
  }

  function loadFixture(): FixtureSample[] {
    return JSON.parse(
      fs.readFileSync(path.join(__dirname, '../../fixtures/jev-permclass-samples.json'), 'utf8'),
    ) as FixtureSample[];
  }

  async function runFixture(jevSystemOne: JevSystemOneCall): Promise<Array<{ sample: FixtureSample; decision: string; rule: string }>> {
    const classifier = newClassifier(jevSystemOne);
    const outcomes = [];
    for (const sample of loadFixture()) {
      const args = sample.tool_name === 'Bash' ? { command: sample.summary } : {};
      const result = await classifier.classify(sample.tool_name, args, { workingDirectory: process.cwd() });
      outcomes.push({
        sample,
        decision: result.decision,
        rule: result.traceStep?.rule ?? '-',
      });
    }
    return outcomes;
  }

  it('变异①：systemOne 恒返 destructive 1.0 ⇒ Jev 侧 0 放行', async () => {
    const alwaysDestructive = stubSystemOne({ riskChoice: 'destructive', riskConfidence: 1, needsHuman: 0, secrets: 0, configAccess: 0 });
    const outcomes = await runFixture(alwaysDestructive);

    // Jev 说 destructive 时一条也不许经它放行
    expect(outcomes.filter((o) => o.rule === 'jev_approve').length).toBe(0);
    // 夹具里唯一的 decision=approve 是 id=8（规则层「安全命令」，根本没问 Jev——
    // 规则 allow 不受 Jev 影响，Jev 只缩小 ask 桶）
    expect(outcomes.filter((o) => o.decision === 'approve').map((o) => o.sample.id)).toEqual([8]);
    // 参照=拒绝 的样本一条不放行
    expect(outcomes.filter((o) => o.sample.history_outcome === 'ask-denied' && o.decision === 'approve').length).toBe(0);
  });

  it('变异②：systemOne 恒抛错 ⇒ 夹具全量不放行，fallback 样本全 ask', async () => {
    const alwaysThrows = throwingSystemOne(new Error('jev is down'));
    const outcomes = await runFixture(alwaysThrows);

    // 故障时 Jev 一条不放行；唯一 approve 仍是规则层的 id=8
    expect(outcomes.filter((o) => o.rule === 'jev_approve').length).toBe(0);
    expect(outcomes.filter((o) => o.decision === 'approve').map((o) => o.sample.id)).toEqual([8]);
    // 原本 Jev 可以放行的探针命令（规则层 null）在故障时必须回到 fallback ask
    const probe = outcomes.find((o) => o.sample.summary === FALLBACK_COMMAND);
    expect(probe?.decision).toBe('ask');
    expect(probe?.rule).toBe('fallback');
  });
});
