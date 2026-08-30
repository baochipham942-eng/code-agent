import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isBuiltinCapabilityInstalledSync,
  isComputerUseCapabilityInstalledSync,
  migrateLegacyComputerUseEnv,
  readBuiltinCapabilityState,
  writeBuiltinCapabilityState,
} from '../../../src/host/plugins/builtin/computerUse/installState';
import {
  COMPUTER_USE_CAPABILITY_ID,
} from '../../../src/host/plugins/builtin/builtinCapabilityIds';
import { BUILTIN_PLUGIN_CATALOG } from '../../../src/host/plugins/builtin/catalog';

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-cua-install-state-'));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('Computer Use capability install state', () => {
  it('ships the other seven builtin plugins installed by default and persists their explicit removal', async () => {
    const defaultInstalled = BUILTIN_PLUGIN_CATALOG
      .map(({ manifest }) => manifest.id)
      .filter((id) => id !== COMPUTER_USE_CAPABILITY_ID);
    expect(defaultInstalled).toHaveLength(7);
    for (const pluginId of defaultInstalled) {
      expect(isBuiltinCapabilityInstalledSync(pluginId, {}, dataDir)).toBe(true);
    }

    await writeBuiltinCapabilityState('builtin.imageProcess', 'removed', { dataDir });
    expect(isBuiltinCapabilityInstalledSync('builtin.imageProcess', {}, dataDir)).toBe(false);
    expect(await readBuiltinCapabilityState('builtin.imageProcess', dataDir)).toBe('removed');

    await writeBuiltinCapabilityState('builtin.imageProcess', 'installed', { dataDir });
    expect(isBuiltinCapabilityInstalledSync('builtin.imageProcess', {}, dataDir)).toBe(true);
  });

  it('ships uninstalled when neither state nor legacy env exists', () => {
    expect(isComputerUseCapabilityInstalledSync({}, dataDir)).toBe(false);
  });

  it('migrates the legacy CODE_AGENT_ENABLE_CUA=1 opt-in to an installed record', async () => {
    expect(isComputerUseCapabilityInstalledSync({ CODE_AGENT_ENABLE_CUA: '1' }, dataDir)).toBe(true);
    expect(await migrateLegacyComputerUseEnv({ CODE_AGENT_ENABLE_CUA: '1' }, dataDir)).toBe(true);
    expect(await readBuiltinCapabilityState(COMPUTER_USE_CAPABILITY_ID, dataDir)).toBe('installed');
    expect(isComputerUseCapabilityInstalledSync({}, dataDir)).toBe(true);
  });

  it('keeps an explicit uninstall authoritative even if the old env remains set', async () => {
    await writeBuiltinCapabilityState(COMPUTER_USE_CAPABILITY_ID, 'removed', { dataDir });
    expect(isComputerUseCapabilityInstalledSync({ CODE_AGENT_ENABLE_CUA: '1' }, dataDir)).toBe(false);
    expect(await migrateLegacyComputerUseEnv({ CODE_AGENT_ENABLE_CUA: '1' }, dataDir)).toBe(false);
    expect(await readBuiltinCapabilityState(COMPUTER_USE_CAPABILITY_ID, dataDir)).toBe('removed');
  });

  it('fails closed on a malformed install record', async () => {
    const target = path.join(dataDir, 'capabilities', 'computer-use.json');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, '{broken', 'utf8');
    expect(isComputerUseCapabilityInstalledSync({ CODE_AGENT_ENABLE_CUA: '1' }, dataDir)).toBe(false);
  });
});
