import type {
  EvalCaseListEntry,
  EvalExperimentCaseDetail,
} from '@shared/contract/evaluation';

interface EvalExperimentCaseRow {
  case_id: string;
  session_id: string | null;
  status: string;
  score: number;
  duration_ms: number | null;
  data_json: string | null;
  config_json: string | null;
  summary_json: string;
}

function parseRecord(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function buildEvalExperimentCaseDetail(input: {
  row: EvalExperimentCaseRow;
  assertionCatalog: ReadonlyArray<{ type: string; summary: string }>;
  failureLabel?: string;
  caseMetadata?: EvalCaseListEntry;
}): EvalExperimentCaseDetail {
  const { row, assertionCatalog, failureLabel, caseMetadata } = input;
  const data = parseRecord(row.data_json);
  const config = parseRecord(row.config_json);
  const summary = parseRecord(row.summary_json);
  const failure = data.failure && typeof data.failure === 'object' && !Array.isArray(data.failure)
    ? data.failure as EvalExperimentCaseDetail['failure']
    : undefined;
  return {
    caseId: row.case_id,
    status: (data.invalid ? 'invalid' : row.status) as EvalExperimentCaseDetail['status'],
    score: row.score,
    durationMs: row.duration_ms,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(typeof data.failureReason === 'string' ? { failureReason: data.failureReason } : {}),
    ...(failure ? { failure, ...(failureLabel ? { failureLabel } : {}) } : {}),
    ...(data.trialAggregate ? {
      trialAggregate: data.trialAggregate as EvalExperimentCaseDetail['trialAggregate'],
    } : {}),
    ...(data.aiReview ? { aiReview: data.aiReview as EvalExperimentCaseDetail['aiReview'] } : {}),
    evidence: data.evidence && typeof data.evidence === 'object'
      ? data.evidence as EvalExperimentCaseDetail['evidence']
      : null,
    ...(!data.evidence ? { evidenceMissingReason: 'legacy_run' as const } : {}),
    assertionCatalog,
    ...(typeof config.promptVersion === 'string' ? { promptVersion: config.promptVersion } : {}),
    ...(Array.isArray(summary.reportFiles)
      ? { reportFiles: summary.reportFiles.filter((file): file is string => typeof file === 'string') }
      : {}),
    ...(caseMetadata ? {
      caseMetadata: {
        type: caseMetadata.type,
        category: caseMetadata.category,
        tags: caseMetadata.tags,
        splits: caseMetadata.splits,
        source: caseMetadata.source,
      },
    } : {}),
  };
}
