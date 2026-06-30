// scripts/probe-veo-reachability.ts
// 免费可达性探针：用现有（可能免费档）Gemini key 打 predictLongRunning，断言端点+鉴权+代理 wiring 通。
// 期望：免费档返回 billing/permission 类 4xx（证明唯一阻塞是计费档位，链路正确），而非网络不可达。
// 不出片、不产生有意义费用（建任务被拒）。
//   运行：GEMINI_API_KEY=xxx HTTPS_PROXY=http://127.0.0.1:7897 npx tsx scripts/probe-veo-reachability.ts
import { veoRequest } from '../src/host/services/media/veoFetch';
import { MODEL_API_ENDPOINTS } from '../src/shared/constants';

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.error('需要 GEMINI_API_KEY'); process.exit(2); }
  const url = `${MODEL_API_ENDPOINTS.gemini}/models/veo-3.1-fast-generate-preview:predictLongRunning`;
  console.log('POST', url, 'proxy=', process.env.HTTPS_PROXY || '(none)');
  try {
    const r = await veoRequest(url, {
      method: 'POST', apiKey,
      body: { instances: [{ prompt: 'probe' }], parameters: { aspectRatio: '16:9' } },
      timeoutMs: 60000,
    });
    console.log('HTTP', r.status);
    console.log('body:', JSON.stringify(r.data).slice(0, 600));
    if (r.status === 200) console.log('⚠️ 200=已建任务（付费档已开通，注意这会出片计费）。');
    else if (r.status >= 400 && r.status < 500) console.log('✅ 4xx：端点+鉴权+代理 wiring 通，阻塞=计费档位（符合免费档预期）。');
    else console.log('? 非预期状态，检查 wiring。');
  } catch (e) {
    console.error('❌ 请求异常（网络/代理 wiring 问题）:', e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
void main();
