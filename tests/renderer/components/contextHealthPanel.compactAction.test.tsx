import { describe, expect, it } from 'vitest';
import * as surface from '../../../src/renderer/components/ContextHealthPanel';

describe('removed context surface', () => {
  it('has no runtime exports', () => {
    expect(Object.keys(surface)).toEqual([]);
  });
});
