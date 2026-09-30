import type {
  ToolEmissionDescriptor,
  ToolPathAuthorityDescriptor,
} from '@shared/contract';
import type { MCPToolAnnotations } from '../../mcp/types';
import { isMcpToolReadOnly } from '../../mcp/mcpToolSafety';
import {
  validateToolAccessDeclaration,
  type ToolAccessDeclaration,
  type ToolAccessKind,
} from '../../protocol/tools';

type ToolAccessFoldSource =
  | 'explicit'
  | 'sideEffect'
  | 'readOnly'
  | 'mcp'
  | 'fallback'
  | 'contradiction';

export interface FoldedToolAccess {
  readonly source: 'explicit' | 'sideEffect' | 'readOnly' | 'mcp' | 'fallback' | 'contradiction';
  readonly kind: ToolAccessKind;
  readonly domain: 'unknown' | 'declared' | 'arguments' | 'unscoped';
  readonly argumentNames?: readonly string[];
  readonly declarations: readonly ToolAccessDeclaration[];
}

export interface ToolAccessFoldInput {
  readonly accesses?: readonly ToolAccessDeclaration[];
  readonly sideEffect?: boolean | 'none' | 'read_only' | string;
  readonly readOnly?: boolean;
  readonly pathAuthority?: readonly ToolPathAuthorityDescriptor[];
  readonly emission?: ToolEmissionDescriptor;
  readonly mcpAnnotations?: MCPToolAnnotations;
  /** 折叠的是 MCP 工具，注解对象可以整体缺失。 */
  readonly mcpTool?: boolean;
  /**
   * 刻意不参与折叠。名字里的 read/search/get 不能把工具收成只读。
   * 保留该字段是为了让调用方把名字传进来时行为仍然与不传相同。
   */
  readonly toolName?: string;
}

interface FoldCandidate {
  readonly source: ToolAccessFoldSource;
  readonly kind: ToolAccessKind;
  readonly domain: 'unknown' | 'arguments' | 'unscoped';
  readonly argumentNames?: readonly string[];
}

function pathArgumentNames(
  pathAuthority: readonly ToolPathAuthorityDescriptor[] | undefined,
  emission: ToolEmissionDescriptor | undefined,
): string[] {
  const names: string[] = [];
  for (const entry of pathAuthority ?? []) {
    if (entry.kind === 'path' || entry.kind === 'global-memory') {
      names.push(entry.pathParameter);
    }
  }
  if (emission?.kind === 'external_file_write') names.push(emission.targetParameter);
  if (emission?.kind === 'external_effect') names.push(...emission.targetParameters);
  return [...new Set(names)];
}

function strictestKind(kinds: readonly ToolAccessKind[]): ToolAccessKind {
  if (kinds.includes('readwrite') || (kinds.includes('read') && kinds.includes('write'))) {
    return 'readwrite';
  }
  if (kinds.includes('write')) return 'write';
  return 'read';
}

function withTarget(
  kind: ToolAccessKind,
  source: ToolAccessFoldSource,
  input: ToolAccessFoldInput,
): FoldCandidate {
  const argumentNames = pathArgumentNames(input.pathAuthority, input.emission);
  if (argumentNames.length === 0) {
    return { source, kind, domain: 'unknown' };
  }
  return { source, kind, domain: 'arguments', argumentNames };
}

function materialize(candidate: FoldCandidate): FoldedToolAccess {
  if (candidate.domain === 'arguments' && candidate.argumentNames) {
    return {
      source: candidate.source,
      kind: candidate.kind,
      domain: 'arguments',
      argumentNames: candidate.argumentNames,
      declarations: [{ kind: candidate.kind, argumentNames: candidate.argumentNames }],
    };
  }
  if (candidate.domain === 'unscoped') {
    return {
      source: candidate.source,
      kind: candidate.kind,
      domain: 'unscoped',
      declarations: [{ kind: candidate.kind }],
    };
  }
  return {
    source: candidate.source,
    kind: candidate.kind,
    domain: 'unknown',
    declarations: [],
  };
}

function sameCandidate(left: FoldCandidate, right: FoldCandidate): boolean {
  if (left.kind !== right.kind || left.domain !== right.domain) return false;
  const leftNames = left.argumentNames ?? [];
  const rightNames = right.argumentNames ?? [];
  return leftNames.length === rightNames.length
    && leftNames.every((name, index) => name === rightNames[index]);
}

function mergeCandidates(candidates: readonly FoldCandidate[]): FoldedToolAccess {
  const [first] = candidates;
  if (!first) {
    return { source: 'fallback', kind: 'readwrite', domain: 'unknown', declarations: [] };
  }
  if (candidates.some((candidate) => !sameCandidate(candidate, first))) {
    return { source: 'contradiction', kind: 'readwrite', domain: 'unknown', declarations: [] };
  }
  return materialize(first);
}

/**
 * 缺省折叠，顺序固定：显式 accesses；sideEffect；readOnly；MCP 注解；其余 readwrite/未知域。
 * 旧标记互相矛盾时取更严的 readwrite。不读 toolName。
 */
export function foldToolAccess(input: ToolAccessFoldInput): FoldedToolAccess {
  if (input.accesses && input.accesses.length > 0) {
    if (input.accesses.some((declaration) => validateToolAccessDeclaration(declaration) !== null)) {
      return { source: 'contradiction', kind: 'readwrite', domain: 'unknown', declarations: [] };
    }
    return {
      source: 'explicit',
      kind: strictestKind(input.accesses.map((declaration) => declaration.kind)),
      domain: 'declared',
      declarations: input.accesses,
    };
  }

  const candidates: FoldCandidate[] = [];
  const destructive = input.mcpAnnotations?.destructiveHint === true;

  if (input.sideEffect !== undefined) {
    if (input.sideEffect === true) {
      candidates.push(withTarget('readwrite', 'sideEffect', input));
    } else if (
      input.sideEffect === false
      || input.sideEffect === 'none'
      || input.sideEffect === 'read_only'
    ) {
      candidates.push(destructive
        ? { source: 'sideEffect', kind: 'readwrite', domain: 'unknown' }
        : { source: 'sideEffect', kind: 'read', domain: 'unscoped' });
    } else {
      candidates.push({ source: 'sideEffect', kind: 'readwrite', domain: 'unknown' });
    }
  }

  if (input.readOnly === true) {
    candidates.push({ source: 'readOnly', kind: 'read', domain: 'unscoped' });
  } else if (input.readOnly === false) {
    candidates.push(withTarget('write', 'readOnly', input));
  }

  if (input.mcpTool === true || input.mcpAnnotations !== undefined) {
    candidates.push(isMcpToolReadOnly(input.mcpAnnotations)
      ? { source: 'mcp', kind: 'read', domain: 'unscoped' }
      : { source: 'mcp', kind: 'readwrite', domain: 'unknown' });
  }

  if (candidates.length === 0) {
    return { source: 'fallback', kind: 'readwrite', domain: 'unknown', declarations: [] };
  }
  return mergeCandidates(candidates);
}
