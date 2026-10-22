import { describe, expect, it, vi } from 'vitest';
import { pluginsCommand } from '../../../src/shared/commands/definitions/newCommands';
import type { CommandContext } from '../../../src/shared/commands/types';
import type { SkillCautionConfirmationRequired } from '../../../src/shared/contract/skillInstallCaution';

function makeContext(extensionOps?: unknown): { ctx: CommandContext; output: string[] } {
  const output: string[] = [];
  return {
    output,
    ctx: {
      surface: 'gui',
      extensionOps,
      output: {
        info: (msg) => output.push(msg),
        success: (msg) => output.push(`success:${msg}`),
        error: (msg) => output.push(`error:${msg}`),
        warn: (msg) => output.push(`warn:${msg}`),
      },
    },
  };
}

function cautionRequired(overrides: Partial<SkillCautionConfirmationRequired> = {}): SkillCautionConfirmationRequired {
  return {
    success: false,
    code: 'SKILL_CAUTION_CONFIRMATION_REQUIRED',
    pluginSpec: 'demo@local',
    sourceTrust: 'local-marketplace',
    cautionHits: [
      { file: 'skills/demo/SKILL.md', ruleId: 'recursive_delete_targeted', snippet: 'rm -rf ./build' },
    ],
    confirmationToken: 'a'.repeat(64),
    ...overrides,
  };
}

function makeExtensionOps(install: (spec: string, options?: { cautionConfirmationToken?: string }) => Promise<unknown>) {
  return {
    list: vi.fn(async () => []),
    install: vi.fn(install),
    uninstall: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    reload: vi.fn(),
    validate: vi.fn(),
  };
}

describe('pluginsCommand', () => {
  it('uses injected extension operations on GUI surface', async () => {
    const extensionOps = {
      list: vi.fn(async () => [
        {
          id: 'browser-control',
          name: 'Browser Control',
          type: 'plugin',
          status: 'active',
          source: 'builtin',
          version: '1.0.0',
        },
        {
          id: 'docx@local',
          name: 'docx',
          type: 'skill',
          status: 'disabled',
          source: 'marketplace',
        },
      ]),
      install: vi.fn(),
      uninstall: vi.fn(),
      enable: vi.fn(),
      disable: vi.fn(),
      reload: vi.fn(),
      validate: vi.fn(),
    };
    const { ctx, output } = makeContext(extensionOps);

    const result = await pluginsCommand.handler(ctx, []);

    expect(result).toEqual({ success: true, data: { count: 2 } });
    expect(extensionOps.list).toHaveBeenCalledTimes(1);
    expect(output.join('\n')).toContain('Extensions (2)');
    expect(output.join('\n')).toContain('browser-control  plugin  active v1.0.0 [builtin]');
    expect(output.join('\n')).toContain('docx@local  skill  disabled [marketplace]');
  });

  it('reports a GUI wiring error instead of importing main services in renderer', async () => {
    const { ctx, output } = makeContext();

    const result = await pluginsCommand.handler(ctx, []);

    expect(result.success).toBe(false);
    expect(result.message).toBe('Extension operations are not wired for GUI commands');
    expect(output.join('\n')).toContain('Plugin operation failed: Extension operations are not wired for GUI commands');
  });
});

describe('pluginsCommand install caution confirmation', () => {
  it('prints the hit summary and the confirm-and-resend line without installing', async () => {
    const required = cautionRequired();
    const extensionOps = makeExtensionOps(async () => required);
    const { ctx, output } = makeContext(extensionOps);

    const result = await pluginsCommand.handler(ctx, ['install', 'demo@local']);

    expect(result).toEqual({ success: false });
    expect(extensionOps.install).toHaveBeenCalledTimes(1);
    expect(extensionOps.install).toHaveBeenCalledWith('demo@local', undefined);
    const text = output.join('\n');
    expect(text).toContain('Nothing was installed');
    expect(text).toContain('demo@local (local-marketplace)');
    expect(text).toContain('skills/demo/SKILL.md · recursive_delete_targeted · rm -rf ./build');
    expect(text).toContain(`/plugins install demo@local --confirm-caution ${required.confirmationToken}`);
    expect(text).not.toContain('Installed:');
  });

  it('installs when the scanned token is passed via --confirm-caution', async () => {
    const extensionOps = makeExtensionOps(async () => undefined);
    const { ctx, output } = makeContext(extensionOps);

    const result = await pluginsCommand.handler(ctx, ['install', 'demo@local', '--confirm-caution', 'b'.repeat(64)]);

    expect(result).toEqual({ success: true });
    expect(extensionOps.install).toHaveBeenCalledWith('demo@local', { cautionConfirmationToken: 'b'.repeat(64) });
    expect(output.join('\n')).toContain('success:Installed: demo@local');
  });

  it('accepts the flag before the spec position', async () => {
    const extensionOps = makeExtensionOps(async () => undefined);
    const { ctx } = makeContext(extensionOps);

    const result = await pluginsCommand.handler(ctx, ['install', '--confirm-caution', 'c'.repeat(64), 'demo@local']);

    expect(result).toEqual({ success: true });
    expect(extensionOps.install).toHaveBeenCalledWith('demo@local', { cautionConfirmationToken: 'c'.repeat(64) });
  });

  it('treats a flag without a value as a usage error and installs nothing', async () => {
    const extensionOps = makeExtensionOps(async () => undefined);
    const { ctx, output } = makeContext(extensionOps);

    const result = await pluginsCommand.handler(ctx, ['install', 'demo@local', '--confirm-caution']);

    expect(result).toEqual({ success: false });
    expect(extensionOps.install).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('error:Usage: /plugins install <spec> [--confirm-caution <token>]');
    expect(output.join('\n')).not.toContain('Installed:');
  });

  it('prints a fresh summary with a new token when the supplied token is stale', async () => {
    // 上一轮扫描的 token 已被内容变化作废：本次携旧 token 重发，host 回一张新命中单
    const stale = cautionRequired({ confirmationToken: 'd'.repeat(64) });
    const fresh = cautionRequired({
      confirmationToken: 'e'.repeat(64),
      cautionHits: [{ file: 'skills/demo/SKILL.md', ruleId: 'history_clear', snippet: 'history -c' }],
    });
    const extensionOps = makeExtensionOps(async () => fresh);
    const { ctx, output } = makeContext(extensionOps);

    const result = await pluginsCommand.handler(ctx, ['install', 'demo@local', '--confirm-caution', stale.confirmationToken]);

    expect(result).toEqual({ success: false });
    expect(extensionOps.install).toHaveBeenCalledWith('demo@local', { cautionConfirmationToken: stale.confirmationToken });
    const text = output.join('\n');
    expect(text).toContain('Nothing was installed');
    expect(text).toContain('skills/demo/SKILL.md · history_clear · history -c');
    expect(text).toContain(`/plugins install demo@local --confirm-caution ${fresh.confirmationToken}`);
    expect(text).not.toContain(stale.confirmationToken);
    expect(text).not.toContain('Installed:');
  });
});
