import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface DiffShapeValidation {
  standard_files_touched: string[];
  hit_standard_file: boolean;
  no_tests_modified: boolean;
  diff_lines: number;
  diff_within_3x_standard: boolean;
  not_empty: boolean;
}

export interface JudgeLikeResult {
  semantic_match: number;
  matches_intent?: boolean;
  matches_implementation?: boolean;
}

export type ExecutableValidationStatus = 'passed' | 'failed' | 'skipped' | 'error';

export interface ExecutableValidation {
  status: ExecutableValidationStatus;
  applied_test_patch: boolean;
  fail_to_pass: string[];
  test_labels: string[];
  command: string[] | null;
  exit_code: number | null;
  duration_ms: number;
  reason: string;
  stdout_tail: string;
  stderr_tail: string;
}

export interface RunOutcome {
  passed: boolean;
  status: 'passed' | 'failed' | 'degraded';
  reasons: string[];
}

export function buildDiffShapeValidation(agentDiff: string, standardPatch: string): DiffShapeValidation {
  const standardFiles = Array.from(standardPatch.matchAll(/^--- a\/(.+)$/gm)).map((m) => m[1]);
  const standardLines = standardPatch.split('\n').length;
  const diffLines = agentDiff.split('\n').length;
  const touchedTests = /^diff --git a\/tests\//m.test(agentDiff) || / a\/tests\//.test(agentDiff);

  return {
    standard_files_touched: standardFiles,
    hit_standard_file: standardFiles.some((f) => agentDiff.includes(`a/${f}`)),
    no_tests_modified: !touchedTests,
    diff_lines: diffLines,
    diff_within_3x_standard: diffLines <= standardLines * 3,
    not_empty: diffLines > 1 && agentDiff.trim().length > 0,
  };
}

export function diffShapePassed(validation: DiffShapeValidation): boolean {
  return (
    validation.hit_standard_file &&
    validation.no_tests_modified &&
    validation.diff_within_3x_standard &&
    validation.not_empty
  );
}

export function parseFailToPass(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // Some datasets use a plain string; keep it as one opaque selector.
  }
  return [raw];
}

export function decideRunOutcome(input: {
  finished: boolean;
  diff_shape_passed: boolean;
  executable_validation: ExecutableValidation;
  judge: JudgeLikeResult | null;
  judge_threshold?: number;
}): RunOutcome {
  const judgeThreshold = input.judge_threshold ?? 70;
  const reasons: string[] = [];

  if (!input.finished) reasons.push('not_finished');
  if (!input.diff_shape_passed) reasons.push('diff_shape_failed');

  // executable validation 是 ground truth — 优先于 judge 和 shape。
  // 真测通过即真过（不被 judge 否决），真测失败即真败。
  if (input.executable_validation.status === 'passed') {
    return { passed: true, status: 'passed', reasons: [] };
  }
  if (input.executable_validation.status === 'failed') {
    reasons.push('executable_validation_failed');
    return { passed: false, status: 'failed', reasons };
  }

  // executable 缺席 (skipped / error) — fallback 到 judge + diff_shape 兜底。
  reasons.push(`executable_validation_${input.executable_validation.status}`);

  if (!input.judge) {
    reasons.push('judge_missing');
    return { passed: false, status: 'degraded', reasons };
  }

  const judgeBelowThreshold = input.judge.semantic_match < judgeThreshold;
  const judgeImplMismatch = input.judge.matches_implementation === false;

  if (judgeBelowThreshold) reasons.push('judge_below_threshold');
  if (judgeImplMismatch) reasons.push('judge_implementation_mismatch');

  const judgeOk = !judgeBelowThreshold && !judgeImplMismatch;
  const fallbackPass = input.diff_shape_passed && judgeOk;

  return {
    passed: fallbackPass,
    status: fallbackPass ? 'degraded' : 'failed',
    reasons,
  };
}

export function extractChangedTestFiles(testPatch: string): string[] {
  return Array.from(testPatch.matchAll(/^\+\+\+ b\/(tests\/.+\.py)$/gm)).map((m) => m[1]);
}

