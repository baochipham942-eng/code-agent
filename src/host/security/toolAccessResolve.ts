import {
  validateToolAccessDeclaration,
  type ToolAccessDeclaration,
  type ToolAccessKind,
} from '../protocol/tools';
import type { FoldedToolAccess } from '../tools/dispatch/foldToolAccess';
import {
  normalizeTargetPath,
  type ResolvedToolAccess,
  type ToolResourceDomain,
} from './resourceScope';

interface ParsedArgument {
  readonly kind: 'ident' | 'args';
  readonly name: string;
}

interface ParsedCall {
  readonly name: string;
  readonly args: readonly ParsedArgument[];
}

type ResolvedExpression =
  | { readonly type: 'domain'; readonly domain: ToolResourceDomain }
  | { readonly type: 'skip' };

export interface ResolveToolAccessInput {
  readonly toolName: string;
  readonly folded: FoldedToolAccess;
  readonly params: Record<string, unknown>;
  readonly workspace: string;
  readonly cwd?: string;
}

/**
 * Host-parsed access expression. The parser never evaluates code: no eval,
 * no Function, no computed member access.
 *
 * Grammar:
 *   expression := identifier "(" [ argument { "," argument } ] ")"
 *   argument   := identifier | "args" "." identifier
 *   identifier := [A-Za-z_][A-Za-z0-9_]*
 * Whitespace between tokens is ignored. Exactly one call is allowed.
 * Nested calls, strings, backticks, and any other member access are invalid.
 *
 * Known functions (any other function is a resolve failure):
 *   mcp(lookup, ...)           named domain "mcp:" + segments joined by ":"
 *   resource(literal | lookup) named domain segments joined by ":"
 *   pty(lookup)                named domain "pty:<id>"; a missing id is "pty:current"
 *   workspace()                workspace domain rooted at the call workspace
 *   workspaceFile(lookup)      path domain; a missing value omits this access
 * A bare identifier lookup reads params[name]. args.<field> reads the call's
 * argument bag (params.arguments, else params.args, else params).
 * For resource(), a bare identifier is a literal segment, not a lookup.
 * Parse or lookup failure becomes the unknown domain and does not throw.
 */
