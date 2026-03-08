/**
 * Append-only JSONL store for human annotations (Open Coding / Axial Coding).
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

export type ErrorType = 'tool_misuse' | 'reasoning_error' | 'incomplete_output' | 'hallucination' | 'security_violation';

export interface Annotation {
  id: string;
  caseId: string;
  round: number;
  timestamp: string;
  errorTypes: ErrorType[];
  rootCause: string;
  severity: 1 | 2 | 3 | 4 | 5;
  annotator: string;
}

export interface AxialCodingEntry {
  errorType: ErrorType;
  count: number;
  avgSeverity: number;
  caseIds: string[];
}

const STORE_PATH = path.join(os.homedir(), '.code-agent', 'eval-annotations.jsonl');

function ensureDir(): void {
  const dir = path.dirname(STORE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function saveAnnotation(annotation: Annotation): void {
  ensureDir();
  const line = JSON.stringify(annotation) + '\n';
  fs.appendFileSync(STORE_PATH, line, 'utf8');
}

export function loadAnnotations(): Annotation[] {
  if (!fs.existsSync(STORE_PATH)) return [];
  const content = fs.readFileSync(STORE_PATH, 'utf8');
  return content
    .split('\n')
    .filter(l => l.trim())
    .map(l => {
      try { return JSON.parse(l) as Annotation; }
      catch { return null; }
    })
    .filter((a): a is Annotation => a !== null);
}

export function getAxialCoding(): AxialCodingEntry[] {
  const annotations = loadAnnotations();
  const map = new Map<ErrorType, { count: number; totalSeverity: number; caseIds: Set<string> }>();

  for (const ann of annotations) {
    for (const et of ann.errorTypes) {
      const entry = map.get(et) ?? { count: 0, totalSeverity: 0, caseIds: new Set() };
      entry.count++;
      entry.totalSeverity += ann.severity;
      entry.caseIds.add(ann.caseId);
      map.set(et, entry);
    }
  }

  return Array.from(map.entries())
    .map(([errorType, data]) => ({
      errorType,
      count: data.count,
      avgSeverity: Math.round((data.totalSeverity / data.count) * 10) / 10,
      caseIds: Array.from(data.caseIds),
    }))
    .sort((a, b) => b.count - a.count);
}
