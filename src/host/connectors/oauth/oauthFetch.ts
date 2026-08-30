import type { FetchLike } from '@modelcontextprotocol/client';
import { fetch as undiciFetch, ProxyAgent } from 'undici';

const TOKEN_REQUEST_TIMEOUT_MS = 30_000;

type ProxyFetch = (
  proxyUrl: string,
  input: Parameters<FetchLike>[0],
  init: Parameters<FetchLike>[1],
) => ReturnType<FetchLike>;

function requestUrl(input: Parameters<FetchLike>[0]): URL {
  if (input instanceof URL) return input;
  return new URL(input);
}

function noProxyMatches(target: URL, rawNoProxy: string | undefined): boolean {
  if (!rawNoProxy) return false;
  const hostname = target.hostname.toLowerCase();
  const hostWithPort = target.port ? `${hostname}:${target.port}` : hostname;
  return rawNoProxy.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean)
    .some((entry) => {
      if (entry === '*') return true;
      if (entry === hostname || entry === hostWithPort) return true;
      const domain = entry.startsWith('.') ? entry.slice(1) : entry;
      return hostname.endsWith(`.${domain}`);
    });
}

function proxyUrlFor(target: URL, env: NodeJS.ProcessEnv): string | undefined {
  if (['localhost', '127.0.0.1', '::1'].includes(target.hostname.toLowerCase())) return undefined;
  if (noProxyMatches(target, env.NO_PROXY || env.no_proxy)) return undefined;
  return target.protocol === 'https:'
    ? env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy
    : env.HTTP_PROXY || env.http_proxy || env.HTTPS_PROXY || env.https_proxy;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : String(error);
}

async function normalizeResponse(response: Response): Promise<Response> {
  if (response instanceof Response) return response;

  const foreignResponse = response as unknown as {
    arrayBuffer: () => Promise<ArrayBuffer>;
    headers: Iterable<[string, string]>;
    status: number;
    statusText: string;
  };
  return new Response(await foreignResponse.arrayBuffer(), {
    status: foreignResponse.status,
    statusText: foreignResponse.statusText,
    headers: Array.from(foreignResponse.headers),
  });
}

/**
 * OAuth token requests run in the Node host, where global fetch does not reliably honor the
 * desktop process' HTTP(S)_PROXY environment. Keep the SDK injectable for tests, but make the
 * production default proxy-aware and bounded so a completed browser callback cannot hang forever.
 */
export function createConnectorOAuthFetch(options: {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  directFetch?: FetchLike;
  proxyFetch?: ProxyFetch;
} = {}): FetchLike {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? TOKEN_REQUEST_TIMEOUT_MS;
  const directFetch = options.directFetch ?? fetch;
  const agents = new Map<string, ProxyAgent>();
  const proxyFetch = options.proxyFetch ?? ((proxyUrl, input, init) => {
    let agent = agents.get(proxyUrl);
    if (!agent) {
      agent = new ProxyAgent(proxyUrl);
      agents.set(proxyUrl, agent);
    }
    return undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...init,
      dispatcher: agent,
    } as Parameters<typeof undiciFetch>[1]) as unknown as ReturnType<FetchLike>;
  });

  return async (input, init) => {
    const target = requestUrl(input);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    const requestInit = { ...init, signal };
    const proxyUrl = proxyUrlFor(target, env);
    try {
      const response = await (proxyUrl
        ? proxyFetch(proxyUrl, input, requestInit)
        : directFetch(input, requestInit));
      // `undici` is a separate package copy from Node's built-in fetch. The MCP SDK uses
      // `instanceof Response` when parsing OAuth errors, so normalize across that boundary.
      return await normalizeResponse(response);
    } catch (error) {
      if (timeoutSignal.aborted && !init?.signal?.aborted) {
        throw new Error(
          `连接 ${target.hostname} 超过 ${Math.ceil(timeoutMs / 1000)} 秒没有响应，请检查网络或代理后重试`,
          { cause: error },
        );
      }
      if (init?.signal?.aborted) throw error;
      throw new Error(`无法连接 ${target.hostname}：${errorMessage(error)}`, { cause: error });
    }
  };
}
