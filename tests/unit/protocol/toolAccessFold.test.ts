import { describe, expect, it } from 'vitest';
import { foldToolAccess, type FoldedToolAccess } from '../../../src/host/tools/dispatch/foldToolAccess';
import { validateToolAccessDeclaration, type ToolAccessKind } from '../../../src/host/protocol/tools';
import { resolveFoldedToolAccess } from '../../../src/host/security/toolAccessResolve';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { terminalListSchema } from '../../../src/host/tools/modules/terminal/terminal.schema';

const FLAGGED_KIND: Record<string, ToolAccessKind> = {
  delegate_task: 'write',
  ProposeCanvasOps: 'readwrite',
  ProposeSlidesOps: 'write',
  ProposeVideoOps: 'write',
  RequestDesignAutonomy: 'write',
  mcp_add_server: 'write',
  mcp: 'readwrite',
  MCPUnified: 'readwrite',
  agent_message: 'readwrite',
  close_agent: 'write',
  send_input: 'write',
  spawn_agent: 'write',
  Task: 'write',
  teammate: 'readwrite',
  workflow: 'readwrite',
  workflow_orchestrate: 'readwrite',
  github_pr: 'readwrite',
  http_request: 'readwrite',
  jira: 'readwrite',
  ppt_generate: 'readwrite', // r3：补声明 template_path/data_source 的读入后折叠档升为 readwrite
  screenshot_page: 'readwrite',
  WebSearch: 'readwrite',
  AskUserQuestion: 'readwrite',
  confirm_action: 'readwrite',
  enter_plan_mode: 'write',
  exit_plan_mode: 'write',
  findings_write: 'write',
  Plan: 'readwrite',
  PlanMode: 'write',
  plan_update: 'write',
  space_create: 'write',
  task_create: 'write',
  TaskManager: 'readwrite',
  task_update: 'write',
  Explore: 'write',
  attempt_completion: 'write',
  declare_deliverables: 'write',
  recommend_capability: 'read',
  propose_role: 'write',
  Skill: 'readwrite',
  sleep_until: 'write',
  SessionManager: 'readwrite',
  terminal_list: 'read',
  terminal_read: 'read',
  terminal_open: 'write',
  terminal_wait: 'read',
  terminal_write: 'write',
};

function resolveExpression(
  expression: string,
  params: Record<string, unknown> = {},
  kind: ToolAccessKind = 'read',
) {
  const folded = foldToolAccess({
    accesses: [{ kind, expression }],
  });
  return resolveFoldedToolAccess({
    toolName: 'probe',
    folded,
    params,
    workspace: '.',
    cwd: '.',
  });
}

describe('tool access declaration', () => {
  it('rejects argumentNames and expression together, and accepts either alone', () => {
    expect(validateToolAccessDeclaration({
      kind: 'read',
      argumentNames: ['path'],
      expression: 'resource(session, plan)',
    })).toBe('argumentNames and expression are mutually exclusive');
    expect(validateToolAccessDeclaration({ kind: 'write', argumentNames: [] }))
      .toBe('argumentNames must be non-empty when set');
    expect(validateToolAccessDeclaration({ kind: 'write', argumentNames: ['path', ' '] }))
      .toBe('argumentNames must not contain an empty name');
    expect(validateToolAccessDeclaration({ kind: 'read', expression: '   ' }))
      .toBe('expression must not be empty');
    expect(validateToolAccessDeclaration({ kind: 'admin' as ToolAccessKind }))
      .toBe('kind must be read, write, or readwrite');
    expect(validateToolAccessDeclaration({ kind: 'read', argumentNames: ['path'] })).toBeNull();
    expect(validateToolAccessDeclaration({ kind: 'read', expression: 'mcp(server, tool, args.target)' })).toBeNull();
    expect(validateToolAccessDeclaration({ kind: 'readwrite' })).toBeNull();
  });
});

