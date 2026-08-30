// ============================================================================
// envSecretFilter (A8) unit tests
// ============================================================================

import { describe, it, expect } from 'vitest';
import { filterSecretEnvVars } from '../../../src/host/utils/envSecretFilter';

describe('filterSecretEnvVars', () => {
  it('strips *_KEY / *_TOKEN / *_SECRET names', () => {
    const { env, strippedNames } = filterSecretEnvVars({
      ANTHROPIC_API_KEY: 'sk-1',
      GITHUB_TOKEN: 'tok-1',
      AWS_SECRET_ACCESS_KEY: 'sec-1',
      MY_APP_SECRET: 'sec-2',
      PATH: '/usr/bin',
      HOME: '/home/x',
      NORMAL_VAR: 'visible',
    });
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/x',
      NORMAL_VAR: 'visible',
    });
    expect(strippedNames.sort()).toEqual([
      'ANTHROPIC_API_KEY',
      'AWS_SECRET_ACCESS_KEY',
      'GITHUB_TOKEN',
      'MY_APP_SECRET',
    ]);
  });

  it('matches case-insensitively (Windows env names are case-insensitive)', () => {
    const { env } = filterSecretEnvVars({
      api_key: 'x',
      My_Token: 'y',
      lowercase_secret: 'z',
    });
    expect(env).toEqual({});
  });

  it('strips the extended same-class suffixes (_PASSWORD/_PASSWD/_PWD/_CREDENTIALS)', () => {
    const { env } = filterSecretEnvVars({
      DB_PASSWORD: 'x',
      MYSQL_PWD: 'y',
      OLD_PASSWD: 'z',
      GCLOUD_CREDENTIALS: 'w',
    });
    expect(env).toEqual({});
  });

  it('requires the underscore delimiter (KEY/MONKEY/APIKEY survive)', () => {
    const { env } = filterSecretEnvVars({
      KEY: 'x',
      MONKEY: 'y',
      APIKEY: 'z',
      TOKEN: 't',
    });
    expect(env).toEqual({ KEY: 'x', MONKEY: 'y', APIKEY: 'z', TOKEN: 't' });
  });

  it('keeps common non-secret plumbing vars (documented empty core whitelist)', () => {
    const input = {
      PATH: '/usr/bin',
      HOME: '/home/x',
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
      SHELL: '/bin/zsh',
      XAUTHORITY: '/home/x/.Xauthority',
      SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
      GPG_TTY: '/dev/ttys001',
      PWD: '/work',
      OLDPWD: '/prev',
      npm_config_registry: 'https://registry.npmjs.org',
    };
    const { env, strippedNames } = filterSecretEnvVars(input);
    expect(env).toEqual(input);
    expect(strippedNames).toEqual([]);
  });

  it('allowedNames escape hatch lets matching vars through (case-insensitive)', () => {
    const { env, strippedNames } = filterSecretEnvVars(
      { E2E_FAKE_API_KEY: 'sk-plant', OTHER_TOKEN: 'tok' },
      { allowedNames: ['e2e_fake_api_key'] },
    );
    expect(env).toEqual({ E2E_FAKE_API_KEY: 'sk-plant' });
    expect(strippedNames).toEqual(['OTHER_TOKEN']);
  });

  it('does not mutate the input and never copies stripped values', () => {
    const input = { SECRET_KEY: 'do-not-copy', KEEP: '1' };
    const result = filterSecretEnvVars(input);
    expect(input).toEqual({ SECRET_KEY: 'do-not-copy', KEEP: '1' });
    expect(Object.values(result.env)).not.toContain('do-not-copy');
    expect(result.strippedNames).toEqual(['SECRET_KEY']);
  });
});
