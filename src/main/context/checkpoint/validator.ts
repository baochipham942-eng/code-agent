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

export interface CheckpointValidationResult {
  valid: boolean;
  missingSections: number[];
  activeIntentHasVerbatimQuote: boolean;
  missingExactLiterals: string[];
  pathViolations: PathDisciplineViolation[];
}

export function validateCheckpointDocument(
  checkpoint: string,
  options: {
    requiredExactLiterals?: Array<string | ExactFormLiteral>;
    pathTable?: CheckpointPathTable;
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

  return {
    valid: missingSections.length === 0
      && activeIntentHasVerbatimQuote
      && exact.valid
      && pathResult.valid,
    missingSections,
    activeIntentHasVerbatimQuote,
    missingExactLiterals: exact.missing,
    pathViolations: pathResult.violations,
  };
}

