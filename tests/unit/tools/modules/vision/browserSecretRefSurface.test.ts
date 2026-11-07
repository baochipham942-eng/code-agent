// ============================================================================
// Browser secretRef surface tests (FB-552/FB-544)
// 1) 模型可见 schema（builtin.browserControl 注册进 protocol registry 的那份，
//    即请求组装 getProtocolToolSchemas() 读到的）必须列出 secretRef；
// 2) BrowserTool.execute 的 type 调用必须把 secretRef 原样转发给
//    browserActionTool.execute（spy 代理），guard/接管逻辑才有输入可用。
// ============================================================================

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PluginRegistry } from '../../../../../src/host/plugins/pluginRegistry';
import { resetProtocolRegistry } from '../../../../../src/host/tools/protocolRegistry';
import { getProtocolToolSchemas } from '../../../../../src/host/tools/protocolToolRegistration';
import { BrowserTool } from '../../../../../src/host/tools/vision/BrowserTool';
import { browserActionTool } from '../../../../../src/host/tools/vision/browserAction';
import { browserActionSchema } from '../../../../../src/host/plugins/builtin/browserControl/browserAction.schema';
import type { ToolContext } from '../../../../../src/host/tools/types';

const SECRET_REF_PROPERTY = {
  type: 'string',
  description: 'Reference to a secret value for type actions, e.g. env:CODE_AGENT_BROWSER_SECRET_PASSWORD. Only env variables prefixed CODE_AGENT_BROWSER_SECRET_ are accepted, and each needs a companion <NAME>_ORIGINS variable (comma-separated exact origins such as https://github.com); typing is refused on any other origin. The secret value is never returned in output.',
} as const;

const SECRET_REF_PARAMS_LINE = '- secretRef: Reference to a secret for type actions (env:CODE_AGENT_BROWSER_SECRET_<NAME>), use instead of text when typing passwords; never put the secret or the reference into text (Playwright)';

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDirectory: '/tmp/secretref',
    requestPermission: async () => true,
    ...overrides,
  };
}

describe('Browser model-visible schema carries secretRef', () => {
  let testDataDir: string;

  beforeEach(async () => {
    testDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-browser-secretref-'));
    process.env.CODE_AGENT_DATA_DIR = testDataDir;
    resetProtocolRegistry();
  });

  afterEach(async () => {
    delete process.env.CODE_AGENT_DATA_DIR;
    await fs.rm(testDataDir, { recursive: true, force: true });
    resetProtocolRegistry();
  });

  it('the schema registered for requests (protocol registry) lists secretRef', async () => {
    const reg = new PluginRegistry();
    await (reg as unknown as { loadBuiltinPlugins: () => Promise<void> }).loadBuiltinPlugins();
    expect(await reg.activatePlugin('builtin.browserControl')).toBe(true);

    const registered = getProtocolToolSchemas().find((schema) => schema.name === 'Browser');
    expect(registered).toBeDefined();
    expect(registered?.inputSchema.properties?.secretRef).toEqual(SECRET_REF_PROPERTY);
    // 与 browser_action 的 secretRef 描述逐字一致（byte-identical text）
    expect(browserActionSchema.inputSchema.properties?.secretRef).toEqual(SECRET_REF_PROPERTY);
    expect(registered?.inputSchema.properties?.secretRef).toEqual(
      browserActionSchema.inputSchema.properties?.secretRef,
    );
    expect(registered?.inputSchema).toEqual(BrowserTool.inputSchema);
    // ## Parameters: 描述列表也列出 secretRef（两份 Browser description 逐字相等由
    // schema-alignment.test.ts 钉死，这里只钉新增行本身）
    expect(BrowserTool.description).toContain(SECRET_REF_PARAMS_LINE);
  });

  it('BrowserTool.execute forwards secretRef to browserActionTool.execute on type', async () => {
    const delegate = vi.spyOn(browserActionTool, 'execute').mockResolvedValue({
      success: true,
      output: 'typed via secretRef',
    });
    try {
      const result = await BrowserTool.execute(
        {
          action: 'type',
          selector: '#p',
          secretRef: 'env:CODE_AGENT_BROWSER_SECRET_X',
        },
        makeContext(),
      );

      expect(result.success).toBe(true);
      expect(delegate).toHaveBeenCalledTimes(1);
      const forwarded = delegate.mock.calls[0][0] as Record<string, unknown>;
      expect(forwarded.action).toBe('type');
      expect(forwarded.secretRef).toBe('env:CODE_AGENT_BROWSER_SECRET_X');
      expect(forwarded.text).toBeUndefined();
    } finally {
      delegate.mockRestore();
    }
  });
});
