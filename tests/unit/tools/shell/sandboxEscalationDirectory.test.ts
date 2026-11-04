// ============================================================================
// N-SANDBOX-ESCALATE-DIR-HOST · 目录子树一次性扩权（host 侧）
// 边界断言按设计稿 docs/architecture/designs/sandbox-escalate-dir.md：
// 边界二「授权根必须恰是拒绝路径的 canonical 形式，绝不向上推断祖先」、
// 边界三「root/home/home 祖先/home 直接子目录永不 offer」、卡文案逐字（D5-A 例外句随
// DIR-FORBIDDEN 的禁写名机制同批落地，见下方专项断言）。
// 单文件版 A1–A12 仍由 tests/unit/tools/modules/shell/bash.test.ts 钉死，本文件只测目录分支。
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../src/host/protocol/tools';

// 与 bash.test.ts 同款 harness：mock 重依赖与沙箱包装（wrapMock 记录 wrapper 选项，
// 授权面判据全部看它，不看平台）。
vi.mock('../../../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: () => Promise.resolve(null),
}));

vi.mock('../../../../src/host/tools/dataFingerprint', () => ({
  extractBashFacts: () => null,
  dataFingerprintStore: { recordFact: () => {} },
}));

vi.mock('../../../../src/host/services/codex/codexSandbox', () => ({
  isCodexSandboxEnabled: () => false,
  runInCodexSandbox: () => Promise.resolve({ success: false }),
}));

vi.mock('../../../../src/host/security/commandSafety', () => ({
  isKnownSafeCommand: () => true,
}));

vi.mock('../../../../src/host/services/infra/shellEnvironment', () => ({
  getShellPathDiagnostics: () => ({
    path: process.env.PATH || '',
    source: 'process',
    pathEntryCount: (process.env.PATH || '').split(':').filter(Boolean).length,
    degraded: false,
    fallbackApplied: false,
    fallbackEntries: [],
  }),
}));

const startBackgroundTaskMock = vi.fn();
const handoverTimedOutCommandMock = vi.fn();
const createPtySessionMock = vi.fn();
const getPtySessionOutputMock = vi.fn();

vi.mock('../../../../src/host/tools/shell/backgroundTasks', () => ({
  startBackgroundTask: (...args: unknown[]) => startBackgroundTaskMock(...args),
}));

vi.mock('../../../../src/host/tools/shell/timeoutHandover', () => ({
  handoverTimedOutCommand: (...args: unknown[]) => handoverTimedOutCommandMock(...args),
}));

vi.mock('../../../../src/host/tools/shell/ptyExecutor', () => ({
  createPtySession: (...args: unknown[]) => createPtySessionMock(...args),
  getPtySessionOutput: (...args: unknown[]) => getPtySessionOutputMock(...args),
}));

const { wrapMock, cleanupMock } = vi.hoisted(() => {
  process.env.OS_SANDBOX_ENABLED = 'true';
  return { wrapMock: vi.fn(), cleanupMock: vi.fn() };
});
vi.mock('../../../../src/host/sandbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/host/sandbox')>()),
  wrapCommandForSandbox: (...args: unknown[]) => wrapMock(...args),
}));

const { spillArchive } = vi.hoisted(() => ({ spillArchive: vi.fn() }));
vi.mock('../../../../src/host/utils/toolResultSpill', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/host/utils/toolResultSpill')>();
  return {
    ...actual,
    spillToolResultArchive: (options: Parameters<typeof actual.spillToolResultArchive>[0]) => spillArchive(options),
  };
});

import { bashModule } from '../../../../src/host/tools/modules/shell/bash';
import { getPermissionModeManager } from '../../../../src/host/permissions/modes';
import { getSandboxManager } from '../../../../src/host/sandbox';
import { resolveCanonicalRunPath } from '../../../../src/host/runtime/runContext';
import { shouldOfferDirectoryEscalation } from '../../../../src/host/tools/shell/sandboxEscalation';
import { getPolicyEngine, resetPolicyEngine } from '../../../../src/host/permissions/policyEngine';
import { getPolicyEnforcer, resetPolicyEnforcer } from '../../../../src/host/security/policyEnforcer';
import type { SandboxEscalationEligibilityInput } from '../../../../src/host/tools/shell/sandboxEscalation';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test-session',
    workingDir: process.cwd(),
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    policyEnforcer: null,
    ...overrides,
  };
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

