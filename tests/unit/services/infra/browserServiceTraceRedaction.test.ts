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
});
