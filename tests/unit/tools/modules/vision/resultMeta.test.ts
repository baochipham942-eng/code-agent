import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
  ToolModule,
} from '../../../../../src/main/protocol/tools';

const legacyExecute = vi.hoisted(() => ({
  browser: vi.fn(),
  browserAction: vi.fn(),
  browserNavigate: vi.fn(),
  computer: vi.fn(),
  computerUse: vi.fn(),
  screenshot: vi.fn(),
  guiAgent: vi.fn(),
}));

vi.mock('../../../../../src/main/tools/vision/BrowserTool', () => ({
  BrowserTool: { execute: legacyExecute.browser },
}));

vi.mock('../../../../../src/main/tools/vision/browserAction', () => ({
  browserActionTool: { execute: legacyExecute.browserAction },
}));

vi.mock('../../../../../src/main/tools/vision/browserNavigate', () => ({
  browserNavigateTool: { execute: legacyExecute.browserNavigate },
}));

vi.mock('../../../../../src/main/tools/vision/ComputerTool', () => ({
  ComputerTool: { execute: legacyExecute.computer },
}));

vi.mock('../../../../../src/main/tools/vision/computerUse', () => ({
  computerUseTool: { execute: legacyExecute.computerUse },
}));

vi.mock('../../../../../src/main/tools/vision/screenshot', () => ({
  screenshotTool: { execute: legacyExecute.screenshot },
}));

vi.mock('../../../../../src/main/tools/vision/guiAgent', () => ({
  guiAgentTool: { execute: legacyExecute.guiAgent },
}));

import { browserModule } from '../../../../../src/main/plugins/builtin/browserControl/browser';
import { browserActionModule } from '../../../../../src/main/plugins/builtin/browserControl/browserAction';
import { browserNavigateModule } from '../../../../../src/main/plugins/builtin/browserControl/browserNavigate';
import { computerModule } from '../../../../../src/main/plugins/builtin/computerUse/computer';
import { computerUseModule } from '../../../../../src/main/plugins/builtin/computerUse/computerUse';
import { screenshotModule } from '../../../../../src/main/plugins/builtin/computerUse/screenshot';
import { guiAgentModule } from '../../../../../src/main/plugins/builtin/computerUse/guiAgent';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'vision-contract-session',
    workingDir: process.cwd(),
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    ...overrides,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