describe('default tool access fold', () => {
  it('prefers an explicit declaration over every older marker', () => {
    const folded = foldToolAccess({
      accesses: [{ kind: 'read', expression: 'resource(session, plan)' }],
      sideEffect: true,
      readOnly: false,
      toolName: 'Write',
    });
    expect(folded).toMatchObject({
      source: 'explicit',
      kind: 'read',
      domain: 'declared',
    });
    expect(folded.declarations).toEqual([
      { kind: 'read', expression: 'resource(session, plan)' },
    ]);
  });

  it('folds sideEffect true to readwrite, using a declared path target when one exists', () => {
    expect(foldToolAccess({
      sideEffect: true,
      pathAuthority: [{ kind: 'path', pathParameter: 'file_path' }],
    })).toMatchObject({
      source: 'sideEffect',
      kind: 'readwrite',
      domain: 'arguments',
      argumentNames: ['file_path'],
    });
    expect(foldToolAccess({ sideEffect: true })).toMatchObject({
      source: 'sideEffect',
      kind: 'readwrite',
      domain: 'unknown',
      declarations: [],
    });
  });

  it('folds sideEffect false, none, and read_only to read, unless destructive', () => {
    for (const sideEffect of [false, 'none', 'read_only'] as const) {
      expect(foldToolAccess({ sideEffect })).toMatchObject({
        source: 'sideEffect',
        kind: 'read',
        domain: 'unscoped',
      });
    }
    expect(foldToolAccess({
      sideEffect: false,
      mcpAnnotations: { destructiveHint: true },
    })).toMatchObject({
      source: 'sideEffect',
      kind: 'readwrite',
      domain: 'unknown',
    });
    expect(foldToolAccess({ sideEffect: 'mutate' })).toMatchObject({
      source: 'sideEffect',
      kind: 'readwrite',
      domain: 'unknown',
    });
  });

  it('folds readOnly true to read and readOnly false to write or unknown', () => {
    expect(foldToolAccess({ readOnly: true })).toMatchObject({
      source: 'readOnly',
      kind: 'read',
      domain: 'unscoped',
    });
    expect(foldToolAccess({
      readOnly: false,
      pathAuthority: [{ kind: 'path', pathParameter: 'path' }],
      emission: {
        kind: 'external_effect',
        targetParameters: ['url'],
        compensationAction: 'noop',
      },
    })).toMatchObject({
      source: 'readOnly',
      kind: 'write',
      domain: 'arguments',
      argumentNames: ['path', 'url'],
    });
    expect(foldToolAccess({
      readOnly: false,
      pathAuthority: [{ kind: 'global-memory', pathParameter: 'memory_path' }],
    })).toMatchObject({
      source: 'readOnly',
      kind: 'write',
      domain: 'arguments',
      argumentNames: ['memory_path'],
    });
    expect(foldToolAccess({
      readOnly: false,
      emission: {
        kind: 'external_file_write',
        targetParameter: 'dest',
        compensationAction: 'delete',
      },
    })).toMatchObject({
      source: 'readOnly',
      kind: 'write',
      domain: 'arguments',
      argumentNames: ['dest'],
    });
    expect(foldToolAccess({
      readOnly: false,
      pathAuthority: [{ kind: 'shell', commandParameter: 'command' }],
    })).toMatchObject({
      source: 'readOnly',
      kind: 'write',
      domain: 'unknown',
    });
    expect(foldToolAccess({ readOnly: false })).toMatchObject({
      source: 'readOnly',
      kind: 'write',
      domain: 'unknown',
    });
  });

  it('folds MCP hints, and sends missing, conflicting, or destructive hints to unknown readwrite', () => {
    expect(foldToolAccess({
      mcpTool: true,
      mcpAnnotations: { readOnlyHint: true },
    })).toMatchObject({
      source: 'mcp',
      kind: 'read',
      domain: 'unscoped',
    });
    expect(foldToolAccess({ mcpTool: true })).toMatchObject({
      source: 'mcp',
      kind: 'readwrite',
      domain: 'unknown',
    });
    expect(foldToolAccess({
      mcpTool: true,
      mcpAnnotations: { readOnlyHint: true, destructiveHint: true },
    })).toMatchObject({
      source: 'mcp',
      kind: 'readwrite',
      domain: 'unknown',
    });
    expect(foldToolAccess({
      mcpTool: true,
      mcpAnnotations: { destructiveHint: true },
    })).toMatchObject({
      source: 'mcp',
      kind: 'readwrite',
      domain: 'unknown',
    });
    expect(foldToolAccess({
      mcpAnnotations: { readOnlyHint: false },
    })).toMatchObject({
      source: 'mcp',
      kind: 'readwrite',
      domain: 'unknown',
    });
  });

  it('folds a tool with no markers to unknown readwrite, and ignores the tool name', () => {
    expect(foldToolAccess({})).toMatchObject({
      source: 'fallback',
      kind: 'readwrite',
      domain: 'unknown',
      declarations: [],
    });
    expect(foldToolAccess({ toolName: 'Read' })).toEqual(foldToolAccess({}));
    expect(foldToolAccess({ toolName: 'search_files' })).toEqual(foldToolAccess({}));
    expect(foldToolAccess({ accesses: [] })).toEqual(foldToolAccess({}));
  });

  it('turns contradictory old markers into readwrite on the unknown domain', () => {
    expect(foldToolAccess({
      sideEffect: true,
      readOnly: true,
    })).toMatchObject({
      source: 'contradiction',
      kind: 'readwrite',
      domain: 'unknown',
      declarations: [],
    });
    expect(foldToolAccess({
      sideEffect: false,
      readOnly: false,
    })).toMatchObject({
      source: 'contradiction',
      kind: 'readwrite',
      domain: 'unknown',
    });
    expect(foldToolAccess({
      readOnly: true,
      mcpTool: true,
      mcpAnnotations: { destructiveHint: true },
    })).toMatchObject({
      source: 'contradiction',
      kind: 'readwrite',
      domain: 'unknown',
    });
    expect(foldToolAccess({
      accesses: [{ kind: 'read', argumentNames: ['path'], expression: 'resource(a)' }],
    })).toMatchObject({
      source: 'contradiction',
      kind: 'readwrite',
      domain: 'unknown',
      declarations: [],
    });
  });

  it('keeps every explicit declaration and summarizes mixed kinds as readwrite', () => {
    const folded = foldToolAccess({
      accesses: [
        { kind: 'read', expression: 'resource(network, web_search)' },
        { kind: 'write', argumentNames: ['output_path'] },
      ],
    });
    expect(folded.source).toBe('explicit');
    expect(folded.kind).toBe('readwrite');
    expect(folded.domain).toBe('declared');
    expect(folded.declarations).toHaveLength(2);
  });
});

