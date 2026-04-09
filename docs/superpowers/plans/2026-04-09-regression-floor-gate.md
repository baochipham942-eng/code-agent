# Regression Floor Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 Self-Evolving 闭环加一道自动化回归地板 —— 任何规则/Skill 变更必须跑过 regression-cases 测试集，通过率下降 >5% 时 `/synthesize` 自动拦截提案。

**Architecture:** 现有 `~/.claude/regression-cases/` 有 3 个 case 和 markdown 格式约定，但没有运行器、没有 baseline、没有接入 synthesize。本计划补齐 runner + baseline + 硬门禁三件事，扩充到 10 个 case。

**Tech Stack:** TypeScript + vitest v4（CA 项目）+ Bash（synthesize skill）

---

## File Structure

**Create:**
- `src/main/evaluation/regression/regressionRunner.ts` — 主 runner，读取 cases 跑 eval_command 输出 scorecard
- `src/main/evaluation/regression/regressionTypes.ts` — 类型定义
- `src/main/evaluation/regression/caseLoader.ts` — 读取 markdown case 文件，解析 frontmatter 和 eval_command
- `src/main/evaluation/regression/baselineStore.ts` — baseline 读写
- `src/main/evaluation/regression/index.ts` — 公开接口
- `src/main/evaluation/regression/__tests__/caseLoader.test.ts`
- `src/main/evaluation/regression/__tests__/regressionRunner.test.ts`
- `src/main/evaluation/regression/__tests__/baselineStore.test.ts`
- `src/cli/regression-cli.ts` — CLI 入口，供 synthesize skill 调用
- `~/.claude/regression-cases/baseline.json` — 当前 baseline 分数
- `~/.claude/regression-cases/reg-004` ~ `reg-010` — 7 个新 case（从 debugging.md 提取）

**Modify:**
- `~/.claude/regression-cases/README.md` — 更新格式说明，加 eval_command 字段规范
- `~/.claude/regression-cases/reg-001-process-undefined.md` — 补充 eval_command 字段
- `~/.claude/regression-cases/reg-002-binary-file-read.md` — 补充 eval_command 字段
- `~/.claude/regression-cases/reg-003-tool-call-pairing.md` — 补充 eval_command 字段
- `~/.claude/skills/synthesize/SKILL.md` — 在 Step 3 后插入 "Step 3.5: Regression Gate"
- `package.json` — 新增 `regression` script

---

## Case 格式约定

每个回归 case 的 frontmatter 新增 `eval_command` 字段（必填），返回 exit code 0 = pass，1 = fail。stdout 可选输出细节用于报告。

```yaml
---
id: reg-001
source: debugging.md (2026-02-09)
tags: [electron, process, shared-code]
related_rules: [L2-005]
eval_command: "! grep -rn 'process\\.' src/shared/ | grep -v 'typeof process' | grep -v '\\.test\\.'"
---
```

`!` 前缀表示"期望无输出"（grep 找到匹配即 fail）。

---

## Task 1: 类型定义 + Case Loader

**Files:**
- Create: `src/main/evaluation/regression/regressionTypes.ts`
- Create: `src/main/evaluation/regression/caseLoader.ts`
- Create: `src/main/evaluation/regression/__tests__/caseLoader.test.ts`

- [ ] **Step 1: 写 types 文件**

```typescript
// src/main/evaluation/regression/regressionTypes.ts
export interface RegressionCase {
  id: string
  filePath: string
  source: string
  tags: string[]
  relatedRules: string[]
  evalCommand: string
  scenario: string       // 从 ## 场景 section 提取
  expectedBehavior: string // 从 ## 预期行为 section 提取
}

export interface CaseResult {
  id: string
  status: 'pass' | 'fail' | 'error'
  durationMs: number
  stdout: string
  stderr: string
  exitCode: number
  errorMessage?: string
}

export interface RegressionReport {
  runId: string
  timestamp: string
  totalCases: number
  passed: number
  failed: number
  errored: number
  passRate: number
  results: CaseResult[]
  durationMs: number
}

export interface Baseline {
  passRate: number
  passed: number
  totalCases: number
  capturedAt: string
  commit?: string
}

export interface GateDecision {
  decision: 'pass' | 'block'
  currentPassRate: number
  baselinePassRate: number
  delta: number          // current - baseline
  blockedCases: string[] // 新增失败的 case id
  reason: string
}
```

