// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const invokeSkillIPCOrThrow = vi.hoisted(() => vi.fn());
const invokeSkillIPC = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast }));
vi.mock('../../../src/renderer/services/invokeSkillIPC', () => ({
  invokeSkillIPCOrThrow: (...args: unknown[]) => invokeSkillIPCOrThrow(...args),
  invokeSkillIPC: (...args: unknown[]) => invokeSkillIPC(...args),
}));

import { divertDroppedSkillZips, pickWebZipFile } from '../../../src/renderer/services/skillLocalZip';

describe('divertDroppedSkillZips', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeSkillIPC.mockResolvedValue(true);
  });

  it('leaves the zip as an attachment when the user declines install', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const zip = new File(['PK'], 'demo.zip', { type: 'application/zip' });

    const leftover = await divertDroppedSkillZips([zip], {
      sessionId: 's1',
      successPrefix: 'ok ',
      failPrefix: 'fail ',
      confirmPrompt: 'Install {name}?',
    });

    expect(confirm).toHaveBeenCalledWith('Install demo.zip?');
    expect(invokeSkillIPCOrThrow).not.toHaveBeenCalled();
    expect(leftover).toEqual([zip]);
    confirm.mockRestore();
  });

  it('installs and mounts after the user confirms', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    invokeSkillIPCOrThrow.mockResolvedValue({
      success: true,
      skillName: 'demo',
      pluginSpec: 'demo@local-zip',
    });
    const zip = new File(['PK'], 'demo.zip', { type: 'application/zip' });

    const leftover = await divertDroppedSkillZips([zip], {
      sessionId: 's1',
      successPrefix: 'ok ',
      failPrefix: 'fail ',
      confirmPrompt: 'Install {name}?',
    });

    expect(invokeSkillIPCOrThrow).toHaveBeenCalled();
    expect(invokeSkillIPC).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('ok demo');
    expect(leftover).toEqual([]);
    confirm.mockRestore();
  });
});

describe('pickWebZipFile', () => {
  it('resolves null when the file picker is cancelled', async () => {
    const inputs: HTMLInputElement[] = [];
    const create = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string, options?: ElementCreationOptions) => {
      const el = create(tag, options);
      if (tag === 'input') {
        const input = el as HTMLInputElement;
        input.click = vi.fn();
        inputs.push(input);
      }
      return el;
    });

    const pending = pickWebZipFile();
    expect(inputs).toHaveLength(1);
    inputs[0]!.dispatchEvent(new Event('cancel'));
    await expect(pending).resolves.toBeNull();
  });
});
