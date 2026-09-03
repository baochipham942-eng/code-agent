import { describe, expect, it } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { SandboxManager } from '../../../../src/host/sandbox/manager';

describe('sandbox npm environment', () => {
  it.each(['development', 'full'] as const)('%s preset pins npm state under TMPDIR', (preset) => {
    const config = SandboxManager.createPreset(preset);
    const npmHome = path.join(process.env.TMPDIR || os.tmpdir(), 'neo-npm');
    const userConfig = config.customEnv?.npm_config_userconfig;

    expect(userConfig).toMatch(new RegExp(`^${npmHome}/[^/]+/npmrc$`));
    const runHome = path.dirname(userConfig!);
    expect(config.customEnv).toEqual({
      npm_config_userconfig: path.join(runHome, 'npmrc'),
      npm_config_cache: path.join(runHome, 'cache'),
      npm_config_logs_dir: path.join(runHome, 'logs'),
      npm_config_update_notifier: 'false',
    });
  });
});
