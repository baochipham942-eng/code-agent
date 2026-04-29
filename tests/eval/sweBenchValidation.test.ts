import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  type ExecutableValidation,
  buildDiffShapeValidation,
  buildDjangoTestLabels,
  decideRunOutcome,
  diffShapePassed,
} from '../../eval/swe-bench/validation';

const STANDARD_15987 = `diff --git a/django/core/management/commands/loaddata.py b/django/core/management/commands/loaddata.py
--- a/django/core/management/commands/loaddata.py
+++ b/django/core/management/commands/loaddata.py
@@ -367,7 +367,7 @@ def fixture_dirs(self):
             app_dir = os.path.join(app_config.path, "fixtures")
-            if app_dir in fixture_dirs:
+            if app_dir in [str(d) for d in fixture_dirs]:
`;

const WRONG_POSITION_15987 = `diff --git a/django/core/management/commands/loaddata.py b/django/core/management/commands/loaddata.py
--- a/django/core/management/commands/loaddata.py
+++ b/django/core/management/commands/loaddata.py
@@ -361,7 +361,7 @@ class Command(BaseCommand):
-        fixture_dirs = settings.FIXTURE_DIRS
+        fixture_dirs = [str(d) for d in settings.FIXTURE_DIRS]
`;

const TEST_PATCH_15987 = `diff --git a/tests/fixtures_regress/tests.py b/tests/fixtures_regress/tests.py
--- a/tests/fixtures_regress/tests.py
+++ b/tests/fixtures_regress/tests.py
@@ -569,6 +569,20 @@ def test_fixture_dirs_with_default_fixture_path(self):
+    @override_settings(FIXTURE_DIRS=[Path(_cur_dir) / "fixtures"])
+    def test_fixture_dirs_with_default_fixture_path_as_pathlib(self):
+        """
+        settings.FIXTURE_DIRS cannot contain a default fixtures directory
+        for application (app/fixtures) in order to avoid repeated fixture loading.
+        """
+        management.call_command("loaddata", "absolute.json", verbosity=0)
`;

const TEST_PATCH_16642 = `diff --git a/tests/responses/test_fileresponse.py b/tests/responses/test_fileresponse.py
--- a/tests/responses/test_fileresponse.py
+++ b/tests/responses/test_fileresponse.py
@@ -253,8 +253,10 @@ def test_compressed_response(self):
             (".tar.gz", "application/gzip"),
+            (".tar.br", "application/x-brotli"),
             (".tar.bz2", "application/x-bzip"),
             (".tar.xz", "application/x-xz"),
+            (".tar.Z", "application/x-compress"),
`;

function executable(status: ExecutableValidation['status']): ExecutableValidation {
  return {
    status,
    applied_test_patch: status !== 'skipped',
    fail_to_pass: [],
    test_labels: [],
    command: null,
    exit_code: status === 'passed' ? 0 : 1,
    duration_ms: 1,
    reason: status,
    stdout_tail: '',
    stderr_tail: '',
  };
}

