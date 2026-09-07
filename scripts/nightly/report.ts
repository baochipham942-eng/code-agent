import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { feedbackFingerprint, counts, validateReport, type Case, type Row } from './contracts';
import { expand, save, scrub, type Resident } from './runtime';
const escape = (s: unknown) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const archive = expand('~/Downloads/ai/code-agent-private-archive');
export const directory = (spec: Case, row: Row) => path.join(expand(spec.root), 'runs', row.id, row.runId);
export function feedback(row: Row, dir: string, date: string, mutation = false): string {
  if (row.status !== '失败') throw new Error('FAIL only executed failed cases can file feedback');
  if (row.fb) return row.fb;
  const result = JSON.parse(readFileSync(path.join(dir, 'result.json'), 'utf8'));
  const fingerprint = feedbackFingerprint(row, result.caseHash, mutation);
  const inbox = expand(`~/.ship/feedback-inbox/${date}-nightly-${row.runId}-${row.id}`);
  mkdirSync(inbox, { recursive: true });
  cpSync(dir, inbox, { recursive: true });
  const note = path.join(inbox, 'defect.md');
  writeFileSync(note, `# 缺陷·${mutation ? '反向变异演练·' : ''}${row.id}\n\n${row.checks.map((c, i) => `${i + 1}. ${c.status}：${c.detail}`).join('\n')}\n\n原始证据在同目录。${mutation ? '人为注入的 runner 检测验收，不是新产品缺陷。' : ''}\n`);
  save(path.join(inbox, 'feedback-signature.json'), { fingerprint });
  const cli = expand('~/Downloads/ai/fleet-console/cli/fb');
  const lock = expand(`~/.code-agent-nightly/feedback-${row.id}.lock`);
  mkdirSync(path.dirname(lock), { recursive: true });
  mkdirSync(lock); // Concurrent reporters fail closed; never race two adds for the same assertion.
  try {
    const items = JSON.parse(execFileSync(cli, ['list', '--json'], { encoding: 'utf8' })) as Array<{ fb: string; source: string; state: string; path: string | null }>;
    const existing = items.find(item => {
      if (item.source !== 'N-NIGHTLY-RUNNER' || !['待分诊', '已立单'].includes(item.state) || !item.path) return false;
      const signature = path.join(path.dirname(expand(item.path)), 'feedback-signature.json');
      return existsSync(signature) && JSON.parse(readFileSync(signature, 'utf8')).fingerprint === fingerprint;
    });
    const fb = existing?.fb ?? JSON.parse(execFileSync(cli, ['add', '--kind', 'diagnostics', '--title', `缺陷·${mutation ? '反向变异演练·' : ''}${row.id} 夜跑断言失败`, '--source', 'N-NIGHTLY-RUNNER', '--lane', '研发体系线', '--path', note, '--json'], { encoding: 'utf8' })).fb;
    if (!/^FB-\d+$/.test(fb)) throw new Error('FAIL feedback receipt has no FB number');
    if (existing) {
      const originalNote = expand(existing.path!);
      if (!readFileSync(originalNote, 'utf8').includes(row.runId)) appendFileSync(originalNote, `\n复现 ${row.runId}：${scrub(note)}\n`);
    }
    row.fb = fb; row.fbCreated = !existing;
    save(path.join(dir, 'feedback.json'), { fb, created: row.fbCreated, fingerprint, evidence: scrub(note) });
    return fb;
  } finally { rmdirSync(lock); }
}
/** Auxiliary outages stay visible without discarding observations already collected. */
export async function captureReferencesAndFeedback(row: Row, dir: string, date: string, mutation = false): Promise<string[]> {
  const errors: string[] = [];
  if (row.frames.length) {
    try { await designReferences(dir, row.frames); }
    catch (error) { errors.push(`设计参照采集失败：${scrub(String(error))}`); }
  }
  if (row.status === '失败') {
    try { feedback(row, dir, date, mutation); }
    catch (error) { errors.push(`缺陷回写失败：${scrub(String(error))}`); }
  }
  row.reasons.push(...errors);
  save(path.join(dir, 'delivery.json'), { errors, fb: row.fb ?? null, fbCreated: row.fbCreated ?? false });
  return errors;
}
export async function renderReport(cases: Case[], rows: Row[], state: Resident | null, date: string, runId: string, gates: string[], mechanism?: string) {
  const summary = counts(rows);
  const errors = validateReport(cases, rows, summary, row => directory(cases.find(c => c.id === row.id)!, row));
  if (errors.length) throw new Error(errors.join('\n'));
  const out = path.join(archive, 'docs/features/context-health-compaction/acceptance');
  mkdirSync(out, { recursive: true });
  const title = `真跑 ${summary.executed} 条 / 未执行 ${summary.skipped} 条 / 共 ${cases.length} 条`;
  const jsonFile = path.join(out, `${date}-${runId}.json`);
  save(jsonFile, { summary, rows, runId, date, mechanism, state, gates, inputs: cases.map(c => ({ id: c.id, hash: c.hash })) });
  const colors: Record<string, string> = { '通过': '#167044', '失败': '#b42318', '未执行': '#665b44' };
  const label = (status: string) => `<span style="color:${colors[status]}">${escape(status)}</span>`;
  const narrow = (s: string) => `<code>${escape(s)}</code>`;
  const table = rows.map(row => { const spec = cases.find(c => c.id === row.id)!; return `<tr data-case="${row.id}" data-status="${row.status}"><td><a href="#${row.id}">${row.id}</a></td><td>${escape(spec.title)}</td><td>${narrow(spec.modules.join('·'))}</td><td>${narrow(spec.surfaces.join('+'))}</td><td>${label(row.status)}</td>${row.checks.map(c => `<td>${label(c.status)}</td>`).join('')}<td>${escape(row.reasons.join('；') || spec.title)}</td><td>${escape(row.fb ?? '—')}</td></tr>`; }).join('');
  let details = '';
  for (const row of rows) {
    const spec = cases.find(c => c.id === row.id)!;
    const dir = directory(spec, row);
    details += `<details id="${row.id}"><summary>${row.id} ${escape(spec.title)} — ${label(row.status)}</summary><p>${escape(row.reasons.join('；'))}</p>`;
    const shownReasons = new Set([row.reasons.join('；')]);
    row.checks.forEach((c, i) => {
      const detail = row.status === '未执行' && shownReasons.has(c.detail) ? '' : c.detail;
      shownReasons.add(c.detail);
      details += `<p>${i + 1} ${label(c.status)} ${escape(detail)}</p><details><summary>用例断言原文</summary><pre>${escape(spec.fields[['①结果断言', '②过程断言', '③渲染断言'][i]])}</pre></details>`;
    });
    if (row.status !== '未执行') {
      details += `<p>运行 ${escape(row.runId)}，${escape(row.startedAt)} 至 ${escape(row.endedAt)}。下列是原始响应、事件和记录；未知字段没有补零。</p>`;
      for (const file of ['result.json', 'trace.jsonl', 'timeline.json', 'audit.json', 'messages.json', 'stdout.json', 'host.log', 'files.sha256', 'delivery.json']) {
        details += `<details><summary>${file} · ${escape(scrub(path.join(dir, file)))}</summary><pre>${escape(existsSync(path.join(dir, file)) ? readFileSync(path.join(dir, file), 'utf8') : '证据缺失')}</pre></details>`;
      }
      details += '<p>真实运行截图按采集时间排列；右侧为原设计稿参照。合成 F0 数据，页面及服务是真实构建。人工仍需判断过程和文案是否可理解。</p>';
      for (const f of row.frames) {
        const png = path.join(dir, `screens/${f}.png`); const dom = path.join(dir, `screens/${f}.dom.json`);
        const design = path.join(dir, `screens/${f}.design.png`);
        const observed = existsSync(dom) ? JSON.parse(readFileSync(dom, 'utf8')) : null;
        details += `<figure><figcaption>${escape(observed?.event ?? f)} · ${escape(observed?.timestamp ?? '未知')}</figcaption><div class="pair">${existsSync(png) ? `<img alt="运行时 ${f}" src="data:image/png;base64,${readFileSync(png).toString('base64')}">` : '<p>失败：过程截图缺失</p>'}${existsSync(design) ? `<img alt="设计稿参照" src="data:image/png;base64,${readFileSync(design).toString('base64')}">` : '<p>设计参照未采到，不据此判绿</p>'}</div><details><summary>DOM 判据原文</summary><pre>${escape(observed ? JSON.stringify(observed, null, 2) : '缺失')}</pre></details></figure>`;
      }
    }
    details += '</details>';
  }
  const value = (s: string | undefined) => escape(scrub(s ?? '未采集'));
  const hash = (s: string) => `<code title="${value(s)}">${value(s.slice(0, 12))}</code>`;
  const declaration = [
    ['machine', '运行机器', value(`${process.platform}/${process.arch}`)],
    ['data', '数据目录', value(state?.dataDir)],
    ['keySlot', '密钥槽', value('~/.code-agent-chatprobe')],
    ['date', '验收日期', value(date)],
    ['head', '源码版本', state?.head ? hash(state.head) : '未采集'],
    ['build', '构建指纹', state?.build && Object.keys(state.build).length ? Object.entries(state.build).map(([file, sha]) => `<div>${value(file)}：${hash(sha)}</div>`).join('') : '未采集'],
  ].map(([key, name, content]) => `<tr data-field="${key}"><th scope="row">${name} <code>${key}</code></th><td>${content}</td></tr>`).join('');
  const lead = `<style>pre{white-space:pre-wrap;overflow-wrap:anywhere}.pair{display:flex;gap:12px}.pair img{width:49%;object-fit:contain;align-self:start}td{vertical-align:top}details{margin:12px 0}img{max-width:100%}#nightly-counts{margin-top:0}#case-table{width:100%}#case-table th,#case-table td{overflow-wrap:anywhere}#case-table td code{font-size:12px}#evidence-declaration{width:100%;table-layout:fixed;overflow-wrap:anywhere}#evidence-declaration th{width:190px;white-space:normal}</style><section><h1 id="夜跑验收包">夜跑验收包</h1><h2 id="nightly-counts" data-executed="${summary.executed}" data-skipped="${summary.skipped}">${title}</h2><p>通过 ${summary.passed} / 失败 ${summary.failed}。${escape(mechanism ?? '部分执行，未执行项目仍待补齐。')}</p><h2>门汇总原始行</h2><pre>${escape(gates.join('\n'))}</pre><table id="case-table"><thead><tr><th>用例</th><th>标题</th><th>模块</th><th>验收面</th><th>结论</th><th>①结果</th><th>②过程</th><th>③渲染</th><th>说明</th><th>缺陷</th></tr></thead><tbody>${table}</tbody></table>${details}<h2>证据声明</h2><table id="evidence-declaration"><tbody>${declaration}</tbody></table><p>合成 F0；真实 webServer/renderer/CLI；未执行项目没有运行时证据。采集器不代表产品断言通过。</p><p>证据档位：static-contract / fault-injection / real-runtime</p></section>`;
  const leadFile = path.join(out, `${date}-${runId}.lead.html`);
  const mdFile = path.join(out, `${date}-${runId}.md`);
  writeFileSync(leadFile, lead); writeFileSync(mdFile, '原始证据已内嵌，可断网打开。各用例状态由原始证据及阻塞清单共同核定。\n');
  const html = path.join(out, `${date}.html`);
  execFileSync('python3', [path.join(archive, 'tools/md2html.py'), mdFile, html, '--title', 'Neo 夜跑验收包', '--lead', leadFile]);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.route('http://**/*', route => route.abort()); await page.route('https://**/*', route => route.abort());
    await page.goto(`file://${html}`);
    if (await page.locator('h1').count() !== 1 || await page.locator('main h1, main h2').first().innerText() !== '夜跑验收包') throw new Error('FAIL HTML 文档标题不在首位/存在两个 h1');
    const countBox = await page.locator('#nightly-counts').boundingBox();
    if (!countBox || countBox.y < 0 || countBox.y + countBox.height > 1000) throw new Error('FAIL HTML 计数不在第一屏');
    if (await page.locator('#case-table tbody tr').count() !== cases.length || await page.locator('#nightly-counts').innerText() !== title) throw new Error('FAIL HTML counts/table drift');
    for (const field of ['machine', 'data', 'keySlot', 'date', 'head', 'build']) {
      const entry = page.locator(`#evidence-declaration [data-field="${field}"]`);
      if (await entry.count() !== 1 || !(await entry.locator('td').innerText()).trim()) throw new Error(`FAIL HTML 证据声明缺字段 ${field}`);
    }
    if (summary.skipped && (await page.locator('body').innerText()).includes('全部通过')) throw new Error('FAIL HTML false all-pass');
    await page.screenshot({ path: path.join(out, `${date}.png`) });
  } finally { await browser.close(); }
  return { html, jsonFile, summary };
}
async function designReferences(dir: string, frames: string[]) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`file://${path.join(archive, 'docs/features/context-health-compaction/design.html')}`);
    for (const [i, frame] of frames.entries()) {
      const target = page.locator(`#${['S-30', 'S-31', 'S-32'][i] ?? 'S-30'}`);
      if (await target.count()) await target.screenshot({ path: path.join(dir, `screens/${frame}.design.png`) });
    }
  } finally { await browser.close(); }
}
export function sendSummary(configFile: string, text: string, runId: string) {
  const config = JSON.parse(readFileSync(expand(configFile), 'utf8'));
  if (!['bot', 'user'].includes(config.identity) || !/^oc_/.test(config.chatId) || !config.profile) throw new Error('FAIL explicit notification profile/identity/chatId required');
  const output = execFileSync('lark-cli', ['im', '+messages-send', '--profile', config.profile, '--as', config.identity, '--chat-id', config.chatId, '--text', text, '--idempotency-key', `nightly-${runId}`.slice(0, 50)], { encoding: 'utf8' });
  const receipt = JSON.parse(output);
  if (receipt.ok !== true) throw new Error('FAIL Feishu delivery receipt rejected');
  return receipt;
}
