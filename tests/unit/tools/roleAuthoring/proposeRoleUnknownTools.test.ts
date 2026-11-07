// ============================================================================
// propose_role 工具名校验 — 编造的工具名不得入队 / 映射表与注册表不漂移 / 端到端无启动期报错
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));
const loaderErrorSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => mockConfigDir.dir,
  getAgentsMdDir: () => ({ user: path.join(mockConfigDir.dir, 'agents') }),
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: loaderErrorSpy, debug: vi.fn() }),
}));

vi.mock('../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getMessages: async () => [{ id: 'u1', role: 'user', content: '帮我想想要不要建个日程助理', timestamp: 1 }],
    getSession: async () => ({ origin: undefined }),
  }),
}));

vi.mock('../../../../src/host/permissions/modes', () => ({
  getPermissionModeManager: () => ({ isUnattendedSession: () => false }),
}));

import { proposeRoleModule } from '../../../../src/host/tools/modules/roleAuthoring/proposeRole';
import { getProtocolRegistry } from '../../../../src/host/tools/protocolRegistry';
import { getKnownToolNames } from '../../../../src/host/tools/knownToolNames';
import { confirmRoleDraft, getRoleDraftsDir } from '../../../../src/host/services/roleAssets/roleDraftQueue';
import { loadAgentMdFiles } from '../../../../src/host/agent/hybrid/agentMdLoader';
import { BUILTIN_SKILLS } from '../../../../src/host/services/skills/builtinSkillsData';

function makeCtx() {
  return {
    sessionId: 'sess-1',
    workingDir: mockConfigDir.dir,
    abortSignal: { aborted: false } as AbortSignal,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    emit: vi.fn(),
  };
}
const allow = vi.fn(async () => ({ allow: true }));

async function propose(tools: string[], ctx = makeCtx()) {
  const handler = await proposeRoleModule.createHandler();
  const result = await handler.execute(
    { roleId: '日程助理', description: '管日程', category: 'automation', tools, systemPrompt: '你是日程助理。' },
    ctx as never,
    allow as never,
  );
  return { result, ctx };
}

async function draftDirExists(): Promise<boolean> {
  try {
    return (await fs.readdir(getRoleDraftsDir())).length > 0;
  } catch {
    return false;
  }
}

describe('propose_role 工具名校验', () => {
  beforeEach(async () => {
    loaderErrorSpy.mockClear();
    getProtocolRegistry();
    mockConfigDir.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'propose-role-tools-'));
  });
  afterEach(async () => {
    await fs.rm(mockConfigDir.dir, { recursive: true, force: true });
  });

  it('编造的工具名：ok:false，不写草稿、不发事件，错误点名并给出最接近的真实名', async () => {
    const { result, ctx } = await propose(['tmeetCalendarList', 'MemoryRead']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('UNKNOWN_TOOLS');
    expect(result.error).toContain('tmeetCalendarList');
    expect(result.error).toContain('tmeetMeetingList');
    expect(result.error).toContain('calendar');
    expect(result.error).toContain('plain Chinese');
    expect(ctx.emit).not.toHaveBeenCalled();
    expect(await draftDirExists()).toBe(false);
  });

  it('真实工具名：ok:true 并发事件', async () => {
    const { result, ctx } = await propose(['calendar', 'reminders', 'MemoryRead', 'MemoryWrite']);
    expect(result.ok).toBe(true);
    expect(ctx.emit).toHaveBeenCalledTimes(1);
  });

  it('漂移门：create-role 常用映射里的每个工具名都在注册表里', () => {
    getProtocolRegistry();
    const known = getKnownToolNames();
    const skill = BUILTIN_SKILLS.find((s) => s.name === 'create-role');
    const prompt = skill?.promptContent ?? '';
    const block = prompt.slice(prompt.indexOf('常用映射'), prompt.indexOf('调用前用一句话'));
    const names = new Set<string>();
    for (const line of block.split('\n').filter((l) => l.includes('→'))) {
      // 括号内也是要比对的工具名（calendar_create_event / reminders_create 只出现在括号里），
      // 故不再剥掉全角括号，而是把括号当分隔符一并分词；action=xxx 是 calendar 的动作值
      // 不是工具名，先剔除，避免 list_events 被当成工具名进漂移比对。
      const rhs = line.split('→')[1].replace(/action\s*=\s*[A-Za-z0-9_]+/g, ' ');
      for (const token of rhs.split(/[（）\s,，+、；]+/)) {
        if (/^[A-Za-z][A-Za-z0-9_]*$/.test(token)) names.add(token);
      }
    }
    for (const required of [
      'calendar',
      'reminders',
      'mail',
      'mail_draft',
      'tmeetMeetingList',
      'calendar_create_event',
      'reminders_create',
      'mail_send',
    ]) {
      expect(names.has(required)).toBe(true);
    }
    const missing = [...names].filter((n) => !known.has(n));
    expect(missing).toEqual([]);
  });

  it('端到端：真实名起草 → 确认 → loadAgentMdFiles 不报「不存在的工具」', async () => {
    const { result } = await propose(['calendar', 'reminders', 'MemoryRead', 'MemoryWrite']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const draftId = (result.meta as { draftId: string }).draftId;
    const confirmed = await confirmRoleDraft(draftId);
    expect(confirmed.success).toBe(true);
    loaderErrorSpy.mockClear();
    const agents = await loadAgentMdFiles(path.join(mockConfigDir.dir, 'agents'));
    expect(agents.length).toBeGreaterThan(0);
    expect(loaderErrorSpy).not.toHaveBeenCalled();
  });
});
