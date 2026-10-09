import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import type { ToolCall, ToolResult } from '../../../src/shared/contract';
import type { ContextAssembly } from '../../../src/host/agent/runtime/contextAssembly';
import type { RunFinalizer } from '../../../src/host/agent/runtime/runFinalizer';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';
import type { ArtifactPreviewHealthSummary } from '../../../src/host/agent/runtime/browser/artifactPreviewHealth';

// 接线验收（N-DESIGN-PREVIEW-REPAIR-WIRE ①②③）：网页交付物写后确定性预览体检 +
// 至多一次自动修复。designPreviewRepair 只替换 assessment 的 healthRunner（spec/prompt
// 构造走真实现），vision runner 整体替换为 spy 以断言"从不调用"。

const previewRepairState = vi.hoisted(() => ({ healthRunner: vi.fn() }));
const visionState = vi.hoisted(() => ({ runArtifactPreviewVision: vi.fn() }));
const gameValidatorState = vi.hoisted(() => ({ validateGameArtifact: vi.fn() }));

vi.mock('../../../src/host/agent/runtime/browser/designPreviewRepair', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../src/host/agent/runtime/browser/designPreviewRepair')
  >();
  return {
    ...actual,
    runDesignPreviewRepairAssessment: vi.fn((artifactPath: string, options = {}) =>
      actual.runDesignPreviewRepairAssessment(artifactPath, {
        ...options,
        healthRunner: previewRepairState.healthRunner,
      })),
  };
});

vi.mock('../../../src/host/agent/runtime/browser/artifactPreviewVision', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../src/host/agent/runtime/browser/artifactPreviewVision')
  >();
  return {
    ...actual,
    runArtifactPreviewVision: visionState.runArtifactPreviewVision,
  };
});

vi.mock('../../../src/host/agent/runtime/gameArtifactValidator', () => ({
  validateGameArtifact: gameValidatorState.validateGameArtifact,
}));

import { maybeRunWebDeliverablePreviewRepair } from '../../../src/host/agent/runtime/webDeliverablePreviewRepair';
import { handleModifiedArtifactValidation } from '../../../src/host/agent/runtime/toolArtifactValidationLifecycle';

function makeHealthSummary(overrides: Partial<ArtifactPreviewHealthSummary> = {}): ArtifactPreviewHealthSummary {
  return {
    attempted: true,
    passed: true,
    findings: [],
    failures: [],
    checks: ['artifact preview health passed'],
    diagnostics: {
      title: 'fixture',
      consoleErrors: [],
      pageErrors: [],
      viewports: [],
    },
    route: 'self-started-chrome',
    ...overrides,
  };
}

function finding(code: string, message: string) {
  return { code, message } as ArtifactPreviewHealthSummary['findings'][number];
}

function findingsSummary(...codes: string[]): ArtifactPreviewHealthSummary {
  const findings = codes.map((code, index) => finding(code, `fixture finding ${index + 1}: ${code}`));
  return makeHealthSummary({
    passed: false,
    findings,
    failures: findings.map((item) => item.message),
  });
}

function makeCtx(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    workingDirectory: '/tmp',
    artifact: ArtifactState.forTest(),
    onEvent: vi.fn(),
    ...overrides,
  } as unknown as RuntimeContext;
}

function makeHarness(filePath: string, toolName = 'Write') {
  const contextAssembly = { injectSystemMessage: vi.fn() } as unknown as ContextAssembly;
  const runFinalizer = { emitTaskProgress: vi.fn() } as unknown as RunFinalizer;
  const toolCall: ToolCall = {
    id: 'call_write_web',
    name: toolName,
    arguments: { file_path: filePath, content: '<!doctype html><html><body></body></html>' },
  };
  const toolResult: ToolResult = { toolCallId: 'call_write_web', success: true, output: 'created' };
  return { contextAssembly, runFinalizer, toolCall, toolResult };
}

async function runHook(options: {
  ctx?: RuntimeContext;
  filePath: string;
  toolName?: string;
}) {
  const ctx = options.ctx ?? makeCtx();
  const harness = makeHarness(options.filePath, options.toolName);
  await maybeRunWebDeliverablePreviewRepair({
    ctx,
    contextAssembly: harness.contextAssembly,
    runFinalizer: harness.runFinalizer,
    toolCall: harness.toolCall,
    absolutePath: options.filePath,
    toolResult: harness.toolResult,
    healthRunner: previewRepairState.healthRunner,
  });
  return { ctx, ...harness };
}

