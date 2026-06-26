import { DESIGN_CODE_HANDOFF } from '../constants/designHandoff';
import {
  normalizeDesignAcceptanceContract,
  type DesignAcceptanceContract,
} from './designAcceptanceContract';
import type { CanvasSnapshot } from './canvasProposal';

export const DESIGN_CODE_HANDOFF_MODE = 'design_to_code_b' as const;

export type DesignCodeHandoffMode = typeof DESIGN_CODE_HANDOFF_MODE;
export type DesignCodeVisibility = 'hidden';
export type DesignCodeUserSuccessSignal = 'running_artifact';
export type DesignCodeHandoffMediaType = 'image' | 'video' | 'prototype';

export interface DesignCodeHandoffBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  coordinateSpace: 'canvas_absolute';
}

export interface DesignCodeHandoffInteractionState {
  id: string;
  description: string;
  trigger?: string;
  selector?: string;
  expectedState?: string;
}

export interface DesignCodeHandoffVariant {
  id: string;
  label?: string;
  sourcePath?: string;
  mediaType: DesignCodeHandoffMediaType;
  chosen?: boolean;
  bounds: DesignCodeHandoffBounds;
  interactionStates?: DesignCodeHandoffInteractionState[];
}

export interface DesignCodeHandoffPreviewQa {
  deterministicPassed?: boolean;
  visionPassed?: boolean;
  repairAttempts?: number;
  finalFindingCount?: number;
  checks?: string[];
  artifactPath?: string;
}

export interface DesignCodeHandoffContext {
  version: typeof DESIGN_CODE_HANDOFF.VERSION;
  mode: DesignCodeHandoffMode;
  codeVisibility: DesignCodeVisibility;
  userSuccessSignal: DesignCodeUserSuccessSignal;
  selectedVariants: DesignCodeHandoffVariant[];
  acceptanceContract?: DesignAcceptanceContract;
  canvasSnapshot?: CanvasSnapshot;
  previewQa?: DesignCodeHandoffPreviewQa;
  notes?: string[];
}

function normalizeText(value: unknown, maxChars: number = DESIGN_CODE_HANDOFF.MAX_TEXT_CHARS): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxChars) : undefined;
}

function normalizeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeStringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const text = normalizeText(item);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeBounds(value: unknown): DesignCodeHandoffBounds | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<DesignCodeHandoffBounds>;
  const x = normalizeNumber(raw.x);
  const y = normalizeNumber(raw.y);
  const width = normalizeNumber(raw.width);
  const height = normalizeNumber(raw.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined;
  if (width <= 0 || height <= 0) return undefined;
  return {
    x,
    y,
    width,
    height,
    coordinateSpace: 'canvas_absolute',
  };
}

function normalizeMediaType(value: unknown): DesignCodeHandoffMediaType {
  return value === 'video' || value === 'prototype' ? value : 'image';
}

function normalizeInteractionState(value: unknown, index: number): DesignCodeHandoffInteractionState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<DesignCodeHandoffInteractionState>;
  const description = normalizeText(raw.description);
  if (!description) return undefined;
  const state: DesignCodeHandoffInteractionState = {
    id: normalizeText(raw.id, DESIGN_CODE_HANDOFF.MAX_ID_CHARS) ?? `interaction-${index + 1}`,
    description,
  };
  const trigger = normalizeText(raw.trigger);
  const selector = normalizeText(raw.selector, DESIGN_CODE_HANDOFF.MAX_ID_CHARS);
  const expectedState = normalizeText(raw.expectedState);
  if (trigger) state.trigger = trigger;
  if (selector) state.selector = selector;
  if (expectedState) state.expectedState = expectedState;
  return state;
}

function normalizeInteractionStates(value: unknown): DesignCodeHandoffInteractionState[] {
  if (!Array.isArray(value)) return [];
  const states: DesignCodeHandoffInteractionState[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    const state = normalizeInteractionState(item, index);
    if (!state || seen.has(state.id)) continue;
    seen.add(state.id);
    states.push(state);
    if (states.length >= DESIGN_CODE_HANDOFF.MAX_INTERACTION_STATES) break;
  }
  return states;
}