describe('vision wrapper ToolResult contract', () => {
  let tmpDir: string;
  let imagePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vision-result-meta-'));
    imagePath = path.join(tmpDir, 'screen.png');
    await fs.writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    Object.values(legacyExecute).forEach((mock) => mock.mockReset());
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it.each([
    {
      label: 'Browser',
      module: browserModule,
      execute: legacyExecute.browser,
      args: { action: 'screenshot', url: 'https://example.test/app' },
      metadata: () => ({ path: imagePath, legacyFlag: 'browser' }),
      expectedAction: 'screenshot',
      expectedTarget: 'https://example.test/app',
      expectedArtifactKind: 'image',
    },
    {
      label: 'browser_action',
      module: browserActionModule,
      execute: legacyExecute.browserAction,
      args: {
        action: 'get_content',
        url: 'https://example.test/page',
        apiKey: 'secret-value',
      },
      metadata: () => ({
        url: 'https://example.test/page',
        content: 'Rendered page content',
        legacyFlag: 'browser-action',
      }),
      expectedAction: 'get_content',
      expectedTarget: 'https://example.test/page',
      expectedArtifactKind: 'web',
    },
    {
      label: 'browser_navigate',
      module: browserNavigateModule,
      execute: legacyExecute.browserNavigate,
      args: { action: 'open', url: 'https://example.test/nav' },
      metadata: () => ({ url: 'https://example.test/nav', legacyFlag: 'browser-navigate' }),
      expectedAction: 'open',
      expectedTarget: 'https://example.test/nav',
      expectedArtifactKind: 'web',
    },
    {
      label: 'Computer',
      module: computerModule,
      execute: legacyExecute.computer,
      args: { action: 'screenshot', target: 'screen' },
      metadata: () => ({ screenshotPath: imagePath, legacyFlag: 'computer' }),
      expectedAction: 'screenshot',
      expectedTarget: 'screen',
      expectedArtifactKind: 'image',
    },
    {
      label: 'computer_use',
      module: computerUseModule,
      execute: legacyExecute.computerUse,
      args: { action: 'observe', targetApp: 'Safari', includeScreenshot: true },
      metadata: () => ({ file: imagePath, legacyFlag: 'computer-use' }),
      expectedAction: 'observe',
      expectedTarget: 'Safari',
      expectedArtifactKind: 'image',
    },
    {
      label: 'screenshot',
      module: screenshotModule,
      execute: legacyExecute.screenshot,
      args: { target: 'screen' },
      metadata: () => ({ legacyFlag: 'screenshot' }),
      outputPath: () => imagePath,
      expectedAction: 'capture',
      expectedTarget: 'screen',
      expectedArtifactKind: 'image',
    },
    {
      label: 'gui_agent',
      module: guiAgentModule,
      execute: legacyExecute.guiAgent,
      args: { task: 'Click the submit button and report the result' },
      metadata: () => ({ path: imagePath, legacyFlag: 'gui-agent' }),
      expectedAction: 'run',
      expectedTarget: undefined,
      expectedArtifactKind: 'image',
    },
  ] satisfies Array<{
    label: string;
    module: ToolModule<Record<string, unknown>, string>;
    execute: ReturnType<typeof vi.fn>;
    args: Record<string, unknown>;
    metadata: () => Record<string, unknown>;
    outputPath?: () => string;
    expectedAction: string;
    expectedTarget: unknown;
    expectedArtifactKind: string;
  }>)(
    'adds structured meta and artifacts for $label success results',
    async ({ module, execute, args, metadata, outputPath, expectedAction, expectedTarget, expectedArtifactKind }) => {
      const legacyMetadata = metadata();
      execute.mockResolvedValueOnce({
        success: true,
        output: 'legacy ok',
        outputPath: outputPath?.(),
        metadata: legacyMetadata,
      });

      const handler = await module.createHandler();
      const result = await handler.execute(args, makeCtx(), allowAll);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.output).toBe('legacy ok');
      expect(result.meta).toMatchObject({
        tool: module.schema.name,
        action: expectedAction,
        target: expectedTarget,
        request: expect.any(Object),
        legacyMetadata,
      });
      expect(result.meta?.legacyFlag).toBe(legacyMetadata.legacyFlag);
      expect(result.meta?.artifact).toMatchObject({
        kind: expectedArtifactKind,
        sourceTool: module.schema.name,
        sessionId: 'vision-contract-session',
      });
      expect(result.meta?.artifacts).toEqual(expect.arrayContaining([result.meta?.artifact]));
    },
  );

  it('redacts sensitive request args while preserving legacy metadata', async () => {
    legacyExecute.browserAction.mockResolvedValueOnce({
      success: true,
      output: 'legacy ok',
      metadata: {
        url: 'https://example.test/redacted',
        legacyFlag: 'kept',
      },
    });

    const handler = await browserActionModule.createHandler();
    const result = await handler.execute(
      { action: 'navigate', url: 'https://example.test/redacted', apiKey: 'top-secret' },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meta?.legacyFlag).toBe('kept');
    expect(result.meta?.request).toMatchObject({
      args: {
        apiKey: { redacted: true, length: 'top-secret'.length },
      },
    });
  });

  it('keeps structured action, target, legacy metadata, and evidence artifacts on failures', async () => {
    legacyExecute.computerUse.mockResolvedValueOnce({
      success: false,
      error: 'Computer Surface observe blocked.',
      metadata: {
        code: 'COMPUTER_SURFACE_BLOCKED',
        computerSurfaceSnapshot: { screenshotPath: imagePath },
        workbenchTrace: {
          id: 'trace-1',
          action: 'observe',
          screenshotPath: imagePath,
        },
      },
    });

    const handler = await computerUseModule.createHandler();
    const result = await handler.execute(
      { action: 'observe', targetApp: 'Safari', includeScreenshot: true },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Computer Surface observe blocked');
    expect(result.meta).toMatchObject({
      tool: 'computer_use',
      action: 'observe',
      target: 'Safari',
      legacyMetadata: {
        code: 'COMPUTER_SURFACE_BLOCKED',
      },
    });
    expect(result.meta?.artifact).toMatchObject({
      kind: 'image',
      sourceTool: 'computer_use',
      path: imagePath,
    });
    expect(result.meta?.artifacts).toHaveLength(1);
  });

  it('normalizes browser artifact summaries without depending on legacy-only fields', async () => {
    legacyExecute.browserAction.mockResolvedValueOnce({
      success: true,
      output: 'Download completed',
      metadata: {
        browserArtifact: {
          artifactId: 'download_1',
          kind: 'download',
          name: 'report.csv',
          artifactPath: 'report.csv',
          size: 128,
          mimeType: 'text/csv',
          sha256: 'abc123',
          createdAtMs: 1_700_000_000_000,
          sessionId: 'managed-browser-session',
        },
      },
    });

    const handler = await browserActionModule.createHandler();
    const result = await handler.execute(
      { action: 'wait_for_download', selector: '#export' },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meta?.artifact).toMatchObject({
      artifactId: 'download_1',
      kind: 'text',
      sourceTool: 'browser_action',
      name: 'report.csv',
      mimeType: 'text/csv',
      sizeBytes: 128,
      sha256: 'abc123',
    });
    expect(result.meta?.artifact?.metadata).toMatchObject({
      sourceKey: 'browserArtifact',
      legacyBrowserArtifact: expect.objectContaining({ artifactId: 'download_1' }),
    });
  });
});
