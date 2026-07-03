import { pathToFileURL } from 'url';
import { openArtifactPage, type ArtifactPageSession } from './browser/artifactPage';
import { gameSubtypeRegistry } from './gameArtifactSubtypeRegistry';

export const DEFAULT_RUNTIME_SMOKE_TIMEOUT_MS = 7000;

/**
 * Inline runtime probe 透传给 TS 侧的 subtype dispatch 数据。
 * page.evaluate 不能直接调 TS 函数，所以原本写在 string literal 里的
 * `validatePlatformerGameplayRuntimeEvidence` 改成把原料返回，TS 侧再调
 * `GameSubtypeChecker.validateRuntimeEvidence`。
 */
interface SubtypeDispatchPayload {
  subtype: string;
  meta: Record<string, unknown> | undefined;
  coverage: unknown;
  observations: unknown;
  beforeSmokeSnapshot: unknown;
  afterSmokeSnapshot: unknown;
  smokePassed: boolean;
}

export interface RuntimeSmokeSummary {
  attempted: boolean;
  skipped?: boolean;
  passed: boolean;
  failures: string[];
  checks: string[];
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === 'string') return item;
      try {
        return JSON.stringify(item);
      } catch {
        return String(item);
      }
    })
    .filter(Boolean);
}

function normalizeRuntimeSmokeResult(value: unknown): RuntimeSmokeSummary {
  if (!value || typeof value !== 'object') {
    return {
      attempted: true,
      passed: false,
      failures: ['runSmokeTest 没有返回结构化结果。'],
      checks: [],
    };
  }

  const result = value as Record<string, unknown>;
  const checks = [
    ...stringArray(result.checks),
    ...stringArray(result.observations),
  ];
  const failures = stringArray(result.failures);
  const passed = result.passed === true && failures.length === 0;

  return {
    attempted: true,
    passed,
    checks,
    failures: passed ? [] : failures.length > 0 ? failures : ['runSmokeTest 返回未通过，但没有说明失败原因。'],
  };
}

