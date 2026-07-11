import { describe, expect, it } from 'vitest';
import {
  ORCHESTRATION_CAPABILITIES,
  capabilityManifestForToolProfile,
  capabilityManifestForTools,
} from '../../../../src/host/agent/scriptRuntime/capabilityManifest';

describe('dynamic workflow capability manifest', () => {
  it('gives the orchestration process no ambient capabilities', () => {
    expect(ORCHESTRATION_CAPABILITIES).toEqual({
      fileRead: false,
      fileWrite: false,
      shell: false,
      network: false,
      credential: false,
      childProcess: false,
    });
  });

  it('maps readonly/edit/full profiles without granting credentials', () => {
    expect(capabilityManifestForToolProfile('readonly')).toMatchObject({
      fileRead: true,
      fileWrite: false,
      shell: false,
      network: true,
      credential: false,
      childProcess: false,
    });
    expect(capabilityManifestForToolProfile('edit')).toMatchObject({
      fileRead: true,
      fileWrite: true,
      shell: false,
      credential: false,
      childProcess: false,
    });
    expect(capabilityManifestForToolProfile('full')).toMatchObject({
      fileWrite: true,
      shell: true,
      credential: false,
      childProcess: true,
    });
  });

  it('derives a credential-free manifest for ordinary child agent tool lists', () => {
    expect(capabilityManifestForTools(['Read', 'Edit', 'Bash', 'WebFetch'])).toEqual({
      fileRead: true,
      fileWrite: true,
      shell: true,
      network: true,
      credential: false,
      childProcess: true,
    });
  });
});
