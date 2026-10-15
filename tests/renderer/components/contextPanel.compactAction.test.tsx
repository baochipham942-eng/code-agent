import { describe, expect, it } from 'vitest';
import * as surface from '../../../src/renderer/components/ContextPanel';

describe('removed context surface', () => {
  it('has no runtime exports', () => {
    expect(Object.keys(surface)).toEqual([]);
  });
});
