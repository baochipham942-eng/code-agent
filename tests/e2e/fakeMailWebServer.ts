// ============================================================================
// fakeMailWebServer —— N-TRIGGER-MAIL-CREATE-ENTRY-K1 截图夹具的 webServer 启动器。
//
// 从源码（tsx）启动 webServer，并先经 getConnectorRegistry().register() 注册一个
// 假 mail 连接器——截图走真 webServer + 真 IPC 域通道 + 真 store，只有 Mail 连接器
// 本体是假的（绝不触碰真实 Mail.app / AppleScript / TCC）。
//
// 形态由 NEO_FAKE_MAIL_STATE 选（每次 playwright 起一个进程跑一种）：
//   ready           — 已授权：两个账户 + 各自邮箱目录（编辑器正常态）
//   not-authorized  — readiness unchecked 且 probe_access 抛错（未授权态）
//   unsupported     — readiness unavailable（非 macOS 平台态）
//   not-enabled     — 不注册（设置里没启用；config.json 也不启用 mail）
//
// 数据目录（CODE_AGENT_DATA_DIR）里预写 connectors.enabledNative=['mail']
// （not-enabled 除外）：registry.configure() 对已注册的 id 幂等，假连接器得以
// 存活到 IPC 调用；不启用 mail 时 configure 会把预注册的假连接器摘掉。
// ============================================================================

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getConnectorRegistry } from '../../src/host/connectors/registry';
import type { Connector, ConnectorStatus } from '../../src/host/connectors/base';

const state = process.env.NEO_FAKE_MAIL_STATE ?? 'ready';
const dataDir = process.env.CODE_AGENT_DATA_DIR;
if (!dataDir) throw new Error('fakeMailWebServer: CODE_AGENT_DATA_DIR is required');

// settings.connectors.enabledNative（not-enabled 态不启用 mail，其余启用）。
mkdirSync(dataDir, { recursive: true });
writeFileSync(
  path.join(dataDir, 'config.json'),
  JSON.stringify({ connectors: { enabledNative: state === 'not-enabled' ? [] : ['mail'] } }, null, 2) + '\n',
);

const ACCOUNTS = [
  { name: 'iCloud · 艾达' },
  { name: 'Gmail · ada.example@gmail.com' },
];
const MAILBOXES_BY_ACCOUNT: Record<string, string[]> = {
  'iCloud · 艾达': ['INBOX', '归档', '已发送'],
  'Gmail · ada.example@gmail.com': ['INBOX', '工作'],
};

function status(readiness: ConnectorStatus['readiness'], connected = false): ConnectorStatus {
  return { connected, readiness, capabilities: ['list_accounts', 'list_mailboxes'] };
}

if (state !== 'not-enabled') {
  const fakeMail: Connector = {
    id: 'mail',
    label: 'Mail',
    capabilities: ['get_status', 'list_accounts', 'list_mailboxes', 'list_messages', 'read_message'],
    getCachedStatus: () => status(state === 'unsupported' ? 'unavailable' : state === 'ready' ? 'ready' : 'unchecked', state === 'ready'),
    getStatus: async () => status(state === 'unsupported' ? 'unavailable' : state === 'ready' ? 'ready' : 'unchecked', state === 'ready'),
    async execute(action, payload) {
      if (action === 'probe_access') {
        if (state === 'not-authorized') throw new Error('Automation access to Mail was denied');
        return { data: status('ready', true) };
      }
      if (action === 'list_accounts') return { data: ACCOUNTS };
      if (action === 'list_mailboxes') {
        const account = typeof payload.account === 'string' ? payload.account : '';
        return { data: (MAILBOXES_BY_ACCOUNT[account] ?? []).map((name) => ({ account, name })) };
      }
      return { data: [] };
    },
  };
  getConnectorRegistry().register(fakeMail);
}

// webServer.ts 在 import 期自动 main()（非 test 环境）。动态 import（不带顶层
// await——本文件会以 CJS bundle 跑）：假连接器先注册（configure 对已注册 id 幂等，
// 不会被真 mailConnector 覆盖），webServer 模块随后求值。
void import('../../src/web/webServer');
