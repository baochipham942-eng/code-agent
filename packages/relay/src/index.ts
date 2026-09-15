import { readFileSync } from 'node:fs';
import process from 'node:process';
import { COMPANION_LIMITS as L } from '../../../src/shared/constants/companion';
import { CompanionRelayServer, type CompanionRelayLogger } from './server';

/**
 * neo-companion-relay 独立服务入口。所有输入走环境变量（systemd EnvironmentFile）：
 *   NEO_RELAY_PORT             监听端口（必填）
 *   NEO_RELAY_CREDENTIAL       路由凭据（与 NEO_RELAY_CREDENTIAL_FILE 二选一）
 *   NEO_RELAY_CREDENTIAL_FILE  凭据文件路径（600，部署脚本写入）。注意：随附 systemd unit
 *                              开了 ProtectHome=true，/home 下的路径读不到——文件放 /etc 一类
 *                              系统路径，或在 unit 里放宽 ProtectHome
 *   NEO_RELAY_BIND             监听地址，只接受回环地址，缺省 127.0.0.1
 * 日志为 JSON 行打到 stdout，由 journald 接管。TLS 终止与公网暴露是反代层（Caddy）的活。
 */

const LOOPBACK_BINDS = new Set(['127.0.0.1', '::1', 'localhost']);

function jsonLogger(): CompanionRelayLogger {
  const write = (level: string, event: string, fields: Record<string, unknown>) => {
    process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })}\n`);
  };
  return {
    info: (event, fields = {}) => write('info', event, fields),
    warn: (event, fields = {}) => write('warn', event, fields),
  };
}

function fail(message: string): never {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level: 'error', event: 'relay_config_error', message })}\n`);
  process.exit(1);
}

const portRaw = process.env.NEO_RELAY_PORT;
if (!portRaw) fail('NEO_RELAY_PORT is required');
const port = Number(portRaw);
if (!Number.isInteger(port) || port < 1 || port > 65_535) fail(`NEO_RELAY_PORT is not a valid port: ${portRaw}`);

const bind = process.env.NEO_RELAY_BIND ?? '127.0.0.1';
if (!LOOPBACK_BINDS.has(bind)) fail(`NEO_RELAY_BIND must be loopback (127.0.0.1/::1/localhost), got: ${bind}`);

const credentialFile = process.env.NEO_RELAY_CREDENTIAL_FILE;
const credential = process.env.NEO_RELAY_CREDENTIAL
  ?? (credentialFile ? readFileSync(credentialFile, 'utf8').trim() : undefined);
if (!credential) fail('NEO_RELAY_CREDENTIAL or NEO_RELAY_CREDENTIAL_FILE is required');
if (credential.length < L.relayAuthLength) fail(`credential shorter than ${L.relayAuthLength} chars`);

const server = new CompanionRelayServer({ credential, host: bind, port, logger: jsonLogger() });
let stopping = false;

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  await server.stop();
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level: 'info', event: 'relay_exit', signal })}\n`);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('uncaughtException', error => {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level: 'error', event: 'relay_uncaught', message: String(error) })}\n`);
  process.exit(1);
});

server.listen().catch(error => fail(`listen failed: ${String(error)}`));
