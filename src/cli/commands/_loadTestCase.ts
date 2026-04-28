// ============================================================================
// _loadTestCase - 轻量 YAML 测试用例加载，给 debug replay 用
// 不依赖 main/testing 的类型，只取 debug 需要的字段
// ============================================================================

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

export interface ReplayCase {
  id: string;
  type?: string;
  description?: string;
  prompt: string;
  follow_up_prompts?: string[];
  setup?: string[];
  cleanup?: string[];
  tags?: string[];
  suiteName: string;
  suiteFile: string;
}

interface RawCase {
  id?: unknown;
  type?: unknown;
  description?: unknown;
  prompt?: unknown;
  follow_up_prompts?: unknown;
  setup?: unknown;
  cleanup?: unknown;
  tags?: unknown;
}

interface RawSuite {
  name?: unknown;
  description?: unknown;
  cases?: RawCase[];
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === 'string');
}

function defaultTestCaseDir(projectDir: string): string {
  return path.join(projectDir, '.claude', 'test-cases');
}

/**
 * 扫描目录下所有 YAML，返回所有 case（带 suite 元信息）
 */
export function loadAllReplayCases(testCaseDir?: string, projectDir = process.cwd()): ReplayCase[] {
  const dir = testCaseDir ? path.resolve(testCaseDir) : defaultTestCaseDir(projectDir);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  const out: ReplayCase[] = [];

  for (const file of files) {
    const filePath = path.join(dir, file);
    let raw: unknown;
    try {
      raw = yaml.load(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;

    const suite = raw as RawSuite;
    const suiteName = asString(suite.name) ?? file.replace(/\.ya?ml$/, '');
    const cases = Array.isArray(suite.cases) ? suite.cases : [];

    for (const c of cases) {
      const id = asString(c.id);
      const prompt = asString(c.prompt);
      if (!id || !prompt) continue;
      out.push({
        id,
        type: asString(c.type),
        description: asString(c.description),
        prompt,
        follow_up_prompts: asStringArray(c.follow_up_prompts),
        setup: asStringArray(c.setup),
        cleanup: asStringArray(c.cleanup),
        tags: asStringArray(c.tags),
        suiteName,
        suiteFile: file,
      });
    }
  }
  return out;
}

export function findReplayCase(caseId: string, testCaseDir?: string, projectDir = process.cwd()): ReplayCase | null {
  return loadAllReplayCases(testCaseDir, projectDir).find((c) => c.id === caseId) ?? null;
}
