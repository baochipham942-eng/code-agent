// ============================================================================
// Change Detector — Detects which file changes should trigger eval re-runs
// ============================================================================

import { execSync } from 'child_process';
import picomatch from 'picomatch';

interface TriggerPattern {
  glob: string;
  scope: 'smoke' | 'full';
}

const TRIGGER_PATTERNS: TriggerPattern[] = [
  // Full re-run triggers
  { glob: 'src/main/prompts/**', scope: 'full' },
  { glob: 'src/main/tools/**', scope: 'full' },
  { glob: 'src/main/model/**', scope: 'full' },
  { glob: 'src/shared/constants.ts', scope: 'full' },
  // Smoke test triggers
  { glob: 'src/main/agent/agent*.ts', scope: 'smoke' },
  { glob: 'src/main/agent/generation*.ts', scope: 'smoke' },
];

const SKIP_PATTERNS = [
  'src/renderer/**',
  '**/*.md',
  '**/*.test.ts',
  'scripts/**',
];

export interface ChangeDetectionResult {
  shouldRunEval: boolean;
  changedFiles: string[];
  triggerReason: string;
  scope: 'smoke' | 'full';
}

export class ChangeDetector {
  private skipMatcher: picomatch.Matcher;
  private triggerMatchers: Array<{ matcher: picomatch.Matcher; pattern: TriggerPattern }>;

  constructor() {
    this.skipMatcher = picomatch(SKIP_PATTERNS);
    this.triggerMatchers = TRIGGER_PATTERNS.map((pattern) => ({
      matcher: picomatch(pattern.glob),
      pattern,
    }));
  }

  async detectTriggeringChanges(base?: string): Promise<ChangeDetectionResult> {
    const changedFiles = this.getChangedFiles(base);

    if (changedFiles.length === 0) {
      return {
        shouldRunEval: false,
        changedFiles: [],
        triggerReason: 'No changed files detected',
        scope: 'smoke',
      };
    }

    // Filter out skipped files
    const relevantFiles = changedFiles.filter((f) => !this.skipMatcher(f));

    if (relevantFiles.length === 0) {
      return {
        shouldRunEval: false,
        changedFiles,
        triggerReason: 'All changed files match skip patterns',
        scope: 'smoke',
      };
    }

    // Determine scope — full takes priority over smoke
    let scope: 'smoke' | 'full' = 'smoke';
    const triggerReasons: string[] = [];

    for (const file of relevantFiles) {
      for (const { matcher, pattern } of this.triggerMatchers) {
        if (matcher(file)) {
          if (pattern.scope === 'full') {
            scope = 'full';
          }
          triggerReasons.push(`${file} matches ${pattern.glob} (${pattern.scope})`);
          break;
        }
      }
    }

    if (triggerReasons.length === 0) {
      return {
        shouldRunEval: false,
        changedFiles,
        triggerReason: 'Changed files do not match any trigger patterns',
        scope: 'smoke',
      };
    }

    return {
      shouldRunEval: true,
      changedFiles: relevantFiles,
      triggerReason: triggerReasons.join('; '),
      scope,
    };
  }

  private getChangedFiles(base?: string): string[] {
    try {
      const ref = base ?? 'HEAD';
      const output = execSync(`git diff --name-only ${ref}`, {
        encoding: 'utf-8',
        timeout: 10_000,
      });
      return output
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      // If git diff fails (e.g., no commits yet), try getting staged files
      try {
        const output = execSync('git diff --name-only --cached', {
          encoding: 'utf-8',
          timeout: 10_000,
        });
        return output
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
      } catch {
        return [];
      }
    }
  }
}