function normalizeVariant(value: unknown): DesignCodeHandoffVariant | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<DesignCodeHandoffVariant>;
  const id = normalizeText(raw.id, DESIGN_CODE_HANDOFF.MAX_ID_CHARS);
  const bounds = normalizeBounds(raw.bounds);
  if (!id || !bounds) return undefined;

  const variant: DesignCodeHandoffVariant = {
    id,
    mediaType: normalizeMediaType(raw.mediaType),
    bounds,
  };
  const label = normalizeText(raw.label);
  const sourcePath = normalizeText(raw.sourcePath, DESIGN_CODE_HANDOFF.MAX_PATH_CHARS);
  const interactionStates = normalizeInteractionStates(raw.interactionStates);
  if (label) variant.label = label;
  if (sourcePath) variant.sourcePath = sourcePath;
  if (raw.chosen === true) variant.chosen = true;
  if (interactionStates.length > 0) variant.interactionStates = interactionStates;
  return variant;
}

function normalizeVariants(value: unknown): DesignCodeHandoffVariant[] {
  if (!Array.isArray(value)) return [];
  const variants: DesignCodeHandoffVariant[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const variant = normalizeVariant(item);
    if (!variant || seen.has(variant.id)) continue;
    seen.add(variant.id);
    variants.push(variant);
    if (variants.length >= DESIGN_CODE_HANDOFF.MAX_SELECTED_VARIANTS) break;
  }
  return variants;
}

function normalizePreviewQa(value: unknown): DesignCodeHandoffPreviewQa | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<DesignCodeHandoffPreviewQa>;
  const previewQa: DesignCodeHandoffPreviewQa = {};
  if (typeof raw.deterministicPassed === 'boolean') previewQa.deterministicPassed = raw.deterministicPassed;
  if (typeof raw.visionPassed === 'boolean') previewQa.visionPassed = raw.visionPassed;
  if (typeof raw.repairAttempts === 'number' && Number.isFinite(raw.repairAttempts) && raw.repairAttempts >= 0) {
    previewQa.repairAttempts = Math.floor(raw.repairAttempts);
  }
  if (typeof raw.finalFindingCount === 'number' && Number.isFinite(raw.finalFindingCount) && raw.finalFindingCount >= 0) {
    previewQa.finalFindingCount = Math.floor(raw.finalFindingCount);
  }
  const checks = normalizeStringList(raw.checks, DESIGN_CODE_HANDOFF.MAX_QA_CHECKS);
  const artifactPath = normalizeText(raw.artifactPath, DESIGN_CODE_HANDOFF.MAX_PATH_CHARS);
  if (checks.length > 0) previewQa.checks = checks;
  if (artifactPath) previewQa.artifactPath = artifactPath;
  return Object.keys(previewQa).length > 0 ? previewQa : undefined;
}

function normalizeCanvasSnapshot(value: unknown): CanvasSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<CanvasSnapshot>;
  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) return undefined;
  return value as CanvasSnapshot;
}

export function normalizeDesignCodeHandoffContext(value?: unknown): DesignCodeHandoffContext | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<DesignCodeHandoffContext>;
  const selectedVariants = normalizeVariants(raw.selectedVariants);
  if (selectedVariants.length === 0) return undefined;

  const acceptanceContract = normalizeDesignAcceptanceContract(raw.acceptanceContract);
  const canvasSnapshot = normalizeCanvasSnapshot(raw.canvasSnapshot);
  const previewQa = normalizePreviewQa(raw.previewQa);
  const notes = normalizeStringList(raw.notes, DESIGN_CODE_HANDOFF.MAX_NOTES);

  const context: DesignCodeHandoffContext = {
    version: DESIGN_CODE_HANDOFF.VERSION,
    mode: DESIGN_CODE_HANDOFF_MODE,
    codeVisibility: 'hidden',
    userSuccessSignal: 'running_artifact',
    selectedVariants,
  };
  if (acceptanceContract) context.acceptanceContract = acceptanceContract;
  if (canvasSnapshot) context.canvasSnapshot = canvasSnapshot;
  if (previewQa) context.previewQa = previewQa;
  if (notes.length > 0) context.notes = notes;
  return context;
}

export function serializeDesignCodeHandoffContext(value: unknown): string | undefined {
  const normalized = normalizeDesignCodeHandoffContext(value);
  return normalized ? JSON.stringify(normalized) : undefined;
}

export function deserializeDesignCodeHandoffContext(value: string): DesignCodeHandoffContext | undefined {
  try {
    return normalizeDesignCodeHandoffContext(JSON.parse(value));
  } catch {
    return undefined;
  }
}

export function formatDesignCodeHandoffForPrompt(value?: unknown): string | null {
  const normalized = normalizeDesignCodeHandoffContext(value);
  return normalized ? JSON.stringify(normalized, null, 2) : null;
}
