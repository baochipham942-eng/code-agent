import { describe, expect, it, beforeEach } from 'vitest';
import {
  isMultiAgentMode,
  setMultiAgentMode,
  resetMultiAgentModeForTests,
} from '../../../src/host/services/multiAgentMode';

describe('multiAgentMode', () => {
  beforeEach(() => {
    resetMultiAgentModeForTests();
  });

  it('defaults to disabled', () => {
    expect(isMultiAgentMode()).toBe(false);
  });

  it('toggles on and off', () => {
    setMultiAgentMode(true);
    expect(isMultiAgentMode()).toBe(true);
    setMultiAgentMode(false);
    expect(isMultiAgentMode()).toBe(false);
  });

  it('coerces non-boolean truthy values to false (only strict true enables)', () => {
    setMultiAgentMode(true);
    expect(isMultiAgentMode()).toBe(true);
    // @ts-expect-error — testing strict-boolean guard
    setMultiAgentMode('true');
    expect(isMultiAgentMode()).toBe(false);
    // @ts-expect-error — testing strict-boolean guard
    setMultiAgentMode(1);
    expect(isMultiAgentMode()).toBe(false);
  });
});
