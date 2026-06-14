import { describe, expect, it } from 'vitest';
import { getMarketplaceExtensionStatus } from '../../../../src/main/services/plugins/extensionOpsService';

describe('ExtensionOpsService marketplace status mapping', () => {
  it('marks enabled skill and command plugins as active runtime extensions', () => {
    expect(getMarketplaceExtensionStatus({
      isEnabled: true,
      types: ['skill'],
      skills: ['review'],
    })).toBe('active');

    expect(getMarketplaceExtensionStatus({
      isEnabled: true,
      types: ['command'],
      commands: ['inspect'],
    })).toBe('active');
  });

  it('keeps enabled provider theme and UI assets inactive until adapters exist', () => {
    expect(getMarketplaceExtensionStatus({
      isEnabled: true,
      types: ['provider'],
      skills: [],
      commands: [],
    })).toBe('inactive');

    expect(getMarketplaceExtensionStatus({
      isEnabled: true,
      types: ['theme'],
      skills: [],
      commands: [],
    })).toBe('inactive');

    expect(getMarketplaceExtensionStatus({
      isEnabled: true,
      types: ['ui'],
      skills: [],
      commands: [],
    })).toBe('inactive');
  });

  it('marks disabled marketplace plugins as disabled regardless of type', () => {
    expect(getMarketplaceExtensionStatus({
      isEnabled: false,
      types: ['command'],
      commands: ['inspect'],
    })).toBe('disabled');
  });
});
