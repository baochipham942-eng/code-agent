import {
  CHECKPOINT_SECTIONS,
  getSectionBody,
} from './templates';
import {
  validateExactLiteralsPreserved,
  type ExactFormLiteral,
} from './exactValues';
import {
  validatePathDiscipline,
  type CheckpointPathTable,
  type PathDisciplineViolation,
} from './pathDiscipline';

export interface CheckpointTaskSnapshotEntry {
  id: string;
  status?: string;
}

export interface CheckpointValidationResult {
  valid: boolean;
  missingSections: number[];
  activeIntentHasVerbatimQuote: boolean;
  missingExactLiterals: string[];
  pathViolations: PathDisciplineViolation[];
  tamperedInstructionSections: number[];
  taskTreeViolations: string[];
}

const TASK_LINE_PATTERN = /(?:🔵|🔄|🟡|✅|❌)\s+(\S+)/gu;

function findTamperedInstructionSections(checkpoint: string): number[] {
  const tampered: number[] = [];
  for (const section of CHECKPOINT_SECTIONS) {
    const headingIndex = checkpoint.indexOf(`${section.heading}\n`);
    if (headingIndex < 0) continue; // 缺头由 missingSections 报
    const afterHeading = checkpoint.slice(headingIndex + section.heading.length + 1);
    const instructionLine = afterHeading.split('\n', 1)[0];
    if (instructionLine.trim() !== section.instruction) {
      tampered.push(section.number);
    }
  }
  return tampered;
}

function validateTaskTree(checkpoint: string, tasks: CheckpointTaskSnapshotEntry[]): string[] {
  const violations: string[] = [];
  const body = getSectionBody(checkpoint, 4) ?? '';
  const realIds = new Set(tasks.map((task) => task.id));
  const renderedIds = new Set<string>();
  for (const match of body.matchAll(TASK_LINE_PATTERN)) {
    renderedIds.add(match[1]);
  }
  for (const id of realIds) {
    if (!renderedIds.has(id)) {
      violations.push(`§4 missing task id from task store: ${id}`);
    }
  }
  for (const id of renderedIds) {
    if (!realIds.has(id)) {
      violations.push(`§4 contains task id not in task store: ${id}`);
    }
  }
  return violations;
}

export function validateCheckpointDocument(
  checkpoint: string,
  options: {
    requiredExactLiterals?: Array<string | ExactFormLiteral>;
    pathTable?: CheckpointPathTable;
    /** taskStore 快照：传入时对 §4 做交叉校验（audit C-H2/C-M1），不传跳过 */
    tasks?: CheckpointTaskSnapshotEntry[];
  } = {},
): CheckpointValidationResult {
  const missingSections = CHECKPOINT_SECTIONS
    .map((section) => section.number)
    .filter((sectionNumber) => getSectionBody(checkpoint, sectionNumber) === null);
  const activeIntent = getSectionBody(checkpoint, 1) ?? '';
  const activeIntentHasVerbatimQuote = /^>\s*".+"/m.test(activeIntent);
  const exact = validateExactLiteralsPreserved(options.requiredExactLiterals ?? [], checkpoint);
  const exactLiterals = (options.requiredExactLiterals ?? [])
    .map((value) => typeof value === 'string' ? value : value.literal);
  const pathResult = options.pathTable
    ? validatePathDiscipline(checkpoint, options.pathTable, { allowExactLiterals: exactLiterals })
    : { valid: true, violations: [] };
  const tamperedInstructionSections = findTamperedInstructionSections(checkpoint);
  const taskTreeViolations = options.tasks
    ? validateTaskTree(checkpoint, options.tasks)
    : [];

  return {
    valid: missingSections.length === 0
      && activeIntentHasVerbatimQuote
      && exact.valid
      && pathResult.valid
      && tamperedInstructionSections.length === 0
      && taskTreeViolations.length === 0,
    missingSections,
    activeIntentHasVerbatimQuote,
    missingExactLiterals: exact.missing,
    pathViolations: pathResult.violations,
    tamperedInstructionSections,
    taskTreeViolations,
  };
}
