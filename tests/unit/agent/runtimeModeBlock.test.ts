import { afterEach, describe, expect, it } from 'vitest';
import { buildRuntimeModeBlock } from '../../../src/host/agent/messageHandling/contextBuilder';

describe('buildRuntimeModeBlock', () => {
  const previousCliMode = process.env.CODE_AGENT_CLI_MODE;
  const previousWebMode = process.env.CODE_AGENT_WEB_MODE;
  const previousEvalRealRoot = process.env.CODE_AGENT_EVAL_REAL_ROOT;

  afterEach(() => {
    if (previousCliMode === undefined) delete process.env.CODE_AGENT_CLI_MODE;
    else process.env.CODE_AGENT_CLI_MODE = previousCliMode;

    if (previousWebMode === undefined) delete process.env.CODE_AGENT_WEB_MODE;
    else process.env.CODE_AGENT_WEB_MODE = previousWebMode;

    if (previousEvalRealRoot === undefined) delete process.env.CODE_AGENT_EVAL_REAL_ROOT;
    else process.env.CODE_AGENT_EVAL_REAL_ROOT = previousEvalRealRoot;
  });

  it('does not describe app-host web mode as CLI-only', () => {
    process.env.CODE_AGENT_CLI_MODE = 'true';
    process.env.CODE_AGENT_WEB_MODE = 'true';

    const block = buildRuntimeModeBlock();

    expect(block).toContain('app-host web runtime');
    expect(block).toContain('visual chat interface');
    expect(block).not.toContain('GUI features (screenshot, browser_action) are unavailable');
  });

  // N-PROMPT-TERMINAL：右栏共用交互终端是真话——desktop/web 两档都要讲清右栏终端、
  // terminal_open 入口与 ToolSearch 加载指引，不许再说 "not a terminal" 把用户推回去自己开终端。
  it('desktop and web runtime modes describe the shared right-rail terminal instead of denying it', () => {
    process.env.CODE_AGENT_WEB_MODE = 'true';
    const webBlock = buildRuntimeModeBlock();

    delete process.env.CODE_AGENT_WEB_MODE;
    delete process.env.CODE_AGENT_CLI_MODE;
    const desktopBlock = buildRuntimeModeBlock();

    for (const block of [webBlock, desktopBlock]) {
      expect(block).toContain('shared interactive terminal');
      expect(block).toContain('right rail');
      expect(block).toContain('terminal_open');
      expect(block).toContain('ToolSearch');
      expect(block).not.toContain('not a terminal');
    }
  });

  it('keeps CLI-only guidance for real terminal mode', () => {
    process.env.CODE_AGENT_CLI_MODE = 'true';
    delete process.env.CODE_AGENT_WEB_MODE;

    const block = buildRuntimeModeBlock();

    expect(block).toContain('CLI mode');
    expect(block).toContain('GUI features (screenshot, browser_action) are unavailable');
  });

  it('omits the source path only when it equals the working directory', () => {
    delete process.env.CODE_AGENT_CLI_MODE;
    delete process.env.CODE_AGENT_WEB_MODE;

    const samePathBlock = buildRuntimeModeBlock(process.cwd());
    const differentPathBlock = buildRuntimeModeBlock('/tmp/another-worktree');

    expect(samePathBlock).not.toContain('Your own source code is at:');
    expect(differentPathBlock).toContain(`Your own source code is at: ${process.cwd()}`);
  });

  // N-EVAL-L3-WORKDIR：评测沙箱是仓库副本（eval-sandbox 设 CODE_AGENT_EVAL_REAL_ROOT），不许再指回原仓——
  // 09-02 L3 真跑里模型照这句去 ~/…/code-agent/casebank-* 找题目目录，找不到就 find / 全盘搜。
  it('inside an eval sandbox (CODE_AGENT_EVAL_REAL_ROOT set) never points the model back at the original repo', () => {
    delete process.env.CODE_AGENT_CLI_MODE;
    delete process.env.CODE_AGENT_WEB_MODE;
    process.env.CODE_AGENT_EVAL_REAL_ROOT = process.cwd();

    const sandboxBlock = buildRuntimeModeBlock('/tmp/case-abc123');

    expect(sandboxBlock).not.toContain('Your own source code is at:');
    expect(sandboxBlock).not.toContain('not the sandbox working directory');
    expect(sandboxBlock).toContain('You ARE the');
  });
});