- [ ] **Step 2: 写 caseLoader 的失败测试**

```typescript
// src/main/evaluation/regression/__tests__/caseLoader.test.ts
import { describe, it, expect } from 'vitest'
import { loadCase, loadAllCases } from '../caseLoader'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs/promises'

describe('caseLoader', () => {
  it('parses a well-formed case file', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reg-test-'))
    const file = path.join(tmpDir, 'reg-sample.md')
    await fs.writeFile(file, `---
id: reg-sample
source: test
tags: [foo, bar]
related_rules: [L2-001]
eval_command: "true"
---

## 场景
Sample scenario description

## 预期行为
Expected behavior description
`)

    const loaded = await loadCase(file)
    expect(loaded.id).toBe('reg-sample')
    expect(loaded.tags).toEqual(['foo', 'bar'])
    expect(loaded.relatedRules).toEqual(['L2-001'])
    expect(loaded.evalCommand).toBe('true')
    expect(loaded.scenario).toContain('Sample scenario')
    expect(loaded.expectedBehavior).toContain('Expected behavior')

    await fs.rm(tmpDir, { recursive: true })
  })

  it('throws on missing eval_command', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reg-test-'))
    const file = path.join(tmpDir, 'reg-bad.md')
    await fs.writeFile(file, `---
id: reg-bad
source: test
tags: []
---
## 场景
x
`)
    await expect(loadCase(file)).rejects.toThrow(/eval_command/)
    await fs.rm(tmpDir, { recursive: true })
  })

  it('loads all cases from a directory', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reg-test-'))
    for (const id of ['reg-001', 'reg-002']) {
      await fs.writeFile(path.join(tmpDir, `${id}.md`), `---
id: ${id}
source: test
tags: []
eval_command: "true"
---
## 场景
x
## 预期行为
y
`)
    }
    // Non-case file should be ignored
    await fs.writeFile(path.join(tmpDir, 'README.md'), '# readme')

    const cases = await loadAllCases(tmpDir)
    expect(cases).toHaveLength(2)
    expect(cases.map(c => c.id).sort()).toEqual(['reg-001', 'reg-002'])
    await fs.rm(tmpDir, { recursive: true })
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd ~/Downloads/ai/code-agent && npx vitest run src/main/evaluation/regression/__tests__/caseLoader.test.ts`
Expected: FAIL — `Cannot find module '../caseLoader'`

- [ ] **Step 4: 实现 caseLoader**

```typescript
// src/main/evaluation/regression/caseLoader.ts
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { RegressionCase } from './regressionTypes'

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/

export async function loadCase(filePath: string): Promise<RegressionCase> {
  const raw = await fs.readFile(filePath, 'utf8')
  const match = FRONTMATTER_RE.exec(raw)
  if (!match) {
    throw new Error(`Case ${filePath} is missing YAML frontmatter`)
  }
  const [, fmText, body] = match
  const fm = parseFrontmatter(fmText)

  if (!fm.eval_command) {
    throw new Error(`Case ${filePath} is missing required field: eval_command`)
  }

  return {
    id: String(fm.id ?? path.basename(filePath, '.md')),
    filePath,
    source: String(fm.source ?? ''),
    tags: toStringArray(fm.tags),
    relatedRules: toStringArray(fm.related_rules),
    evalCommand: String(fm.eval_command),
    scenario: extractSection(body, '场景'),
    expectedBehavior: extractSection(body, '预期行为'),
  }
}

export async function loadAllCases(dir: string): Promise<RegressionCase[]> {
  const entries = await fs.readdir(dir)
  const caseFiles = entries
    .filter(f => f.startsWith('reg-') && f.endsWith('.md'))
    .map(f => path.join(dir, f))
  const cases = await Promise.all(caseFiles.map(loadCase))
  return cases.sort((a, b) => a.id.localeCompare(b.id))
}

function parseFrontmatter(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const line of text.split('\n')) {
    const m = /^(\w+):\s*(.*)$/.exec(line)
    if (!m) continue
    const [, key, rawVal] = m
    out[key] = parseValue(rawVal.trim())
  }
  return out
}

function parseValue(raw: string): unknown {
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim()
    if (!inner) return []
    return inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, ''))
  }
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1)
  }
  return raw
}

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String)
  if (typeof v === 'string' && v) return [v]
  return []
}

function extractSection(body: string, heading: string): string {
  const re = new RegExp(`##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`)
  const m = re.exec(body)
  return m ? m[1].trim() : ''
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd ~/Downloads/ai/code-agent && npx vitest run src/main/evaluation/regression/__tests__/caseLoader.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
cd ~/Downloads/ai/code-agent
git add src/main/evaluation/regression/regressionTypes.ts src/main/evaluation/regression/caseLoader.ts src/main/evaluation/regression/__tests__/caseLoader.test.ts
git commit -m "feat(regression): add case loader and types"
```

---

## Task 2: Baseline Store

**Files:**
- Create: `src/main/evaluation/regression/baselineStore.ts`
- Create: `src/main/evaluation/regression/__tests__/baselineStore.test.ts`

- [ ] **Step 1: 写 baseline store 的失败测试**

```typescript
// src/main/evaluation/regression/__tests__/baselineStore.test.ts
import { describe, it, expect } from 'vitest'
import { readBaseline, writeBaseline } from '../baselineStore'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs/promises'

