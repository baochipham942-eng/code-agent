import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseJson } from '../../../../src/host/services/desktop/backgroundCgEventWindowModel';

describe('backgroundCgEventWindowModel parseJson error cause', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves the native JSON parser error', () => {
    const originalError = new SyntaxError('invalid helper JSON');
    vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      throw originalError;
    });

    let thrown: unknown;
    try {
      parseJson('{invalid}');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).cause).toBe(originalError);
  });
});
