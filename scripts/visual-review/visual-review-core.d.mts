interface RubricItem {
  id: string;
  name: string;
  criterion: string;
  goldSource?: string;
}

interface Rubric {
  items: RubricItem[];
  [key: string]: unknown;
}

interface ReviewItem {
  rubricId: string;
  status: 'PASS' | 'RED' | 'NA';
  reason: string;
  region: string;
}

interface ReviewDraft {
  draftOnly: true;
  mode: 'single' | 'triptych';
  recommendHumanOpen: boolean;
  summary: string;
  items: ReviewItem[];
}

export function parseRepeatedArgs(argv: string[]): Record<string, unknown> & {
  positional: string[];
};

export function asStringList(value: unknown): string[];

export function isMaskPixel(data: Uint8Array, offset: number): boolean;

export function createPixelDiff(beforeBuffer: Buffer, afterBuffer: Buffer): {
  buffer: Buffer;
  width: number;
  height: number;
  changedPixels: number;
  maskedPixels: number;
  scoredPixels: number;
  changedRatio: number;
};

export function readRubric(rubricPath: string): Promise<Rubric>;

export function appendRubricToPrompt(
  template: string,
  rubric: Rubric,
  mode: 'single' | 'triptych',
): string;

export function validateReviewDraft(
  draft: unknown,
  rubric: Rubric,
  mode: 'single' | 'triptych',
): ReviewDraft;

export function listPngFiles(directory: string): Promise<string[]>;
