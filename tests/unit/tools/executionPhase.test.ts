import { describe, expect, it } from 'vitest';
import { classifyExecutionPhase } from '../../../src/host/tools/executionPhase';

describe('classifyExecutionPhase', () => {
  it('classifies both dynamic workflow and legacy workflow_orchestrate as execute', () => {
    expect(classifyExecutionPhase('workflow')).toBe('execute');
    expect(classifyExecutionPhase('DynamicWorkflow')).toBe('execute');
    expect(classifyExecutionPhase('workflow_orchestrate')).toBe('execute');
    expect(classifyExecutionPhase('WorkflowOrchestrate')).toBe('execute');
  });
});