describe('tool access expression', () => {
  it('resolves the documented call form and does not execute it', () => {
    const marker = '__toolres_dsl_executed';
    delete (globalThis as Record<string, unknown>)[marker];
    const resolved = resolveExpression(
      'mcp(server, tool, args.target)',
      {
        server: 'filesystem',
        tool: 'read_file',
        arguments: { target: 'notes.md' },
      },
      'readwrite',
    );
    expect(resolved).toEqual([{
      kind: 'readwrite',
      domain: { type: 'named', name: 'mcp:filesystem:read_file:notes.md' },
    }]);
    expect(resolveExpression('resource(session, plan)')).toEqual([{
      kind: 'read',
      domain: { type: 'named', name: 'session:plan' },
    }]);
    expect(resolveExpression('pty(args.session_id)', {})).toEqual([{
      kind: 'read',
      domain: { type: 'named', name: 'pty:current' },
    }]);
    expect(resolveExpression('pty(args.session_id)', { session_id: 'pty-7' })).toEqual([{
      kind: 'read',
      domain: { type: 'named', name: 'pty:pty-7' },
    }]);
    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
  });

  it('lands invalid expressions on the unknown domain without throwing', () => {
    const marker = '__toolres_dsl_executed';
    delete (globalThis as Record<string, unknown>)[marker];
    const invalid = [
      '',
      'notARealFunction(server)',
      `constructor.constructor("globalThis.${marker} = true")()`,
      'mcp(server, `tool`)',
      'mcp(server, tool(args.target))',
    ];
    for (const expression of invalid) {
      const folded: FoldedToolAccess = expression.trim() === ''
        ? foldToolAccess({ accesses: [{ kind: 'read', expression }] })
        : {
          source: 'explicit',
          kind: 'read',
          domain: 'declared',
          declarations: [{ kind: 'read', expression }],
        };
      let resolved: ReturnType<typeof resolveFoldedToolAccess> | undefined;
      expect(() => {
        resolved = resolveFoldedToolAccess({
          toolName: 'probe',
          folded,
          params: { server: 'filesystem', tool: 'read_file' },
          workspace: '.',
          cwd: '.',
        });
      }).not.toThrow();
      expect(resolved?.length).toBeGreaterThan(0);
      expect(resolved?.every((access) => access.domain.type === 'unknown')).toBe(true);
    }
    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
  });
});

