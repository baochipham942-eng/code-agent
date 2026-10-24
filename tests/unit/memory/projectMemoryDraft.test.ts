import { describe, expect, it } from 'vitest';
import { draftEntryId } from '../../../src/host/memory/projectMemoryDraft';
import { contentHash } from '../../../src/host/memory/importers/markdown';
import { INIT_MEMORY_GUI_DRAFT } from '../../../src/renderer/services/memoryGuiSurface';
import { initMemoryCommands } from '../../../src/shared/commands/definitions/initMemoryCommands';
import type { ProjectMemoryDraftTopic } from '../../../src/shared/contract/memory';

describe('project memory draft id', () => {
  it('uses initmem_ plus the hash of the directory and topic', () => {
    const projectDir = '/work/notes';
    const topic: ProjectMemoryDraftTopic = 'purpose';
    const id = draftEntryId(projectDir, topic);
    expect(id).toBe(`initmem_${contentHash(`${projectDir}\n${topic}`)}`);
    expect(draftEntryId(projectDir, topic)).toBe(id);
    expect(draftEntryId(projectDir, 'key-files')).not.toBe(id);
    expect(draftEntryId(`${projectDir}/`, topic)).not.toBe(id);
  });
});

describe('removed deterministic init-memory surfaces', () => {
  it('registers no handler and does not revive the gui scanner', () => {
    expect(initMemoryCommands).toEqual([]);
    expect(INIT_MEMORY_GUI_DRAFT).toBe('prompt-command');
  });
});