async function runLifecycle(options: {
  ctx?: RuntimeContext;
  filePath: string;
  toolName?: string;
}) {
  const ctx = options.ctx ?? makeCtx();
  const harness = makeHarness(options.filePath, options.toolName);
  await handleModifiedArtifactValidation({
    ctx,
    contextAssembly: harness.contextAssembly,
    runFinalizer: harness.runFinalizer,
    toolCall: harness.toolCall,
    normalizedSuccess: true,
    toolResult: harness.toolResult,
    artifactRepairRollbackSnapshot: null,
  });
  return { ctx, ...harness };
}

function plainArtifactProbe() {
  return {
    shouldValidate: false,
    passed: false,
    isComplete: true,
    inferredKind: 'unknown',
    checks: [],
    failures: [],
  };
}

describe('webDeliverablePreviewRepair module', () => {
  beforeEach(() => {
    previewRepairState.healthRunner.mockReset();
    visionState.runArtifactPreviewVision.mockReset();
  });

  it('emits the notice and exactly one repair instruction when findings exist', async () => {
    previewRepairState.healthRunner.mockResolvedValueOnce(
      findingsSummary('blank_body_text', 'horizontal_overflow'),
    );

    const { runFinalizer, contextAssembly, toolResult } = await runHook({ filePath: '/tmp/page-a.html' });

    expect(previewRepairState.healthRunner).toHaveBeenCalledTimes(1);
    expect(runFinalizer.emitTaskProgress).toHaveBeenCalledWith(
      'tool_running',
      expect.stringContaining('2'),
    );
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledTimes(1);
    const [injected, source] = (contextAssembly.injectSystemMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(injected).toContain('<design-preview-repair kind="web_deliverable">');
    expect(injected).toContain('<design-preview-repair-spec>');
    expect(source).toBe('artifact-validation');
    expect(toolResult.metadata).toMatchObject({
      designPreviewRepair: { stage: 'repair-instructed' },
    });
  });

  it('re-checks once after the repair write and reports the fixed outcome', async () => {
    previewRepairState.healthRunner
      .mockResolvedValueOnce(findingsSummary('blank_body_text'))
      .mockResolvedValueOnce(makeHealthSummary());

    const ctx = makeCtx();
    const first = await runHook({ ctx, filePath: '/tmp/page-b.html' });
    expect(first.contextAssembly.injectSystemMessage).toHaveBeenCalledTimes(1);

    const second = await runHook({ ctx, filePath: '/tmp/page-b.html' });
    expect(second.runFinalizer.emitTaskProgress).toHaveBeenCalledWith(
      'tool_running',
      expect.stringContaining('fixed automatically'),
    );
    expect(second.contextAssembly.injectSystemMessage).not.toHaveBeenCalled();
    expect(second.toolResult.metadata).toMatchObject({
      designPreviewRepair: { stage: 'recheck-reported', repaired: true, remainingFindings: 0 },
    });
  });

  it('reports the still-broken outcome honestly without a second repair', async () => {
    previewRepairState.healthRunner
      .mockResolvedValueOnce(findingsSummary('blank_body_text'))
      .mockResolvedValueOnce(findingsSummary('blank_body_text', 'broken_image'));

    const ctx = makeCtx();
    await runHook({ ctx, filePath: '/tmp/page-c.html' });
    const second = await runHook({ ctx, filePath: '/tmp/page-c.html' });

    expect(second.runFinalizer.emitTaskProgress).toHaveBeenCalledWith(
      'tool_running',
      expect.stringContaining('2 display problem(s) remain'),
    );
    expect(second.contextAssembly.injectSystemMessage).not.toHaveBeenCalled();
  });

  it('never loops twice: a third write of the same path in the same run does nothing', async () => {
    previewRepairState.healthRunner
      .mockResolvedValueOnce(findingsSummary('blank_body_text'))
      .mockResolvedValueOnce(makeHealthSummary());

    const ctx = makeCtx();
    await runHook({ ctx, filePath: '/tmp/page-d.html' });
    await runHook({ ctx, filePath: '/tmp/page-d.html' });
    const third = await runHook({ ctx, filePath: '/tmp/page-d.html' });

    expect(previewRepairState.healthRunner).toHaveBeenCalledTimes(2);
    expect(third.runFinalizer.emitTaskProgress).not.toHaveBeenCalled();
    expect(third.contextAssembly.injectSystemMessage).not.toHaveBeenCalled();
    expect(third.toolResult.metadata).toBeUndefined();
  });

  it('is byte-identical when the page passes: no events, no injection, no metadata', async () => {
    previewRepairState.healthRunner.mockResolvedValue(makeHealthSummary());

    const { runFinalizer, contextAssembly, toolResult } = await runHook({ filePath: '/tmp/page-e.html' });

    expect(previewRepairState.healthRunner).toHaveBeenCalledTimes(1);
    expect(runFinalizer.emitTaskProgress).not.toHaveBeenCalled();
    expect(contextAssembly.injectSystemMessage).not.toHaveBeenCalled();
    expect(toolResult.metadata).toBeUndefined();
  });

  it.each(['/tmp/notes.md', '/tmp/app.tsx', '/tmp/report.docx', '/tmp/deck.pptx'])(
    'ignores non-web deliverables (%s)',
    async (filePath) => {
      const { runFinalizer, contextAssembly, toolResult } = await runHook({ filePath });

      expect(previewRepairState.healthRunner).not.toHaveBeenCalled();
      expect(runFinalizer.emitTaskProgress).not.toHaveBeenCalled();
      expect(contextAssembly.injectSystemMessage).not.toHaveBeenCalled();
      expect(toolResult.metadata).toBeUndefined();
    },
  );

  it('ignores append chunk writes (mid-stream partial files)', async () => {
    const { runFinalizer, toolResult } = await runHook({ filePath: '/tmp/page-f.html', toolName: 'append_file' });

    expect(previewRepairState.healthRunner).not.toHaveBeenCalled();
    expect(runFinalizer.emitTaskProgress).not.toHaveBeenCalled();
    expect(toolResult.metadata).toBeUndefined();
  });

  it('stays out of the way while the legacy game repair guard is active', async () => {
    const ctx = makeCtx({
      artifact: ArtifactState.forTest({
        repairGuard: { targetFile: '/tmp/other-game.html', attempts: 1, phase: 'baseline_repair' },
      }),
    });

    const { runFinalizer, toolResult } = await runHook({ ctx, filePath: '/tmp/page-g.html' });

    expect(previewRepairState.healthRunner).not.toHaveBeenCalled();
    expect(runFinalizer.emitTaskProgress).not.toHaveBeenCalled();
    expect(toolResult.metadata).toBeUndefined();
  });

  it('degrades without repair when the checker is skipped or failed (never fails the turn)', async () => {
    previewRepairState.healthRunner
      .mockResolvedValueOnce(makeHealthSummary({ attempted: false, skipped: true, passed: true }))
      .mockResolvedValueOnce(makeHealthSummary({ checkerFailed: true, passed: false, findings: [finding('page_error', 'Unable to run artifact preview health: boom')] }));

    for (const filePath of ['/tmp/page-h.html', '/tmp/page-i.html']) {
      const { runFinalizer, contextAssembly, toolResult } = await runHook({ filePath });
      expect(runFinalizer.emitTaskProgress).not.toHaveBeenCalled();
      expect(contextAssembly.injectSystemMessage).not.toHaveBeenCalled();
      expect(toolResult.metadata).toBeUndefined();
    }
  });

  it('swallows an assessment crash and leaves the turn untouched', async () => {
    previewRepairState.healthRunner.mockRejectedValueOnce(new Error('health runner exploded'));

    const { runFinalizer, contextAssembly, toolResult } = await runHook({ filePath: '/tmp/page-j.html' });

    expect(runFinalizer.emitTaskProgress).not.toHaveBeenCalled();
    expect(contextAssembly.injectSystemMessage).not.toHaveBeenCalled();
    expect(toolResult.metadata).toBeUndefined();
  });

  it('never calls the vision runner (deterministic checks only)', async () => {
    previewRepairState.healthRunner
      .mockResolvedValueOnce(findingsSummary('blank_body_text'))
      .mockResolvedValueOnce(makeHealthSummary());

    const ctx = makeCtx();
    await runHook({ ctx, filePath: '/tmp/page-k.html' });
    await runHook({ ctx, filePath: '/tmp/page-k.html' });

    expect(visionState.runArtifactPreviewVision).not.toHaveBeenCalled();
  });
});

describe('toolArtifactValidationLifecycle wiring', () => {
  beforeEach(() => {
    previewRepairState.healthRunner.mockReset();
    visionState.runArtifactPreviewVision.mockReset();
    gameValidatorState.validateGameArtifact.mockReset();
    gameValidatorState.validateGameArtifact.mockResolvedValue(plainArtifactProbe() as never);
  });

  it('runs the deterministic preview check for plain (non-game) html writes', async () => {
    previewRepairState.healthRunner.mockResolvedValueOnce(
      findingsSummary('blank_body_text', 'horizontal_overflow', 'primary_button_not_visible'),
    );

    const { runFinalizer, contextAssembly, toolResult } = await runLifecycle({ filePath: '/tmp/web-draft.html' });

    expect(gameValidatorState.validateGameArtifact).toHaveBeenCalledTimes(1);
    expect(previewRepairState.healthRunner).toHaveBeenCalledTimes(1);
    expect(runFinalizer.emitTaskProgress).toHaveBeenCalledWith(
      'tool_running',
      expect.stringContaining('3'),
    );
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledTimes(1);
    expect(toolResult.metadata).toMatchObject({
      designPreviewRepair: { stage: 'repair-instructed' },
    });
    expect(visionState.runArtifactPreviewVision).not.toHaveBeenCalled();
  });

  it('leaves game artifacts on the exact old code path (no preview health call)', async () => {
    gameValidatorState.validateGameArtifact.mockResolvedValue({
      shouldValidate: true,
      inferredKind: 'game',
      isComplete: true,
      passed: true,
      failures: [],
      checks: ['detected game artifact with interactive delivery surface'],
    } as never);

    const { runFinalizer, contextAssembly, toolResult, ctx } = await runLifecycle({ filePath: '/tmp/game.html' });

    expect(previewRepairState.healthRunner).not.toHaveBeenCalled();
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('<artifact-validation-passed'),
      'artifact-validation',
    );
    // 游戏路径只发既有的验收消息，不叠加预览体检消息。
    const progressCalls = (runFinalizer.emitTaskProgress as ReturnType<typeof vi.fn>).mock.calls;
    expect(progressCalls.every(([phase, step]) => phase === 'tool_running' && !String(step).includes('display problem'))).toBe(true);
    expect(ctx.artifact.validationPassedTargetFile).toBe('/tmp/game.html');
    expect(toolResult.metadata?.designPreviewRepair).toBeUndefined();
  });

  it('leaves non-html deliverables untouched', async () => {
    const { runFinalizer, contextAssembly, toolResult } = await runLifecycle({ filePath: '/tmp/summary.md' });

    expect(previewRepairState.healthRunner).not.toHaveBeenCalled();
    expect(runFinalizer.emitTaskProgress).not.toHaveBeenCalled();
    expect(contextAssembly.injectSystemMessage).not.toHaveBeenCalled();
    expect(toolResult.metadata).toBeUndefined();
  });

  it('covers design-draft html paths too (still deterministic, still bounded)', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'code-agent-web-preview-test-'));
    const previousDataDir = process.env.CODE_AGENT_DATA_DIR;
    process.env.CODE_AGENT_DATA_DIR = dataDir;
    try {
      previewRepairState.healthRunner.mockResolvedValueOnce(findingsSummary('missing_main_element'));

      const draftPath = path.join(dataDir, 'design', 'variant-a.html');
      const { runFinalizer, contextAssembly } = await runLifecycle({ filePath: draftPath });

      // 设计草稿不走游戏探针（豁免），只走确定性预览体检。
      expect(gameValidatorState.validateGameArtifact).not.toHaveBeenCalled();
      expect(previewRepairState.healthRunner).toHaveBeenCalledTimes(1);
      expect(runFinalizer.emitTaskProgress).toHaveBeenCalledWith(
        'tool_running',
        expect.stringContaining('1'),
      );
      expect(contextAssembly.injectSystemMessage).toHaveBeenCalledTimes(1);
    } finally {
      if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
      else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
    }
  });
});

afterEach(() => {
  vi.clearAllMocks();
});