describe('baselineStore', () => {
  it('returns null when baseline file does not exist', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reg-baseline-'))
    const file = path.join(tmpDir, 'baseline.json')
    const baseline = await readBaseline(file)
    expect(baseline).toBeNull()
    await fs.rm(tmpDir, { recursive: true })
  })

  it('round-trips a baseline', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reg-baseline-'))
    const file = path.join(tmpDir, 'baseline.json')
    const baseline = {
      passRate: 0.9,
      passed: 9,
      totalCases: 10,
      capturedAt: '2026-04-09T00:00:00Z',
      commit: 'abc123',
    }
    await writeBaseline(file, baseline)
    const loaded = await readBaseline(file)
    expect(loaded).toEqual(baseline)
    await fs.rm(tmpDir, { recursive: true })
  })

  it('throws on corrupt baseline file', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reg-baseline-'))
    const file = path.join(tmpDir, 'baseline.json')
    await fs.writeFile(file, 'not valid json')
    await expect(readBaseline(file)).rejects.toThrow()
    await fs.rm(tmpDir, { recursive: true })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/main/evaluation/regression/__tests__/baselineStore.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 baselineStore**

```typescript
// src/main/evaluation/regression/baselineStore.ts
import * as fs from 'node:fs/promises'
import type { Baseline } from './regressionTypes'

export async function readBaseline(filePath: string): Promise<Baseline | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return JSON.parse(raw) as Baseline
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw err
  }
}

export async function writeBaseline(filePath: string, baseline: Baseline): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(baseline, null, 2) + '\n', 'utf8')
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/main/evaluation/regression/__tests__/baselineStore.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/evaluation/regression/baselineStore.ts src/main/evaluation/regression/__tests__/baselineStore.test.ts
git commit -m "feat(regression): add baseline store"
```

---

## Task 3: Regression Runner 核心

**Files:**
- Create: `src/main/evaluation/regression/regressionRunner.ts`
- Create: `src/main/evaluation/regression/__tests__/regressionRunner.test.ts`

- [ ] **Step 1: 写 runner 的失败测试**

```typescript
// src/main/evaluation/regression/__tests__/regressionRunner.test.ts
import { describe, it, expect } from 'vitest'
import { runRegression, decideGate } from '../regressionRunner'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs/promises'

async function makeCaseDir(cases: Array<{ id: string; evalCommand: string }>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reg-runner-'))
  for (const c of cases) {
    await fs.writeFile(path.join(dir, `${c.id}.md`), `---
id: ${c.id}
source: test
tags: []
eval_command: "${c.evalCommand}"
---
## 场景
x
## 预期行为
y
`)
  }
  return dir
}

describe('regressionRunner', () => {
  it('runs all cases and reports pass/fail', async () => {
    const dir = await makeCaseDir([
      { id: 'reg-a', evalCommand: 'true' },
      { id: 'reg-b', evalCommand: 'false' },
      { id: 'reg-c', evalCommand: 'true' },
    ])

    const report = await runRegression(dir)
    expect(report.totalCases).toBe(3)
    expect(report.passed).toBe(2)
    expect(report.failed).toBe(1)
    expect(report.passRate).toBeCloseTo(2 / 3, 2)

    const failed = report.results.find(r => r.id === 'reg-b')
    expect(failed?.status).toBe('fail')

    await fs.rm(dir, { recursive: true })
  })

  it('marks case as error when command times out', async () => {
    const dir = await makeCaseDir([
      { id: 'reg-slow', evalCommand: 'sleep 5' },
    ])
    const report = await runRegression(dir, { timeoutMs: 200 })
    expect(report.results[0].status).toBe('error')
    expect(report.results[0].errorMessage).toMatch(/timeout/i)
    await fs.rm(dir, { recursive: true })
  })

  it('decideGate blocks when pass rate drops more than threshold', () => {
    const decision = decideGate({
      current: { passRate: 0.8, passed: 8, totalCases: 10, results: [
        { id: 'reg-a', status: 'pass' },
        { id: 'reg-b', status: 'fail' },
      ] as any },
      baseline: { passRate: 0.9, passed: 9, totalCases: 10, capturedAt: '', },
      thresholdPct: 5,
    })
    expect(decision.decision).toBe('block')
    expect(decision.delta).toBeCloseTo(-0.1, 2)
    expect(decision.blockedCases).toContain('reg-b')
  })

  it('decideGate passes when no baseline exists yet', () => {
    const decision = decideGate({
      current: { passRate: 0.5, passed: 5, totalCases: 10, results: [] as any },
      baseline: null,
      thresholdPct: 5,
    })
    expect(decision.decision).toBe('pass')
    expect(decision.reason).toMatch(/no baseline/i)
  })

  it('decideGate passes when improvement exceeds threshold', () => {
    const decision = decideGate({
      current: { passRate: 0.95, passed: 19, totalCases: 20, results: [] as any },
      baseline: { passRate: 0.85, passed: 17, totalCases: 20, capturedAt: '' },
      thresholdPct: 5,
    })
    expect(decision.decision).toBe('pass')
    expect(decision.delta).toBeCloseTo(0.1, 2)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/main/evaluation/regression/__tests__/regressionRunner.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 regressionRunner**

```typescript
// src/main/evaluation/regression/regressionRunner.ts
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { loadAllCases } from './caseLoader'
import type {
  CaseResult,
  RegressionCase,
  RegressionReport,
  Baseline,
  GateDecision,
} from './regressionTypes'

interface RunOptions {
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 10_000

export async function runRegression(
  casesDir: string,
  opts: RunOptions = {},
): Promise<RegressionReport> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const cases = await loadAllCases(casesDir)
  const startedAt = Date.now()

  const results: CaseResult[] = []
  for (const c of cases) {
    results.push(await runOne(c, timeoutMs))
  }

  const passed = results.filter(r => r.status === 'pass').length
  const failed = results.filter(r => r.status === 'fail').length
  const errored = results.filter(r => r.status === 'error').length

  return {
    runId: randomUUID(),
    timestamp: new Date().toISOString(),
    totalCases: cases.length,
    passed,
    failed,
    errored,
    passRate: cases.length === 0 ? 0 : passed / cases.length,
    results,
    durationMs: Date.now() - startedAt,
  }
}

async function runOne(c: RegressionCase, timeoutMs: number): Promise<CaseResult> {
  const startedAt = Date.now()
  return new Promise<CaseResult>(resolve => {
    const child = execFile(
      'bash',
      ['-c', c.evalCommand],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const durationMs = Date.now() - startedAt
        if (err && (err as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
          resolve({
            id: c.id,
            status: 'error',
            durationMs,
            stdout: String(stdout),
            stderr: String(stderr),
            exitCode: -1,
            errorMessage: `timeout after ${timeoutMs}ms`,
          })
          return
        }
        const exitCode = err && typeof (err as any).code === 'number' ? (err as any).code : err ? 1 : 0
        resolve({
          id: c.id,
          status: exitCode === 0 ? 'pass' : 'fail',
          durationMs,
          stdout: String(stdout),
          stderr: String(stderr),
          exitCode,
        })
      },
    )
    child.on('error', e => {
      resolve({
        id: c.id,
        status: 'error',
        durationMs: Date.now() - startedAt,
        stdout: '',
        stderr: '',
        exitCode: -1,
        errorMessage: e.message,
      })
    })
  })
}

interface DecideGateInput {
  current: { passRate: number; passed: number; totalCases: number; results: CaseResult[] }
  baseline: Baseline | null
  thresholdPct: number
}

export function decideGate(input: DecideGateInput): GateDecision {
  const { current, baseline, thresholdPct } = input
  if (!baseline) {
    return {
      decision: 'pass',
      currentPassRate: current.passRate,
      baselinePassRate: 0,
      delta: 0,
      blockedCases: [],
      reason: 'no baseline yet — current run will be used as baseline',
    }
  }
  const delta = current.passRate - baseline.passRate
  const threshold = -thresholdPct / 100
  if (delta < threshold) {
    const blockedCases = current.results
      .filter(r => r.status === 'fail' || r.status === 'error')
      .map(r => r.id)
    return {
      decision: 'block',
      currentPassRate: current.passRate,
      baselinePassRate: baseline.passRate,
      delta,
      blockedCases,
      reason: `pass rate dropped ${(delta * 100).toFixed(1)}pp (threshold ${thresholdPct}pp)`,
    }
  }
  return {
    decision: 'pass',
    currentPassRate: current.passRate,
    baselinePassRate: baseline.passRate,
    delta,
    blockedCases: [],
    reason: delta >= 0 ? `pass rate maintained or improved (+${(delta * 100).toFixed(1)}pp)` : `pass rate dropped ${(delta * 100).toFixed(1)}pp but within threshold`,
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/main/evaluation/regression/__tests__/regressionRunner.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: 导出公开接口**

Create `src/main/evaluation/regression/index.ts`:

```typescript
export { runRegression, decideGate } from './regressionRunner'
export { loadAllCases, loadCase } from './caseLoader'
export { readBaseline, writeBaseline } from './baselineStore'
export type {
  RegressionCase,
  CaseResult,
  RegressionReport,
  Baseline,
  GateDecision,
} from './regressionTypes'
```

- [ ] **Step 6: Commit**

```bash
git add src/main/evaluation/regression/regressionRunner.ts src/main/evaluation/regression/__tests__/regressionRunner.test.ts src/main/evaluation/regression/index.ts
git commit -m "feat(regression): add runner and gate decision"
```

---

## Task 4: CLI 入口

**Files:**
- Create: `src/cli/regression-cli.ts`
- Modify: `package.json`

- [ ] **Step 1: 实现 CLI**

```typescript
// src/cli/regression-cli.ts
// 用法:
//   bun run regression run           — 跑一轮，输出 JSON 报告到 stdout
//   bun run regression gate          — 跑一轮 + 对比 baseline，输出 gate decision
//   bun run regression baseline      — 跑一轮并写入 baseline
import * as path from 'node:path'
import * as os from 'node:os'
import {
  runRegression,
  decideGate,
  readBaseline,
  writeBaseline,
} from '../main/evaluation/regression'

const CASES_DIR = path.join(os.homedir(), '.claude', 'regression-cases')
const BASELINE_FILE = path.join(CASES_DIR, 'baseline.json')
const THRESHOLD_PCT = 5

async function main() {
  const cmd = process.argv[2] ?? 'run'
  switch (cmd) {
    case 'run': {
      const report = await runRegression(CASES_DIR)
      console.log(JSON.stringify(report, null, 2))
      process.exit(report.failed + report.errored > 0 ? 1 : 0)
    }
    case 'gate': {
      const report = await runRegression(CASES_DIR)
      const baseline = await readBaseline(BASELINE_FILE)
      const decision = decideGate({
        current: {
          passRate: report.passRate,
          passed: report.passed,
          totalCases: report.totalCases,
          results: report.results,
        },
        baseline,
        thresholdPct: THRESHOLD_PCT,
      })
      console.log(JSON.stringify({ report, decision }, null, 2))
      process.exit(decision.decision === 'block' ? 1 : 0)
    }
    case 'baseline': {
      const report = await runRegression(CASES_DIR)
      await writeBaseline(BASELINE_FILE, {
        passRate: report.passRate,
        passed: report.passed,
        totalCases: report.totalCases,
        capturedAt: report.timestamp,
      })
      console.log(`baseline written: ${report.passed}/${report.totalCases} = ${(report.passRate * 100).toFixed(1)}%`)
      process.exit(0)
    }
    default:
      console.error(`unknown command: ${cmd}`)
      console.error('usage: regression [run|gate|baseline]')
      process.exit(2)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
```

- [ ] **Step 2: 加 package.json script**

Modify `package.json` — 在 scripts 部分新增：

```json
"regression": "bun run src/cli/regression-cli.ts"
```

- [ ] **Step 3: 冒烟测试 CLI（用现有 3 个 case）**

```bash
cd ~/Downloads/ai/code-agent
bun run regression run
```

Expected: JSON 报告，`totalCases: 3` 或 3 个 case 中含 eval_command 的数量。
如果现有 3 个 case 还没加 eval_command，此步会 throw — 正常，Task 5 会补上。

- [ ] **Step 4: Commit**

```bash
git add src/cli/regression-cli.ts package.json
git commit -m "feat(regression): add CLI entry for run/gate/baseline"
```

---

## Task 5: 补齐现有 3 个 case 的 eval_command

**Files:**
- Modify: `~/.claude/regression-cases/reg-001-process-undefined.md`
- Modify: `~/.claude/regression-cases/reg-002-binary-file-read.md`
- Modify: `~/.claude/regression-cases/reg-003-tool-call-pairing.md`
- Modify: `~/.claude/regression-cases/README.md`

- [ ] **Step 1: reg-001 加 eval_command**

在 frontmatter 插入：

```yaml
eval_command: "! grep -rn 'process\\.' ~/Downloads/ai/code-agent/src/shared/ | grep -v 'typeof process' | grep -v '\\.test\\.' | grep -v '\\.d\\.ts'"
```

- [ ] **Step 2: reg-002 加 eval_command**

先读当前内容确认 reg-002 的验证方法。根据 debugging.md 2026-02-09 的 read_file xlsx 乱码记录，eval_command 应检查 binary 守卫代码存在：

```yaml
eval_command: "grep -q 'isBinaryFile' ~/Downloads/ai/code-agent/src/main/tools/readFile.ts"
```

（具体路径执行时按实际源码调整）

- [ ] **Step 3: reg-003 加 eval_command**

根据 autoCompressor tool_call 配对问题：

```yaml
eval_command: "grep -q 'preservePairing\\|toolCallPair' ~/Downloads/ai/code-agent/src/main/context/autoCompressor.ts"
```

（具体 symbol 按实际源码调整）

- [ ] **Step 4: 跑 CLI 确认 3 个 case 全部可运行**

```bash
bun run regression run
```

Expected: `totalCases: 3`，全部 pass（因为这些 bug 都已经修过了）。

- [ ] **Step 5: 更新 README.md 说明 eval_command 规范**

在 README.md 的"格式"章节追加：

```markdown
### eval_command（必填）

返回 exit code 判定 case 结果：
- `0` = pass
- 非 0 = fail
- 超时（默认 10s）= error

约定前缀：
- `!` 反转 — 期望无输出（grep 找到匹配即 fail）
- 可以用任意 bash 表达式

示例：
- `! grep -rn 'process\.' src/shared/ | grep -v 'typeof process'` — 确认 shared/ 没有裸 process
- `grep -q 'isBinaryFile' src/main/tools/readFile.ts` — 确认 binary 守卫存在
- `cd repo && npm run test:reg-004 -- --run` — 跑专门的单测
```

- [ ] **Step 6: Commit**

```bash
cd ~/.claude/regression-cases
git add reg-001-process-undefined.md reg-002-binary-file-read.md reg-003-tool-call-pairing.md README.md 2>/dev/null || true
# 注：~/.claude 不在 code-agent repo 里，如果是独立 git 仓库另行 commit；否则仅保存
```

---

## Task 6: 补充 7 个新 case 到 reg-010

**Files:**
- Create: `~/.claude/regression-cases/reg-004-sse-token-usage.md`
- Create: `~/.claude/regression-cases/reg-005-cli-data-pipeline.md`
- Create: `~/.claude/regression-cases/reg-006-turnid-guard-silent.md`
- Create: `~/.claude/regression-cases/reg-007-moonshot-concurrent-limit.md`
- Create: `~/.claude/regression-cases/reg-008-workspace-diff.md`
- Create: `~/.claude/regression-cases/reg-009-prompt-hardcoded-rules.md`
- Create: `~/.claude/regression-cases/reg-010-stale-model-config.md`

每个 case 基于 debugging.md 对应条目。以 reg-004 为例：

- [ ] **Step 1: 创建 reg-004**

```markdown
---
id: reg-004
source: debugging.md (2026-02-09)
tags: [sse, telemetry, token-usage]
related_rules: [L2-008]
eval_command: "grep -q 'stream_options.*include_usage' ~/Downloads/ai/code-agent/src/main/providers/moonshot.ts"
---

## 场景

SSE 流 token usage 全为 0。Provider 未发送 `stream_options: { include_usage: true }`，
sseStream.ts fallback 使用 `charCount/4` 估算而非真实 token 数。

## 预期行为

- 所有 provider 必须发送 `stream_options: { include_usage: true }`
- agentLoop 有 fallback 本地估算作为兜底

## 验证方法

```bash
grep -q 'stream_options.*include_usage' src/main/providers/moonshot.ts
```
```

- [ ] **Step 2: 创建 reg-005 (CLI 数据管道断裂)**

核心：`persistMessage` 回调存在，`CODE_AGENT_CLI_MODE` 不再粗暴跳过持久化。

```yaml
eval_command: "grep -q 'persistMessage' ~/Downloads/ai/code-agent/src/main/agentLoop/loopTypes.ts"
```

- [ ] **Step 3: 创建 reg-006 (TelemetryCollector turnId 守卫)**

核心：turnId mismatch 必须 log warn 不能静默。

```yaml
eval_command: "grep -q 'turnId.*mismatch\\|logger.warn.*turnId' ~/Downloads/ai/code-agent/src/main/telemetry/telemetryCollector.ts"
```

- [ ] **Step 4: 创建 reg-007 (Moonshot 并发限流)**

核心：MoonshotRateLimiter 存在，默认 maxConcurrent=2。

```yaml
eval_command: "grep -q 'MoonshotRateLimiter' ~/Downloads/ai/code-agent/src/main/providers/moonshot.ts"
```

- [ ] **Step 5: 创建 reg-008 (Workspace Diff 防幻觉)**

核心：`snapshotOutput` 或 workspace diff 机制存在。

```yaml
eval_command: "grep -rq 'workspaceDiff\\|snapshotOutput' ~/Downloads/ai/code-agent/src/main/evaluation/"
```

- [ ] **Step 6: 创建 reg-009 (Prompt 硬编码反例)**

核心：分类器 prompt 不用动作列表。这个是 content rule，验证方法是 grep 确保新 prompt 使用抽象意图维度。

```yaml
eval_command: "grep -q '获取信息\\|评判质量\\|intent' ~/Downloads/ai/code-agent/src/main/router/classifier.ts"
```

（具体文件路径按实际调整）

- [ ] **Step 7: 创建 reg-010 (模型配置过时检查)**

核心：CI 或启动时有个检查，确保不使用已过时的模型 id 如 `glm-4-flash`。

```yaml
eval_command: "! grep -rn 'glm-4-flash' ~/Downloads/ai/code-agent/src/ | grep -v '\\.test\\.' | grep -v '// legacy'"
```

- [ ] **Step 8: 跑完整 regression，确认 10 个 case 都能运行**

```bash
bun run regression run | tee /tmp/reg-run.json
cat /tmp/reg-run.json | jq '.totalCases, .passed, .failed, .errored'
```

Expected: `totalCases: 10`。允许部分 case fail（如 reg-009 可能找不到对应文件），此时要么调整 eval_command 要么标记为 TODO 占位。目标是"10 个 case 能跑"，不是"10 个全 pass"。

- [ ] **Step 9: 写入初始 baseline**

```bash
bun run regression baseline
```

Expected: `baseline written: X/10 = XX.X%` 并生成 `~/.claude/regression-cases/baseline.json`。

- [ ] **Step 10: Commit**

```bash
# ~/.claude 如果是 git 管理的，在那里 commit
# 否则在 code-agent 里记录一下 snapshot
cd ~/Downloads/ai/code-agent
git add -A docs/superpowers/plans/2026-04-09-regression-floor-gate.md
git commit -m "docs(plan): add regression floor gate plan" || true
```

---

## Task 7: 接入 /synthesize skill

**Files:**
- Modify: `~/.claude/skills/synthesize/SKILL.md`

- [ ] **Step 1: 读当前 synthesize SKILL.md 的 Step 3 位置**

Read the file to find where Step 3 (Capacity Check) ends and Step 4 begins.

- [ ] **Step 2: 在 Step 3 和 Step 4 之间插入 Step 3.5**

```markdown
## Step 3.5: Regression Gate（v2.4 新增）

在生成提案前，跑一次回归测试集确认当前状态相对 baseline 无退化。

```bash
cd ~/Downloads/ai/code-agent
bun run regression gate > /tmp/synth-gate.json
GATE_DECISION=$(jq -r '.decision.decision' /tmp/synth-gate.json)
GATE_DELTA=$(jq -r '.decision.delta' /tmp/synth-gate.json)
GATE_REASON=$(jq -r '.decision.reason' /tmp/synth-gate.json)
```

### 决策分支

- **decision = "pass"** — 继续正常流程，把 `delta` 和 `reason` 写进简报的"回归状态"一行
- **decision = "block"** — 提案被硬拦截。生成简报时：
  1. 顶部显著标注 `⚠️ REGRESSION BLOCKED`
  2. 列出 `blockedCases` 中的 case id 和关联的 `related_rules`
  3. 不生成 L3 实验文件，不晋升 L2
  4. 推荐动作：检查最近的规则变更，回滚或修复 blocked cases
  5. 审批时明确告知用户这是阻塞状态，不能简单 y/n 通过

### 回归通过后更新 baseline（可选）

如果用户审批通过本次提案并合入 L2/L1，且变更完成后：

```bash
bun run regression baseline  # 重新采样作为新 baseline
```

这保证 baseline 跟随 main 分支演化。
```

- [ ] **Step 3: 手动冒烟测试 synthesize skill（在 Claude Code 里）**

在 Claude Code 中执行 `/synthesize`，确认新的 Step 3.5 被识别且 `bun run regression gate` 命令能跑通。
Expected: synthesize 输出中包含"回归状态: pass/block"一行。

- [ ] **Step 4: 更新 self-evolving-v2.md 记录 v2.4 变更**

在 `~/.claude/projects/-Users-linchen/memory/self-evolving-v2.md` 追加：

```markdown
---

## 十三、Regression Floor Gate (v2.4, 2026-04-09)

基于 Hermes Agent 的 Benchmark 硬门禁启发，给 `/synthesize` 流程加自动化回归地板。

### 核心改动

| 组件 | 位置 | 作用 |
|---|---|---|
| regressionRunner | code-agent repo src/main/evaluation/regression/ | 读取 regression-cases/ 跑 eval_command 输出 scorecard |
| baseline.json | ~/.claude/regression-cases/ | 当前 main 分支的通过率快照 |
| Step 3.5 Gate | synthesize SKILL.md | 提案前跑回归，>5% 下降自动拦截 |
| bun run regression | package.json | CLI 入口（run/gate/baseline） |

### 门禁规则

- 通过率下降 ≤ 5pp → pass，简报正常生成
- 通过率下降 > 5pp → block，提案被硬拦截，列出失败 case

### 回归 case 来源

从 debugging.md 提取已修复的 bug（reg-001 ~ reg-010），每个 case 有 eval_command 字段返回 0/1 判定。
```

- [ ] **Step 5: Commit（如果 ~/.claude 是 git 管理的）**

```bash
# SKILL.md 和 memory 变更
```

---

## Self-Review Checklist

完成实施前自查：

- [ ] 所有 vitest 测试通过（`npx vitest run src/main/evaluation/regression/`）
- [ ] `bun run regression run` 能跑出 10 个 case 的报告
- [ ] `bun run regression baseline` 能写入 baseline.json
- [ ] `bun run regression gate` 在 baseline 存在时能产出 decision
- [ ] 手动触发 `/synthesize` 时 Step 3.5 的 gate 命令被执行
- [ ] 人工故意破坏一个 case（例如改回 reg-001 的 process 守卫）后，`bun run regression gate` 返回 block
- [ ] baseline.json 已提交到适当位置（~/.claude 目录或项目备份）

---

## 非目标（YAGNI）

本期**不做**以下事项，留给后续期：

- ❌ 轨迹级失败归因（Phase 2 的内容）
- ❌ Shadow 评估 + 提案模式（Phase 3 的内容）
- ❌ DSPy/GEPA 级别的自动 prompt 优化
- ❌ 三级递进 benchmark（Hermes 的 TBLite→YC-Bench→TerminalBench2 分层）
- ❌ 自动生成新 case（本期手动从 debugging.md 摘）
- ❌ LLM-based eval command（本期全部用 bash grep / pytest 等确定性检查）

---

## 后续期预告

- **Phase 2（轨迹归因）** — 利用 `src/main/evaluation/trajectory/` 已有的 deviationDetector 和 trajectoryBuilder，增加 LLM-based 因果链分析，输出 `failure_attribution` 接入 Grader Report。
- **Phase 3（进化/生产解耦）** — 改造 ExperimentRepository 支持 shadow 评估流程，synthesize 输出改为 `~/.claude/proposals/` 下的提案文件而非直接变更。