export function extractAddedTestMethods(testPatch: string): Map<string, string[]> {
  const methods = new Map<string, string[]>();
  let currentFile: string | null = null;

  for (const line of testPatch.split('\n')) {
    const fileMatch = line.match(/^\+\+\+ b\/(tests\/.+\.py)$/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      if (!methods.has(currentFile)) methods.set(currentFile, []);
      continue;
    }

    const methodMatch = line.match(/^\+\s+def (test_[A-Za-z0-9_]+)\(/);
    if (currentFile && methodMatch) {
      methods.get(currentFile)!.push(methodMatch[1]);
    }
  }

  return methods;
}

export function djangoModuleFromTestPath(testFile: string): string {
  return testFile.replace(/^tests\//, '').replace(/\.py$/, '').split('/').join('.');
}

export function findDjangoTestLabel(testFile: string, fileContent: string, methodName: string): string | null {
  const lines = fileContent.split('\n');
  const methodIndex = lines.findIndex((line) => new RegExp(`^\\s+def ${methodName}\\(`).test(line));
  if (methodIndex < 0) return null;

  let className: string | null = null;
  for (let i = methodIndex; i >= 0; i--) {
    const classMatch = lines[i].match(/^class ([A-Za-z_][A-Za-z0-9_]*)\(/);
    if (classMatch) {
      className = classMatch[1];
      break;
    }
  }

  const moduleName = djangoModuleFromTestPath(testFile);
  return className ? `${moduleName}.${className}.${methodName}` : `${moduleName}.${methodName}`;
}

function findMethodContainingText(fileContent: string, text: string): string | null {
  if (!text) return null;
  const textLine = fileContent.split('\n').findIndex((line) => line.includes(text));
  if (textLine < 0) return null;

  const lines = fileContent.split('\n');
  for (let i = textLine; i >= 0; i--) {
    const methodMatch = lines[i].match(/^\s+def (test_[A-Za-z0-9_]+)\(/);
    if (methodMatch) return methodMatch[1];
  }
  return null;
}

export function buildDjangoTestLabels(testPatch: string, sandboxRoot: string, failToPass: string[]): string[] {
  const changedFiles = extractChangedTestFiles(testPatch);
  const addedMethods = extractAddedTestMethods(testPatch);
  const labels: string[] = [];

  for (const testFile of changedFiles) {
    const fullPath = path.join(sandboxRoot, testFile);
    if (!fs.existsSync(fullPath)) {
      labels.push(djangoModuleFromTestPath(testFile));
      continue;
    }

    const fileContent = fs.readFileSync(fullPath, 'utf8');
    const explicitMethods = addedMethods.get(testFile) ?? [];
    const methods = explicitMethods.length > 0
      ? explicitMethods
      : failToPass
          .map((text) => findMethodContainingText(fileContent, text))
          .filter((method): method is string => Boolean(method));

    if (methods.length === 0) {
      labels.push(djangoModuleFromTestPath(testFile));
      continue;
    }

    for (const method of new Set(methods)) {
      labels.push(findDjangoTestLabel(testFile, fileContent, method) ?? djangoModuleFromTestPath(testFile));
    }
  }

  return Array.from(new Set(labels));
}

function tail(text: string, maxChars = 4000): string {
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}

function applyPatchViaGit(sandboxRoot: string, patchText: string): { ok: boolean; error: string } {
  const result = spawnSync('git', ['apply', '--whitespace=nowarn', '-'], {
    cwd: sandboxRoot,
    input: patchText,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 20,
  });

  return {
    ok: result.status === 0,
    error: `${result.stderr ?? ''}${result.stdout ?? ''}`.trim(),
  };
}

export function applyAgentDiff(sandboxRoot: string, agentDiff: string): { ok: boolean; error: string } {
  return applyPatchViaGit(sandboxRoot, agentDiff);
}

export function resetSandboxToBase(sandboxRoot: string, baseCommit: string): void {
  spawnSync('git', ['checkout', '--', '.'], { cwd: sandboxRoot, stdio: 'pipe' });
  spawnSync('git', ['clean', '-fd'], { cwd: sandboxRoot, stdio: 'pipe' });
  spawnSync('git', ['fetch', '--depth', '1', 'origin', baseCommit], { cwd: sandboxRoot, stdio: 'pipe' });

  const checkout = spawnSync('git', ['checkout', baseCommit], {
    cwd: sandboxRoot,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 5,
  });
  if (checkout.status !== 0) {
    throw new Error(`git checkout ${baseCommit} failed: ${checkout.stderr || checkout.stdout}`);
  }
}

export function runExecutableValidation(input: {
  sandboxRoot: string;
  testPatch: string;
  failToPass: string | string[] | undefined;
  timeoutMs?: number;
}): ExecutableValidation {
  const started = Date.now();
  const failToPass = parseFailToPass(input.failToPass);

  if (!input.testPatch.trim()) {
    return {
      status: 'skipped',
      applied_test_patch: false,
      fail_to_pass: failToPass,
      test_labels: [],
      command: null,
      exit_code: null,
      duration_ms: Date.now() - started,
      reason: 'missing_test_patch',
      stdout_tail: '',
      stderr_tail: '',
    };
  }

  const patchResult = applyPatchViaGit(input.sandboxRoot, input.testPatch);
  if (!patchResult.ok) {
    return {
      status: 'error',
      applied_test_patch: false,
      fail_to_pass: failToPass,
      test_labels: [],
      command: null,
      exit_code: null,
      duration_ms: Date.now() - started,
      reason: `test_patch_apply_failed: ${patchResult.error}`,
      stdout_tail: '',
      stderr_tail: patchResult.error,
    };
  }

  const testLabels = buildDjangoTestLabels(input.testPatch, input.sandboxRoot, failToPass);
  if (testLabels.length === 0) {
    return {
      status: 'skipped',
      applied_test_patch: true,
      fail_to_pass: failToPass,
      test_labels: [],
      command: null,
      exit_code: null,
      duration_ms: Date.now() - started,
      reason: 'no_test_labels_derived_from_test_patch',
      stdout_tail: '',
      stderr_tail: '',
    };
  }

  const pythonBin = process.env.SWE_BENCH_PYTHON || 'python3';
  const command = [pythonBin, './tests/runtests.py', ...testLabels, '--verbosity', '1'];
  const result = spawnSync(command[0], command.slice(1), {
    cwd: input.sandboxRoot,
    env: {
      ...process.env,
      PYTHONPATH: [input.sandboxRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    },
    encoding: 'utf8',
    timeout: input.timeoutMs ?? 120000,
    maxBuffer: 1024 * 1024 * 20,
  });

  const timedOut = result.error?.message.includes('ETIMEDOUT') ?? false;
  const status: ExecutableValidationStatus = result.status === 0 ? 'passed' : result.error ? 'error' : 'failed';
  const reason =
    result.status === 0
      ? 'tests_passed'
      : timedOut
        ? 'test_command_timeout'
        : result.error
          ? `test_command_error: ${result.error.message}`
          : `test_command_exit_${result.status ?? 'unknown'}`;

  return {
    status,
    applied_test_patch: true,
    fail_to_pass: failToPass,
    test_labels: testLabels,
    command,
    exit_code: result.status,
    duration_ms: Date.now() - started,
    reason,
    stdout_tail: tail(result.stdout ?? ''),
    stderr_tail: tail(result.stderr ?? result.error?.message ?? ''),
  };
}

// ─── Docker 模式 ────────────────────────────────────────────────────────
// 用 SWE-bench 官方 docker image 跑测试，是业界标准 e2e 验证。
// 不依赖本地 Python 环境，每个 case 一个独立 image（含正确的 Python + 依赖）。

/**
 * SWE-bench instance image 命名规则：
 *   swebench/sweb.eval.<arch>.<repo>_<numeric_id>_<instance_short_name>
 * numeric_id 是 SWE-bench 内部对每个 repo 的固定 ID。
 * 已知映射（按需扩展）：
 */
const REPO_NUMERIC_ID: Record<string, string> = {
  django: '1776',
};

export type SweBenchArch = 'x86_64' | 'arm64';

export function buildSweBenchImageName(instanceId: string, arch: SweBenchArch = 'x86_64'): string {
  const parts = instanceId.split('__');
  if (parts.length !== 2) throw new Error(`Invalid instance_id format: ${instanceId}`);
  const [orgRepo, name] = parts;
  const numericId = REPO_NUMERIC_ID[orgRepo];
  if (!numericId) {
    throw new Error(`No SWE-bench numeric_id for repo: ${orgRepo}. 已知: ${Object.keys(REPO_NUMERIC_ID).join(', ')}`);
  }
  return `swebench/sweb.eval.${arch}.${orgRepo}_${numericId}_${name}`;
}

/**
 * SWE-bench FAIL_TO_PASS 字符串格式: "method_name (module.path.ClassName)"
 * 转成 Django runtests 可识别的 dotted label: "module.path.ClassName.method_name"
 *
 * 注意：部分 case 的 FAIL_TO_PASS 是自然语言描述（如 "If compressed responses..."），
 * 不能直接当 test_label。这种 case 必须从 test_patch hunks 推 method+class。
 */
export function failToPassToTestLabels(failToPass: string[]): string[] {
  const labels: string[] = [];
  for (const item of failToPass) {
    const m = item.match(/^(\S+)\s*\((.+)\)$/);
    if (m) {
      labels.push(`${m[2]}.${m[1]}`);
    } else if (item.trim()) {
      labels.push(item.trim());
    }
  }
  return Array.from(new Set(labels));
}

/**
 * 从 test_patch 的 diff hunks 提取 method → class 的映射。
 * 适用于 FAIL_TO_PASS 不是标准 dotted path 的 case。
 *
 * Patch hunk header 通常是 `@@ -X,Y +A,B @@ class FooBar(Base):` ——直接给出 class 名。
 * 上下文行（` class XXX:`）也提供 class 信号。
 */
export function deriveMethodToClassFromTestPatch(testPatch: string): Map<string, string> {
  const methodToClass = new Map<string, string>();
  let currentClass: string | null = null;
  let currentFile: string | null = null;
  const fileToCurrentClass = new Map<string, string | null>();

  for (const line of testPatch.split('\n')) {
    const fileMatch = line.match(/^\+\+\+ b\/(tests\/.+\.py)$/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      currentClass = fileToCurrentClass.get(currentFile) ?? null;
      continue;
    }

    // hunk header 直接含 class
    const hunkClass = line.match(/^@@.*@@\s+class\s+([A-Za-z_]\w*)/);
    if (hunkClass) {
      currentClass = hunkClass[1];
      if (currentFile) fileToCurrentClass.set(currentFile, currentClass);
      continue;
    }

    // 上下文行 / 加行里的 class 定义
    const ctxClass = line.match(/^[\s+-]\s*class\s+([A-Za-z_]\w*)/);
    if (ctxClass) {
      currentClass = ctxClass[1];
      if (currentFile) fileToCurrentClass.set(currentFile, currentClass);
      continue;
    }

    // 加号前缀的 method 定义 → 用 currentClass 关联
    const methodMatch = line.match(/^\+\s+def\s+(test_[A-Za-z0-9_]+)\(/);
    if (methodMatch && currentClass) {
      methodToClass.set(methodMatch[1], currentClass);
    }
  }
  return methodToClass;
}

/**
 * Docker 模式下推 Django test labels：完全基于 test_patch 解析（不依赖 sandbox 文件）。
 * 优先 `<module>.<class>.<method>`；解析不出 class 时降级到 `<module>` 整个 module。
 */
export function buildDjangoTestLabelsFromPatchOnly(testPatch: string, failToPass: string[]): string[] {
  // 策略 1（最精准）：FAIL_TO_PASS 是标准格式 "method (module.Class)"
  const standardLabels = new Set<string>();
  for (const item of failToPass) {
    const m = item.match(/^(\S+)\s*\((.+)\)$/);
    if (m) standardLabels.add(`${m[2]}.${m[1]}`);
  }
  if (standardLabels.size > 0) return Array.from(standardLabels);

  // 策略 2：从 test_patch hunks 推 method + class
  const changedFiles = extractChangedTestFiles(testPatch);
  const addedMethods = extractAddedTestMethods(testPatch);
  const methodToClass = deriveMethodToClassFromTestPatch(testPatch);

  const derived = new Set<string>();
  for (const testFile of changedFiles) {
    const moduleName = djangoModuleFromTestPath(testFile);
    const methods = addedMethods.get(testFile) ?? [];
    for (const method of methods) {
      const cls = methodToClass.get(method);
      if (cls) derived.add(`${moduleName}.${cls}.${method}`);
    }
  }
  if (derived.size > 0) return Array.from(derived);

  // 策略 3（降级）：跑整个 module
  const fallback = new Set<string>();
  for (const testFile of changedFiles) {
    fallback.add(djangoModuleFromTestPath(testFile));
  }
  return Array.from(fallback);
}

function makeSkippedExec(failToPass: string[], reason: string, started: number): ExecutableValidation {
  return {
    status: 'skipped',
    applied_test_patch: false,
    fail_to_pass: failToPass,
    test_labels: [],
    command: null,
    exit_code: null,
    duration_ms: Date.now() - started,
    reason,
    stdout_tail: '',
    stderr_tail: '',
  };
}

export function runExecutableValidationDocker(input: {
  instanceId: string;
  agentDiff: string;
  testPatch: string;
  failToPass: string | string[] | undefined;
  patchesDir: string;
  arch?: SweBenchArch;
  timeoutMs?: number;
}): ExecutableValidation {
  const started = Date.now();
  const failToPass = parseFailToPass(input.failToPass);
  const arch = input.arch ?? 'x86_64';

  if (!input.testPatch.trim()) {
    return makeSkippedExec(failToPass, 'missing_test_patch', started);
  }
  if (!input.agentDiff.trim()) {
    return makeSkippedExec(failToPass, 'missing_agent_diff', started);
  }

  // 优先从 test_patch hunks 推 method+class（应对 FAIL_TO_PASS 是自然语言描述的 case）
  const testLabels = buildDjangoTestLabelsFromPatchOnly(input.testPatch, failToPass);
  if (testLabels.length === 0) {
    return makeSkippedExec(failToPass, 'no_test_labels_derivable', started);
  }

  fs.mkdirSync(input.patchesDir, { recursive: true });
  const testPatchPath = path.join(input.patchesDir, 'test.patch');
  const agentPatchPath = path.join(input.patchesDir, 'agent.patch');
  fs.writeFileSync(testPatchPath, input.testPatch);
  fs.writeFileSync(agentPatchPath, input.agentDiff);

  let imageName: string;
  try {
    imageName = buildSweBenchImageName(input.instanceId, arch);
  } catch (e) {
    return {
      ...makeSkippedExec(failToPass, `image_name_build_failed: ${(e as Error).message}`, started),
      status: 'error',
    };
  }

  const labelsArg = testLabels.map((l) => `'${l.replace(/'/g, "'\\''")}'`).join(' ');
  const innerScript = [
    'source /opt/miniconda3/etc/profile.d/conda.sh && conda activate testbed',
    'cd /testbed',
    'git apply /patches/test.patch || { echo TEST_PATCH_APPLY_FAILED >&2; exit 91; }',
    'git apply /patches/agent.patch || { echo AGENT_PATCH_APPLY_FAILED >&2; exit 92; }',
    `./tests/runtests.py ${labelsArg}`,
  ].join('\n');

  const platform = arch === 'x86_64' ? 'linux/amd64' : 'linux/arm64';
  const command = [
    'docker',
    'run',
    '--rm',
    '--platform',
    platform,
    '-v',
    `${input.patchesDir}:/patches:ro`,
    '-e',
    'LANG=C.UTF-8',
    '-e',
    'LC_ALL=C.UTF-8',
    `${imageName}:latest`,
    'bash',
    '-c',
    innerScript,
  ];

  const result = spawnSync(command[0], command.slice(1), {
    encoding: 'utf8',
    timeout: input.timeoutMs ?? 600000,
    maxBuffer: 1024 * 1024 * 20,
  });

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? result.error?.message ?? '';
  const timedOut = result.error?.message.includes('ETIMEDOUT') ?? false;

  let status: ExecutableValidationStatus;
  let reason: string;
  let appliedTestPatch = true;

  if (timedOut) {
    status = 'error';
    reason = 'docker_command_timeout';
  } else if (result.error) {
    status = 'error';
    reason = `docker_command_error: ${result.error.message}`;
  } else if (result.status === 91) {
    status = 'error';
    reason = 'test_patch_apply_failed_in_container';
    appliedTestPatch = false;
  } else if (result.status === 92) {
    status = 'error';
    reason = 'agent_diff_apply_failed_in_container';
  } else if (result.status === 0) {
    status = 'passed';
    reason = 'tests_passed';
  } else {
    status = 'failed';
    reason = `test_command_exit_${result.status ?? 'unknown'}`;
  }

  return {
    status,
    applied_test_patch: appliedTestPatch,
    fail_to_pass: failToPass,
    test_labels: testLabels,
    command,
    exit_code: result.status,
    duration_ms: Date.now() - started,
    reason,
    stdout_tail: tail(stdout),
    stderr_tail: tail(stderr),
  };
}
