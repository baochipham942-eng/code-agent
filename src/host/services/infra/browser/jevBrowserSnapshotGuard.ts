// ============================================================================
// Jev browser snapshot guard — InputSanitizer + guardSensitiveText before Jev
// ============================================================================
// Inner loop never goes through toolResultLifecycle. Same sanitizer enumerator
// and block policy as N-INJGUARD-BROWSER; then every state string is masked.

import { buildBrowserStepQuestions } from '../../../../shared/constants/jevQuestions';
import { getInputSanitizer } from '../../../security/inputSanitizer';
import { guardSensitiveText } from '../../../security/sensitiveDataGuard';
import {
  buildTargetLabels,
  type JevCandidate,
  type PreparedJevSnapshot,
} from './jevBrowserSnapshotPrep';

const JEV_STATE_SOFT_TOKEN_LIMIT = 24_000;
const JEV_STATE_SOFT_CHAR_LIMIT = 96_000;

interface JevGuardedState {
  blocked: boolean;
  injectionFlag: boolean;
  overBudget: boolean;
  state: Record<string, unknown>;
  labels: Record<string, string>;
  selected: JevCandidate[];
  warnings: string[];
}

function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

type JevSnapshotSanitizer = {
  sanitize: (text: string, source: string, options?: { scope?: 'lenient' | 'strict' }) => {
    blocked: boolean;
    sanitized: string;
    warnings: Array<{ description: string }>;
  };
};

function guardString(value: string, sanitizer: JevSnapshotSanitizer): string {
  const rewritten = sanitizer.sanitize(value, 'Browser.jev_snapshot', { scope: 'lenient' }).sanitized;
  return guardSensitiveText(rewritten, { surface: 'prompt', mode: 'model-context' });
}

function walkStrings(value: unknown, sanitizer: JevSnapshotSanitizer): unknown {
  if (typeof value === 'string') return guardString(value, sanitizer);
  if (Array.isArray(value)) return value.map((child) => walkStrings(child, sanitizer));
  if (value && typeof value === 'object') {
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      next[key] = walkStrings(child, sanitizer);
    }
    return next;
  }
  return value;
}

function concatScanText(prepared: PreparedJevSnapshot, task: string): string {
  const headingText = prepared.snapshot.headings.map((heading) => heading.text).join('\n');
  const targetText = prepared.selected.map((candidate) => [
    candidate.name,
    candidate.text,
    candidate.ariaLabel || '',
    candidate.placeholder || '',
  ].join(' ')).join('\n');
  return [
    task,
    prepared.snapshot.url,
    prepared.snapshot.title,
    headingText,
    targetText,
  ].join('\n');
}

function padHeadingKey(index: number): string {
  return `h_${String(index + 1).padStart(2, '0')}`;
}

function buildJevStateSkeleton(args: {
  task: string;
  prepared: PreparedJevSnapshot;
  assertions: Array<{ id: string; kind: string; needle: string; met: boolean }>;
  recentSteps: Array<{ op: string; target_name: string; result: string }>;
  injectionFlag: boolean;
  targetTextChars?: number;
  dropZones?: ReadonlySet<JevCandidate['zone']>;
}): { state: Record<string, unknown>; labels: Record<string, string>; selected: JevCandidate[] } {
  const maxChars = args.targetTextChars ?? 120;
  const dropZones = args.dropZones ?? new Set<JevCandidate['zone']>();
  const selected = args.prepared.selected.filter((candidate) => !dropZones.has(candidate.zone));
  const labels = buildTargetLabels(selected, maxChars);
  const headings: Record<string, string> = {};
  args.prepared.snapshot.headings.slice(0, 30).forEach((heading, index) => {
    headings[padHeadingKey(index)] = heading.text.slice(0, 120);
  });
  const targets: Record<string, unknown> = {};
  for (const candidate of selected) {
    targets[candidate.refId] = {
      tag: candidate.tag,
      role: candidate.role,
      name: candidate.name.slice(0, maxChars),
      text: candidate.text.slice(0, maxChars),
      in_view: candidate.inView,
      input_kind: candidate.inputKind,
    };
  }
  const recent: Record<string, unknown> = {};
  args.recentSteps.slice(-8).forEach((step, index) => {
    recent[`s${index + 1}`] = step;
  });
  const assertions: Record<string, unknown> = {};
  args.assertions.forEach((assertion, index) => {
    assertions[`a${index + 1}`] = {
      kind: assertion.kind,
      needle: assertion.needle,
      met: assertion.met,
    };
  });
  return {
    selected,
    labels,
    state: {
      task: args.task.slice(0, 2_000),
      page: {
        url: args.prepared.snapshot.url.slice(0, 1_500),
        title: args.prepared.snapshot.title.slice(0, 500),
      },
      headings,
      window: args.prepared.window,
      targets,
      recent_steps: recent,
      assertions,
      injection_flag: args.injectionFlag,
      sensitive_fields_present: args.prepared.sensitiveFieldsPresent,
      dialog_pending: false,
      unavailable_frames: args.prepared.unavailableFrames,
    },
  };
}

