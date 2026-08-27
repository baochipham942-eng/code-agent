import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowPath = path.resolve(
  import.meta.dirname,
  '../../.github/workflows/repository-structure.yml',
);

function eventBlock(workflow: string, event: 'pull_request' | 'push'): string {
  const match = workflow.match(new RegExp(
    `^  ${event}:\\n([\\s\\S]*?)(?=^  [a-z_]+:|^permissions:)`,
    'm',
  ));

  expect(match, `${event} trigger must exist`).not.toBeNull();
  return match?.[1] ?? '';
}

describe('repository structure workflow triggers', () => {
  it.each(['pull_request', 'push'] as const)(
    'runs on every %s so every measured repository dimension is covered',
    (event) => {
      const workflow = fs.readFileSync(workflowPath, 'utf8');
      const trigger = eventBlock(workflow, event);

      expect(trigger).not.toMatch(/^ {4}paths(?:-ignore)?:/m);
    },
  );
});
