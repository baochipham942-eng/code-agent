import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/host/services/capability/capabilityLifecycleTrace', () => ({
  recordCapabilityLifecycle: vi.fn(),
}));

import { synchronizeSkillCapabilitySurface } from '../../../../src/host/services/skills/skillCapabilitySurface';
import { parseSkillMetadataOnly } from '../../../../src/host/services/skills/skillParser';
import { ToolSearchService } from '../../../../src/host/services/toolSearch';

const LEGACY_SKILL_NAMES = ['dream', 'lark-sheets', 'e2e-cdp', 'deploy-tauri-app'] as const;

describe('skill capability surface legacy declarations', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-capability-surface-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('synchronizes all observed legacy skills without missing depends failures', async () => {
    const skills = await Promise.all(LEGACY_SKILL_NAMES.map(async (name) => {
      const skillDir = path.join(tmpDir, name);
      await fs.mkdir(skillDir);
      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        ['---', `name: ${name}`, 'description: Legacy skill fixture', '---', '', 'Body.'].join('\n'),
        'utf-8',
      );
      return parseSkillMetadataOnly(skillDir, 'user');
    }));
    const toolSearch = new ToolSearchService();

    await synchronizeSkillCapabilitySurface(skills, toolSearch);

    for (const name of LEGACY_SKILL_NAMES) {
      const result = await toolSearch.searchTools(name, { maxResults: 10, includeMCP: false });
      expect(result.tools.map((tool) => tool.name)).toContain(`skill:${name}`);
    }
  });
});
