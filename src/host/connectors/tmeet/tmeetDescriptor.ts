import type { CliConnectorDescriptor } from '../cli/cliConnector';

export const tmeetDescriptor = {
  id: 'tmeet',
  displayName: '腾讯会议',
  loggerName: 'TencentMeetingCli',
  installDirectory: 'tmeet',
  npmPackage: '@tencentcloud/tmeet',
  version: '1.0.15',
  packageJsonVersion: 'v1.0.15',
  packagePath: ['@tencentcloud', 'tmeet'],
  binaryPath: ['scripts', 'tmeet.js'],
  binaryName: 'tmeet',
  env: {
    remove: ['OPENCLAW_HOME', 'HERMES_HOME'],
    add: {
      TMEET_AGENT: 'AgentNeo',
      TMEET_MODEL: 'unknown',
    },
  },
  authSteps: [{
    kind: 'pty-url',
    step: 1,
    command: {
      args: ['auth', 'login', '--no-browser'],
      label: 'tmeet auth login',
    },
    urlPattern: /https:\/\/[^\s"'<>]*meeting\.tencent\.com\/[^\s"'<>]*/iu,
    missingUrlMessage: 'tmeet auth login did not return an authorization URL',
    openUrlErrorMessage: 'Could not open the Tencent Meeting authorization URL',
    pollStatusAfterExit: true,
    pollIntervalMs: 1_000,
  }],
  status: {
    command: {
      args: ['auth', 'status'],
      label: 'tmeet auth status',
    },
    match: {
      type: 'text',
      pattern: /(?:^|\n)Logged in\b/iu,
    },
    disconnectedIdentity: 'none',
    connectedIdentity: 'user',
  },
  logout: {
    args: ['auth', 'logout'],
    label: 'tmeet auth logout',
  },
  missingConfigurationPattern: /user config is empty|not logged in/iu,
  errorMappings: [
    {
      codes: ['190004'],
      message: 'Tencent Meeting rejected the requested time range. Use a valid ISO 8601 range.',
    },
    {
      outputPattern: /user has been initialized/iu,
      message: 'Tencent Meeting is already authorized on this device.',
    },
  ],
} satisfies CliConnectorDescriptor;
