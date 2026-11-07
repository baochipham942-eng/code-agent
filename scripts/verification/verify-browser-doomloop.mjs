#!/usr/bin/env node
/* global fetch, AbortSignal, TextDecoder */
// Real-run recipe: drive a >=8-step managed-browser task over the local fixture via POST /api/run (SSE),
// print ordered Browser calls (action,args,result digest) and any permission/doom-loop events.
// Usage: node scripts/verification/verify-browser-doomloop.mjs <webServerUrl> <dataDir> [out.json] [provider] [model]
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startFixture } from '../../tests/fixtures/browser-doomloop/server.mjs';

const [baseUrl, dataDir, outFile, provider = 'zhipu', model = 'glm-5.3'] = process.argv.slice(2);
if (!baseUrl || !dataDir) { console.error('usage: <url> <dataDir> [out.json] [provider] [model]'); process.exit(2); }
const token = readFileSync(path.join(dataDir, '.dev-token'), 'utf8').trim();
const { server, port } = await startFixture();
const fx = `http://127.0.0.1:${port}`;
const prompt = [
  `请用托管浏览器(Browser 工具)依次完成下面的任务，不要用其它工具，每步都真实操作：`,
  `1. 打开 ${fx}/ 读出 Secret code A。`,
  `2. 点击导航进入 Form 页，在 Name 输入框输入 Neo，点击 Greet，读出页面显示的问候语。`,
  `3. 进入 Reveal 页，点击 Show secret 按钮，读出 Secret code B。`,
  `4. 进入 Delayed 页，等页面状态变成 ready（页面约 4 秒后才变化，需要等待并重新读取），读出 Secret code C。`,
  `5. 最后汇总 A、B、C 三个 code 和问候语。`,
].join('\n');

const res = await fetch(`${baseUrl}/api/run`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ prompt, provider, model, goal: { goal: prompt, review: '最终回答必须包含 Secret code A、B、C 和问候语，且都是真实从页面读到的', maxTurns: 40 }, context: { executionIntent: { browserSessionMode: 'managed' } } }),
  signal: AbortSignal.timeout(20 * 60_000),
});
const events = [];
let buf = '';
const decoder = new TextDecoder();
for await (const chunk of res.body) {
  buf += decoder.decode(chunk, { stream: true });
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const raw = buf.slice(0, i); buf = buf.slice(i + 2);
    const ev = /^event: (.*)$/m.exec(raw)?.[1]; const data = /^data: (.*)$/m.exec(raw)?.[1];
    if (!ev) continue;
    let parsed; try { parsed = JSON.parse(data); } catch { parsed = data; }
    events.push({ ev, data: parsed });
    if (ev === 'permission_request' && parsed?.id) {
      const answer = process.env.PERMISSION_ANSWER ?? 'allow_session';
      const r = await fetch(`${baseUrl}/api/agent/permission-response`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify([parsed.id, answer, parsed.sessionId]),
      });
      events.push({ ev: '_permission_answer', data: { id: parsed.id, tool: parsed.tool, action: parsed.details?.action, answer, status: r.status, body: (await r.text()).slice(0, 200) } });
    }
  }
}
server.close();
if (outFile) writeFileSync(outFile, JSON.stringify(events, null, 1));
const counts = {}; for (const e of events) counts[e.ev] = (counts[e.ev] ?? 0) + 1;
console.log(JSON.stringify(counts));