describe('built-in tool access coverage', () => {
  it('pins terminal_list to an explicit read declaration', () => {
    const folded = foldToolAccess({
      accesses: terminalListSchema.accesses,
      readOnly: terminalListSchema.readOnly,
      pathAuthority: terminalListSchema.pathAuthority,
      emission: terminalListSchema.emission,
      toolName: terminalListSchema.name,
    });
    expect(folded.source).toBe('explicit');
    expect(folded.kind).toBe('read');
    expect(terminalListSchema.accesses?.[0]).toEqual({
      kind: 'read',
      expression: 'resource(pty, catalog)',
    });
  });

  it('folds every registered built-in schema without throwing', () => {
    const schemas = getProtocolRegistry().getSchemas();
    expect(schemas.length).toBeGreaterThan(100);
    const byName = new Map(schemas.map((schema) => [schema.name, schema]));
    const foldUnknown: string[] = [];
    const resolveUnknown: string[] = [];

    for (const schema of schemas) {
      const folded = foldToolAccess({
        accesses: schema.accesses,
        readOnly: schema.readOnly,
        pathAuthority: schema.pathAuthority,
        emission: schema.emission,
        toolName: schema.name,
      });
      expect(folded.kind === 'read' || folded.kind === 'write' || folded.kind === 'readwrite').toBe(true);
      if (folded.domain === 'unknown') foldUnknown.push(schema.name);
      const resolved = resolveFoldedToolAccess({
        toolName: schema.name,
        folded,
        params: {},
        workspace: '.',
        cwd: '.',
      });
      expect(resolved.length).toBeGreaterThan(0);
      if (resolved.some((access) => access.domain.type === 'unknown')) {
        resolveUnknown.push(schema.name);
      }
    }

    for (const [name, kind] of Object.entries(FLAGGED_KIND)) {
      const schema = byName.get(name);
      expect(schema, name).toBeDefined();
      const folded = foldToolAccess({
        accesses: schema?.accesses,
        readOnly: schema?.readOnly,
        pathAuthority: schema?.pathAuthority,
        emission: schema?.emission,
        toolName: name,
      });
      expect(folded.source, name).toBe('explicit');
      expect(folded.kind, name).toBe(kind);
      expect(foldUnknown, name).not.toContain(name);
    }

    for (const name of ['steer_task', 'cancel_task', 'task_status', 'wake_on', 'wake_on_event', 'AgentSpawn']) {
      expect(byName.get(name)?.accesses, name).toBeUndefined();
    }

    foldUnknown.sort();
    resolveUnknown.sort();
    console.info(JSON.stringify({
      schemaCount: schemas.length,
      foldUnknownCount: foldUnknown.length,
      foldUnknown,
      resolveUnknownCount: resolveUnknown.length,
      resolveUnknown,
    }));
  });
});
