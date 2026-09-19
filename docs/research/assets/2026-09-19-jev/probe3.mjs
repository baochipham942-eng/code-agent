import fs from 'node:fs'; import os from 'node:os';
const KEY = fs.readFileSync(`${os.homedir()}/.config/typesafe/api_key`, 'utf8').trim();
const call = async (state, questions) => { const t0 = performance.now(); const r = await fetch('https://api.typesafe.ai/v1/systemone', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ state, model: 'jev-latest', questions }) }); const j = await r.json(); j._ms = Math.round(performance.now() - t0); return j; };
const turns = ['user: 帮我看看 sales.csv 有多少行', 'assistant: 有 1,204 行，列是 date/amount/region', 'user: 顺便问下今天上海天气', 'assistant: 上海今天多云 24-29 度', 'user: 按 region 汇总金额', 'assistant: 华东 45 万 / 华南 31 万 / 华北 22 万，已存 summary.csv', 'user: 帮我写个 Python 打印 hello', 'assistant: print("hello")'];
const current = 'user: 把刚才按 region 的汇总画成柱状图保存 PNG';
console.log('## J2. compaction, pair form (state = {current_request, past_turn}), 8 concurrent');
const t0 = performance.now();
const rs = await Promise.all(turns.map(t => call({ current_request: current, past_turn: t }, { keep: { type: 'noul', instructions: 'Does `past_turn` contain information the assistant needs in order to carry out `current_request`?', criteria: { true: 'It names a file, value, result, or constraint the current request depends on', false: 'Unrelated small talk, or a task the current request does not build on' } } })));
turns.forEach((t, i) => console.log(`  ${rs[i].answers.keep.noul.toFixed(2)}  ${t.slice(0, 44)}`)); console.log(`  wall=${Math.round(performance.now() - t0)}ms`);
// J3: 同一状态但把 history 做成带 id 的对象而不是数组下标
console.log('\n## J3. compaction, object-keyed history in one request');
const hist = Object.fromEntries(turns.map((t, i) => [`t${i}`, t]));
const qs = Object.fromEntries(turns.map((_, i) => [`keep_t${i}`, { type: 'noul', instructions: `Does \`history.t${i}\` contain information the assistant needs in order to carry out \`current_request\`?` }]));
const j = await call({ history: hist, current_request: current }, qs);
turns.forEach((t, i) => console.log(`  ${j.answers[`keep_t${i}`].noul.toFixed(2)}  ${t.slice(0, 44)}`)); console.log(`  ${j._ms}ms`);
