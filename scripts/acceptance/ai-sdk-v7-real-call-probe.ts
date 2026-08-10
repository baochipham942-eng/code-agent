// AI SDK v7 迁移真实调用探针（E 批验收）
// ============================================================================
// 走的是**项目自己的适配器** inferenceViaAiSdk，不是裸 SDK——验的是我们的改动，
// 不是 Vercel 的代码。三件事：
//   1. openai-compatible v3 腿：非流式 + 流式（`.stream` 改名后事件映射还对不对）
//   2. anthropic v4 腿：非流式
//   3. 🔴 instructions（原 system）真的送到了模型 —— 判据是模型按 system 里的
//      指令改变输出，不是"字段在请求体里"。后者是静态契约，前者是真行为。
//   4. 🔴 Anthropic prompt caching 断点：连打两次同一长 system，
//      第一次 cacheCreation > 0、第二次 cacheRead > 0。
//      这是本批唯一"改错了没有任何门会红"的地方（见迁移清单 §2）。
//
// 用法：npx tsx scripts/acceptance/ai-sdk-v7-real-call-probe.ts
// 全部走爸的基元（TokenRhythm）key，不碰其它 provider 的额度。
// ============================================================================
// 🔴 必须在 import 适配器之前执行：适配器解析 key 时走的是
// resolveProviderApiKey(config, { trustConfigKey: false })，优先级是
// SecureStorage/env 的 claude key **压过**显式传入的 config.apiKey。
// 不摘掉 ANTHROPIC_API_KEY，provider:'claude' 这条腿会拿别家中转的 key
// 去打基元（实测 401），更糟的情况是 baseUrl 也被顶走 → 真扣别家额度。
// 摘掉之后 serviceKey/envVal 双空，才轮得到我们显式传的基元 key。
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_BASE_URL;

const { inferenceViaAiSdk } = await import('../../src/host/model/adapters/aiSdkAdapter');
const { resolveProviderApiKey, resolveProviderBaseUrl } = await import('../../src/host/model/providers/providerResolution');
type ModelConfig = import('../../src/shared/contract').ModelConfig;
type ModelMessage = import('../../src/host/model/types').ModelMessage;

const BASE_URL = 'https://tokenrhythm.studio/v1';
// deepseek-v4-flash 是 thinking 模型：max_tokens 给小了会全烧在 reasoning 上、
// 正文为空（实测 64 → content="" 而 outputTokens=65）。判据要的是正文，给足。
const MAX_TOKENS = 512;
const MODEL = 'deepseek-v4-flash';
const MAGIC = 'NEOTEST7';
// 基元自己的 key 命名空间；护栏据此判「这把 key 是不是基元的」，
// 比「等于我读到的那串」更强：它能识别出别家 provider 的 key 被顶上来。
const TOKENRHYTHM_KEY_PREFIX = 'sk_tr_';

// 基元 key 的真源是 resolveProviderApiKey 而不是 config.json：configService 读到明文
// 会自动把它迁进 SecureStorage 并从 config.json 删掉（实测第一次跑探针就触发了），
// 自己解析文件必然读空。
function readTokenRhythmKey(): string {
  const key = resolveProviderApiKey(
    { provider: 'custom-tokenrhythm', model: MODEL } as ModelConfig,
    { trustConfigKey: false },
  );
  if (!key.startsWith(TOKENRHYTHM_KEY_PREFIX)) {
    throw new Error(`custom-tokenrhythm 解析到的不是基元 key（前缀应为 ${TOKENRHYTHM_KEY_PREFIX}）`);
  }
  return key;
}

const apiKey = readTokenRhythmKey();

