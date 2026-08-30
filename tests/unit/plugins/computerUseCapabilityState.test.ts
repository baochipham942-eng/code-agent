import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isComputerUseCapabilityInstalledSync,
  migrateLegacyComputerUseEnv,
  readComputerUseCapabilityState,
  writeComputerUseCapabilityState,
} from '../../../src/host/plugins/builtin/computerUse/installState';

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-cua-install-state-'));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('Computer Use capability install state', () => {
  it('ships uninstalled when neither state nor legacy env exists', () => {
    expect(isComputerUseCapabilityInstalledSync({}, dataDir)).toBe(false);
  });

  it('migrates the legacy CODE_AGENT_ENABLE_CUA=1 opt-in to an installed record', async () => {
    expect(isComputerUseCapabilityInstalledSync({ CODE_AGENT_ENABLE_CUA: '1' }, dataDir)).toBe(true);
    expect(await migrateLegacyComputerUseEnv({ CODE_AGENT_ENABLE_CUA: '1' }, dataDir)).toBe(true);
    expect(await readComputerUseCapabilityState(dataDir)).toBe('installed');
    expect(isComputerUseCapabilityInstalledSync({}, dataDir)).toBe(true);
  });

  it('keeps an explicit uninstall authoritative even if the old env remains set', async () => {
    await writeComputerUseCapabilityState('removed', { dataDir });
    expect(isComputerUseCapabilityInstalledSync({ CODE_AGENT_ENABLE_CUA: '1' }, dataDir)).toBe(false);
    expect(await migrateLegacyComputerUseEnv({ CODE_AGENT_ENABLE_CUA: '1' }, dataDir)).toBe(false);
    expect(await readComputerUseCapabilityState(dataDir)).toBe('removed');
  });

  it('fails closed on a malformed install record', async () => {
    const target = path.join(dataDir, 'capabilities', 'computer-use.json');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, '{broken', 'utf8');
    expect(isComputerUseCapabilityInstalledSync({ CODE_AGENT_ENABLE_CUA: '1' }, dataDir)).toBe(false);
  });
});