function parseToolAccessExpression(expression: string): ParsedCall | null {
  const source = expression.trim();
  if (source.length === 0 || /[`"'\\]/.test(source)) return null;
  let index = 0;

  const skipWs = (): void => {
    while (index < source.length && /\s/.test(source[index] ?? '')) index += 1;
  };
  const readIdent = (): string | null => {
    const start = index;
    if (!/[A-Za-z_]/.test(source[index] ?? '')) return null;
    index += 1;
    while (index < source.length && /[A-Za-z0-9_]/.test(source[index] ?? '')) index += 1;
    return source.slice(start, index);
  };
  const readArg = (): ParsedArgument | null => {
    const ident = readIdent();
    if (!ident) return null;
    if (source[index] === '.') {
      if (ident !== 'args') return null;
      index += 1;
      const field = readIdent();
      if (!field || source[index] === '.' || source[index] === '(') return null;
      return { kind: 'args', name: field };
    }
    if (source[index] === '(') return null;
    return { kind: 'ident', name: ident };
  };

  const name = readIdent();
  if (!name) return null;
  skipWs();
  if (source[index] !== '(') return null;
  index += 1;
  const args: ParsedArgument[] = [];
  skipWs();
  if (source[index] === ')') {
    index += 1;
    skipWs();
    return index === source.length ? { name, args } : null;
  }
  while (index < source.length) {
    const arg = readArg();
    if (!arg) return null;
    args.push(arg);
    skipWs();
    if (source[index] === ',') {
      index += 1;
      skipWs();
      if (source[index] === ')') return null;
      continue;
    }
    if (source[index] === ')') {
      index += 1;
      skipWs();
      return index === source.length ? { name, args } : null;
    }
    return null;
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOwn(bag: Record<string, unknown>, field: string): unknown {
  if (!Object.hasOwn(bag, field)) return undefined;
  return bag[field];
}

function lookupArgument(argument: ParsedArgument, params: Record<string, unknown>): unknown {
  if (argument.kind === 'ident') return readOwn(params, argument.name);
  if (isPlainObject(params.arguments)) return readOwn(params.arguments, argument.name);
  if (isPlainObject(params.args)) return readOwn(params.args, argument.name);
  return readOwn(params, argument.name);
}

function asSegment(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function unknownAccess(kind: ToolAccessKind): ResolvedToolAccess {
  return { kind, domain: { type: 'unknown' } };
}

function resolveExpression(
  expression: string,
  params: Record<string, unknown>,
  workspace: string,
  cwd: string,
): ResolvedExpression | null {
  const parsed = parseToolAccessExpression(expression);
  if (!parsed) return null;
  if (parsed.name === 'workspace') {
    if (parsed.args.length !== 0) return null;
    const root = normalizeTargetPath(workspace, '.');
    return { type: 'domain', domain: { type: 'workspace', root, targetPath: root } };
  }
  if (parsed.name === 'workspaceFile') {
    const argument = parsed.args[0];
    if (parsed.args.length !== 1 || !argument) return null;
    const value = lookupArgument(argument, params);
    if (value === undefined) return { type: 'skip' };
    const segment = asSegment(value);
    if (!segment) return null;
    const root = normalizeTargetPath(workspace, '.');
    return {
      type: 'domain',
      domain: { type: 'path', root, targetPath: normalizeTargetPath(cwd, segment) },
    };
  }
  if (parsed.name === 'pty') {
    const argument = parsed.args[0];
    if (parsed.args.length !== 1 || !argument) return null;
    const value = lookupArgument(argument, params);
    if (value === undefined) {
      return { type: 'domain', domain: { type: 'named', name: 'pty:current' } };
    }
    const segment = asSegment(value);
    if (!segment) return null;
    return { type: 'domain', domain: { type: 'named', name: `pty:${segment}` } };
  }
  if (parsed.name !== 'mcp' && parsed.name !== 'resource') return null;
  if (parsed.args.length === 0) return null;
  const segments: string[] = [];
  for (const argument of parsed.args) {
    if (parsed.name === 'resource' && argument.kind === 'ident') {
      segments.push(argument.name);
      continue;
    }
    const segment = asSegment(lookupArgument(argument, params));
    if (!segment) return null;
    segments.push(segment);
  }
  const name = parsed.name === 'mcp' ? `mcp:${segments.join(':')}` : segments.join(':');
  return { type: 'domain', domain: { type: 'named', name } };
}

function cwdReadAccess(workspace: string, cwd: string): ResolvedToolAccess {
  const root = normalizeTargetPath(workspace, '.');
  return {
    kind: 'read',
    domain: { type: 'path', root, targetPath: normalizeTargetPath(cwd, '.') },
  };
}

function resolveArgumentNames(
  kind: ToolAccessKind,
  names: readonly string[],
  params: Record<string, unknown>,
  workspace: string,
  cwd: string,
): ResolvedToolAccess[] {
  const paths: string[] = [];
  for (const name of names) {
    const value = readOwn(params, name);
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') {
      if (value.trim() === '') {
        if (kind !== 'read') return [unknownAccess(kind)];
        continue;
      }
      paths.push(value);
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        if (kind !== 'read') return [unknownAccess(kind)];
        continue;
      }
      for (const item of value) {
        if (typeof item !== 'string' || item.trim() === '') return [unknownAccess(kind)];
        paths.push(item);
      }
      continue;
    }
    return [unknownAccess(kind)];
  }
  if (paths.length === 0) {
    return kind === 'read' ? [cwdReadAccess(workspace, cwd)] : [unknownAccess(kind)];
  }
  const root = normalizeTargetPath(workspace, '.');
  return paths.map((candidate) => ({
    kind,
    domain: { type: 'path', root, targetPath: normalizeTargetPath(cwd, candidate) },
  }));
}

function resolveDeclaration(
  declaration: ToolAccessDeclaration,
  params: Record<string, unknown>,
  workspace: string,
  cwd: string,
  toolName: string,
): ResolvedToolAccess[] {
  if (validateToolAccessDeclaration(declaration) !== null) {
    return [unknownAccess('readwrite')];
  }
  if (declaration.expression !== undefined) {
    const resolved = resolveExpression(declaration.expression, params, workspace, cwd);
    if (!resolved) return [unknownAccess(declaration.kind)];
    if (resolved.type === 'skip') return [];
    return [{ kind: declaration.kind, domain: resolved.domain }];
  }
  if (declaration.argumentNames !== undefined) {
    return resolveArgumentNames(declaration.kind, declaration.argumentNames, params, workspace, cwd);
  }
  return [{ kind: declaration.kind, domain: { type: 'named', name: `fixed:${toolName}` } }];
}

/** 把折叠结果落到规范化资源域。解析失败返回未知域，不向调用方抛错。 */
export function resolveFoldedToolAccess(input: ResolveToolAccessInput): ResolvedToolAccess[] {
  const cwd = input.cwd ?? input.workspace;
  try {
    if (input.folded.source === 'explicit') {
      const resolved = input.folded.declarations.flatMap((declaration) => resolveDeclaration(
        declaration,
        input.params,
        input.workspace,
        cwd,
        input.toolName,
      ));
      return resolved.length > 0 ? resolved : [unknownAccess('readwrite')];
    }
    if (input.folded.domain === 'unknown') return [unknownAccess(input.folded.kind)];
    if (input.folded.domain === 'unscoped') {
      return [{ kind: input.folded.kind, domain: { type: 'unscoped' } }];
    }
    if (input.folded.domain === 'arguments' && input.folded.argumentNames?.length) {
      return resolveArgumentNames(
        input.folded.kind,
        input.folded.argumentNames,
        input.params,
        input.workspace,
        cwd,
      );
    }
    if (input.folded.declarations.length > 0) {
      const resolved = input.folded.declarations.flatMap((declaration) => resolveDeclaration(
        declaration,
        input.params,
        input.workspace,
        cwd,
        input.toolName,
      ));
      if (resolved.length > 0) return resolved;
    }
    return [{ kind: input.folded.kind, domain: { type: 'unscoped' } }];
  } catch {
    return [unknownAccess('readwrite')];
  }
}
