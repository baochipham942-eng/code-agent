import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectRendererShellCapabilities } from '../../../scripts/renderer-capability-scanner.mjs';
import { getShellCapabilities, getShellCapabilityIds } from '../../../src/main/shellCapabilities';
import { makeTauriCommandCapabilityId } from '../../../src/shared/contract/shellCapabilities';

describe('shell capabilities', () => {
  it('covers static shell invocations used by the current renderer', () => {
    const repoRoot = process.cwd();
    const detected = collectRendererShellCapabilities({
      rendererDir: path.join(repoRoot, 'src/renderer'),
      domainsPath: path.join(repoRoot, 'src/shared/ipc/domains.ts'),
      repoRoot,
    });
    const supported = new Set(getShellCapabilityIds());
    const missing = detected
      .filter((capability) => !supported.has(capability.id))
      .map((capability) => `${capability.id} (${capability.file})`);

    expect(missing).toEqual([]);
  });

  it('advertises native Tauri commands that renderer hot updates can require', () => {
    const supported = new Set(getShellCapabilityIds());

    expect(supported.has(makeTauriCommandCapabilityId('desktop_get_capabilities'))).toBe(true);
    expect(supported.has(makeTauriCommandCapabilityId('appshots_read_image_data_url'))).toBe(true);
    expect(supported.has(makeTauriCommandCapabilityId('pip_show'))).toBe(true);
    expect(supported.has(makeTauriCommandCapabilityId('install_update'))).toBe(true);
  });

  it('labels shell capabilities by hot-update layer', () => {
    const capabilities = getShellCapabilities();
    expect(capabilities.find((capability) => capability.id === 'domain:update/check')).toMatchObject({
      layer: 'domain',
    });
    expect(capabilities.find((capability) => capability.id === makeTauriCommandCapabilityId('desktop_get_capabilities'))).toMatchObject({
      layer: 'native',
    });
  });
});
