// Structured DesignDoc / DesignIR layer.
// This sits above canvas.json: DesignDoc stores semantic design intent, while canvas.json stores visual stage nodes.

export type DesignDocMedium = 'web' | 'slides' | 'infographic' | 'video';
export type DesignDocLayerKind = 'frame' | 'component' | 'text' | 'image' | 'media' | 'shape';

export interface DesignStyleTokens {
  colors?: Record<string, string>;
  typography?: Record<string, string>;
  spacing?: Record<string, number>;
  radii?: Record<string, number>;
}

export interface DesignDocProvenance {
  id: string;
  source: 'user' | 'ai' | 'import' | 'system';
  prompt?: string;
  model?: string;
  createdAt?: number;
}

export interface DesignDocSelectionBinding {
  id: string;
  layerIds: string[];
  canvasNodeIds?: string[];
  note?: string;
}

export interface DesignDocLayer {
  id: string;
  kind: DesignDocLayerKind;
  name?: string;
  text?: string;
  src?: string;
  component?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  styleRefs?: string[];
  children?: DesignDocLayer[];
  selectionId?: string;
  provenanceId?: string;
  metadata?: Record<string, unknown>;
}

export interface DesignDocFrame {
  id: string;
  name?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  layers: DesignDocLayer[];
  selectionId?: string;
  provenanceId?: string;
}

export interface DesignDocPage {
  id: string;
  name?: string;
  medium: DesignDocMedium;
  frames: DesignDocFrame[];
  selectionId?: string;
  provenanceId?: string;
}

export interface DesignDoc {
  version: 1;
  id: string;
  title?: string;
  medium: DesignDocMedium;
  pages: DesignDocPage[];
  tokens: DesignStyleTokens;
  selections: DesignDocSelectionBinding[];
  provenance: DesignDocProvenance[];
  metadata?: Record<string, unknown>;
}

const DOC_VERSION = 1 as const;
const MEDIA: readonly DesignDocMedium[] = ['web', 'slides', 'infographic', 'video'];
const LAYER_KINDS: readonly DesignDocLayerKind[] = ['frame', 'component', 'text', 'image', 'media', 'shape'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeMedium(value: unknown): DesignDocMedium {
  return typeof value === 'string' && MEDIA.includes(value as DesignDocMedium)
    ? (value as DesignDocMedium)
    : 'web';
}

function normalizeBounds(raw: unknown): DesignDocLayer['bounds'] | undefined {
  if (!isRecord(raw)) return undefined;
  const x = finite(raw.x);
  const y = finite(raw.y);
  const width = finite(raw.width);
  const height = finite(raw.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined;
  return { x, y, width, height };
}

function normalizeTokens(raw: unknown): DesignStyleTokens {
  if (!isRecord(raw)) return {};
  const tokens: DesignStyleTokens = {};
  for (const key of ['colors', 'typography'] as const) {
    if (isRecord(raw[key])) {
      const pairs = Object.entries(raw[key]).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
      if (pairs.length > 0) tokens[key] = Object.fromEntries(pairs);
    }
  }
  for (const key of ['spacing', 'radii'] as const) {
    if (isRecord(raw[key])) {
      const pairs = Object.entries(raw[key]).filter((entry): entry is [string, number] => finite(entry[1]) !== undefined);
      if (pairs.length > 0) tokens[key] = Object.fromEntries(pairs);
    }
  }
  return tokens;
}

function normalizeLayer(raw: unknown): DesignDocLayer | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  const kind = typeof raw.kind === 'string' && LAYER_KINDS.includes(raw.kind as DesignDocLayerKind)
    ? (raw.kind as DesignDocLayerKind)
    : null;
  if (!id || !kind) return null;
  const layer: DesignDocLayer = { id, kind };
  const name = str(raw.name);
  const text = str(raw.text);
  const src = str(raw.src);
  const component = str(raw.component);
  if (name) layer.name = name;
  if (text) layer.text = text;
  if (src) layer.src = src;
  if (component) layer.component = component;
  const bounds = normalizeBounds(raw.bounds);
  if (bounds) layer.bounds = bounds;
  if (Array.isArray(raw.styleRefs)) layer.styleRefs = raw.styleRefs.filter((v): v is string => typeof v === 'string');
  if (Array.isArray(raw.children)) {
    const children = raw.children.map(normalizeLayer).filter((v): v is DesignDocLayer => v !== null);
    if (children.length > 0) layer.children = children;
  }
  const selectionId = str(raw.selectionId);
  const provenanceId = str(raw.provenanceId);
  if (selectionId) layer.selectionId = selectionId;
  if (provenanceId) layer.provenanceId = provenanceId;
  if (isRecord(raw.metadata)) layer.metadata = raw.metadata;
  return layer;
}

function normalizeFrame(raw: unknown): DesignDocFrame | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  if (!id) return null;
  const frame: DesignDocFrame = {
    id,
    layers: Array.isArray(raw.layers)
      ? raw.layers.map(normalizeLayer).filter((v): v is DesignDocLayer => v !== null)
      : [],
  };
  const name = str(raw.name);
  const bounds = normalizeBounds(raw.bounds);
  const selectionId = str(raw.selectionId);
  const provenanceId = str(raw.provenanceId);
  if (name) frame.name = name;
  if (bounds) frame.bounds = bounds;
  if (selectionId) frame.selectionId = selectionId;
  if (provenanceId) frame.provenanceId = provenanceId;
  return frame;
}

