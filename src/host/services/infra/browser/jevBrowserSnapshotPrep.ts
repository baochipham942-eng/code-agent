// ============================================================================
// Jev browser snapshot prep — inner-loop capture, sensitive-field drop, window
// ============================================================================
// Tool-facing get_dom_snapshot stays 80 interactive. This module only feeds the
// execute_goal inner loop: collect 1024, drop password/file, score a 254-wide
// choice window, and attach viewport/scrollY that the tool JSON does not carry.

import { BROWSER_TARGET_REF_TTL_MS } from './managedBrowserHelpers';
import { buildBrowserDomSnapshot } from './domSnapshotBuilder';
import {
  JEV_MAX_INTERACTIVE_ELEMENTS,
  type JevInteractiveExtras,
} from './domSnapshotParser';
import type { BrowserTargetRefRegistry } from './targetRefRegistry';
import type {
  BrowserDomSnapshot,
  BrowserTab,
  BrowserTargetRef,
} from './types';

const JEV_WINDOW_CAP = 254;
const JEV_TARGET_TEXT_CHARS = 120;

const HIGH_VALUE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'menuitem',
]);

type JevViewportZone = 'in_view' | 'above' | 'below';

interface JevViewport {
  width: number;
  height: number;
}

export interface JevCapturedSnapshot {
  snapshot: BrowserDomSnapshot;
  extras: JevInteractiveExtras[];
  viewport: JevViewport;
  scrollY: number;
}

export interface JevCandidate {
  refId: string;
  tag: string;
  role: string | null;
  name: string;
  text: string;
  ariaLabel: string | null;
  placeholder: string | null;
  inputKind: string;
  inView: boolean;
  zone: JevViewportZone;
  rect: { x: number; y: number; width: number; height: number };
  targetRef: BrowserTargetRef;
  extras: JevInteractiveExtras;
  score: number;
  index: number;
}

interface JevWindowMeta {
  selected: number;
  collected: number;
  in_view: number;
  above: number;
  below: number;
  truncated: boolean;
  dropped_below: number;
}

export interface PreparedJevSnapshot {
  snapshot: BrowserDomSnapshot;
  collected: JevCandidate[];
  selected: JevCandidate[];
  sensitiveFieldsPresent: boolean;
  unavailableFrames: number;
  window: JevWindowMeta;
  viewport: JevViewport;
  scrollY: number;
}

function isSensitiveField(args: {
  tag: string;
  role?: string | null;
  extras: JevInteractiveExtras;
}): boolean {
  const inputType = (args.extras.inputType || '').toLowerCase();
  const autocomplete = (args.extras.autocomplete || '').toLowerCase();
  const accept = args.extras.accept || '';
  if (inputType === 'password' || inputType === 'file') return true;
  if (
    autocomplete.includes('password')
    || autocomplete.includes('current-password')
    || autocomplete.includes('new-password')
    || autocomplete.includes('cc-number')
    || autocomplete.includes('cc-csc')
  ) {
    return true;
  }
  if (args.tag.toLowerCase() === 'input' && accept.trim().length > 0) return true;
  if ((args.role || '').toLowerCase() === 'textbox' && inputType === 'password') return true;
  return false;
}

function zoneForRect(
  rect: { x: number; y: number; width: number; height: number },
  scrollY: number,
  viewport: JevViewport,
): JevViewportZone {
  const top = rect.y;
  const bottom = rect.y + rect.height;
  if (bottom > scrollY && top < scrollY + viewport.height) return 'in_view';
  if (bottom <= scrollY) return 'above';
  return 'below';
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length >= 2),
  );
}

function taskOverlapScore(task: string, candidate: JevCandidate): number {
  const taskTokens = tokenize(task);
  if (taskTokens.size === 0) return 0;
  const hay = tokenize([candidate.name, candidate.text, candidate.ariaLabel || '', candidate.placeholder || ''].join(' '));
  for (const token of hay) {
    if (taskTokens.has(token)) return 30;
  }
  return 0;
}

function inputKindOf(extras: JevInteractiveExtras): string {
  const type = (extras.inputType || '').trim().toLowerCase();
  return type || 'none';
}

