export interface ModelFacingDocCheckResult {
  ok: boolean;
  entryCount: number;
  missingPaths: string[];
  errors: string[];
}

export declare function checkModelFacingDocs(
  content: string,
  repoRoot?: string,
): ModelFacingDocCheckResult;
