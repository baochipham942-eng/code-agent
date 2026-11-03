// N-CUA-SCREEN-GUARDS-LADDER：能力阶梯规则必须常驻系统提示词，不依赖 cua 安装态。
// 设计选项 A：规则写在 TOOLS_PROMPT（常驻段）而不是 buildComputerUseBlock——
// 后者在 cua 能力未安装时返回空串，带不了「cua 开没开都成立」的规则。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPrompt } from '../../../src/host/prompts/builder';
import { isComputerUseCapabilityInstalledSync } from '../../../src/host/plugins/builtin/computerUse/installState';

describe('cua screen ladder rule in system prompt (N-CUA-SCREEN-GUARDS-LADDER)', () => {
  const PREV_DATA_DIR = process.env.CODE_AGENT_DATA_DIR;
  const PREV_ENABLE_CUA = process.env.CODE_AGENT_ENABLE_CUA;
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cua-ladder-rule-'));
    process.env.CODE_AGENT_DATA_DIR = dataDir;
    delete process.env.CODE_AGENT_ENABLE_CUA;
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (PREV_DATA_DIR === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = PREV_DATA_DIR;
    if (PREV_ENABLE_CUA !== undefined) process.env.CODE_AGENT_ENABLE_CUA = PREV_ENABLE_CUA;
  });

  it('rule text is in buildPrompt() output with cua NOT installed', () => {
    // 前提钉死：空数据目录 + 无 legacy env → cua 能力未安装。
    expect(isComputerUseCapabilityInstalledSync()).toBe(false);

    const prompt = buildPrompt();
    expect(prompt).toContain(
      'Capability ladder: connectors/native tools first (mail, calendar, reminders, MCP, files, shell); `browser_action` for web pages; screen control (`mcp__cua-driver__*`, `computer_use`) only when nothing above works.',
    );
    expect(prompt).toContain(
      "Before a task's first screen action, say ONE sentence in the user's language naming the app and why no connector/browser route works; if a connector is unavailable, say so and continue under normal per-app approval",
    );
  });
});
