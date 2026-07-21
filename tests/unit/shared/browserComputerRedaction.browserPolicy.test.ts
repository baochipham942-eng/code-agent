import { describe, expect, it } from 'vitest';
import {
  sanitizeBrowserComputerToolArguments,
  sanitizeBrowserComputerToolResult,
} from '../../../src/shared/utils/browserComputerRedaction';
import { redactSurfaceExecutionValue } from '../../../src/shared/utils/surfaceExecutionRedaction';

describe('browser dialog and clipboard redaction policy', () => {
  it('removes clipboard payloads from arguments, results, and nested trace metadata', () => {
    const canary = 'surface-secret-canary-clipboard-policy';
    const args = { action: 'write_clipboard', clipboardText: canary };
    const sanitizedArgs = sanitizeBrowserComputerToolArguments('browser_action', args);
    const sanitizedResult = sanitizeBrowserComputerToolResult('browser_action', args, {
      output: `wrote ${canary}`,
      error: `failed near ${canary}`,
      metadata: {
        trace: {
          params: { clipboardText: canary },
          evidenceSummary: [`clipboard=${canary}`],
        },
      },
    });

    expect(JSON.stringify({ sanitizedArgs, sanitizedResult })).not.toContain(canary);
    expect(sanitizedArgs?.clipboardText).toBe(`[redacted ${canary.length} chars]`);
  });

  it('removes prompt responses while retaining safe dialog action metadata', () => {
    const canary = 'surface-secret-canary-dialog-prompt';
    const args = {
      action: 'handle_dialog',
      dialogAction: 'accept',
      dialogPromptText: canary,
    };
    const sanitized = sanitizeBrowserComputerToolResult('browser_action', args, {
      output: `accepted prompt with ${canary}`,
      metadata: {
        browserDialogState: {
          pending: false,
          action: 'accept',
          dialogPromptText: canary,
        },
      },
    });

    expect(JSON.stringify(sanitized)).not.toContain(canary);
    expect(sanitized.metadata?.browserDialogState).toMatchObject({ action: 'accept' });
  });

  it('redacts clipboard and prompt keys at the durable Surface projection boundary', () => {
    const serialized = JSON.stringify(redactSurfaceExecutionValue({
      clipboardText: 'surface-secret-canary-clipboard-durable',
      dialogPromptText: 'surface-secret-canary-dialog-durable',
      nested: { clipboard: 'surface-secret-canary-system-clipboard' },
    }));

    expect(serialized).not.toContain('surface-secret-canary');
    expect(serialized).toContain('[redacted]');
  });
});
