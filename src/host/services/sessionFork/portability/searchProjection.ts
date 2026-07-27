import type {
  ForkLineageEnvelopeV1,
  ForkNeighborhoodNodeProjection,
  ForkNeighborhoodProjection,
  ForkSearchDocument,
  ForkTreeNodeProjection,
  SessionExportEnvelopeV2,
} from '../../../../shared/contract/sessionForkPortability';
import { SessionForkPortabilityError } from '../../../../shared/contract/sessionForkPortability';
import {
  validateForkLineageEnvelopeV1,
  validateSessionExportEnvelopeV2,
} from './codec';

function compareLineagePosition(
  left: Pick<ForkLineageEnvelopeV1['nodes'][number], 'depth' | 'ordinal' | 'createdAt' | 'sessionId'>,
  right: Pick<ForkLineageEnvelopeV1['nodes'][number], 'depth' | 'ordinal' | 'createdAt' | 'sessionId'>,
): number {
  return (
    left.depth - right.depth
    || left.ordinal - right.ordinal
    || left.createdAt - right.createdAt
    || left.sessionId.localeCompare(right.sessionId)
  );
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

export function buildForkSearchDocuments(
  envelope: SessionExportEnvelopeV2,
): ForkSearchDocument[] {
  validateSessionExportEnvelopeV2(envelope);
  const sessions = new Map(envelope.sessions.map((session) => [session.id, session]));
  const messageCount = new Map<string, number>();
  for (const message of envelope.messages) {
    messageCount.set(message.sessionId, (messageCount.get(message.sessionId) ?? 0) + 1);
  }
  return [...envelope.lineage.nodes]
    .sort(compareLineagePosition)
    .map((node) => {
      const session = sessions.get(node.sessionId);
      if (!session) {
        throw new SessionForkPortabilityError(
          'REFERENCE_NOT_CLOSED',
          `search projection cannot resolve ${node.sessionId}`,
        );
      }
      const engineKind = session.engine?.kind ?? null;
      const searchText = normalizeSearchText([
        session.id,
        session.title,
        node.rootSessionId,
        node.parentSessionId ?? '',
        engineKind ?? '',
        node.workspaceMode,
      ].join(' '));
      return {
        id: `fork-search:${session.id}`,
        sessionId: session.id,
        rootSessionId: node.rootSessionId,
        parentSessionId: node.parentSessionId,
        depth: node.depth,
        title: session.title,
        engineKind,
        workspaceMode: node.workspaceMode,
        messageCount: messageCount.get(session.id) ?? 0,
        createdAt: session.createdAt,
        searchText,
      };
    });
}

export function searchForkDocuments(
  documents: ForkSearchDocument[],
  query: string,
): ForkSearchDocument[] {
  const normalized = normalizeSearchText(query);
  if (!normalized) return [...documents];
  const tokens = [...new Set(normalized.split(' ').filter(Boolean))];
  return documents
    .map((document) => {
      const title = normalizeSearchText(document.title);
      const sessionId = normalizeSearchText(document.sessionId);
      const matched = tokens.filter((token) => document.searchText.includes(token));
      const score = matched.reduce((total, token) => (
        total
        + (title === token ? 100 : title.includes(token) ? 30 : 0)
        + (sessionId === token ? 50 : sessionId.includes(token) ? 20 : 0)
        + 1
      ), 0);
      return { document, score, matchedAll: matched.length === tokens.length };
    })
    .filter((item) => item.matchedAll)
    .sort((left, right) => (
      right.score - left.score
      || left.document.depth - right.document.depth
      || left.document.createdAt - right.document.createdAt
      || left.document.sessionId.localeCompare(right.document.sessionId)
    ))
    .map((item) => item.document);
}

export function buildForkTreeProjection(
  lineage: ForkLineageEnvelopeV1,
): ForkTreeNodeProjection {
  validateForkLineageEnvelopeV1(lineage);
  const children = new Map<string, ForkLineageEnvelopeV1['nodes']>();
  for (const node of lineage.nodes) {
    if (!node.parentSessionId) continue;
    const entries = children.get(node.parentSessionId) ?? [];
    entries.push(node);
    children.set(node.parentSessionId, entries);
  }
  for (const entries of children.values()) entries.sort(compareLineagePosition);

  const bySession = new Map(lineage.nodes.map((node) => [node.sessionId, node]));
  const visit = (sessionId: string): ForkTreeNodeProjection => {
    const node = bySession.get(sessionId);
    if (!node) {
      throw new SessionForkPortabilityError(
        'REFERENCE_NOT_CLOSED',
        `tree projection cannot resolve ${sessionId}`,
      );
    }
    return {
      sessionId: node.sessionId,
      parentSessionId: node.parentSessionId,
      depth: node.depth,
      ordinal: node.ordinal,
      createdAt: node.createdAt,
      children: (children.get(node.sessionId) ?? []).map((child) => visit(child.sessionId)),
    };
  };
  return visit(lineage.rootSessionId);
}

function ancestorsOf(
  bySession: ReadonlyMap<string, ForkLineageEnvelopeV1['nodes'][number]>,
  sessionId: string,
): string[] {
  const result: string[] = [];
  let cursor = bySession.get(sessionId)?.parentSessionId ?? null;
  while (cursor) {
    result.push(cursor);
    cursor = bySession.get(cursor)?.parentSessionId ?? null;
  }
  return result;
}

function requireLineageNode(
  bySession: ReadonlyMap<string, ForkLineageEnvelopeV1['nodes'][number]>,
  sessionId: string,
): ForkLineageEnvelopeV1['nodes'][number] {
  const node = bySession.get(sessionId);
  if (!node) {
    throw new SessionForkPortabilityError(
      'REFERENCE_NOT_CLOSED',
      `lineage projection cannot resolve ${sessionId}`,
    );
  }
  return node;
}

export function buildForkNeighborhoodProjection(
  lineage: ForkLineageEnvelopeV1,
  centerSessionId: string,
  radius = 1,
): ForkNeighborhoodProjection {
  validateForkLineageEnvelopeV1(lineage);
  if (!Number.isSafeInteger(radius) || radius < 0) {
    throw new SessionForkPortabilityError('ORDINAL_INVALID', 'neighborhood radius must be a non-negative integer');
  }
  const bySession = new Map(lineage.nodes.map((node) => [node.sessionId, node]));
  if (!bySession.has(centerSessionId)) {
    throw new SessionForkPortabilityError(
      'REFERENCE_NOT_CLOSED',
      `neighborhood center ${centerSessionId} does not exist`,
    );
  }
  const adjacency = new Map<string, Set<string>>();
  for (const node of lineage.nodes) {
    if (!adjacency.has(node.sessionId)) adjacency.set(node.sessionId, new Set());
    if (node.parentSessionId) {
      const nodeEdges = adjacency.get(node.sessionId) ?? new Set<string>();
      nodeEdges.add(node.parentSessionId);
      adjacency.set(node.sessionId, nodeEdges);
      const parentEdges = adjacency.get(node.parentSessionId) ?? new Set<string>();
      parentEdges.add(node.sessionId);
      adjacency.set(node.parentSessionId, parentEdges);
    }
  }
  const distances = new Map<string, number>([[centerSessionId, 0]]);
  const queue = [centerSessionId];
  while (queue.length) {
    const current = queue.shift();
    if (current === undefined) break;
    const distance = distances.get(current);
    if (distance === undefined) {
      throw new SessionForkPortabilityError(
        'REFERENCE_NOT_CLOSED',
        `distance for ${current} is missing`,
      );
    }
    if (distance >= radius) continue;
    const neighbors = [...(adjacency.get(current) ?? [])].sort();
    for (const neighbor of neighbors) {
      if (distances.has(neighbor)) continue;
      distances.set(neighbor, distance + 1);
      queue.push(neighbor);
    }
  }
  const centerAncestors = new Set(ancestorsOf(bySession, centerSessionId));
  const nodes: ForkNeighborhoodNodeProjection[] = [...distances]
    .map(([sessionId, distance]) => {
      const node = requireLineageNode(bySession, sessionId);
      let relation: ForkNeighborhoodNodeProjection['relation'];
      if (sessionId === centerSessionId) relation = 'self';
      else if (centerAncestors.has(sessionId)) relation = 'ancestor';
      else if (ancestorsOf(bySession, sessionId).includes(centerSessionId)) relation = 'descendant';
      else relation = 'sibling';
      return {
        sessionId,
        parentSessionId: node.parentSessionId,
        depth: node.depth,
        relation,
        distance,
      };
    })
    .sort((left, right) => {
      const leftNode = requireLineageNode(bySession, left.sessionId);
      const rightNode = requireLineageNode(bySession, right.sessionId);
      return compareLineagePosition(leftNode, rightNode);
    });
  const included = new Set(nodes.map((node) => node.sessionId));
  const edges = lineage.nodes
    .filter((node) => (
      node.parentSessionId
      && included.has(node.parentSessionId)
      && included.has(node.sessionId)
    ))
    .sort(compareLineagePosition)
    .flatMap((node) => (
      node.parentSessionId
        ? [{
          parentSessionId: node.parentSessionId,
          childSessionId: node.sessionId,
        }]
        : []
    ));
  return { centerSessionId, nodes, edges };
}
