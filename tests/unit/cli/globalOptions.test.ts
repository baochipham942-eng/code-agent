// ============================================================================
// CLI 全局选项注册（src/cli/globalOptions.ts）
// 与 `neo --help` 同源：index.ts 的根命令选项清单只此一份，这里钉住旗标面。
// ============================================================================
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { registerCLIGlobalOptions } from '../../../src/cli/globalOptions';

describe('CLI 全局选项（neo 根命令）', () => {
  it('注册 --bare 布尔旗标（不取值，无需进 requestedTopLevelCommand 的取值集合）', () => {
    const program = registerCLIGlobalOptions(new Command());
    const bare = program.options.find((option) => option.long === '--bare');
    expect(bare).toBeDefined();
    expect(bare?.flags).toBe('--bare');
    expect(bare?.required).toBeFalsy();
  });

  it('既有选项清单原样保留（只新增 --bare，不重命名不删除）', () => {
    const program = registerCLIGlobalOptions(new Command());
    expect(program.options.map((option) => option.long)).toEqual([
      '--project',
      '--json',
      '--model',
      '--provider',
      '--plan',
      '--debug',
      '--output-format',
      '--system-prompt',
      '--metrics',
      '--bare',
    ]);
  });

  it('--bare 解析为 true；不传时为 undefined（历史行为不变）', async () => {
    const bareProgram = registerCLIGlobalOptions(new Command());
    bareProgram.exitOverride();
    bareProgram.action(() => {});
    await bareProgram.parseAsync(['node', 'neo', '--bare']);
    expect(bareProgram.opts().bare).toBe(true);

    const plainProgram = registerCLIGlobalOptions(new Command());
    plainProgram.exitOverride();
    plainProgram.action(() => {});
    await plainProgram.parseAsync(['node', 'neo']);
    expect(plainProgram.opts().bare).toBeUndefined();
  });
});