function makeEligibility(
  overrides: Partial<SandboxEscalationEligibilityInput> = {},
): SandboxEscalationEligibilityInput {
  return {
    sandboxDecision: { sandboxed: true },
    foreground: true,
    pty: false,
    background: false,
    unattended: false,
    writeFence: false,
    evalRealRoot: false,
    permissionMode: 'default',
    abortSignal: new AbortController().signal,
    deniedPath: undefined,
    deniedPathCreatesDirectory: undefined,
    newFileGrantSupported: true,
    workingDirectory: process.cwd(),
    policyEnforcer: null,
    ...overrides,
  };
}

describe('shouldOfferDirectoryEscalation (gate)', () => {
  const dirs: string[] = [];
  const tmp = (prefix: string): string => {
    const dir = resolveCanonicalRunPath(mkdtempSync(join(tmpdir(), prefix)));
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    resetPolicyEngine();
    resetPolicyEnforcer();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('offers an existing directory and returns its canonical path', () => {
    const dir = tmp('escalate-dir-existing-');
    expect(shouldOfferDirectoryEscalation(makeEligibility({ deniedPath: dir }))).toBe(dir);
  });

  it('offers the real directory when a parent is a symlink, never the workspace spelling', () => {
    const outside = tmp('escalate-dir-outside-');
    const ws = tmp('escalate-dir-ws-');
    mkdirSync(join(outside, 'sub'));
    const link = join(ws, 'link');
    symlinkSync(outside, link);
    // 拒绝信息里是工作区拼法 …/ws/link/sub，卡与授权都必须落在真实路径 …/outside/sub
    expect(shouldOfferDirectoryEscalation(makeEligibility({ deniedPath: join(ws, 'link', 'sub') })))
      .toBe(join(outside, 'sub'));
  });

  it('refuses a symlink as the denied path itself', () => {
    const real = tmp('escalate-dir-real-');
    const parent = tmp('escalate-dir-link-');
    const link = join(parent, 'link');
    symlinkSync(real, link);
    expect(shouldOfferDirectoryEscalation(makeEligibility({ deniedPath: link }))).toBeUndefined();
  });

  it('offers a mkdir-denied missing directory only when the parent exists and new paths can be granted', () => {
    const parent = tmp('escalate-dir-missing-');
    const target = join(parent, 'new-dir');
    const base = makeEligibility({ deniedPath: target, deniedPathCreatesDirectory: true });
    expect(shouldOfferDirectoryEscalation(base)).toBe(target);
    // linux（bwrap 绑不了不存在的路径）：不出卡
    expect(shouldOfferDirectoryEscalation({ ...base, newFileGrantSupported: false })).toBeUndefined();
    // 不是 mkdir 拒绝的 missing 路径：不出卡
    expect(shouldOfferDirectoryEscalation({ ...base, deniedPathCreatesDirectory: false })).toBeUndefined();
    // 父目录不存在：不出卡
    expect(
      shouldOfferDirectoryEscalation({ ...base, deniedPath: join(parent, 'no-such', 'new-dir') }),
    ).toBeUndefined();
  });

  it('grants exactly the denied mkdir path and never its nearest existing ancestor (边界二反例)', () => {
    // mkdir /a/b/c，现存的是 /a：授权根必须恰是 /a/b/c 的 canonical 形式，绝不取最近现存祖先 /a
    const a = tmp('escalate-dir-a-');
    const b = join(a, 'b');
    mkdirSync(b);
    const c = join(b, 'c');
    expect(
      shouldOfferDirectoryEscalation(makeEligibility({ deniedPath: c, deniedPathCreatesDirectory: true })),
    ).toBe(c);
    // 父目录 b 不存在时（只有 /a 现存）missing 分支直接不出卡，更轮不到取祖先
    expect(
      shouldOfferDirectoryEscalation(makeEligibility({
        deniedPath: join(a, 'b2', 'c'),
        deniedPathCreatesDirectory: true,
      })),
    ).toBeUndefined();
  });

  it('refuses root, home, home ancestors, and direct children of home (spelled and resolved)', () => {
    const home = resolveCanonicalRunPath(homedir());
    const refused = [
      '/',
      home,
      dirname(home), // 含 /Users：子树包住 home
      join(home, 'Library'),
      join(home, 'neo-escalate-probe'), // home 直接子目录一刀切，不逐个评判存在性
    ];
    for (const candidate of refused) {
      expect(
        shouldOfferDirectoryEscalation(makeEligibility({ deniedPath: candidate })),
        candidate,
      ).toBeUndefined();
      expect(
        shouldOfferDirectoryEscalation(makeEligibility({ deniedPath: candidate, deniedPathCreatesDirectory: true })),
        `${candidate} (mkdir)`,
      ).toBeUndefined();
    }
    // resolved 侧：指向 home 的软链拼写 canonical 化后落回 home 本尊，仍拒
    const linkParent = tmp('escalate-dir-home-link-');
    const homeAlias = join(linkParent, 'home-alias');
    symlinkSync(home, homeAlias);
    expect(
      shouldOfferDirectoryEscalation(makeEligibility({ deniedPath: homeAlias })),
    ).toBeUndefined();
  });

  it('refuses files and shares every file-gate session/mode/fence gate', () => {
    const dir = tmp('escalate-dir-gates-');
    const file = join(dir, 'file.txt');
    writeFileSync(file, 'x');
    // 现存普通文件走文件门，目录门不得接盘
    expect(shouldOfferDirectoryEscalation(makeEligibility({ deniedPath: file }))).toBeUndefined();
    const aborted = new AbortController();
    aborted.abort();
    const ineligible: Array<Partial<SandboxEscalationEligibilityInput>> = [
      { sandboxDecision: { sandboxed: false } },
      { foreground: false },
      { pty: true },
      { background: true },
      { unattended: true },
      { writeFence: true },
      { evalRealRoot: true },
      { permissionMode: 'readOnly' },
      { permissionMode: 'bypassPermissions' },
      { deniedPath: 'relative-dir' },
      { deniedPath: undefined },
      { policyEnforcer: undefined },
      { abortSignal: aborted.signal },
    ];
    for (const override of ineligible) {
      const input = { deniedPath: dir, ...override } as Partial<SandboxEscalationEligibilityInput>;
      expect(shouldOfferDirectoryEscalation(makeEligibility(input)), JSON.stringify(override)).toBeUndefined();
    }
  });

  it('never offers a policy-denied directory body', () => {
    const project = tmp('escalate-dir-policy-project-');
    const dir = tmp('escalate-dir-policy-');
    writeFileSync(join(project, 'code-agent-policy.toml'), [
      '[filesystem]',
      `writable_paths = ["./**", "${dir}/**"]`,
      `denied_paths = ["${dir}"]`,
      '',
    ].join('\n'));
    resetPolicyEnforcer();
    const policyEnforcer = getPolicyEnforcer(project);
    expect(policyEnforcer?.isActive).toBe(true);
    try {
      // active policy denied_paths 命中目录本体：审批不能覆盖策略
      expect(
        shouldOfferDirectoryEscalation(makeEligibility({ deniedPath: dir, policyEnforcer })),
      ).toBeUndefined();
      // 用户 Edit deny 命中目录本体：同样硬拒
      const userDenied = join(dir, 'user-denied');
      mkdirSync(userDenied);
      getPolicyEngine().loadUserRules({ deny: [`Edit(${userDenied})`] });
      expect(
        shouldOfferDirectoryEscalation(makeEligibility({ deniedPath: userDenied, policyEnforcer })),
      ).toBeUndefined();
      // 未被点名的孙目录照常 offer（D2：本体照旧查、子孙不预判）
      const grandchild = join(dir, 'sub', 'deep');
      mkdirSync(grandchild, { recursive: true });
      expect(
        shouldOfferDirectoryEscalation(makeEligibility({ deniedPath: grandchild, policyEnforcer })),
      ).toBe(grandchild);
    } finally {
      resetPolicyEngine();
      resetPolicyEnforcer();
    }
  });
});

describe('bashModule directory escalation', () => {
  const modeMgr = getPermissionModeManager();
  let availableSpy: ReturnType<typeof vi.spyOn> | undefined;
  let newFileGrantSpy: ReturnType<typeof vi.spyOn> | undefined;
  const dirs: string[] = [];
  const tmp = (prefix: string): string => {
    const dir = resolveCanonicalRunPath(mkdtempSync(join(tmpdir(), prefix)));
    dirs.push(dir);
    return dir;
  };
  // D5-A 例外句只承诺拒绝时**已存在**的禁写名（deny 行 / ro-bind 盖现存路径，FB-415）：
  // 已有目录卡带「其中已有的…」句；拒绝时尚不存在的目录（mkdir 拒绝）没有可保护对象，卡面不带该句。
  const DIR_CARD_REASON = (path: string) =>
    `沙盒拦截了这一步：它想写入目录 ${path}（含其中全部内容）。允许仅这一次写入这个目录及其中内容并重跑？（其中已有的凭据与配置类文件仍不可写）`;
  const MISSING_DIR_CARD_REASON = (path: string) =>
    `沙盒拦截了这一步：它想写入目录 ${path}（含其中全部内容）。允许仅这一次写入这个目录及其中内容并重跑？`;

  beforeEach(() => {
    modeMgr.setMode('default', true);
    process.env.OS_SANDBOX_ENABLED = 'true';
    availableSpy = vi.spyOn(getSandboxManager(), 'isAvailable').mockReturnValue(true);
    newFileGrantSpy = vi.spyOn(getSandboxManager(), 'supportsNewFileWriteGrant').mockReturnValue(true);
    wrapMock.mockReset();
    cleanupMock.mockReset();
  });

  afterEach(() => {
    availableSpy?.mockRestore();
    newFileGrantSpy?.mockRestore();
    modeMgr.setMode('default', true);
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('asks once with the verbatim directory card, grants the subtree, and retries once after approval', async () => {
    const dir = tmp('escalate-dir-card-');
    wrapMock
      .mockReturnValueOnce({
        command: `printf '%s\\n' "EPERM: operation not permitted, open '${dir}'" >&2; exit 1`,
        cleanup: cleanupMock,
      })
      .mockReturnValueOnce({ command: "printf 'retried\\n'", cleanup: cleanupMock });
    const canUse = vi.fn().mockResolvedValue({ allow: true as const });
    const handler = await bashModule.createHandler();
    const result = await handler.execute({ command: `mkdir -p ${dir}` }, makeCtx(), canUse);
    expect(result.ok).toBe(true);
    expect(wrapMock).toHaveBeenCalledTimes(2);
    const escalationCalls = canUse.mock.calls.filter(([toolName]) => toolName === 'bash');
    expect(escalationCalls).toHaveLength(1);
    expect(canUse).toHaveBeenCalledTimes(2);
    expect(escalationCalls[0]?.[2]).toBe(DIR_CARD_REASON(dir));
    expect(escalationCalls[0]?.[3]).toEqual(expect.objectContaining({
      type: 'command',
      forceConfirm: true,
      dangerLevel: 'warning',
      reason: DIR_CARD_REASON(dir),
      details: { command: `mkdir -p ${dir}`, deniedPath: dir, action: 'sandbox_escalate_dir_once' },
    }));
    // 目录授权走 readWriteRoots（基座写根缺省回退 cwd，之上追加该目录），永不进 readWriteFiles；
    // 该树同时作为 forbiddenWriteUnder 下传：子树内禁写名（凭据/笼子/钩子/rc）仍保持只读（DIR-FORBIDDEN）
    const firstOptions = wrapMock.mock.calls[0]?.[1] as { readWriteRoots?: string[]; readWriteFiles?: string[]; forbiddenWriteUnder?: string[] };
    const retryOptions = wrapMock.mock.calls[1]?.[1] as { readWriteRoots?: string[]; readWriteFiles?: string[]; forbiddenWriteUnder?: string[] };
    expect(firstOptions.readWriteRoots).toBeUndefined();
    expect(firstOptions.forbiddenWriteUnder).toBeUndefined();
    expect(retryOptions.readWriteRoots).toEqual([resolveCanonicalRunPath(process.cwd()), dir]);
    expect(retryOptions.readWriteFiles).toBeUndefined();
    expect(retryOptions.forbiddenWriteUnder).toEqual([dir]);
    if (result.ok) {
      expect(result.meta?.sandboxEscalation).toEqual({ path: dir, decision: 'approved', granularity: 'directory' });
    }
  });

  it('carries the existing-files credential/config exception sentence (D5 + DIR-FORBIDDEN, FB-415)', async () => {
    // D5 r1：例外句「（其中已有的凭据与配置类文件仍不可写）」与禁写名机制同批上卡面——
    // deny 行 / ro-bind 盖只盖**已存在**的禁写名（设计稿 D1 残余：新建名挡不住），措辞如实。
    // 反向钉死：句子若被单独摘掉，本测试红。
    const dir = tmp('escalate-dir-exception-');
    wrapMock
      .mockReturnValueOnce({
        command: `printf '%s\\n' "EPERM: operation not permitted, open '${dir}'" >&2; exit 1`,
        cleanup: cleanupMock,
      })
      .mockReturnValueOnce({ command: "printf 'retried\\n'", cleanup: cleanupMock });
    const canUse = vi.fn().mockResolvedValue({ allow: true as const });
    const handler = await bashModule.createHandler();
    await handler.execute({ command: `mkdir -p ${dir}` }, makeCtx(), canUse);
    const escalationCalls = canUse.mock.calls.filter(([toolName]) => toolName === 'bash');
    expect(escalationCalls).toHaveLength(1);
    const reason = escalationCalls[0]?.[2] as string;
    expect(reason).toBe(DIR_CARD_REASON(dir));
    expect(reason).toContain('（其中已有的凭据与配置类文件仍不可写）');
    // 例外句只在目录卡上：机制（forbiddenWriteUnder → deny 行 / ro-bind）只随目录授权下发
    const retryOptions = wrapMock.mock.calls[1]?.[1] as { forbiddenWriteUnder?: string[] };
    expect(retryOptions.forbiddenWriteUnder).toEqual([dir]);
  });

  it('omits the exception sentence for a directory that does not exist at denial time (FB-415)', async () => {
    // 禁写名 deny 行 / ro-bind 盖只覆盖子树内已存在的名字；mkdir 拒绝时目录尚不存在，
    // 没有可保护对象——卡面不得承诺开不出的保护（铁律：重跑开口子 ⊆ 卡面承诺）。
    // 禁写名机制本身不受措辞影响：missing 目录的重跑同样下发 forbiddenWriteUnder。
    const parent = tmp('escalate-dir-missing-sentence-');
    const missing = join(parent, 'new-dir');
    wrapMock
      .mockReturnValueOnce({
        command: `printf '%s\\n' 'mkdir: ${missing}: Operation not permitted' >&2; exit 1`,
        cleanup: cleanupMock,
      })
      .mockReturnValueOnce({ command: "printf 'retried\\n'", cleanup: cleanupMock });
    const canUse = vi.fn().mockResolvedValue({ allow: true as const });
    const handler = await bashModule.createHandler();
    const result = await handler.execute({ command: `mkdir ${missing}` }, makeCtx(), canUse);
    expect(result.ok).toBe(true);
    const escalationCalls = canUse.mock.calls.filter(([toolName]) => toolName === 'bash');
    expect(escalationCalls).toHaveLength(1);
    expect(escalationCalls[0]?.[2]).toBe(MISSING_DIR_CARD_REASON(missing));
    expect(escalationCalls[0]?.[2]).not.toContain('仍不可写');
    const retryOptions = wrapMock.mock.calls[1]?.[1] as { readWriteRoots?: string[]; forbiddenWriteUnder?: string[] };
    expect(retryOptions.readWriteRoots).toEqual([resolveCanonicalRunPath(process.cwd()), missing]);
    expect(retryOptions.forbiddenWriteUnder).toEqual([missing]);
  });

  it('grants exactly the denied mkdir path and never its nearest existing ancestor (边界二反例)', async () => {
    // mkdir /a/b/c，现存的是 /a：重跑 wrapper 只追加 c 本身（missing 目录），绝不绑最近现存祖先 /a
    const a = tmp('escalate-dir-retry-a-');
    const b = join(a, 'b');
    mkdirSync(b);
    const c = join(b, 'c');
    wrapMock
      .mockReturnValueOnce({
        command: `printf '%s\\n' 'mkdir: ${c}: Operation not permitted' >&2; exit 1`,
        cleanup: cleanupMock,
      })
      .mockReturnValueOnce({ command: "printf 'retried\\n'", cleanup: cleanupMock });
    const canUse = vi.fn().mockResolvedValue({ allow: true as const });
    const handler = await bashModule.createHandler();
    const result = await handler.execute({ command: `mkdir -p ${c}` }, makeCtx(), canUse);
    expect(result.ok).toBe(true);
    const escalationCalls = canUse.mock.calls.filter(([toolName]) => toolName === 'bash');
    expect(escalationCalls).toHaveLength(1);
    // mkdir 拒绝的 c 拒绝时尚不存在：卡面不带例外句（FB-415）
    expect(escalationCalls[0]?.[2]).toBe(MISSING_DIR_CARD_REASON(c));
    const retryOptions = wrapMock.mock.calls[1]?.[1] as { readWriteRoots?: string[]; readWriteFiles?: string[] };
    expect(retryOptions.readWriteRoots).toEqual([resolveCanonicalRunPath(process.cwd()), c]);
    expect(retryOptions.readWriteRoots).not.toContain(a);
    expect(retryOptions.readWriteRoots).not.toContain(b);
    expect(retryOptions.readWriteFiles).toBeUndefined();
    if (result.ok) {
      expect(result.meta?.sandboxEscalation).toEqual({ path: c, decision: 'approved', granularity: 'directory' });
    }
  });

  it('declines keep the original failure and record directory granularity', async () => {
    const dir = tmp('escalate-dir-decline-');
    wrapMock.mockReturnValue({
      command: `printf '%s\\n' "EPERM: operation not permitted, open '${dir}'" >&2; exit 1`,
      cleanup: cleanupMock,
    });
    const canUse = vi.fn()
      .mockResolvedValueOnce({ allow: true as const })
      .mockResolvedValueOnce({ allow: false as const, reason: 'no' });
    const handler = await bashModule.createHandler();
    const result = await handler.execute({ command: `touch ${join(dir, 'x')}` }, makeCtx(), canUse);
    expect(result.ok).toBe(false);
    expect(wrapMock).toHaveBeenCalledTimes(1);
    if (!result.ok) {
      expect(result.error).toContain('Command failed with exit code 1');
      expect(result.error).toContain('The user declined to widen the sandbox');
      expect(result.meta?.sandboxEscalation).toEqual({ path: dir, decision: 'declined', granularity: 'directory' });
    }
  });

  it('does not open a second card when the approved directory retry fails', async () => {
    const dir = tmp('escalate-dir-retry-fail-');
    const denial = `printf '%s\\n' "EPERM: operation not permitted, open '${dir}'" >&2; exit 1`;
    wrapMock
      .mockReturnValueOnce({ command: denial, cleanup: cleanupMock })
      .mockReturnValueOnce({ command: denial, cleanup: cleanupMock });
    const canUse = vi.fn().mockResolvedValue({ allow: true as const });
    const handler = await bashModule.createHandler();
    const result = await handler.execute({ command: `touch ${join(dir, 'x')}` }, makeCtx(), canUse);
    expect(result.ok).toBe(false);
    expect(wrapMock).toHaveBeenCalledTimes(2);
    expect(canUse).toHaveBeenCalledTimes(2);
    if (!result.ok) {
      expect(result.meta?.sandboxEscalation).toEqual({ path: dir, decision: 'approved', granularity: 'directory' });
    }
  });

  it('keeps the file card for file denials (file gate first, directory gate never takes over)', async () => {
    const dir = tmp('escalate-dir-file-first-');
    const file = join(dir, 'out.txt');
    writeFileSync(file, 'x');
    wrapMock
      .mockReturnValueOnce({
        command: `printf '%s\\n' "EPERM: operation not permitted, open '${file}'" >&2; exit 1`,
        cleanup: cleanupMock,
      })
      .mockReturnValueOnce({ command: "printf 'retried\\n'", cleanup: cleanupMock });
    const canUse = vi.fn().mockResolvedValue({ allow: true as const });
    const handler = await bashModule.createHandler();
    const result = await handler.execute({ command: `printf x > ${file}` }, makeCtx(), canUse);
    expect(result.ok).toBe(true);
    const escalationCalls = canUse.mock.calls.filter(([toolName]) => toolName === 'bash');
    expect(escalationCalls).toHaveLength(1);
    expect(escalationCalls[0]?.[2]).toBe(`沙盒拦截了这一步：它想写入文件 ${file}。允许仅这一次写入这个文件并重跑？`);
    expect(escalationCalls[0]?.[3]).toEqual(expect.objectContaining({
      details: expect.objectContaining({ deniedPath: file, action: 'sandbox_escalate_once' }),
    }));
    const retryOptions = wrapMock.mock.calls[1]?.[1] as { readWriteRoots?: string[]; readWriteFiles?: string[]; forbiddenWriteUnder?: string[] };
    expect(retryOptions.readWriteFiles).toEqual([file]);
    expect(retryOptions.readWriteRoots).toBeUndefined();
    // 文件卡（sandbox_escalate_once）永不带 forbiddenWriteUnder：禁写名例外只属于目录子树授权
    expect(retryOptions.forbiddenWriteUnder).toBeUndefined();
    if (result.ok) {
      expect(result.meta?.sandboxEscalation).toEqual({ path: file, decision: 'approved' });
    }
  });

  it('offers existing directories even when the sandbox cannot grant new paths, but never missing ones (D3)', async () => {
    newFileGrantSpy?.mockReturnValue(false);
    const existing = tmp('escalate-dir-bwrap-');
    const handler = await bashModule.createHandler();
    const offered = async (denial: string, command: string): Promise<number> => {
      wrapMock.mockReset();
      wrapMock.mockReturnValue({ command: denial, cleanup: cleanupMock });
      const canUse = vi.fn().mockResolvedValue({ allow: true as const });
      await handler.execute({ command }, makeCtx(), canUse);
      return canUse.mock.calls.filter(([toolName]) => toolName === 'bash').length;
    };
    // 现存目录（写目录内被拒）：两平台都可授
    expect(await offered(
      `printf '%s\\n' "EPERM: operation not permitted, open '${existing}'" >&2; exit 1`,
      `touch ${join(existing, 'x')}`,
    )).toBe(1);
    // mkdir 的 missing 目录（bwrap 绑不了不存在的路径）：不出卡
    expect(await offered(
      `printf '%s\\n' 'mkdir: ${join(existing, 'new')}: Operation not permitted' >&2; exit 1`,
      `mkdir ${join(existing, 'new')}`,
    )).toBe(0);
  });

  it('never opens a directory card for a direct child of home', async () => {
    // 在 home 下真建一个直接子目录（跨平台确定性），写它被拒也不得出卡
    const child = resolveCanonicalRunPath(mkdtempSync(join(homedir(), 'neo-escalate-home-child-')));
    try {
      wrapMock.mockReturnValue({
        command: `printf '%s\\n' "EPERM: operation not permitted, open '${child}'" >&2; exit 1`,
        cleanup: cleanupMock,
      });
      const canUse = vi.fn().mockResolvedValue({ allow: true as const });
      const handler = await bashModule.createHandler();
      const result = await handler.execute({ command: `touch ${join(child, 'x')}` }, makeCtx(), canUse);
      expect(canUse.mock.calls.filter(([toolName]) => toolName === 'bash')).toHaveLength(0);
      expect(canUse).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.meta?.sandboxEscalation).toBeUndefined();
    } finally {
      rmSync(child, { recursive: true, force: true });
    }
  });

  // N-SANDBOX-ESCALATE-DIR-TESTS：三条边界的 bash 模块级反例。写目录本体被拒用
  // EPERM open 形（现存目录）、mkdir 被拒用 `mkdir: <path>:` 形，均与真实 seatbelt 文案一致。
  const escalationCardCount = async (
    handler: Awaited<ReturnType<typeof bashModule.createHandler>>,
    denial: string,
    command: string,
    ctx = makeCtx(),
  ): Promise<number> => {
    wrapMock.mockReset();
    wrapMock.mockReturnValue({ command: denial, cleanup: cleanupMock });
    const canUse = vi.fn().mockResolvedValue({ allow: true as const });
    await handler.execute({ command }, ctx, canUse);
    return canUse.mock.calls.filter(([toolName]) => toolName === 'bash').length;
  };

  it('never opens a directory card for /, the home ancestor, home itself, or a symlink alias of home (end to end)', async () => {
    // 边界三 bash 级：gate 级已钉（refuses root, home, home ancestors...），这里从失败文案
    // 提取路径一路走到出卡判定，四个形状都不得出卡。别名拼写 lstat 见软链拒之，canonical
    // 化后也落回 home 本尊——两层判据都得拒绝它。
    const home = resolveCanonicalRunPath(homedir());
    const linkParent = tmp('escalate-dir-home-e2e-');
    const homeAlias = join(linkParent, 'home-alias');
    symlinkSync(home, homeAlias);
    const handler = await bashModule.createHandler();
    try {
      for (const candidate of ['/', dirname(home), home, homeAlias]) {
        wrapMock.mockReset();
        wrapMock.mockReturnValue({
          command: `printf '%s\\n' "EPERM: operation not permitted, open '${candidate}'" >&2; exit 1`,
          cleanup: cleanupMock,
        });
        const canUse = vi.fn().mockResolvedValue({ allow: true as const });
        const result = await handler.execute({ command: `touch ${join(candidate, 'probe')}` }, makeCtx(), canUse);
        expect(canUse.mock.calls.filter(([toolName]) => toolName === 'bash'), candidate).toHaveLength(0);
        expect(canUse, candidate).toHaveBeenCalledTimes(1);
        expect(result.ok, candidate).toBe(false);
        if (!result.ok) expect(result.meta?.sandboxEscalation).toBeUndefined();
      }
    } finally {
      rmSync(linkParent, { recursive: true, force: true });
    }
  });

  it('never opens a directory card for a policy-denied directory body (end to end)', async () => {
    // 边界二 bash 级：审批不能覆盖 denyConcreteShellWritePath——active policy denied_paths
    // 或用户 Edit deny 命中目录本体时，从失败文案到出卡判定全程零卡；未被点名的子孙照常
    // 出卡（D2 本体照旧查、子孙不预判），兼作策略真在起作用的阳性对照。
    const project = tmp('escalate-dir-epolicy-project-');
    const dir = tmp('escalate-dir-epolicy-');
    writeFileSync(join(project, 'code-agent-policy.toml'), [
      '[filesystem]',
      `writable_paths = ["./**", "${dir}/**"]`,
      `denied_paths = ["${dir}"]`,
      '',
    ].join('\n'));
    resetPolicyEnforcer();
    const policyEnforcer = getPolicyEnforcer(project);
    expect(policyEnforcer?.isActive).toBe(true);
    const handler = await bashModule.createHandler();
    const boundCtx = makeCtx({ policyEnforcer });
    try {
      expect(await escalationCardCount(
        handler,
        `printf '%s\\n' "EPERM: operation not permitted, open '${dir}'" >&2; exit 1`,
        `touch ${join(dir, 'x')}`,
        boundCtx,
      )).toBe(0);
      const userDenied = join(dir, 'user-denied');
      mkdirSync(userDenied);
      resetPolicyEngine();
      getPolicyEngine().loadUserRules({ deny: [`Edit(${userDenied})`] });
      expect(await escalationCardCount(
        handler,
        `printf '%s\\n' "EPERM: operation not permitted, open '${userDenied}'" >&2; exit 1`,
        `touch ${join(userDenied, 'x')}`,
        boundCtx,
      )).toBe(0);
      resetPolicyEngine();
      const grandchild = join(dir, 'sub', 'deep');
      mkdirSync(grandchild, { recursive: true });
      expect(await escalationCardCount(
        handler,
        `printf '%s\\n' "EPERM: operation not permitted, open '${grandchild}'" >&2; exit 1`,
        `touch ${join(grandchild, 'x')}`,
        boundCtx,
      )).toBe(1);
    } finally {
      resetPolicyEngine();
      resetPolicyEnforcer();
    }
  });

  it('mkdir-denied missing directories follow the platform capability; the grant root is exactly the denied path', async () => {
    // D3 平台差 bash 级自洽版：同一 missing 路径，new-path 授权关（bwrap 形）永不 out 卡、
    // 开（seatbelt 形）出卡且重跑写根恰是该路径；现存目录不受能力开关影响；父链缺失的
    // 嵌套 missing（mkdir -p 形）无论开关都不出卡。mkdir 重跑同时必须带禁写名清单（边界一）。
    const parent = tmp('escalate-dir-capability-');
    const missing = join(parent, 'new-dir');
    const deep = join(parent, 'a', 'b');
    const existing = tmp('escalate-dir-capability-exists-');
    const handler = await bashModule.createHandler();
    const mkdirDenial = (path: string) => `printf '%s\\n' 'mkdir: ${path}: Operation not permitted' >&2; exit 1`;
    try {
      newFileGrantSpy?.mockReturnValue(false);
      expect(await escalationCardCount(
        handler,
        `printf '%s\\n' "EPERM: operation not permitted, open '${existing}'" >&2; exit 1`,
        `touch ${join(existing, 'x')}`,
      )).toBe(1);
      expect(await escalationCardCount(handler, mkdirDenial(missing), `mkdir ${missing}`)).toBe(0);
      expect(await escalationCardCount(handler, mkdirDenial(deep), `mkdir -p ${deep}`)).toBe(0);

      newFileGrantSpy?.mockReturnValue(true);
      wrapMock.mockReset();
      wrapMock
        .mockReturnValueOnce({ command: mkdirDenial(missing), cleanup: cleanupMock })
        .mockReturnValueOnce({ command: "printf 'retried\\n'", cleanup: cleanupMock });
      const canUse = vi.fn().mockResolvedValue({ allow: true as const });
      const result = await handler.execute({ command: `mkdir ${missing}` }, makeCtx(), canUse);
      expect(result.ok).toBe(true);
      expect(canUse.mock.calls.filter(([toolName]) => toolName === 'bash')).toHaveLength(1);
      const retryOptions = wrapMock.mock.calls[1]?.[1] as { readWriteRoots?: string[]; forbiddenWriteUnder?: string[] };
      expect(retryOptions.readWriteRoots).toEqual([resolveCanonicalRunPath(process.cwd()), missing]);
      expect(retryOptions.forbiddenWriteUnder).toEqual([missing]);
      // 父链缺失（mkdir -p 的深层拼写）：能力开也不出卡
      expect(await escalationCardCount(handler, mkdirDenial(deep), `mkdir -p ${deep}`)).toBe(0);
    } finally {
      newFileGrantSpy?.mockReturnValue(true);
    }
  });
});
