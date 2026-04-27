import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dispose: vi.fn(),
  },
}));

vi.mock('../../../src/main/services/serviceRegistry', () => ({
  getServiceRegistry: () => ({
    register: vi.fn(),
  }),
}));

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { buildSessionTraceIdentity } from '../../../src/shared/contract/reviewQueue';
import { getDatabase } from '../../../src/main/services/core/databaseService';
import { getTelemetryQueryService } from '../../../src/main/evaluation/telemetryQueryService';

const dbState = vi.hoisted(() => ({
  sqlite: null as import('better-sqlite3').Database | null,
  getSession: vi.fn(),
  getMessages: vi.fn(),
}));

describe('TelemetryQueryService transcript replay fallback', () => {
  let database: ReturnType<typeof getDatabase>;
  let originalGetDb: typeof database.getDb;
  let originalGetSession: typeof database.getSession;
  let originalGetMessages: typeof database.getMessages;
  let isReadySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dbState.sqlite = new Database(':memory:');
    dbState.getSession.mockReset();
    dbState.getMessages.mockReset();

    database = getDatabase();
    originalGetDb = database.getDb.bind(database);
    originalGetSession = database.getSession.bind(database);
    originalGetMessages = database.getMessages.bind(database);
    isReadySpy = vi.spyOn(database, 'isReady', 'get').mockReturnValue(true);

    database.getDb = () => dbState.sqlite;
    database.getSession = dbState.getSession as typeof database.getSession;
    database.getMessages = dbState.getMessages as typeof database.getMessages;
  });

  afterEach(() => {
    if (database) {
      database.getDb = originalGetDb;
      database.getSession = originalGetSession;
      database.getMessages = originalGetMessages;
    }
    isReadySpy?.mockRestore();
    dbState.sqlite?.close();
    dbState.sqlite = null;
  });

  function createTelemetryReplayTables() {
    dbState.sqlite!.exec(`
      CREATE TABLE telemetry_sessions (
        id TEXT PRIMARY KEY
      );
      CREATE TABLE telemetry_turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_number INTEGER NOT NULL,
        agent_id TEXT DEFAULT 'main',
        turn_type TEXT DEFAULT 'user',
        parent_turn_id TEXT,
        user_prompt TEXT,
        assistant_response TEXT,
        thinking_content TEXT,
        start_time INTEGER NOT NULL,
        end_time INTEGER,
        duration_ms INTEGER DEFAULT 0,
        total_input_tokens INTEGER DEFAULT 0,
        total_output_tokens INTEGER DEFAULT 0,
        compaction_occurred INTEGER DEFAULT 0,
        compaction_saved_tokens INTEGER
      );
      CREATE TABLE telemetry_model_calls (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        temperature REAL,
        max_tokens INTEGER,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        latency_ms INTEGER DEFAULT 0,
        response_type TEXT,
        tool_call_count INTEGER DEFAULT 0,
        truncated INTEGER DEFAULT 0,
        error TEXT,
        fallback_info TEXT,
        prompt TEXT,
        completion TEXT
      );
      CREATE TABLE telemetry_tool_calls (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        name TEXT NOT NULL,
        arguments TEXT,
        actual_arguments TEXT,
        result_summary TEXT,
        success INTEGER DEFAULT 0,
        error TEXT,
        duration_ms INTEGER DEFAULT 0,
        timestamp INTEGER NOT NULL,
        idx INTEGER DEFAULT 0,
        parallel INTEGER DEFAULT 0
      );
      CREATE TABLE telemetry_events (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        summary TEXT,
        data TEXT,
        duration_ms INTEGER
      );
    `);
  }

  it('falls back to persisted session transcript when telemetry tables are absent', async () => {
    dbState.getSession.mockReturnValue({
      id: 'session-direct-1',
      title: 'Direct Session',
      createdAt: 100,
      updatedAt: 160,
    });
    dbState.getMessages.mockReturnValue([
      {
        id: 'user-1',
        role: 'user',
        content: '只发给 reviewer',
        timestamp: 100,
        metadata: {
          workbench: {
            routingMode: 'direct',
            targetAgentIds: ['agent-reviewer'],
            targetAgentNames: ['reviewer'],
            directRoutingDelivery: {
              deliveredTargetIds: ['agent-reviewer'],
              deliveredTargetNames: ['reviewer'],
            },
          },
        },
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'reviewer 已接收。',
        timestamp: 160,
      },
    ]);

    const replay = await getTelemetryQueryService().getStructuredReplay('session-direct-1');

    expect(replay).not.toBeNull();
    expect(replay?.traceIdentity).toEqual(buildSessionTraceIdentity('session-direct-1'));
    expect(replay?.traceSource).toBe('session_replay');
    expect(replay?.dataSource).toBe('transcript_fallback');
    expect(replay?.summary.telemetryCompleteness).toMatchObject({
      sessionId: 'session-direct-1',
      replayKey: 'session-direct-1',
      dataSource: 'transcript_fallback',
      hasRealAgentTrace: false,
      hasModelDecisions: false,
      hasToolSchemas: false,
      incompleteReasons: expect.arrayContaining([
        'transcript_fallback_replay',
        'missing_model_decisions',
        'missing_event_trace',
        'missing_tool_schemas',
      ]),
    });
    expect(replay?.summary.totalTurns).toBe(1);
    expect(replay?.turns).toHaveLength(1);
    expect(replay?.turns[0]?.blocks).toEqual([
      {
        type: 'user',
        content: '只发给 reviewer',
        timestamp: 100,
      },
      {
        type: 'text',
        content: 'reviewer 已接收。',
        timestamp: 160,
      },
    ]);
  });

  it('preserves transcript tool calls and tool results in fallback replay summary', async () => {
    dbState.getSession.mockReturnValue({
      id: 'session-tools-1',
      title: 'Tool Session',
      createdAt: 100,
      updatedAt: 220,
    });
    dbState.getMessages.mockReturnValue([
      {
        id: 'user-1',
        role: 'user',
        content: '检查文件',
        timestamp: 100,
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        timestamp: 120,
        contentParts: [
          { type: 'text', text: '先读旧路径。' },
          { type: 'tool_call', toolCallId: 'tool-read-1' },
        ],
        toolCalls: [
          {
            id: 'tool-read-1',
            name: 'read_file',
            arguments: { file_path: 'src/missing.ts' },
          },
        ],
      },
      {
        id: 'tool-result-1',
        role: 'tool',
        content: '',
        timestamp: 140,
        toolResults: [
          {
            toolCallId: 'tool-read-1',
            success: false,
            error: 'ENOENT: no such file',
            duration: 12,
          },
        ],
      },
      {
        id: 'assistant-2',
        role: 'assistant',
        content: '换正确路径。',
        timestamp: 180,
        toolCalls: [
          {
            id: 'tool-read-2',
            name: 'read_file',
            arguments: { file_path: 'src/main.ts' },
            result: {
              toolCallId: 'tool-read-2',
              success: true,
              output: 'export const ok = true;',
              duration: 8,
            },
          },
        ],
      },
    ]);

    const replay = await getTelemetryQueryService().getStructuredReplay('session-tools-1');
    const blocks = replay?.turns[0]?.blocks || [];
    const toolBlocks = blocks.filter(block => block.type === 'tool_call');
    const toolResultBlocks = blocks.filter(block => block.type === 'tool_result');

    expect(replay?.summary.toolDistribution.Read).toBe(2);
    expect(replay?.summary.selfRepairChains).toBe(1);
    expect(replay?.summary.metricAvailability).toEqual({
      dataSource: 'transcript_fallback',
      replaySource: 'transcript_fallback',
      toolDistribution: 'transcript',
      selfRepair: 'transcript',
      actualArgs: 'transcript',
    });
    expect(toolBlocks).toHaveLength(2);
    expect(toolBlocks[0]?.toolCall).toMatchObject({
      id: 'tool-read-1',
      name: 'read_file',
      args: { file_path: 'src/missing.ts' },
      actualArgs: { file_path: 'src/missing.ts' },
      argsSource: 'transcript',
      success: false,
      successKnown: true,
    });
    expect(toolBlocks[1]?.toolCall).toMatchObject({
      id: 'tool-read-2',
      name: 'read_file',
      args: { file_path: 'src/main.ts' },
      result: 'export const ok = true;',
      success: true,
      successKnown: true,
    });
    expect(toolResultBlocks).toEqual([
      {
        type: 'tool_result',
        content: 'ENOENT: no such file',
        timestamp: 140,
        toolCall: expect.objectContaining({
          id: 'tool-read-1',
          name: 'read_file',
          args: { file_path: 'src/missing.ts' },
          result: 'ENOENT: no such file',
          success: false,
          successKnown: true,
        }),
      },
    ]);
  });

  it('uses telemetry actual arguments when all tool call rows provide them', async () => {
    createTelemetryReplayTables();
    dbState.sqlite!.prepare('INSERT INTO telemetry_sessions (id) VALUES (?)').run('session-telemetry-args');
    dbState.sqlite!.prepare(`
      INSERT INTO telemetry_turns (
        id, session_id, turn_number, user_prompt, assistant_response, start_time, end_time,
        duration_ms, total_input_tokens, total_output_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('turn-1', 'session-telemetry-args', 1, '读真实路径', '完成', 100, 150, 50, 10, 12);
    dbState.sqlite!.prepare(`
      INSERT INTO telemetry_tool_calls (
        id, turn_id, session_id, tool_call_id, name, arguments, actual_arguments,
        result_summary, success, duration_ms, timestamp, idx, parallel
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'row-1',
      'turn-1',
      'session-telemetry-args',
      'tool-read-1',
      'read_file',
      '{"file_path":"[redacted]"}',
      '{"file_path":"src/main.ts"}',
      'ok',
      1,
      8,
      120,
      0,
      0
    );

    const replay = await getTelemetryQueryService().getStructuredReplay('session-telemetry-args');
    const toolBlock = replay?.turns[0]?.blocks.find(block => block.type === 'tool_call');

    expect(replay?.traceIdentity).toEqual(buildSessionTraceIdentity('session-telemetry-args'));
    expect(replay?.traceSource).toBe('session_replay');
    expect(replay?.dataSource).toBe('telemetry');
    expect(replay?.summary.metricAvailability?.dataSource).toBe('telemetry');
    expect(replay?.summary.metricAvailability?.actualArgs).toBe('telemetry');
    expect(toolBlock?.toolCall).toMatchObject({
      id: 'tool-read-1',
      name: 'read_file',
      args: { file_path: 'src/main.ts' },
      actualArgs: { file_path: 'src/main.ts' },
      argsSource: 'telemetry_actual',
    });
  });

  it('marks telemetry actual arguments as partial when only some rows provide them', async () => {
    createTelemetryReplayTables();
    dbState.sqlite!.prepare('INSERT INTO telemetry_sessions (id) VALUES (?)').run('session-partial-args');
    dbState.sqlite!.prepare(`
      INSERT INTO telemetry_turns (
        id, session_id, turn_number, user_prompt, assistant_response, start_time, end_time,
        duration_ms, total_input_tokens, total_output_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('turn-1', 'session-partial-args', 1, '读两个文件', '完成', 100, 180, 80, 10, 12);
    const insertTool = dbState.sqlite!.prepare(`
      INSERT INTO telemetry_tool_calls (
        id, turn_id, session_id, tool_call_id, name, arguments, actual_arguments,
        result_summary, success, duration_ms, timestamp, idx, parallel
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertTool.run(
      'row-1',
      'turn-1',
      'session-partial-args',
      'tool-read-1',
      'read_file',
      '{"file_path":"safe-a.ts"}',
      '{"file_path":"actual-a.ts"}',
      'ok',
      1,
      8,
      120,
      0,
      0
    );
    insertTool.run(
      'row-2',
      'turn-1',
      'session-partial-args',
      'tool-read-2',
      'read_file',
      '{"file_path":"safe-b.ts"}',
      null,
      'ok',
      1,
      9,
      130,
      1,
      0
    );

    const replay = await getTelemetryQueryService().getStructuredReplay('session-partial-args');

    expect(replay?.dataSource).toBe('telemetry');
    expect(replay?.summary.metricAvailability?.actualArgs).toBe('partial');
  });

  it('exposes incomplete reasons when telemetry lacks model decisions or tool schemas', async () => {
    createTelemetryReplayTables();
    dbState.sqlite!.prepare('INSERT INTO telemetry_sessions (id) VALUES (?)').run('session-incomplete-gate');
    dbState.sqlite!.prepare(`
      INSERT INTO telemetry_turns (
        id, session_id, turn_number, user_prompt, assistant_response, start_time, end_time,
        duration_ms, total_input_tokens, total_output_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('turn-1', 'session-incomplete-gate', 1, '读文件', '完成', 100, 160, 60, 10, 12);
    dbState.sqlite!.prepare(`
      INSERT INTO telemetry_tool_calls (
        id, turn_id, session_id, tool_call_id, name, arguments, actual_arguments,
        result_summary, success, duration_ms, timestamp, idx, parallel
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'row-1',
      'turn-1',
      'session-incomplete-gate',
      'tool-read-1',
      'read_file',
      '{"file_path":"safe.ts"}',
      '{"file_path":"actual.ts"}',
      'ok',
      1,
      8,
      120,
      0,
      0
    );
    dbState.sqlite!.prepare(`
      INSERT INTO telemetry_events (
        id, turn_id, session_id, timestamp, event_type, summary, data, duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'event-1',
      'turn-1',
      'session-incomplete-gate',
      130,
      'agent_event',
      'generic event present',
      '{}',
      null,
    );

    const replay = await getTelemetryQueryService().getStructuredReplay('session-incomplete-gate');

    expect(replay?.dataSource).toBe('telemetry');
    expect(replay?.summary.telemetryCompleteness).toMatchObject({
      sessionId: 'session-incomplete-gate',
      replayKey: 'session-incomplete-gate',
      dataSource: 'telemetry',
      hasRealAgentTrace: false,
      hasModelDecisions: false,
      hasToolSchemas: false,
      modelCallCount: 0,
      toolCallCount: 1,
      eventCount: 1,
      incompleteReasons: expect.arrayContaining([
        'missing_model_decisions',
        'missing_tool_schemas',
      ]),
    });
  });

  it('joins model decisions, events, permission trace, and subagent telemetry in structured replay', async () => {
    createTelemetryReplayTables();
    dbState.sqlite!.prepare('INSERT INTO telemetry_sessions (id) VALUES (?)').run('session-replay-join');
    dbState.sqlite!.prepare(`
      INSERT INTO telemetry_turns (
        id, session_id, turn_number, agent_id, turn_type, parent_turn_id,
        user_prompt, assistant_response, start_time, end_time,
        duration_ms, total_input_tokens, total_output_tokens, compaction_occurred
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'turn-sub-1',
      'session-replay-join',
      1,
      'agent-reviewer',
      'iteration',
      'parent-turn-1',
      '检查权限',
      '完成',
      100,
      180,
      80,
      10,
      8,
      1,
    );
    dbState.sqlite!.prepare(`
      INSERT INTO telemetry_model_calls (
        id, turn_id, session_id, timestamp, provider, model,
        input_tokens, output_tokens, latency_ms, response_type,
        tool_call_count, truncated, prompt, completion
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'mc-1',
      'turn-sub-1',
      'session-replay-join',
      110,
      'mock',
      'gpt-test',
      10,
      8,
      12,
      'tool_use',
      2,
      0,
      '[user] 检查权限',
      '[tools: read_file({"file_path":"safe.ts"})]',
    );
    dbState.sqlite!.prepare(`
      INSERT INTO telemetry_tool_calls (
        id, turn_id, session_id, tool_call_id, name, arguments, actual_arguments,
        result_summary, success, duration_ms, timestamp, idx, parallel
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'row-1',
      'turn-sub-1',
      'session-replay-join',
      'tool-read-1',
      'read_file',
      '{"file_path":"safe.ts"}',
      '{"file_path":"actual.ts"}',
      'ok',
      1,
      9,
      120,
      0,
      0,
    );
    dbState.sqlite!.prepare(`
      INSERT INTO telemetry_tool_calls (
        id, turn_id, session_id, tool_call_id, name, arguments, actual_arguments,
        result_summary, success, duration_ms, timestamp, idx, parallel
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'row-2',
      'turn-sub-1',
      'session-replay-join',
      'tool-write-1',
      'write_file',
      '{"file_path":"out.ts"}',
      '{"file_path":"out.ts","content":"ok"}',
      'written',
      1,
      7,
      125,
      1,
      0,
    );
    const insertEvent = dbState.sqlite!.prepare(`
      INSERT INTO telemetry_events (
        id, turn_id, session_id, timestamp, event_type, summary, data, duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertEvent.run(
      'event-1',
      'turn-sub-1',
      'session-replay-join',
      115,
      'permission_denied',
      'Permission denied once',
      '{"name":"read_file","reason":"denied"}',
      null,
    );
    insertEvent.run(
      'event-2',
      'turn-sub-1',
      'session-replay-join',
      130,
      'context_compressed',
      'Context compaction triggered',
      '{"savedTokens":123}',
      null,
    );
    insertEvent.run(
      'event-3',
      'turn-sub-1',
      'session-replay-join',
      105,
      'tool_schema_snapshot',
      '1 tool schemas available',
      '{"tools":[{"name":"read_file","inputSchema":{"type":"object"},"requiresPermission":false,"permissionLevel":"read"}]}',
      null,
    );

    const replay = await getTelemetryQueryService().getStructuredReplay('session-replay-join');
    const blocks = replay?.turns[0]?.blocks || [];
    const modelBlockIndex = blocks.findIndex(block => block.type === 'model_call');
    const permissionEventIndex = blocks.findIndex(block => block.type === 'event' && block.event?.eventType === 'permission_denied');
    const firstToolBlockIndex = blocks.findIndex(block => block.type === 'tool_call');
    const contextEventIndex = blocks.findIndex(block => block.type === 'context_event');

    expect(replay?.turns[0]).toMatchObject({
      agentId: 'agent-reviewer',
      turnType: 'iteration',
      parentTurnId: 'parent-turn-1',
    });
    expect(modelBlockIndex).toBeGreaterThanOrEqual(0);
    expect(permissionEventIndex).toBeGreaterThan(modelBlockIndex);
    expect(firstToolBlockIndex).toBeGreaterThan(permissionEventIndex);
    expect(contextEventIndex).toBeGreaterThan(firstToolBlockIndex);
    const modelBlock = blocks.find(block => block.type === 'model_call');
    expect(modelBlock?.modelDecision).toMatchObject({
      id: 'mc-1',
      toolSchemas: [
        expect.objectContaining({
          name: 'read_file',
          inputSchema: { type: 'object' },
        }),
      ],
    });
    expect(blocks.some(block => block.type === 'context_event')).toBe(true);
    const toolBlocks = blocks.filter(block => block.type === 'tool_call');
    const readToolBlock = toolBlocks.find(block => block.toolCall?.name === 'read_file');
    const writeToolBlock = toolBlocks.find(block => block.toolCall?.name === 'write_file');
    expect(readToolBlock?.toolCall).toMatchObject({
      id: 'tool-read-1',
      name: 'read_file',
      permissionTrace: [
        expect.objectContaining({
          eventType: 'permission_denied',
          summary: 'Permission denied once',
        }),
      ],
    });
    expect(writeToolBlock?.toolCall?.permissionTrace).toBeUndefined();
    expect(replay?.summary.telemetryCompleteness).toMatchObject({
      sessionId: 'session-replay-join',
      replayKey: 'session-replay-join',
      modelCallCount: 1,
      toolCallCount: 2,
      eventCount: 3,
      hasModelDecisions: true,
      hasToolSchemas: true,
      hasPermissionTrace: true,
      hasContextCompressionEvents: true,
      hasSubagentTelemetry: true,
      hasRealAgentTrace: true,
      dataSource: 'telemetry',
      incompleteReasons: [],
    });
  });
});