export async function runRuntimeSmoke(filePath: string, timeoutMs: number): Promise<RuntimeSmokeSummary> {
  let session: ArtifactPageSession | null = null;

  try {
    const opened = await openArtifactPage(timeoutMs);
    if (!opened.ok) {
      return {
        attempted: false,
        skipped: true,
        passed: true,
        failures: [],
        checks: [`runtime smoke skipped: ${opened.skippedReason}`],
      };
    }
    session = opened.session;
    const { page, launchChecks } = session;

    await page.goto(pathToFileURL(filePath).href, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    const smokeTimeoutMs = Math.min(timeoutMs, 5000);
    const runtimeProbeScript = `
      (async () => {
        const innerTimeoutMs = ${smokeTimeoutMs};
        const root = window;
        const contract = root.__INTERACTIVE_TEST__ || root.__GAME_TEST__;
        if (!contract || typeof contract.runSmokeTest !== 'function') {
          return { passed: false, failures: ['运行时没有找到 runSmokeTest。'] };
        }
        if (typeof contract.start !== 'function' || typeof contract.snapshot !== 'function') {
          return { passed: false, failures: ['运行时测试合约缺少 start 或 snapshot。'] };
        }

        const checks = [];
        const failures = [];
        const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
        const collectStrings = (value) => {
          if (typeof value === 'string') return [value];
          if (Array.isArray(value)) return value.flatMap(collectStrings);
          if (value && typeof value === 'object') return Object.values(value).flatMap(collectStrings);
          return [];
        };
        const collectControlKeys = (value) => {
          if (!value) return [];
          if (typeof value === 'string') return [value];
          if (Array.isArray(value)) return value.flatMap(collectControlKeys);
          if (typeof value === 'object') {
            const directKeys = Object.keys(value).filter((key) => /^[A-Za-z0-9_+-]+$/.test(key));
            return [
              ...directKeys,
              ...Object.values(value).flatMap(collectControlKeys),
            ];
          }
          return [];
        };
        const contractMeta = contract && typeof contract === 'object' ? contract : {};
        const meta = Object.assign(
          {},
          root.__GAME_META__ || {},
          root.__INTERACTIVE_META__ || {},
          contractMeta
        );
        const controls = collectStrings(meta.controls);
        const keyControls = [...new Set(collectControlKeys(meta.controls).filter((control) => /^[A-Za-z0-9_+-]+$/.test(control)))];
        const controlAliases = {};
        const addControlAlias = (inputKey, alias) => {
          if (typeof inputKey !== 'string' || typeof alias !== 'string') return;
          const key = inputKey.trim();
          const normalizedAlias = alias.trim();
          if (!key || !normalizedAlias) return;
          if (!controlAliases[key]) controlAliases[key] = [];
          if (!controlAliases[key].includes(normalizedAlias)) controlAliases[key].push(normalizedAlias);
        };
        const registerControlAliases = (value) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return;
          for (const [alias, mappedValue] of Object.entries(value)) {
            addControlAlias(alias, alias);
            for (const key of collectControlKeys(mappedValue)) {
              addControlAlias(key, alias);
            }
          }
        };
        registerControlAliases(meta.controls);
        addControlAlias('ArrowLeft', 'left');
        addControlAlias('ArrowRight', 'right');
        addControlAlias('ArrowUp', 'jump');
        addControlAlias('Space', 'jump');
        addControlAlias(' ', 'jump');
        const firstArray = (...values) => values.find((value) => Array.isArray(value));
        const authoredUnits = firstArray(meta.levels, meta.segments, meta.scenarios, meta.stages, meta.missions) || [];
        const authoredUnitTargets = authoredUnits.map((unit, index) => {
          if (typeof unit === 'string' || typeof unit === 'number') return unit;
          if (unit && typeof unit === 'object') {
            if (typeof unit.id === 'string' || typeof unit.id === 'number') return unit.id;
            if (typeof unit.key === 'string' || typeof unit.key === 'number') return unit.key;
            if (typeof unit.name === 'string' || typeof unit.name === 'number') return unit.name;
          }
          return index;
        });
        const qualityPlan = meta.qualityPlan || (!Array.isArray(meta.acceptance) && meta.acceptance && typeof meta.acceptance === 'object' ? meta.acceptance : {});
        const subtypeForDispatch = String(meta.subtype || meta.genre || meta.type || '').toLowerCase();
        const breakoutSubtype = /^(breakout|arkanoid)$/.test(subtypeForDispatch);
        // runner 是自动奔跑玩法：空输入代表"松手让角色自己跑"，是合法的 reachability 步骤。
        const runnerSubtype = /^(runner|endless[-_ ]?runner|auto[-_ ]?runner)$/.test(subtypeForDispatch);
        const hasReset = typeof contract.reset === 'function';
        const hasStep = typeof contract.step === 'function';
        const numericCountFrom = (value) => {
          if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value));
          if (Array.isArray(value)) return value.length;
          if (value && typeof value === 'object') {
            const nestedCounts = Object.values(value).map(numericCountFrom).filter((count) => count > 0);
            return nestedCounts.length > 0 ? Math.max(...nestedCounts) : 0;
          }
          return 0;
        };
        const declaredAuthoredCount = Math.max(
          authoredUnits.length,
          numericCountFrom(meta.levelsCovered),
          numericCountFrom(qualityPlan.levelsCovered),
          numericCountFrom(meta.totalLevels),
          numericCountFrom(qualityPlan.totalLevels)
        );
        while (authoredUnitTargets.length < declaredAuthoredCount) {
          authoredUnitTargets.push(authoredUnitTargets.length);
        }
        const listFrom = (value, keyPath = '') => {
          if (!value) return [];
          if (Array.isArray(value)) return value.filter(Boolean).flatMap((item) => listFrom(item, keyPath));
          if (typeof value === 'object') {
            return Object.entries(value).flatMap(([key, childValue]) => {
              const childPath = keyPath ? keyPath + '.' + key : key;
              if (childValue === true) return [childPath];
              if (childValue === false || childValue === null || typeof childValue === 'undefined') return [];
              return listFrom(childValue, childPath);
            });
          }
          if (typeof value === 'boolean') return value ? (keyPath ? [keyPath] : ['true']) : [];
          return [String(value)];
        };
        const isPlainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
        const textFrom = (value) => {
          try {
            return JSON.stringify(value || {}).toLowerCase();
          } catch {
            return String(value || '').toLowerCase();
          }
        };
        const anyTextMatches = (value, patterns) => patterns.some((pattern) => pattern.test(textFrom(value)));
        const isNegativeEvidence = (value) => (
          /(?:^|[\\s:,[({=;-])(?:false|fail|failed|failure|missing|not|none|no)(?:$|[\\s:,\\])}.!;=-])|缺少|失败|未通过|没有|不能|无法/i
            .test(String(value || '').toLowerCase())
        );
        const collectEvidenceStrings = (smoke, coverage) => {
          if (!smoke || smoke.passed !== true) return '';
          return [
            ...listFrom(coverage && coverage.mechanics),
            ...listFrom(coverage && coverage.rewards),
            ...listFrom(coverage && coverage.risks),
            ...listFrom(coverage && coverage.stateChanges),
            ...listFrom(coverage && coverage.gameplayMechanics),
            ...listFrom(coverage && coverage.mechanicsEvidence),
            ...listFrom(smoke && smoke.checks),
            ...listFrom(smoke && smoke.observations),
          ].filter((item) => !isNegativeEvidence(item)).join(' | ').toLowerCase();
        };
        // platformer 等 subtype-specific 的 runtime evidence 检查已经迁移到
        // src/host/agent/runtime/game/<subtype>/<Subtype>Checker.ts，由 TS 侧
        // 根据 page.evaluate 返回的 before/after snapshot + smoke + meta + coverage
        // 派发到对应 checker 上跑。这里的 inline JS 只负责采集运行时证据。
        const executableKeySet = new Set(keyControls);
        const collectActionStrings = (value) => {
          if (typeof value === 'string') return [value];
          if (Array.isArray(value)) return value.flatMap(collectActionStrings);
          if (value && typeof value === 'object') return Object.values(value).flatMap(collectActionStrings);
          return [];
        };
        const parseActionKeys = (action) => {
          const rawCandidates = [];
          if (typeof action.key === 'string') rawCandidates.push(action.key);
          if (typeof action.input === 'string') rawCandidates.push(action.input);
          if (typeof action.control === 'string') rawCandidates.push(action.control);
          if (typeof action.action === 'string') rawCandidates.push(action.action);
          if (typeof action.code === 'string') rawCandidates.push(action.code);
          if (Array.isArray(action.input)) rawCandidates.push(...collectActionStrings(action.input));
          if (Array.isArray(action.keys)) rawCandidates.push(...collectActionStrings(action.keys));
          if (Array.isArray(action.controls)) rawCandidates.push(...collectActionStrings(action.controls));

          const extracted = [];
          for (const candidate of rawCandidates) {
            if (typeof candidate !== 'string') continue;
            const trimmed = candidate.trim();
            if (!trimmed) continue;
            if (executableKeySet.size === 0) {
              if (/^[A-Za-z0-9_+-]+$/.test(trimmed)) extracted.push(trimmed);
              continue;
            }
            if (executableKeySet.has(trimmed)) {
              extracted.push(trimmed);
              continue;
            }
            for (const token of trimmed.split(/[^A-Za-z0-9_+-]+/).filter(Boolean)) {
              if (executableKeySet.has(token)) extracted.push(token);
            }
          }

          return [...new Set(extracted)];
        };
        const isReachabilityStepObject = (step) => (
          step && typeof step === 'object' && !Array.isArray(step)
        );
        const usableReachabilityPlan = (plan) => (
          Array.isArray(plan) && plan.some(isReachabilityStepObject) ? plan : null
        );
        const reachabilityPlan = (
          usableReachabilityPlan(meta.reachability)
            || usableReachabilityPlan(meta.progressPlan)
            || usableReachabilityPlan(meta.smokePlan)
            || usableReachabilityPlan(meta.validation)
            || usableReachabilityPlan(meta.acceptance)
            || []
        );
        const actionFrameCount = (action, fallback = 6) => {
          const rawFrames = typeof action.holdFrames === 'number' ? action.holdFrames
            : typeof action.frames === 'number' ? action.frames
              : typeof action.durationFrames === 'number' ? action.durationFrames
                : typeof action.ticks === 'number' ? action.ticks
                  : fallback;
          return Math.max(1, Math.min(600, Math.floor(Number.isFinite(rawFrames) ? rawFrames : fallback)));
        };
        const driveKeys = async (keys, frames) => {
          const inputState = {};
          for (const key of keys) {
            inputState[key] = true;
            for (const alias of controlAliases[key] || []) inputState[alias] = true;
          }

          if (hasStep) {
            for (let frame = 0; frame < frames; frame++) {
              await Promise.resolve(contract.step(inputState, 1));
            }
            await Promise.resolve(contract.step({}, 1));
            return;
          }

          for (let frame = 0; frame < frames; frame++) {
            for (const key of keys) {
              window.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true }));
            }
            if (hasStep) {
              await Promise.resolve(contract.step(inputState, 1));
            } else {
              await sleep(35);
            }
          }

          for (const key of keys) {
            window.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, bubbles: true }));
          }
          await sleep(80);
        };
        const browserKeyInit = (key) => {
          if (key === 'Space') return { key: ' ', code: 'Space' };
          return { key, code: key };
        };
        const dispatchBrowserKey = (type, key) => {
          const init = browserKeyInit(key);
          const targets = [document.activeElement, document, window].filter(Boolean);
          for (const target of targets) {
            try {
              target.dispatchEvent(new KeyboardEvent(type, {
                key: init.key,
                code: init.code,
                bubbles: true,
                cancelable: true,
              }));
            } catch {
              // Continue dispatching to the remaining targets.
            }
          }
        };
        const driveBrowserKeyboard = async (keys, frames) => {
          for (const key of keys) dispatchBrowserKey('keydown', key);
          await sleep(Math.max(80, Math.min(1200, frames * 20)));
          for (const key of keys) dispatchBrowserKey('keyup', key);
          await sleep(80);
        };
        const readMetric = (snapshot, key) => {
          if (!snapshot || typeof snapshot !== 'object') return undefined;
          return String(key).replace(/\\[(\\d+)\\]/g, '.$1').split('.').reduce((current, part) => {
            if (!current || typeof current !== 'object') return undefined;
            return current[part];
          }, snapshot);
        };
        const compareMetric = (beforeValue, afterValue, expectation) => {
          if (expectation === 'increase') return typeof beforeValue === 'number' && typeof afterValue === 'number' && afterValue > beforeValue;
          if (expectation === 'decrease') return typeof beforeValue === 'number' && typeof afterValue === 'number' && afterValue < beforeValue;
          if (expectation === 'change') return JSON.stringify(beforeValue) !== JSON.stringify(afterValue);
          if (expectation === 'truthy') return Boolean(afterValue);
          if (typeof expectation === 'boolean' || typeof expectation === 'number') return afterValue === expectation;
          if (typeof expectation === 'string') {
            const trimmed = expectation.trim();
            if (!trimmed) return JSON.stringify(beforeValue) !== JSON.stringify(afterValue);
            if (trimmed === 'true') return afterValue === true;
            if (trimmed === 'false') return afterValue === false;
            if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return typeof afterValue === 'number' && afterValue === Number(trimmed);
            return afterValue === trimmed;
          }
          return JSON.stringify(beforeValue) !== JSON.stringify(afterValue);
        };

        const labelForUnit = (unitIndex, unitTarget) => {
          if (declaredAuthoredCount <= 1) return 'default start state';
          return 'authored unit ' + String(unitTarget ?? unitIndex);
        };
        const normalizeTargetToken = (value) => String(value ?? '').trim().toLowerCase();
        const collectStepTargets = (step) => {
          if (!step || typeof step !== 'object') return [];
          return [
            step.level,
            step.levelId,
            step.levelKey,
            step.levelName,
            step.scenario,
            step.scenarioId,
            step.scenarioKey,
            step.stage,
            step.stageId,
            step.mission,
            step.missionId,
            step.unit,
            step.unitId,
            step.target,
          ].filter((value) => typeof value === 'string' || typeof value === 'number');
        };
        const reachabilityStepAppliesToUnit = (step, unitIndex, unitTarget) => {
          const targets = collectStepTargets(step);
          if (targets.length === 0) return true;
          const unitTokens = [
            normalizeTargetToken(unitTarget),
            normalizeTargetToken(unitIndex),
            normalizeTargetToken(unitIndex + 1),
          ].filter(Boolean);
          return targets.some((target) => unitTokens.includes(normalizeTargetToken(target)));
        };
        const reachabilityMetricFailures = [];
        const resetToUnit = async (unitIndex, unitTarget) => {
          if (hasReset) {
            try {
              await Promise.resolve(contract.reset(unitTarget));
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              throw new Error(
                'reset(levelOrScenario) failed for authored unit ' +
                JSON.stringify(unitTarget ?? unitIndex) +
                ' at index ' + unitIndex +
                ': ' + message +
                '. reset() must accept every id/key/name declared in __GAME_META__ authored units, or metadata must use numeric ids/indexes that reset() supports.'
              );
            }
            return true;
          }
          await Promise.resolve(contract.start());
          return false;
        };
        const timeout = new Promise((resolve) => {
          window.setTimeout(() => {
            resolve({ passed: false, failures: ['runSmokeTest 超过 ' + innerTimeoutMs + 'ms 仍未返回。'] });
          }, innerTimeoutMs);
        });

        let breakoutInitialLoadProbe = null;
        try {
          if (breakoutSubtype) {
            try {
              const before = await Promise.resolve(contract.snapshot());
              await driveBrowserKeyboard(['Space'], 18);
              const after = await Promise.resolve(contract.snapshot());
              breakoutInitialLoadProbe = { name: 'browserLaunchFromInitialLoad', before, after };
            } catch (error) {
              breakoutInitialLoadProbe = {
                name: 'browserLaunchFromInitialLoad',
                error: error instanceof Error ? error.message : String(error),
              };
            }
          }
          await Promise.resolve(contract.start());
          if (hasStep) {
            checks.push('interactive contract exposes step(inputState, frames)');
          }
          if (hasReset) {
            checks.push('interactive contract exposes reset(levelOrScenario)');
          }
          const tryInputProbe = async (keys) => {
            const before = await Promise.resolve(contract.snapshot());
            await driveKeys(keys, 8);
            const after = await Promise.resolve(contract.snapshot());
            return {
              changed: JSON.stringify(before) !== JSON.stringify(after),
              before,
              after,
            };
          };
          const runReachabilityChecks = async (unitIndex, unitTarget) => {
            const unitLabel = labelForUnit(unitIndex, unitTarget);
            let unitPassed = true;
            const planForUnit = reachabilityPlan.filter((step) => (
              reachabilityStepAppliesToUnit(step, unitIndex, unitTarget)
            ));

            if (keyControls.length > 0) {
              let inputChangedState = false;
              const actionCandidates = [];
              for (const step of planForUnit) {
                const keys = parseActionKeys(step);
                if (keys.length > 0) actionCandidates.push(keys);
              }
              for (const key of keyControls) {
                actionCandidates.push([key]);
              }

              for (const keys of actionCandidates) {
                await resetToUnit(unitIndex, unitTarget);
                const probe = await tryInputProbe(keys);
                if (probe.changed) {
                  checks.push('snapshot changed after declared controls for ' + unitLabel + ': ' + keys.join('+'));
                  inputChangedState = true;
                  break;
                }
              }

              if (!inputChangedState) {
                failures.push(unitLabel + ' 的声明输入执行后 snapshot 没有变化，无法证明主对象可操作。');
                unitPassed = false;
              }
            } else {
              failures.push('元数据 controls 没有暴露可派发的输入值。');
              unitPassed = false;
            }

            await resetToUnit(unitIndex, unitTarget);
            if (planForUnit.length === 0) {
              failures.push('元数据没有暴露可执行的 reachability/progressPlan/smokePlan/validation 数组，无法验证目标或场景是否可推进；字符串数组 acceptance 只算质量清单，不算可执行验收计划。');
              return false;
            }

            for (const [index, step] of planForUnit.entries()) {
              const keysToPress = parseActionKeys(step);
              const metric = typeof step.metric === 'string' && step.metric.trim() ? step.metric.trim() : 'progress';
              const expectation = Object.prototype.hasOwnProperty.call(step, 'expect')
                ? (typeof step.expect === 'string' ? (step.expect.trim() || 'increase') : step.expect)
                : 'increase';
              const holdFrames = actionFrameCount(step);

              if (keysToPress.length === 0 && !runnerSubtype) {
                failures.push('reachability step ' + (index + 1) + ' 缺少可执行输入。请使用 controls 里真实可派发的键值，例如 ArrowRight、Space 或 ["ArrowRight","Space"]。');
                unitPassed = false;
                continue;
              }
              if (keysToPress.length === 0 && runnerSubtype) {
                checks.push('runner auto-run reachability step ' + (index + 1) + ' advances frames with empty input');
              }

              const beforeStep = await Promise.resolve(contract.snapshot());
              const beforeMetric = readMetric(beforeStep, metric);
              if (typeof beforeMetric === 'undefined') {
                failures.push('reachability step ' + (index + 1) + ' 的 metric "' + metric + '" 不在 snapshot() 结果里。请改成 snapshot 里真实存在的字段路径。');
                unitPassed = false;
                continue;
              }
              await driveKeys(keysToPress, holdFrames);
              const afterStep = await Promise.resolve(contract.snapshot());
              const afterMetric = readMetric(afterStep, metric);
              if (compareMetric(beforeMetric, afterMetric, expectation)) {
                checks.push(unitLabel + ' passed reachability step ' + (index + 1) + ' for ' + metric);
              } else {
                reachabilityMetricFailures.push({
                  message: unitLabel + ' 的 reachability step ' + (index + 1) + ' 没有让 ' + metric + ' 满足 ' + expectation + '。',
                  unitLabel,
                  stepIndex: index + 1,
                  metric,
                  expectation,
                  input: keysToPress.join('+'),
                  frames: holdFrames,
                  beforeMetric,
                  afterMetric,
                });
                unitPassed = false;
              }
            }

            return unitPassed;
          };

          let authoredUnitsExercised = declaredAuthoredCount <= 1;
          if (breakoutSubtype && declaredAuthoredCount > 1) {
            await runReachabilityChecks(0, 'default');
            authoredUnitsExercised = false;
          } else if (declaredAuthoredCount > 1 && hasReset) {
            authoredUnitsExercised = true;
            for (let index = 0; index < authoredUnitTargets.length; index++) {
              const unitPassed = await runReachabilityChecks(index, authoredUnitTargets[index]);
              authoredUnitsExercised = authoredUnitsExercised && unitPassed;
            }
          } else {
            const defaultPathPassed = await runReachabilityChecks(0, authoredUnitTargets[0]);
            authoredUnitsExercised = declaredAuthoredCount <= 1 ? defaultPathPassed : false;
          }

          for (const helperName of ['start', 'reset', 'snapshot', 'step']) {
            if (typeof root[helperName] !== 'function' && typeof contract[helperName] === 'function') {
              root[helperName] = (...args) => contract[helperName](...args);
            }
          }

          const beforeSmokeSnapshot = await Promise.resolve(contract.snapshot());
          const smokeResult = await Promise.race([
            Promise.resolve(contract.runSmokeTest({ timeoutMs: innerTimeoutMs })),
            timeout,
          ]);
          const afterSmokeSnapshot = await Promise.resolve(contract.snapshot());
          const smoke = smokeResult && typeof smokeResult === 'object'
            ? smokeResult
            : { passed: false, failures: ['runSmokeTest 没有返回结构化结果。'] };
          if (smoke.passed === true && !Array.isArray(smoke.checks)) {
            failures.push('runSmokeTest.checks 必须是字符串数组，不能返回数字、布尔值或对象计数。');
          }
          if (smoke.passed === true && !Array.isArray(smoke.failures)) {
            failures.push('runSmokeTest.failures 必须是字符串数组；通过时请返回空数组。');
          }
          if (Array.isArray(smoke.checks)) checks.push(...smoke.checks.map(String));
          if (Array.isArray(smoke.observations)) checks.push(...smoke.observations.map(String));
          if (Array.isArray(smoke.failures)) failures.push(...smoke.failures.map(String));
          const coverage = smoke.coverage && typeof smoke.coverage === 'object' ? smoke.coverage : null;
          let stateChangesCovered = [];
          let coverageProvedAuthoredUnits = false;
          if (!coverage) {
            failures.push('runSmokeTest 缺少 coverage，无法证明玩法、奖励/风险或关卡覆盖。');
          } else {
            const coverageValueNamesEvidence = (fieldName, value) => {
              if (typeof value === 'undefined' || value === null) return;
              if (Array.isArray(value) || isPlainObject(value)) return;
              failures.push(
                'runSmokeTest coverage.' + fieldName +
                ' 必须列出已验证的机制名称或布尔证据对象，不能只返回数字、布尔值或 total 计数。'
              );
            };
            coverageValueNamesEvidence('mechanics', coverage.mechanics);
            coverageValueNamesEvidence('rewards', coverage.rewards);
            coverageValueNamesEvidence('risks', coverage.risks);
            coverageValueNamesEvidence('stateChanges', coverage.stateChanges);

            const mechanicsPromised = listFrom(qualityPlan.mechanics || meta.requiredMechanics || meta.mechanics);
            const rewardsPromised = listFrom(qualityPlan.rewards || meta.rewards || meta.powerUps || meta.collectibles);
            const risksPromised = listFrom(qualityPlan.risks || meta.risks || meta.hazards || meta.enemies);
            const mechanicsCovered = listFrom(coverage.mechanics);
            const rewardsCovered = listFrom(coverage.rewards);
            const risksCovered = listFrom(coverage.risks);
            stateChangesCovered = listFrom(coverage.stateChanges);

            if (declaredAuthoredCount > 1) {
              const levelCount = typeof coverage.levelsPassed === 'number'
                ? coverage.levelsPassed
                : Array.isArray(coverage.levelsPassed) ? coverage.levelsPassed.length : 0;
              const totalLevels = typeof coverage.totalLevels === 'number' ? coverage.totalLevels : declaredAuthoredCount;
              if (authoredUnitsExercised) {
                checks.push('reset/step path exercised authored units: ' + authoredUnitTargets.map((target) => String(target)).join(', '));
                coverageProvedAuthoredUnits = true;
              } else if (coverage.allLevelsReachable !== true || totalLevels < declaredAuthoredCount || levelCount < declaredAuthoredCount) {
                const resetHint = hasReset
                  ? ''
                  : ' 请补一个可调用的 reset(levelId/index)，让工程层逐关重置并驱动验证。';
                failures.push('coverage 没有证明所有 authored levels/scenarios 都可推进通关；declared=' + declaredAuthoredCount + ', passed=' + levelCount + ', total=' + totalLevels + '。' + resetHint);
              } else {
                checks.push('coverage proved all authored levels reachable');
                coverageProvedAuthoredUnits = true;
              }
            }

            if (mechanicsPromised.length > 0 && mechanicsCovered.length === 0) {
              failures.push('coverage 没有覆盖 qualityPlan 承诺的核心玩法。');
            } else if (mechanicsCovered.length > 0) {
              checks.push('coverage included mechanics: ' + mechanicsCovered.join(', '));
            }

            if (rewardsPromised.length > 0 && rewardsCovered.length === 0) {
              failures.push('coverage 没有覆盖 qualityPlan 承诺的奖励、增强或收集物。');
            } else if (rewardsCovered.length > 0) {
              checks.push('coverage included rewards: ' + rewardsCovered.join(', '));
            }

            if (risksPromised.length > 0 && risksCovered.length === 0) {
              failures.push('coverage 没有覆盖 qualityPlan 承诺的风险、敌人或失败约束。');
            } else if (risksCovered.length > 0) {
              checks.push('coverage included risks: ' + risksCovered.join(', '));
            }

            if (stateChangesCovered.length > 0) {
              checks.push('coverage included state changes: ' + stateChangesCovered.join(', '));
            }

          }
          // subtype 透传到 TS 侧，由 GameSubtypeChecker.validateRuntimeEvidence 接管 subtype-specific 证据校验
          const breakoutScenarios = breakoutInitialLoadProbe ? [breakoutInitialLoadProbe] : [];
          const runSubtypeScenarioProbe = async (name, options = {}) => {
            const frames = actionFrameCount(options, 12);
            const inputState = options.inputState && typeof options.inputState === 'object' ? options.inputState : {};
            const keys = Array.isArray(options.keys) ? options.keys.filter((key) => typeof key === 'string' && key.trim()) : [];
            try {
              if (options.startOnly === true) {
                // Keep the freshly loaded page state intact. Calling start() or reset()
                // can hide a broken real start screen where Space only works after the
                // test contract mutates the game into "playing".
              } else if (hasReset) {
                await Promise.resolve(contract.reset(name));
              } else {
                await Promise.resolve(contract.start());
              }
              const before = await Promise.resolve(contract.snapshot());
              if (keys.length > 0 && options.browserKeyboard === true) {
                await driveBrowserKeyboard(keys, frames);
              } else if (keys.length > 0) {
                await driveKeys(keys, frames);
              } else if (hasStep) {
                await Promise.resolve(contract.step(inputState, frames));
              } else {
                await sleep(Math.min(800, Math.max(35, frames * 16)));
              }
              const after = await Promise.resolve(contract.snapshot());
              return { name, before, after };
            } catch (error) {
              return { name, error: error instanceof Error ? error.message : String(error) };
            }
          };
          if (breakoutSubtype) {
            const breakoutScenarioSpecs = [
              { name: 'browserLaunchFromStart', keys: ['Space'], browserKeyboard: true, startOnly: true, frames: 18 },
              { name: 'paddleMove', keys: ['ArrowRight'], frames: 12 },
              { name: 'launch', keys: ['Space'], inputState: { Space: true, launch: true }, browserKeyboard: true, frames: 12 },
              { name: 'wallBounce', frames: 20 },
              { name: 'paddleBounce', frames: 20 },
              { name: 'brickHit', frames: 30 },
              { name: 'powerup:wide', frames: 20 },
              { name: 'powerup:multi', frames: 20 },
              { name: 'powerup:slow', frames: 20 },
              { name: 'powerup:through', frames: 20 },
              { name: 'powerup:life', frames: 20 },
              { name: 'win', frames: 6 },
              { name: 'lose', frames: 6 },
            ];
            for (const scenario of breakoutScenarioSpecs) {
              breakoutScenarios.push(await runSubtypeScenarioProbe(scenario.name, scenario));
            }
          }
          const metricCoveredBySmoke = (metric) => {
            const normalized = String(metric || '').trim().toLowerCase();
            if (!normalized) return false;
            const rootMetric = normalized.split('.')[0];
            const smokeEvidence = textFrom({
              coverage,
              checks: Array.isArray(smoke.checks) ? smoke.checks : [],
              observations: Array.isArray(smoke.observations) ? smoke.observations : [],
            });
            if (
              (rootMetric === 'status' || rootMetric === 'state' || rootMetric === 'mode') &&
              /\\b(?:status|state|mode|win|won|complete|completed|lose|lost|gameover|game over)\\b/i.test(smokeEvidence)
            ) {
              return true;
            }
            return stateChangesCovered.some((entry) => {
              const covered = String(entry || '').trim().toLowerCase();
              if (!covered) return false;
              if (covered === normalized || covered === rootMetric) return true;
              if (normalized.startsWith(covered + '.') || covered.startsWith(normalized + '.')) return true;
              if (rootMetric === 'level' && (covered === 'levels' || covered === 'level_progression' || covered === 'progression')) return true;
              if (rootMetric === 'mode' && (covered === 'state' || covered === 'status')) return true;
              if (rootMetric === 'abilities' && (covered === 'ability' || covered === 'powerups' || covered === 'power-ups' || covered === 'power_ups')) return true;
              return false;
            });
          };
          for (const failure of reachabilityMetricFailures) {
            if (smoke.passed === true && metricCoveredBySmoke(failure.metric) && (declaredAuthoredCount <= 1 || coverageProvedAuthoredUnits)) {
              checks.push('runSmokeTest coverage covered reachability metric ' + failure.metric + ' after external probe missed long-path input for ' + failure.unitLabel);
              continue;
            }
            failures.push(
              failure.message +
              ' input=' + failure.input +
              ', frames=' + failure.frames +
              ', before=' + JSON.stringify(failure.beforeMetric) +
              ', after=' + JSON.stringify(failure.afterMetric) +
              '。如果这是长链路目标，请让 runSmokeTest 真正驱动该链路，并在 coverage.stateChanges 中包含 ' + failure.metric + '。'
            );
          }
          if (smoke.passed !== true) failures.push('runSmokeTest 未通过。');
          return {
            passed: failures.length === 0,
            checks,
            failures,
            // 透传 subtype-specific 证据所需的原始数据。TS 侧的 GameSubtypeChecker
            // 会在这之上做 subtype-aware 验证（platformer 的 stomp/bump/combo 等）。
            subtypeDispatch: {
              subtype: subtypeForDispatch,
              meta,
              coverage,
              observations: {
                smoke: Array.isArray(smoke.observations) ? smoke.observations : [],
                breakoutScenarios,
              },
              beforeSmokeSnapshot,
              afterSmokeSnapshot,
              smokePassed: smoke.passed === true,
            },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/reset\\(levelOrScenario\\) failed for authored unit/i.test(message)) {
            return {
              passed: false,
              failures: [message],
            };
          }
          return {
            passed: false,
            failures: ['runSmokeTest 抛出异常: ' + message],
          };
        }
      })()
    `;
    const rawResult = await page.evaluate(runtimeProbeScript);

    const smoke = normalizeRuntimeSmokeResult(rawResult);

    // 把原 inline JS 里的 subtype-specific 证据校验改为 TS 侧 dispatch：
    // 拿到 beforeSnap / afterSnap / meta / coverage / observations 后，
    // 让 GameSubtypeRegistry 里注册的 checker 来跑 platformer/runner 等专属断言。
    const dispatchPayload = (rawResult as { subtypeDispatch?: SubtypeDispatchPayload } | null)
      ?.subtypeDispatch;
    if (dispatchPayload?.subtype) {
      const checker = gameSubtypeRegistry.get(dispatchPayload.subtype);
      if (checker) {
        const evidence = checker.validateRuntimeEvidence(
          (dispatchPayload.beforeSmokeSnapshot ?? {}) as Record<string, unknown>,
          (dispatchPayload.afterSmokeSnapshot ?? {}) as Record<string, unknown>,
          {
            attempted: true,
            passed: dispatchPayload.smokePassed,
            checks: smoke.checks,
            failures: smoke.failures,
          },
          {
            artifactRef: filePath,
            strict: false,
            metadata: {
              meta: dispatchPayload.meta,
              coverage: dispatchPayload.coverage,
              observations: dispatchPayload.observations,
            },
          },
        );
        if (evidence.passed) {
          if (/^(breakout|arkanoid)$/.test(dispatchPayload.subtype) && smoke.failures.length > 0) {
            const supersededFailures = smoke.failures.length;
            smoke.failures = [];
            smoke.passed = true;
            smoke.checks.push(
              `breakout subtype runtime evidence superseded ${supersededFailures} generic author-smoke failure(s)`,
            );
          }
          smoke.checks.push(...evidence.checks);
        } else {
          smoke.failures.push(...evidence.failures);
          if (smoke.passed) {
            smoke.passed = false;
          }
        }
      }
    }

    if (smoke.passed) {
      smoke.checks.unshift('runtime smoke passed via interactive test contract');
    }
    smoke.checks.unshift(...launchChecks);
    return smoke;
  } catch (error) {
    return {
      attempted: true,
      passed: false,
      failures: [`无法运行交互 smoke 验收: ${error instanceof Error ? error.message : String(error)}`],
      checks: [],
    };
  } finally {
    await session?.close().catch(() => undefined);
  }
}
