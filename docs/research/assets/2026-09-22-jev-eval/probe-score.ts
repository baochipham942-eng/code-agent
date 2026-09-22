// 探针：看 jev-1.13.0 对 score 类型问题的真实回答形状（一次性，不进生产）。
import fs from 'node:fs';
import os from 'node:os';

async function main() {
  const KEY = fs.readFileSync(`${os.homedir()}/.config/typesafe/api_key`, 'utf8').trim();
  const state = { input: { id: 'probe', prompt: '写 a.txt 并验证' }, output: { responses: ['已写并验证'], toolExecutions: [{ tool: 'write_file', success: true }] } };
  const questions = {
    task_fulfilled: { type: 'noul', instructions: 'Does `output` deliver what `input.prompt` asks?' },
    quality: {
      type: 'score',
      instructions: 'Score the overall process quality of this trace.',
      criteria: ['Off-task or ungrounded', 'Partially delivered or sloppy', 'Delivered, grounded, disciplined'],
    },
  };
  const r = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, model: 'jev-1.13.0', questions }),
  });
  console.log('HTTP', r.status);
  console.log(JSON.stringify(await r.json(), null, 2).slice(0, 2000));
}

main().catch((error) => { console.error(error); process.exit(1); });
