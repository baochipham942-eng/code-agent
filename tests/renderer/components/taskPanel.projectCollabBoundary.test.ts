import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('TaskPanel project collaboration boundary', () => {
  it('keeps project collaboration out of TaskPanel and routes it through its project page', () => {
    const taskPanelSource = readFileSync(resolve(process.cwd(), 'src/renderer/components/TaskPanel/index.tsx'), 'utf8');
    const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/App.tsx'), 'utf8');

    expect(taskPanelSource).not.toMatch(/ProjectCollaborationPanel|project-collab|项目合作/);
    expect(appSource).toContain('ProjectCollaborationPage');
    expect(appSource).toContain('showProjectCollaborationPage');
    expect(appSource).not.toContain("activeWorkbenchTab === 'project-collab'");
  });

  it('treats uncategorized conversations as unbound in the project collaboration panel', () => {
    const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/App.tsx'), 'utf8');

    expect(appSource).toContain('UNSORTED_PROJECT_ID');
    expect(appSource).toContain('session.projectId !== UNSORTED_PROJECT_ID');
    expect(appSource).toContain('<ProjectCollaborationPage');
  });
});
