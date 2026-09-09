import './remote-only.mjs';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const directory = resolve('.reports/lan-browser');
mkdirSync(directory, { recursive: true });
await build({ stdin: { contents: `
  import Database from 'better-sqlite3';
  import { networkInterfaces } from 'node:os';
  import { CompanionGateway } from '../../src/host/companion/CompanionGateway';
  import { LanCompanionServer } from '../../src/host/companion/LanCompanionServer';
  import { createIdentity } from '../../src/shared/companion/noiseChannel';
  import { isPrivateIPv4 } from '../../src/shared/companion/lanProtocol';
  export async function fixture() {
    const db = new Database(':memory:'); let executions = 0;
    const gateway = new CompanionGateway(db, { dispatch: command => {
      executions++;
      const runId = 'fixture-run-' + executions;
      gateway.publish(command.sessionId, 'message', { id: command.commandId, role: 'user', content: command.payload.text, runId });
      gateway.publish(command.sessionId, 'message_delta', { messageId: runId + '-stream', role: 'assistant', text: 'LAN fixture response ' + executions, op: 'append', runId });
      gateway.publish(command.sessionId, 'message', { id: runId, role: 'assistant', content: 'LAN fixture response ' + executions, runId });
      gateway.publish(command.sessionId, 'message_delta', { messageId: runId + '-stream', role: 'assistant', text: ' late duplicate', op: 'append', runId });
      gateway.publish(command.sessionId, 'message_snapshot', { messageId: runId + '-next', content: 'Follow-up ' + executions, runId });
      gateway.publish(command.sessionId, 'message', { id: runId + '-final-next', role: 'assistant', content: 'Follow-up ' + executions, runId });
      gateway.publish(command.sessionId, 'agent_complete', { runId });
      return { state: 'accepted', result: { runId } };
    }});
    const server = new LanCompanionServer(gateway, createIdentity());
    const address = Object.values(networkInterfaces()).flat().find(n => n?.family === 'IPv4' && isPrivateIPv4(n.address))?.address;
    await server.start(address, 0);
    return { gateway, server, count: () => executions, close: async () => { await server.stop(); db.close(); } };
  }
`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', external: ['better-sqlite3'], outfile: resolve(directory, 'host.cjs') });

await build({ stdin: { contents: `
  import { createRoot } from 'react-dom/client';
  import { MobileRoot } from './src/app/MobileRoot';
  import './src/styles.css';
  createRoot(document.getElementById('root')).render(<MobileRoot fixtures={false} ports={{
    preferences: { get: async () => localStorage.getItem('drafts'), set: async value => localStorage.setItem('drafts', value) },
    companion: { read: () => window.lanRead(), write: value => window.lanWrite(value), scan: () => window.lanScan(), post: (url, body) => window.lanPost(url, body) },
    appInfo: { read: async () => ({ version: 'test', build: 'lan-browser' }) },
    lifecycle: { subscribe: async () => () => {}, leave: async () => {} },
    keyboard: { subscribe: async () => () => {}, hide: async () => {} },
    systemBars: { setStyle: async () => {} },
  }} />);
`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: resolve(directory, 'browser.js') });

const require = createRequire(import.meta.url);
const fixture = await require(resolve(directory, 'host.cjs')).fixture();
const invitation = fixture.server.invite(['browser-session']);
const http = createServer((req, res) => {
  if (req.url === '/browser.js' || req.url === '/browser.css') {
    res.setHeader('content-type', req.url.endsWith('.css') ? 'text/css' : 'application/javascript');
    res.end(readFileSync(resolve(directory, req.url.slice(1))));
  } else res.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/browser.css"><div id="root"></div><script src="/browser.js"></script>');
});
await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 393, height: 852 }, locale: 'zh-CN' });
let storage = null; let loseReceipt = false;
const wire = []; const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
const checks = [];
try {
  await page.exposeFunction('lanRead', () => storage);
  await page.exposeFunction('lanWrite', value => { storage = value; });
  await page.exposeFunction('lanScan', () => JSON.stringify(invitation));
  await page.exposeFunction('lanPost', async (url, body) => {
    assert.equal(new URL(url).origin, invitation.endpoint);
    const before = fixture.count(); wire.push(JSON.stringify(body));
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error' });
    const value = await response.text(); wire.push(value);
    if (!response.ok) throw new Error('LAN_HTTP_REJECTED');
    if (loseReceipt && fixture.count() > before) { loseReceipt = false; throw new Error('FIXTURE_RECEIPT_LOST'); }
    return JSON.parse(value);
  });
  await page.goto(`http://127.0.0.1:${http.address().port}`);
  await page.getByTestId('open-drawer').click();
  await page.getByRole('button', { name: '连接电脑', exact: true }).click();
  await page.getByRole('button', { name: '扫描电脑二维码', exact: true }).click();
  await page.getByText('已连接电脑', { exact: true }).last().waitFor(); checks.push('pair-through-mobile-sheet');
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.locator('.drawer').count(), 0);
  assert.equal(await page.locator('.topbar strong').innerText(), '共享会话 1');
  await page.getByRole('heading', { name: '已连接，可以发任务', exact: true }).waitFor();
  await page.getByTestId('draft').fill('browser-private-message'); await page.getByTestId('send').click();
  await page.getByText('LAN fixture response 1', { exact: true }).waitFor();
  assert.equal(await page.getByText('LAN fixture response 1', { exact: true }).count(), 1);
  assert.equal(await page.getByText('Follow-up 1', { exact: true }).count(), 1);
  assert.equal(await page.locator('.lan-message:not(.from-user)').count(), 2);
  assert.equal(await page.getByTestId('draft').inputValue(), ''); assert.equal(fixture.count(), 1); checks.push('send-ack-and-result');
  await page.screenshot({ path: resolve(directory, 'connected.png') });
  loseReceipt = true;
  await page.getByTestId('draft').fill('browser-private-retry'); await page.getByTestId('send').click();
  await page.getByText('正在核对电脑是否已接收，请勿重复发送', { exact: true }).waitFor();
  await page.reload();
  await page.getByText('LAN fixture response 2', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('draft').inputValue(), ''); assert.equal(fixture.count(), 2); checks.push('reload-reconciles-without-duplicate');
  assert(!wire.join('\n').includes('browser-private')); assert(!wire.join('\n').includes('LAN fixture response')); checks.push('browser-wire-encrypted');
  fixture.server.revoke(fixture.gateway.pairedDevices()[0].deviceId);
  await page.getByText('无法连接电脑。请确认两台设备在同一 Wi-Fi，或电脑连接了手机热点，并允许 Neo 访问本地网络。换网后需重新扫码。', { exact: true }).first().waitFor(); checks.push('revocation-disconnects');
  assert.deepEqual(pageErrors, []); checks.push('no-browser-errors');
  writeFileSync(resolve(directory, 'result.json'), JSON.stringify({ checks, passed: checks.length, failed: 0, skipped: 0,
    scope: 'Chromium + production mobile UI/Noise client + real HTTP/SQLite; scan/storage bridged test ports, engine dispatch fixture, no native camera/keychain evidence' }, null, 2));
  console.log(`LAN_BROWSER ${checks.length} passed / 0 failed / 0 skipped`);
} finally {
  await browser.close(); http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); await fixture.close();
}
