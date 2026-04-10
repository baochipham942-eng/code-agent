// ============================================================================
// LLM Chat Factory — Self-Evolving v2.5 Phase 7 (A)
//
// Builds a ChatFn (prompt => Promise<string>) by calling the provider's
// OpenAI-compatible /chat/completions endpoint directly. Shared by:
//
//   - scripts/proposal-generate.ts  (recipe polishing — Phase 6)
//   - EvaluationService             (failure attribution LLM fallback — Phase 7)
//   - telemetryQueryService         (failure attribution LLM fallback — Phase 7)
//
// We intentionally bypass ModelRouter / configService / SecureStorage so this
// module works identically in main-process Electron runtime and in bare tsx
// scripts. The trade-off: no caching, no fallback chain, no adaptive routing.
// That's fine for the low-volume eval pipelines this serves.
// ============================================================================

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { MODEL_API_ENDPOINTS } from '../../shared/constants/providers';

/** A minimal chat function: prompt in, raw string response out. */
export type ChatFn = (prompt: string) => Promise<string>;

export interface ChatFnBuildOptions {
  /** "provider/model" form, e.g. "deepseek/deepseek-chat". */
  polishModel: string;
  /** Sampling temperature. Default 0.3 (deterministic-ish). */
  temperature?: number;
  /** Max tokens for the response. Default 1024. */
  maxTokens?: number;
  /** Project .env path. Defaults to `${cwd}/.env`. */
  envFilePath?: string;
}

export type ChatFnBuildResult =
  | { chatFn: ChatFn; provider: string; model: string }
  | { error: string };

/**
 * Build a ChatFn from a "provider/model" spec and an API key loaded from
 * `process.env.${PROVIDER}_API_KEY` or a project .env file. Returns an
 * error object (not a thrown exception) so callers can cleanly fall back.
 */
export async function buildChatFn(opts: ChatFnBuildOptions): Promise<ChatFnBuildResult> {
  const slashIdx = opts.polishModel.indexOf('/');
  if (slashIdx <= 0 || slashIdx === opts.polishModel.length - 1) {
    return { error: `model spec must be "provider/model", got: ${opts.polishModel}` };
  }
  const provider = opts.polishModel.slice(0, slashIdx);
  const model = opts.polishModel.slice(slashIdx + 1);

  const apiKey = await loadApiKeyForProvider(provider, opts.envFilePath);
  if (!apiKey) {
    return {
      error: `No API key for provider "${provider}" (checked env ${provider.toUpperCase()}_API_KEY and .env)`,
    };
  }

  const baseUrl = resolveProviderBaseUrl(provider);
  if (!baseUrl) {
    return { error: `Unknown provider "${provider}" (no entry in MODEL_API_ENDPOINTS)` };
  }

  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const temperature = opts.temperature ?? 0.3;
  const maxTokens = opts.maxTokens ?? 1024;

  const chatFn: ChatFn = async (prompt) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature,
        max_tokens: maxTokens,
        stream: false,
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '<no body>');
      throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new Error(`empty content in response: ${JSON.stringify(data).slice(0, 200)}`);
    }
    return content;
  };

  return { chatFn, provider, model };
}

/**
 * Resolve a provider id to its OpenAI-compatible chat completions base URL.
 * Reads from shared MODEL_API_ENDPOINTS constants (no hard-coded URLs here).
 */
export function resolveProviderBaseUrl(provider: string): string | null {
  const endpoints = MODEL_API_ENDPOINTS as unknown as Record<string, string>;
  return endpoints[provider] ?? null;
}

/**
 * Load an API key from process.env or a .env file.
 * Env variables take precedence.
 */
export async function loadApiKeyForProvider(
  provider: string,
  envFilePath?: string
): Promise<string | null> {
  const envVar = `${provider.toUpperCase()}_API_KEY`;
  if (process.env[envVar]) return process.env[envVar] as string;

  const filePath = envFilePath ?? path.join(process.cwd(), '.env');
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const re = new RegExp(`^${envVar}=["']?([^"'\\s\\n]+)["']?`, 'm');
    const m = re.exec(raw);
    if (m) return m[1].trim();
  } catch {
    // .env missing or unreadable — fall through
  }
  return null;
}

// ============================================================================
// Attribution-specific convenience
//
// Reads the attribution feature flag (CODE_AGENT_EVAL_LLM_ENABLED=1) and the
// optional model override (CODE_AGENT_EVAL_LLM_MODEL) from the environment.
// Returns either a built ChatFn or null (silent disable).
//
// Consumer pattern:
//
//   const llmFn = await buildAttributionChatFnFromEnv();
//   const attribution = await new FailureAttributor().attribute(trajectory, {
//     enableLLM: llmFn !== null,
//     llmFn: llmFn ?? undefined,
//   });
// ============================================================================

const ATTRIBUTION_ENV_ENABLED = 'CODE_AGENT_EVAL_LLM_ENABLED';
const ATTRIBUTION_ENV_MODEL = 'CODE_AGENT_EVAL_LLM_MODEL';
/** Default model for attribution LLM fallback — pay-per-use, reliable. */
export const DEFAULT_ATTRIBUTION_MODEL = 'deepseek/deepseek-chat';

export async function buildAttributionChatFnFromEnv(): Promise<ChatFn | null> {
  const enabled = process.env[ATTRIBUTION_ENV_ENABLED];
  if (enabled !== '1' && enabled !== 'true') return null;

  const model = process.env[ATTRIBUTION_ENV_MODEL] || DEFAULT_ATTRIBUTION_MODEL;
  const built = await buildChatFn({ polishModel: model, maxTokens: 2048 });
  if ('error' in built) {
    // Silent null — callers fall back to rule-only attribution.
    // Error is swallowed here because attribution is a read-side concern
    // and should never fail the containing eval / telemetry call.
    return null;
  }
  return built.chatFn;
}
