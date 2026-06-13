import { describe, expect, it } from 'vitest';
import { snapshotFromWorkbenchMetadata } from '../../../src/shared/contract/turnTimeline';
import type { WorkbenchMessageMetadata } from '../../../src/shared/contract/conversationEnvelope';

describe('turn timeline workbench snapshot', () => {
  it('keeps composer-selected agent and prompt metadata visible in the snapshot', () => {
    const metadata: WorkbenchMessageMetadata = {
      preferredAgentId: 'reviewer',
      preferredAgentName: 'Reviewer',
      selectedAgent: {
        id: 'reviewer',
        name: 'Reviewer',
        token: 'reviewer',
        via: 'slash_picker',
      },
      selectedPromptCommand: {
        name: 'review',
        source: 'file',
        hints: ['$ARGUMENTS'],
        via: 'slash_picker',
      },
      selectedSkillIds: ['docx'],
    };

    const snapshot = snapshotFromWorkbenchMetadata(metadata);
    expect(snapshot).toEqual({
      preferredAgentId: 'reviewer',
      preferredAgentName: 'Reviewer',
      selectedAgent: {
        id: 'reviewer',
        name: 'Reviewer',
        token: 'reviewer',
        via: 'slash_picker',
      },
      selectedPromptCommand: {
        name: 'review',
        source: 'file',
        hints: ['$ARGUMENTS'],
        via: 'slash_picker',
      },
      selectedSkillIds: ['docx'],
    });

    metadata.selectedPromptCommand?.hints?.push('mutated');
    expect(snapshot?.selectedPromptCommand?.hints).toEqual(['$ARGUMENTS']);
  });
});