describe('SWE-bench validation policy', () => {
  // ADR-015 D4: executable validation is ground truth — overrides judge and not_finished.
  // 测试反映真实场景: 15987 agent 在不同位置做等价修复，judge 认为不等价（30 分），
  // 但 docker 真测通过 (FAIL_TO_PASS test 实际运行 OK)。docker > judge。

  it('accepts patches that docker actually passes even when judge says wrong-location (15987 case)', () => {
    const shape = buildDiffShapeValidation(WRONG_POSITION_15987, STANDARD_15987);
    expect(diffShapePassed(shape)).toBe(true);

    const outcome = decideRunOutcome({
      finished: true,
      diff_shape_passed: true,
      executable_validation: executable('passed'),
      judge: {
        semantic_match: 30,
        matches_intent: true,
        matches_implementation: false,
      },
    });

    expect(outcome.passed).toBe(true);
    expect(outcome.status).toBe('passed');
  });

  it('rejects patches that docker truly fails (16642 wrong-key case)', () => {
    const outcome = decideRunOutcome({
      finished: true,
      diff_shape_passed: true,
      executable_validation: executable('failed'),
      judge: {
        semantic_match: 40,
        matches_intent: true,
        matches_implementation: false,
      },
    });

    expect(outcome.passed).toBe(false);
    expect(outcome.status).toBe('failed');
    expect(outcome.reasons).toContain('executable_validation_failed');
  });

  it('docker pass overrides not_finished — agent 改对了即可，不强制 finish', () => {
    const outcome = decideRunOutcome({
      finished: false,
      diff_shape_passed: true,
      executable_validation: executable('passed'),
      judge: {
        semantic_match: 95,
        matches_intent: true,
        matches_implementation: true,
      },
    });

    expect(outcome.passed).toBe(true);
    expect(outcome.status).toBe('passed');
  });

  it('falls back to judge + shape when executable is skipped', () => {
    const outcome = decideRunOutcome({
      finished: true,
      diff_shape_passed: true,
      executable_validation: executable('skipped'),
      judge: {
        semantic_match: 90,
        matches_intent: true,
        matches_implementation: true,
      },
    });

    expect(outcome.passed).toBe(true);
    expect(outcome.status).toBe('degraded');
    expect(outcome.reasons).toContain('executable_validation_skipped');
  });

  it('fails fallback when executable skipped + judge below threshold', () => {
    const outcome = decideRunOutcome({
      finished: true,
      diff_shape_passed: true,
      executable_validation: executable('skipped'),
      judge: {
        semantic_match: 30,
        matches_intent: true,
        matches_implementation: false,
      },
    });

    expect(outcome.passed).toBe(false);
    expect(outcome.status).toBe('failed');
    expect(outcome.reasons).toContain('judge_below_threshold');
  });
});

describe('Django FAIL_TO_PASS label extraction', () => {
  let tempRoot: string | null = null;

  afterEach(() => {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  });

  function writeFixture(relativePath: string, content: string): string {
    tempRoot ??= fs.mkdtempSync(path.join(os.tmpdir(), 'swe-bench-validation-'));
    const filePath = path.join(tempRoot, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return tempRoot;
  }

  it('targets the newly added django__django-15987 test method', () => {
    const root = writeFixture(
      'tests/fixtures_regress/tests.py',
      `class TestFixtures(TestCase):
    def test_fixture_dirs_with_default_fixture_path(self):
        """
        settings.FIXTURE_DIRS cannot contain a default fixtures directory
        """
        pass

    def test_fixture_dirs_with_default_fixture_path_as_pathlib(self):
        """
        settings.FIXTURE_DIRS cannot contain a default fixtures directory
        for application (app/fixtures) in order to avoid repeated fixture loading.
        """
        pass
`,
    );

    expect(buildDjangoTestLabels(TEST_PATCH_15987, root, ['settings.FIXTURE_DIRS cannot contain a default fixtures directory'])).toEqual([
      'fixtures_regress.tests.TestFixtures.test_fixture_dirs_with_default_fixture_path_as_pathlib',
    ]);
  });

  it('finds the existing django__django-16642 test method from FAIL_TO_PASS text', () => {
    const root = writeFixture(
      'tests/responses/test_fileresponse.py',
      `class FileResponseTests(SimpleTestCase):
    def test_compressed_response(self):
        """
        If compressed responses are served with the uncompressed Content-Type
        and a compression Content-Encoding, browsers might automatically
        uncompress the file, which is most probably not wanted.
        """
        pass
`,
    );

    expect(
      buildDjangoTestLabels(TEST_PATCH_16642, root, [
        'If compressed responses are served with the uncompressed Content-Type',
      ]),
    ).toEqual(['responses.test_fileresponse.FileResponseTests.test_compressed_response']);
  });
});