function collectCandidates(
  captured: JevCapturedSnapshot,
  task: string,
): { collected: JevCandidate[]; sensitiveFieldsPresent: boolean } {
  const collected: JevCandidate[] = [];
  let sensitiveFieldsPresent = false;
  captured.snapshot.interactiveElements.forEach((element, index) => {
    const extras = captured.extras[index] || { inputType: null, autocomplete: null, accept: null };
    if (isSensitiveField({ tag: element.tag, role: element.role, extras })) {
      sensitiveFieldsPresent = true;
      return;
    }
    const zone = zoneForRect(element.rect, captured.scrollY, captured.viewport);
    const name = element.targetRef.name
      || element.ariaLabel
      || element.text
      || element.placeholder
      || element.selectorHint;
    collected.push({
      refId: element.targetRef.refId,
      tag: element.tag,
      role: element.role || null,
      name,
      text: element.text,
      ariaLabel: element.ariaLabel || null,
      placeholder: element.placeholder || null,
      inputKind: inputKindOf(extras),
      inView: zone === 'in_view',
      zone,
      rect: element.rect,
      targetRef: element.targetRef,
      extras,
      score: 0,
      index,
    });
  });

  const textCounts = new Map<string, number>();
  for (const candidate of collected) {
    const key = candidate.text.trim().toLowerCase();
    if (!key) continue;
    textCounts.set(key, (textCounts.get(key) || 0) + 1);
  }
  const seenChrome = new Set<string>();
  const nameCounts = new Map<string, number>();
  for (const candidate of collected) {
    const key = candidate.name.trim().toLowerCase();
    if (!key) continue;
    nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
  }

  for (const candidate of collected) {
    let score = 0;
    if (candidate.zone === 'in_view') score += 100;
    else if (candidate.zone === 'below') score += 40;
    else score += 10;
    score += taskOverlapScore(task, candidate);
    if (HIGH_VALUE_ROLES.has((candidate.role || '').toLowerCase())) score += 20;
    const nameKey = candidate.name.trim().toLowerCase();
    if (nameKey && nameCounts.get(nameKey) === 1) score += 15;
    const textKey = candidate.text.trim().toLowerCase();
    if (textKey && (textCounts.get(textKey) || 0) >= 5) {
      if (seenChrome.has(textKey)) score -= 50;
      else seenChrome.add(textKey);
    }
    candidate.score = score;
  }

  return { collected, sensitiveFieldsPresent };
}

function selectCandidateWindow(
  collected: JevCandidate[],
  options?: { mutateEmptyWindow?: boolean },
): JevCandidate[] {
  const ranked = [...collected].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.index - right.index;
  });
  const selected = ranked.slice(0, JEV_WINDOW_CAP);
  if (options?.mutateEmptyWindow) return [];
  return selected;
}

function countZones(candidates: JevCandidate[]): { in_view: number; above: number; below: number } {
  let inView = 0;
  let above = 0;
  let below = 0;
  for (const candidate of candidates) {
    if (candidate.zone === 'in_view') inView += 1;
    else if (candidate.zone === 'above') above += 1;
    else below += 1;
  }
  return { in_view: inView, above, below };
}

export function prepareJevBrowserSnapshot(
  captured: JevCapturedSnapshot,
  task: string,
  options?: { mutateEmptyWindow?: boolean },
): PreparedJevSnapshot {
  const { collected, sensitiveFieldsPresent } = collectCandidates(captured, task);
  const selected = selectCandidateWindow(collected, options);
  const zones = countZones(collected);
  const selectedZones = countZones(selected);
  const truncated = collected.length > selected.length;
  const droppedBelow = Math.max(0, zones.below - selectedZones.below);
  const unavailableFrames = (captured.snapshot.frameDocuments || []).filter(
    (document) => document.status === 'unavailable',
  ).length;
  return {
    snapshot: captured.snapshot,
    collected,
    selected,
    sensitiveFieldsPresent,
    unavailableFrames,
    viewport: captured.viewport,
    scrollY: captured.scrollY,
    window: {
      selected: selected.length,
      collected: captured.snapshot.interactiveElements.length,
      in_view: zones.in_view,
      above: zones.above,
      below: zones.below,
      truncated,
      dropped_below: droppedBelow,
    },
  };
}

function candidateLabel(candidate: JevCandidate, maxChars = JEV_TARGET_TEXT_CHARS): string {
  const role = (candidate.role || candidate.tag || 'element').toUpperCase();
  const view = candidate.inView ? 'in view' : candidate.zone === 'below' ? 'below' : 'above';
  const name = (candidate.name || candidate.text || candidate.refId).replace(/\s+/g, ' ').trim();
  return `${role} ${name} (${view})`.slice(0, maxChars);
}

export function buildTargetLabels(
  selected: JevCandidate[],
  maxChars = JEV_TARGET_TEXT_CHARS,
): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const candidate of selected) {
    labels[candidate.refId] = candidateLabel(candidate, maxChars);
  }
  return labels;
}

export async function captureJevPageFromTab(args: {
  tab: BrowserTab;
  registry: BrowserTargetRefRegistry;
  maxInteractiveElements?: number;
}): Promise<JevCapturedSnapshot> {
  const snapshotId = args.registry.createSnapshotId();
  const capturedAtMs = Date.now();
  const { snapshot, targetRefRecords, elementExtras } = await buildBrowserDomSnapshot({
    tab: args.tab,
    snapshotId,
    capturedAtMs,
    targetRefTtlMs: BROWSER_TARGET_REF_TTL_MS,
    maxInteractiveElements: args.maxInteractiveElements ?? JEV_MAX_INTERACTIVE_ELEMENTS,
  });
  args.registry.addRecords(targetRefRecords, capturedAtMs);
  const viewport = args.tab.page.viewportSize() || { width: 1280, height: 720 };
  const scrollY = await args.tab.page.evaluate(() => window.scrollY).catch(() => 0);
  return {
    snapshot,
    extras: elementExtras,
    viewport,
    scrollY: typeof scrollY === 'number' && Number.isFinite(scrollY) ? scrollY : 0,
  };
}
