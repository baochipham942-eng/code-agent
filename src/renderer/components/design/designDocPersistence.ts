import { IPC_DOMAINS } from '@shared/ipc';
import {
  isVideoNode,
  type CanvasNode,
  type DesignCanvasDoc,
} from './designCanvasTypes';
import {
  deserializeDesignDoc,
  serializeDesignDoc,
  type DesignDoc,
  type DesignDocLayer,
  type DesignDocMedium,
  type DesignDocProvenance,
} from './designDocTypes';

export const DESIGN_DOC_FILE = 'design-doc.json';

function cleanRunDir(runDir: string): string {
  return runDir.replace(/\/+$/, '');
}

export function designDocPath(runDir: string): string {
  return `${cleanRunDir(runDir)}/${DESIGN_DOC_FILE}`;
}

function inferMedium(nodes: readonly CanvasNode[]): DesignDocMedium {
  return nodes.some(isVideoNode) ? 'video' : 'web';
}

function docBounds(nodes: readonly CanvasNode[]): { x: number; y: number; width: number; height: number } | undefined {
  const active = nodes.filter((node) => !node.discarded);
  if (active.length === 0) return undefined;
  const minX = Math.min(...active.map((node) => node.x));
  const minY = Math.min(...active.map((node) => node.y));
  const maxX = Math.max(...active.map((node) => node.x + node.width));
  const maxY = Math.max(...active.map((node) => node.y + node.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function layerName(node: CanvasNode): string {
  return node.label || node.prompt || node.id;
}

function provenanceForNode(node: CanvasNode): DesignDocProvenance {
  return {
    id: `canvas-provenance:${node.id}`,
    source: node.prompt ? 'ai' : 'import',
    ...(node.prompt ? { prompt: node.prompt } : {}),
    createdAt: node.createdAt,
  };
}

function layerForNode(node: CanvasNode): DesignDocLayer {
  const provenanceId = `canvas-provenance:${node.id}`;
  return {
    id: `canvas-node:${node.id}`,
    kind: isVideoNode(node) ? 'media' : 'image',
    name: layerName(node),
    src: node.src,
    bounds: { x: node.x, y: node.y, width: node.width, height: node.height },
    provenanceId,
    metadata: {
      canvasNodeId: node.id,
      role: node.role ?? 'output',
      createdAt: node.createdAt,
      ...(node.parentId ? { parentId: node.parentId } : {}),
      ...(node.chosen ? { chosen: true } : {}),
      ...(node.discarded ? { discarded: true } : {}),
      ...(typeof node.costCny === 'number' ? { costCny: node.costCny } : {}),
      ...(isVideoNode(node)
        ? {
            durationSec: node.durationSec,
            ...(node.poster ? { poster: node.poster } : {}),
          }
        : {}),
    },
  };
}

export function canvasDocToDesignDoc(
  canvasDoc: DesignCanvasDoc,
  options: { id?: string; title?: string; medium?: DesignDocMedium } = {},
): DesignDoc {
  const medium = options.medium ?? inferMedium(canvasDoc.nodes);
  const layers = canvasDoc.nodes.map(layerForNode);
  const bounds = docBounds(canvasDoc.nodes);
  return {
    version: 1,
    id: options.id ?? `canvas-design-doc:${medium}`,
    ...(options.title ? { title: options.title } : {}),
    medium,
    pages: [
      {
        id: `canvas-page:${medium}`,
        name: 'Canvas',
        medium,
        frames: [
          {
            id: 'canvas-frame:main',
            name: 'Design Canvas',
            ...(bounds ? { bounds } : {}),
            layers,
          },
        ],
      },
    ],
    tokens: {},
    selections: [],
    provenance: canvasDoc.nodes.map(provenanceForNode),
    metadata: {
      source: 'canvas.json',
      camera: canvasDoc.camera,
      nodeCount: canvasDoc.nodes.length,
      activeNodeCount: canvasDoc.nodes.filter((node) => !node.discarded).length,
    },
  };
}

export async function saveDesignDocForCanvas(
  runDir: string,
  canvasDoc: DesignCanvasDoc,
  options: { title?: string; medium?: DesignDocMedium } = {},
): Promise<boolean> {
  const doc = canvasDocToDesignDoc(canvasDoc, options);
  const res = await window.domainAPI?.invoke(IPC_DOMAINS.WORKSPACE, 'writeFile', {
    filePath: designDocPath(runDir),
    content: serializeDesignDoc(doc),
  });
  return Boolean(res?.success);
}

export async function loadDesignDoc(runDir: string): Promise<DesignDoc> {
  try {
    const res = await window.domainAPI?.invoke<string>(IPC_DOMAINS.WORKSPACE, 'readFile', {
      filePath: designDocPath(runDir),
    });
    return deserializeDesignDoc(res?.success ? ((res.data as string) ?? '') : null);
  } catch {
    return deserializeDesignDoc(null);
  }
}
