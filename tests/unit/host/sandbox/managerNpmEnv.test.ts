import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SandboxManager } from '../../../../src/host/sandbox/manager';

describe('sandbox npm environment', () => {
  it.each(['development', 'full'] as const)('%s preset pins npm state under TMPDIR', (preset) => {
    const config = SandboxManager.createPreset(preset);
    const npmHome = path.join(process.env.TMPDIR || os.tmpdir(), 'neo-npm');

    expect(config.customEnv).toEqual({
      npm_config_userconfig: path.join(npmHome, 'npmrc'),
      npm_config_cache: path.join(npmHome, 'cache'),
      npm_config_logs_dir: path.join(npmHome, 'logs'),
      npm_config_update_notifier: 'false',
    });
    expect(fs.readFileSync(path.join(npmHome, 'npmrc'), 'utf8')).toBe('');
  });
});
