export interface CheckpointSection {
  number: number;
  heading: string;
  instruction: string;
  budgetTokens: number;
}

export const CHECKPOINT_SECTIONS: CheckpointSection[] = [
  {
    number: 1,
    heading: '## §1 Active intent',
    instruction: '_Verbatim current user intent. Must include at least one block quote with exact user words._',
    budgetTokens: 600,
  },
  {
    number: 2,
    heading: '## §2 Next concrete action',
    instruction: '_The next concrete action, with a verbatim quote when the user explicitly gave one._',
    budgetTokens: 450,
  },
  {
    number: 3,
    heading: '## §3 Directives (this session)',
    instruction: '_Session-scoped directives and exact-form literals that must survive this session._',
    budgetTokens: 900,
  },
  {
    number: 4,
    heading: '## §4 Task tree',
    instruction: '_Task status tree from the task source of truth. Use (none) when unavailable._',
    budgetTokens: 900,
  },
  {
    number: 5,
    heading: '## §5 Current work',
    instruction: '_What was being done immediately before this checkpoint._',
    budgetTokens: 900,
  },
  {
    number: 6,
    heading: '## §6 Files and code sections',
    instruction: '_Repo-relative files and code sections actively read or edited, with one-line purpose._',
    budgetTokens: 900,
  },
  {
    number: 7,
    heading: '## §7 Discovered knowledge (cross-task)',
    instruction: '_Cross-task facts discovered in this session and candidates for project memory._',
    budgetTokens: 800,
  },
  {
    number: 8,
    heading: '## §8 Errors and fixes',
    instruction: '_Errors encountered and fixes or mitigations that worked._',
    budgetTokens: 700,
  },
  {
    number: 9,
    heading: '## §9 Live resources',
    instruction: '_Runtime state such as branch, active processes, and external resources._',
    budgetTokens: 600,
  },
  {
    number: 10,
    heading: '## §10 Design decisions and discussion outcomes',
    instruction: '_Decisions reached through discussion that may not have an immediate file artifact._',
    budgetTokens: 800,
  },
  {
    number: 11,
    heading: '## §11 Open notes',
    instruction: '_Writer-curated catch-all for unresolved questions or orphan observations; prefer (none)._',
    budgetTokens: 450,
  },
];

export const CHECKPOINT_SECTION_BUDGETS = Object.fromEntries(
  CHECKPOINT_SECTIONS.map((section) => [`§${section.number}`, section.budgetTokens]),
) as Record<string, number>;

export const MEMORY_TEMPLATE = [
  '# Project Memory',
  '',
  '## Project context',
  '(none)',
  '',
  '## Rules',
  '(none)',
  '',
  '## Architecture decisions',
  '(none)',
  '',
  '## Discovered durable knowledge',
  '(none)',
  '',
].join('\n');

export const NOTES_TEMPLATE = [
  '# Checkpoint Notes',
  '',
  '(none)',
  '',
].join('\n');

export function createCheckpointTemplate(): string {
  return [
    '# Session Checkpoint',
    '',
    ...CHECKPOINT_SECTIONS.flatMap((section) => [
      section.heading,
      section.instruction,
      '(none)',
      '',
    ]),
  ].join('\n');
}

export function getSectionHeading(sectionNumber: number): string {
  const section = CHECKPOINT_SECTIONS.find((item) => item.number === sectionNumber);
  if (!section) {
    throw new Error(`Unknown checkpoint section §${sectionNumber}`);
  }
  return section.heading;
}

export function getSectionBody(markdown: string, sectionNumber: number): string | null {
  const heading = getSectionHeading(sectionNumber);
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 不用 m 标志：m 模式下 \s*$ 在每个行尾命中，多行 body 会被截断成首行
  const match = new RegExp(`${escapedHeading}\\n[^\\n]*\\n([\\s\\S]*?)(?=\\n## §\\d+ |\\s*$)`).exec(markdown);
  return match ? match[1].trim() : null;
}

export function replaceSectionBody(
  markdown: string,
  sectionNumber: number,
  body: string,
): string {
  const heading = getSectionHeading(sectionNumber);
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(${escapedHeading}\\n[^\\n]*\\n)([\\s\\S]*?)(?=\\n## §\\d+ |\\s*$)`);
  if (!pattern.test(markdown)) {
    throw new Error(`Cannot replace missing checkpoint section §${sectionNumber}`);
  }
  return markdown.replace(pattern, (_match, prefix: string) => `${prefix}${body.trim() || '(none)'}\n`);
}
