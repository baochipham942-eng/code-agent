/**
 * companion-relay-verify.ts — 对已部署的 companion relay 打一遍端到端：
 * 真 Host 客户端（CompanionRelayClient + in-memory CompanionGateway）↔ 部署的
 * relay ↔ phone stub（RelayPhoneStub）。覆盖握手、加密命令往返、幂等重放、
 * revoke 断路。跑在 relay 可达的本机（直连回环或经 ssh -L 隧道）。
 *
 * 用法：npx tsx scripts/deploy/companion-relay-verify.ts \
 *         --url ws://127.0.0.1:8791 --credential "$(cat ~/.ship/secrets/neo-relay-credential)"
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { CompanionGateway } from '../../src/host/services/companion/CompanionGateway';
import { CompanionRelayClient } from '../../src/host/services/companion/CompanionRelayClient';
import { createIdentity } from '../../src/shared/companion/noiseChannel';
import { toHex } from '../../src/shared/companion/lanProtocol';
import { RelayPhoneStub } from '../../tests/integration/companion/relayPhoneStub';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const usage = 'usage: companion-relay-verify.ts --url ws://127.0.0.1:<port> (--credential <secret> | --credential-file <path>)';

const receipts: string[] = [];
function receipt(line: string): void {
  receipts.push(line);
  console.log(`[verify] ${line}`);
}

async function main(): Promise<void> {
  const url = argValue('--url');
  const credentialValue = argValue('--credential');
  const credentialFile = argValue('--credential-file');
  if (!url) throw new Error(usage);
  let credential: string;
  if (credentialValue) credential = credentialValue;
  else if (credentialFile) credential = readFileSync(credentialFile, 'utf8').trim();
  else throw new Error(usage);

  const healthUrl = url.replace(/^ws/, 'http').replace(/\/$/, '') + '/healthz';
  const health = await fetch(healthUrl);
  if (!health.ok) throw new Error(`healthz ${health.status}`);
  receipt(`healthz ${health.status} ${JSON.stringify(await health.json())}`);

  let executions = 0;
  const db = new Database(':memory:');
  const gateway = new CompanionGateway(db, {
    dispatch: () => { executions += 1; return { state: 'accepted', result: { runId: 'verify-run' } }; },
  });
  const hostIdentity = createIdentity();
  const phoneIdentity = createIdentity();
  const device = gateway.pairIdentity(toHex(phoneIdentity.publicKey), ['shared']);
  const token = randomBytes(24).toString('base64url');

  const host = new CompanionRelayClient({
    gateway,
    identity: hostIdentity,
    config: { url, credentialRef: 'companion-relay', reconnectBackoffMs: [1_000, 2_000, 4_000] },
    credential,
  });
  host.advertise({ deviceRef: device.deviceId, routeToken: token });
  await host.start();
  await host.whenConnected();
  receipt('host dialed and registered');

  const phone = new RelayPhoneStub(phoneIdentity, token, device.deviceId);
  await phone.connect(url, credential);
  const binding = await phone.resume(toHex(hostIdentity.publicKey), url);
  receipt(`noise handshake ok, deviceId=${binding.deviceId}`);

  const command = (commandId: string, text: string) => ({
    version: 1, deviceId: binding.deviceId, commandId, scopeEpoch: 1, sessionId: 'shared',
    action: 'message.send' as const, payload: { text },
  });
  const first = await phone.request({ action: 'command', command: command('verify-once', 'verify-round-trip-正文') }) as { kind?: string };
  if (first.kind !== 'accepted') throw new Error(`first command not accepted: ${JSON.stringify(first)}`);
  if (executions !== 1) throw new Error(`expected 1 execution, got ${executions}`);
  receipt('encrypted round-trip accepted, executions=1');

  const replayed = await phone.request({ action: 'command', command: command('verify-once', 'verify-round-trip-正文') }) as { kind?: string };
  if (replayed.kind !== 'replayed') throw new Error(`replay not detected: ${JSON.stringify(replayed)}`);
  if (executions !== 1) throw new Error(`replay re-executed: executions=${executions}`);
  receipt('idempotent replay honored, executions still 1');

  gateway.revokeDevice(binding.deviceId);
  host.revoke(binding.deviceId);
  const deadline = Date.now() + 10_000;
  while (phone.connected && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  if (phone.connected) throw new Error('device still connected after revoke');
  receipt('revoke broke the device side');

  const after = await fetch(healthUrl);
  receipt(`healthz after verify ${after.status} ${JSON.stringify(await after.json())}`);

  phone.close();
  await host.stop();
  db.close();
  receipt('PASS: deployed relay end-to-end (host <-> relay <-> phone stub)');
}

main().catch(error => {
  console.error(`[verify] FAIL: ${String(error)}`);
  process.exit(String(error).includes('usage:') ? 2 : 1);
});