export function guardJevBrowserSnapshot(args: {
  task: string;
  prepared: PreparedJevSnapshot;
  assertions: Array<{ id: string; kind: string; needle: string; met: boolean }>;
  recentSteps: Array<{ op: string; target_name: string; result: string }>;
  sanitizer?: JevSnapshotSanitizer;
}): JevGuardedState {
  const sanitizer = args.sanitizer ?? getInputSanitizer();
  const scan = concatScanText(args.prepared, args.task);
  const sanitized = sanitizer.sanitize(scan, 'Browser.jev_snapshot', { scope: 'lenient' });
  if (sanitized.blocked) {
    return {
      blocked: true,
      injectionFlag: true,
      overBudget: false,
      state: {},
      labels: {},
      selected: [],
      warnings: sanitized.warnings.map((warning) => warning.description),
    };
  }
  const injectionFlag = sanitized.warnings.length > 0;

  const tryBuild = (targetTextChars: number, dropZones: ReadonlySet<JevCandidate['zone']>) => {
    const built = buildJevStateSkeleton({
      task: args.task,
      prepared: args.prepared,
      assertions: args.assertions,
      recentSteps: args.recentSteps,
      injectionFlag,
      targetTextChars,
      dropZones,
    });
    const guardedState = walkStrings(built.state, sanitizer) as Record<string, unknown>;
    const guardedLabels: Record<string, string> = {};
    for (const [key, label] of Object.entries(built.labels)) {
      guardedLabels[key] = guardString(label, sanitizer);
    }
    const questions = buildBrowserStepQuestions(guardedLabels);
    const chars = JSON.stringify(guardedState).length + JSON.stringify(questions).length;
    return {
      built: { ...built, state: guardedState, labels: guardedLabels },
      chars,
      tokens: estimateTokens(chars),
    };
  };

  let attempt = tryBuild(120, new Set());
  if (attempt.tokens > JEV_STATE_SOFT_TOKEN_LIMIT || attempt.chars > JEV_STATE_SOFT_CHAR_LIMIT) {
    attempt = tryBuild(80, new Set());
  }
  if (attempt.tokens > JEV_STATE_SOFT_TOKEN_LIMIT || attempt.chars > JEV_STATE_SOFT_CHAR_LIMIT) {
    attempt = tryBuild(80, new Set(['below']));
  }
  if (attempt.tokens > JEV_STATE_SOFT_TOKEN_LIMIT || attempt.chars > JEV_STATE_SOFT_CHAR_LIMIT) {
    attempt = tryBuild(80, new Set(['below', 'above']));
  }
  if (attempt.tokens > JEV_STATE_SOFT_TOKEN_LIMIT || attempt.chars > JEV_STATE_SOFT_CHAR_LIMIT) {
    return {
      blocked: false,
      injectionFlag,
      overBudget: true,
      state: attempt.built.state,
      labels: attempt.built.labels,
      selected: attempt.built.selected,
      warnings: sanitized.warnings.map((warning) => warning.description),
    };
  }

  return {
    blocked: false,
    injectionFlag,
    overBudget: false,
    state: attempt.built.state,
    labels: attempt.built.labels,
    selected: attempt.built.selected,
    warnings: sanitized.warnings.map((warning) => warning.description),
  };
}
