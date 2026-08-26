import type { CliConnectorDescriptor } from '../contract/cliConnectorDescriptor';

const LARK_CLI_PROFILE = 'neo';
const LARK_CLI_SCOPE = 'offline_access im:message im:message.send_as_user';

export const feishuCliDescriptor = {
  id: 'feishu',
  displayName: '飞书',
  toolNames: [],
  loggerName: 'FeishuLarkCli',
  installDirectory: 'lark-cli',
  npmPackage: '@larksuite/cli',
  version: '1.0.89',
  packagePath: ['@larksuite', 'cli'],
  binaryPath: ['bin', 'lark-cli'],
  binaryName: 'lark-cli',
  profileArguments: ['--profile', LARK_CLI_PROFILE],
  env: {
    remove: ['OPENCLAW_HOME', 'HERMES_HOME'],
  },
  authSteps: [
    {
      kind: 'url',
      step: 1,
      skipIf: {
        args: ['config', 'show'],
        label: 'lark-cli config show',
        profile: 'append',
      },
      command: {
        args: ['config', 'init', '--new', '--lang', 'zh', '--name', LARK_CLI_PROFILE],
        label: 'lark-cli config init',
      },
      urlPattern: /https:\/\/open\.feishu\.cn\/[^\s"'<>]+/u,
      missingUrlMessage: 'lark-cli config init did not return a Feishu setup URL',
      openUrlErrorMessage: 'Could not open the Feishu setup URL',
    },
    {
      kind: 'device-code',
      step: 2,
      command: {
        args: [
          'auth', 'login', '--no-wait', '--json',
          '--scope', LARK_CLI_SCOPE,
        ],
        label: 'lark-cli auth login',
        profile: 'append',
      },
      deviceCodeField: 'device_code',
      verificationUrlField: 'verification_url',
      followUp: {
        args: ['auth', 'login', '--device-code', '__DEVICE_CODE__'],
        label: 'lark-cli device authorization',
        profile: 'append',
      },
      deviceCodePlaceholder: '__DEVICE_CODE__',
      missingDeviceCodeMessage: 'lark-cli auth login did not return a device code',
    },
  ],
  status: {
    command: {
      args: ['auth', 'status', '--json'],
      label: 'lark-cli auth status',
      profile: 'append',
    },
    match: {
      type: 'json-path',
      path: ['identities', 'user', 'available'],
      equals: true,
    },
    identityPath: ['identity'],
    disconnectedIdentity: 'none',
    connectedIdentity: 'user',
    user: {
      rootPath: ['identities', 'user'],
      openIdPath: ['openId'],
      namePath: ['userName'],
      tenantNamePath: ['tenantName'],
    },
  },
  logout: {
    args: ['auth', 'logout'],
    label: 'lark-cli auth logout',
    profile: 'append',
  },
  missingConfigurationPattern: /not_configured|profile\s+.+not found|not configured/iu,
  errorMappings: [{
    codes: '*',
    outputPattern: /scope|permission|admin|tenant|免审|权限|企业|管理员|拒绝|denied|rejected/iu,
    message: '需联系企业应用管理员安装',
    logMessage: 'Feishu lark-cli authorization rejected',
  }],
} satisfies CliConnectorDescriptor;

export const tmeetDescriptor = {
  id: 'tmeet',
  displayName: '腾讯会议',
  displayNameEn: 'Tencent Meeting',
  logo: 'tmeet',
  toolNames: ['tmeetMeetingList', 'tmeetMeetingCreate', 'tmeetMeetingSearch'],
  writeActions: {
    tmeetMeetingCreate: { zh: '创建会议', en: 'create a meeting' },
  },
  editablePermissionFields: {
    tmeetMeetingCreate: [
      { key: 'subject', kind: 'string', required: true },
      { key: 'start', kind: 'string', required: true },
      { key: 'end', kind: 'string', required: true },
    ],
  },
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

export const CLI_CONNECTOR_DESCRIPTORS: CliConnectorDescriptor[] = [
  feishuCliDescriptor,
  tmeetDescriptor,
];