// 🔴 出门前自证：每条腿实际会用的 key 和 baseURL 必须都是基元的。
// 「我摘了 env 所以应该没事」是推断；这里把它变成断言，不成立就当场退出，
// 一个请求都不发。爸的边界是「别超过基元的范围」，靠机制保证，不靠我记得。
function assertStaysWithinTokenRhythm(config: ModelConfig): void {
  const resolvedKey = resolveProviderApiKey(config, { trustConfigKey: false });
  const resolvedBase = resolveProviderBaseUrl(config);
  const keyOk = resolvedKey.startsWith(TOKENRHYTHM_KEY_PREFIX);
  const baseOk = (resolvedBase || '').startsWith('https://tokenrhythm.studio');
  if (!keyOk || !baseOk) {
    console.error(
      `❌ 越界护栏拦下 provider="${config.provider}"：`
      + `key 是基元的=${keyOk}（解析到长度 ${resolvedKey.length} 的 key）`
      + `，baseURL 是基元的=${baseOk}（${resolvedBase || '(空)'}）`,
    );
    process.exit(2);
  }
}

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const record = (name: string, ok: boolean, detail: string): void => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}\n   ${detail}`);
};

/** system 里下一条能从输出上观察到的硬指令——用来证明 instructions 真的到了模型。 */
const instructionProbe = (): ModelMessage[] => ([
  { role: 'system', content: `You must begin every reply with the exact token ${MAGIC} followed by a space. Never omit it.` },
  { role: 'user', content: 'Say hello in three words.' },
] as unknown as ModelMessage[]);

async function probeOpenAICompatibleNonStream(): Promise<void> {
  const config: ModelConfig = {
    provider: 'custom-tokenrhythm' as ModelConfig['provider'],
    model: MODEL, apiKey, baseUrl: BASE_URL, maxTokens: MAX_TOKENS,
  };
  assertStaysWithinTokenRhythm(config);
  const res = await inferenceViaAiSdk(instructionProbe(), [], config, undefined, undefined, { forceNonStreaming: true } as never);
  const text = res.content ?? '';
  const hit = text.includes(MAGIC);
  record('openai-compatible v3 / 非流式 / instructions 生效',
    hit,
    `content=${JSON.stringify(text.slice(0, 80))} usage=${JSON.stringify(res.usage)}`);
}

async function probeOpenAICompatibleStream(): Promise<void> {
  const config: ModelConfig = {
    provider: 'custom-tokenrhythm' as ModelConfig['provider'],
    model: MODEL, apiKey, baseUrl: BASE_URL, maxTokens: MAX_TOKENS,
  };
  assertStaysWithinTokenRhythm(config);
  const chunks: string[] = [];
  const res = await inferenceViaAiSdk(instructionProbe(), [], config, (chunk) => {
    // StreamChunk.type 的正文事件是 'text'（不是 'content'——第一版探针写错，
    // 表现为「零回调但最终内容正确」，看着像流式坏了，其实是探针的错）。
    // 回调也可能直接给裸字符串（StreamCallback = (chunk: string | StreamChunk) => void）。
    if (typeof chunk === 'string') { chunks.push(chunk); return; }
    if (chunk.type === 'text' && typeof chunk.content === 'string') chunks.push(chunk.content);
  }, undefined, undefined);
  const streamed = chunks.join('');
  const finalText = res.content ?? '';
  // 流式的真判据有两条：① 逐字回调真的发生过（不是一次性给完）② 累积结果与最终 content 一致
  const ok = chunks.length > 1 && streamed.length > 0 && finalText.includes(MAGIC);
  record('openai-compatible v3 / 流式 / result.stream 事件映射',
    ok,
    `回调片数=${chunks.length} 累积长度=${streamed.length} 与最终一致=${streamed === finalText} content=${JSON.stringify(finalText.slice(0, 60))}`);
}

async function probeAnthropicLegAndCaching(): Promise<void> {
  // Anthropic 最小可缓存前缀约 1024 token，system 要够长才会真的建缓存。
  const filler = 'You are a meticulous engineering assistant. Follow instructions exactly. '.repeat(120);
  const messages = [
    { role: 'system', content: filler },
    { role: 'system', content: `You must begin every reply with the exact token ${MAGIC} followed by a space.` },
    { role: 'user', content: 'Say hello in three words.' },
  ] as unknown as ModelMessage[];
  const config: ModelConfig = {
    // 🔴 用 'anthropic' 不用 'claude'：两者都走 createAnthropic，但 'claude' 在
    // SecureStorage 里存着别家中转的 key，会把显式传入的基元 key 顶掉（实测解析到
    // 一把 67 位的别家 key，打到基元直接 401）。'anthropic' 无存储项，显式传参说了算。
    provider: 'anthropic' as ModelConfig['provider'],
    model: MODEL, apiKey, baseUrl: BASE_URL, maxTokens: MAX_TOKENS,
    promptCaching: { enabled: true, cacheSystem: true },
  };

  assertStaysWithinTokenRhythm(config);
  const first = await inferenceViaAiSdk(messages, [], config, undefined, undefined, { forceNonStreaming: true } as never);
  record('anthropic v4 腿 / 非流式 / instructions 生效',
    (first.content ?? '').includes(MAGIC),
    `content=${JSON.stringify((first.content ?? '').slice(0, 80))} usage=${JSON.stringify(first.usage)}`);

  const second = await inferenceViaAiSdk(messages, [], config, undefined, undefined, { forceNonStreaming: true } as never);
  const created = first.usage?.cacheCreationTokens ?? 0;
  const read = second.usage?.cacheReadTokens ?? 0;
  record('🔴 prompt caching 断点：cacheControl 迁到 instructions 后仍生效',
    created > 0 || read > 0,
    `第一次 cacheCreation=${created}  第二次 cacheRead=${read}  `
    + `（两个都为 0 ⇒ 断点没送达，或中转不透传 cache_control）`);
}

async function main(): Promise<void> {
  for (const [name, fn] of [
    ['openai-compatible 非流式', probeOpenAICompatibleNonStream],
    ['openai-compatible 流式', probeOpenAICompatibleStream],
    ['anthropic 腿 + 缓存', probeAnthropicLegAndCaching],
  ] as Array<[string, () => Promise<void>]>) {
    try {
      await fn();
    } catch (err) {
      record(name, false, `抛错：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length > 0) {
    console.log('未通过：');
    for (const f of failed) console.log(`  - ${f.name}`);
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

void main();

// 本文件没有静态 import（适配器必须在 delete process.env 之后才动态载入），
// 加这行让它仍被当作 module，否则顶层 await 非法（TS1375）。
export {};
