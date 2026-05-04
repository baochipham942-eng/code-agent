import { describe, expect, it } from 'vitest';
import { redactBrowserWorkbenchTraceParams } from '../../../../src/main/services/infra/browserService';

describe('browser service trace redaction', () => {
  it('redacts browser typed text from workbench trace params', () => {
    const params = redactBrowserWorkbenchTraceParams('browser_action', {
      action: 'type',
      selector: '#email',
      text: 'secret@example.com',
    });

    expect(params).toEqual({
      action: 'type',
      selector: '#email',
      text: '[redacted 18 chars]',
    });
  });

  it('redacts browser form values from workbench trace params', () => {
    const params = redactBrowserWorkbenchTraceParams('browser_action', {
      action: 'fill_form',
      formData: {
        '#email': 'secret@example.com',
        '#password': 'hunter2',
      },
    });

    expect(params).toEqual({
      action: 'fill_form',
      formData: {
        '#email': '[redacted 18 chars]',
        '#password': '[redacted 7 chars]',
      },
    });
  });

  it('keeps browser secretRef as a placeholder with domain scope metadata', () => {
    const params = redactBrowserWorkbenchTraceParams('browser_action', {
      action: 'type',
      selector: '#password',
      secretRef: 'env:CODE_AGENT_BROWSER_SECRET_TEST_PASSWORD',
      secretScope: {
        kind: 'domain',
        domains: ['https://accounts.example.com/login'],
      },
    });

    expect(params).toEqual({
      action: 'type',
      selector: '#password',
      secretRef: '[secretRef]',
      secretScope: {
        kind: 'domain',
        domains: ['accounts.example.com'],
        source: 'secretScope',
      },
    });
    expect(JSON.stringify(params)).not.toContain('CODE_AGENT_BROWSER_SECRET_TEST_PASSWORD');
  });

  it('does not silently turn a secretRef without scope into a global secret', () => {
    const params = redactBrowserWorkbenchTraceParams('browser_action', {
      action: 'type',
      selector: '#password',
      secretRef: 'env:CODE_AGENT_BROWSER_SECRET_TEST_PASSWORD',
    });

    expect(params).toMatchObject({
      secretRef: '[secretRef]',
      secretScope: {
        kind: 'missing_domain_scope',
        required: true,
      },
    });
    expect(JSON.stringify(params)).not.toContain('legacy_global');
    expect(JSON.stringify(params)).not.toContain('CODE_AGENT_BROWSER_SECRET_TEST_PASSWORD');
  });

  it('requires legacy global secrets to be explicitly marked', () => {
    const params = redactBrowserWorkbenchTraceParams('computer_use', {
      action: 'smart_type',
      selector: '#password',
      secretRef: 'vault:legacy-password',
      secretScope: {
        kind: 'legacy_global',
        explicitlyMarked: true,
      },
    });

    expect(params).toMatchObject({
      action: 'smart_type',
      selector: '#password',
      secretRef: '[secretRef]',
      secretScope: {
        kind: 'legacy_global',
        explicitlyMarked: true,
        source: 'secretScope',
      },
    });
    expect(JSON.stringify(params)).not.toContain('vault:legacy-password');
  });
});
