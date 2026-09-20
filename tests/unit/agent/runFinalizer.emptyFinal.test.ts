import { afterEach, describe, expect, it } from 'vitest';

import { allowEmptyAssistantCompletion } from '../../../src/host/agent/runtime/runFinalizer';

describe('allowEmptyAssistantCompletion', () => {
  const previous = process.env.CODE_AGENT_CLI_MODE;

  afterEach(() => {
    if (previous === undefined) delete process.env.CODE_AGENT_CLI_MODE;
    else process.env.CODE_AGENT_CLI_MODE = previous;
  });

  it('keeps desktop interactive runs failing on empty finals', () => {
    delete process.env.CODE_AGENT_CLI_MODE;
    expect(allowEmptyAssistantCompletion({})).toBe(false);
  });

  it('allows headless / unattended runs to complete without visible assistant text', () => {
    delete process.env.CODE_AGENT_CLI_MODE;
    expect(allowEmptyAssistantCompletion({ unattendedTurn: true })).toBe(true);
    process.env.CODE_AGENT_CLI_MODE = 'true';
    expect(allowEmptyAssistantCompletion({})).toBe(true);
  });
});