function normalizePage(raw: unknown, fallbackMedium: DesignDocMedium): DesignDocPage | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  if (!id) return null;
  const page: DesignDocPage = {
    id,
    medium: normalizeMedium(raw.medium ?? fallbackMedium),
    frames: Array.isArray(raw.frames)
      ? raw.frames.map(normalizeFrame).filter((v): v is DesignDocFrame => v !== null)
      : [],
  };
  const name = str(raw.name);
  const selectionId = str(raw.selectionId);
  const provenanceId = str(raw.provenanceId);
  if (name) page.name = name;
  if (selectionId) page.selectionId = selectionId;
  if (provenanceId) page.provenanceId = provenanceId;
  return page;
}

function normalizeSelection(raw: unknown): DesignDocSelectionBinding | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  if (!id || !Array.isArray(raw.layerIds)) return null;
  const layerIds = raw.layerIds.filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (layerIds.length === 0) return null;
  const binding: DesignDocSelectionBinding = { id, layerIds };
  if (Array.isArray(raw.canvasNodeIds)) {
    binding.canvasNodeIds = raw.canvasNodeIds.filter((v): v is string => typeof v === 'string' && v.length > 0);
  }
  const note = str(raw.note);
  if (note) binding.note = note;
  return binding;
}

function normalizeProvenance(raw: unknown): DesignDocProvenance | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  if (!id) return null;
  const source = raw.source === 'user' || raw.source === 'ai' || raw.source === 'import' || raw.source === 'system'
    ? raw.source
    : 'system';
  const provenance: DesignDocProvenance = { id, source };
  const prompt = str(raw.prompt);
  const model = str(raw.model);
  const createdAt = finite(raw.createdAt);
  if (prompt) provenance.prompt = prompt;
  if (model) provenance.model = model;
  if (createdAt !== undefined) provenance.createdAt = createdAt;
  return provenance;
}

export function emptyDesignDoc(medium: DesignDocMedium = 'web'): DesignDoc {
  return {
    version: DOC_VERSION,
    id: `design-doc-${medium}`,
    medium,
    pages: [],
    tokens: {},
    selections: [],
    provenance: [],
  };
}

export function normalizeDesignDoc(raw: unknown): DesignDoc {
  if (!isRecord(raw)) return emptyDesignDoc();
  const medium = normalizeMedium(raw.medium);
  const id = str(raw.id) ?? `design-doc-${medium}`;
  const doc: DesignDoc = {
    version: DOC_VERSION,
    id,
    medium,
    pages: Array.isArray(raw.pages)
      ? raw.pages.map((page) => normalizePage(page, medium)).filter((v): v is DesignDocPage => v !== null)
      : [],
    tokens: normalizeTokens(raw.tokens),
    selections: Array.isArray(raw.selections)
      ? raw.selections.map(normalizeSelection).filter((v): v is DesignDocSelectionBinding => v !== null)
      : [],
    provenance: Array.isArray(raw.provenance)
      ? raw.provenance.map(normalizeProvenance).filter((v): v is DesignDocProvenance => v !== null)
      : [],
  };
  const title = str(raw.title);
  if (title) doc.title = title;
  if (isRecord(raw.metadata)) doc.metadata = raw.metadata;
  return doc;
}

export function serializeDesignDoc(doc: DesignDoc): string {
  return JSON.stringify(normalizeDesignDoc(doc), null, 2);
}

export function deserializeDesignDoc(text: string | null | undefined): DesignDoc {
  if (!text) return emptyDesignDoc();
  try {
    return normalizeDesignDoc(JSON.parse(text));
  } catch {
    return emptyDesignDoc();
  }
}
