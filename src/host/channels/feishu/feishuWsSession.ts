import * as lark from '@larksuiteoapi/node-sdk';
import type { ChannelAccountStatus } from '../../../shared/contract/channel';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('FeishuChannel');

/** First handshake wait. Rejects connect(); the SDK keeps its own auto-reconnect. */
const FEISHU_WS_HANDSHAKE_TIMEOUT_MS = 30_000;
const LARK_WS_LOG_PREFIX = '[lark-ws]';

interface LarkSdkLogger {
  error: (...msg: unknown[]) => void;
  warn: (...msg: unknown[]) => void;
  info: (...msg: unknown[]) => void;
  debug: (...msg: unknown[]) => void;
  trace: (...msg: unknown[]) => void;
}

interface FeishuWsCredentials {
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
}

export interface FeishuWsSession {
  done: Promise<void>;
  /** Null the account's client first, then close the socket. Does not reject the handshake. */
  detachAndClose(): void;
  /** Reject an in-flight handshake. No-op once onReady, onError, or the timeout settled it. */
  cancel(error: Error): void;
}

interface OpenFeishuWebSocketInput {
  config: FeishuWsCredentials;
  domain: lark.Domain;
  channelName: string;
  onStatus: (status: ChannelAccountStatus, message?: string) => void;
  onEvent: (data: unknown) => Promise<void>;
  attach: (client: lark.WSClient) => void;
  detach: () => void;
  isCurrent: (client: lark.WSClient) => boolean;
}

function feishuWsLoggerLevel(): lark.LoggerLevel {
  return process.env.NEO_FEISHU_WS_DEBUG === '1'
    ? lark.LoggerLevel.debug
    : lark.LoggerLevel.info;
}

function formatLarkWsLog(args: unknown[], secrets: Array<string | undefined>): string {
  const body = args.map((part) => {
    if (typeof part === 'string') return part;
    if (part instanceof Error) return part.message;
    try {
      return JSON.stringify(part);
    } catch {
      return String(part);
    }
  }).join(' ');
  let redacted = body;
  for (const secret of secrets) {
    if (secret && secret.length > 0) {
      redacted = redacted.split(secret).join('[redacted]');
    }
  }
  return `${LARK_WS_LOG_PREFIX} ${redacted}`;
}

function createLarkWsLogger(secrets: Array<string | undefined>): LarkSdkLogger {
  const write = (level: 'error' | 'warn' | 'info' | 'debug', args: unknown[]) => {
    logger[level](formatLarkWsLog(args, secrets));
  };
  return {
    error: (...args: unknown[]) => write('error', args),
    warn: (...args: unknown[]) => write('warn', args),
    info: (...args: unknown[]) => write('info', args),
    debug: (...args: unknown[]) => write('debug', args),
    trace: (...args: unknown[]) => write('debug', args),
  };
}

/**
 * Open a Feishu WSClient and resolve only after the SDK onReady callback.
 * SDK 1.64 stores onReady/onError/onReconnecting/onReconnected on the constructor;
 * start() only reads eventDispatcher and resolves before the handshake.
 */
export function openFeishuWebSocket(input: OpenFeishuWebSocketInput): FeishuWsSession {
  let markReady: (() => void) | null = null;
  let markFailed: ((error: Error) => void) | null = null;
  let client: lark.WSClient | null = null;
  let cancelHandshake: ((error: Error) => void) | null = null;
  const current = () => client !== null && input.isCurrent(client);

  const onReady = () => {
    if (!current()) return;
    logger.info(`${input.channelName} WebSocket connected`);
    input.onStatus('connected');
    markReady?.();
  };
  const onError = (err: Error) => {
    if (!current()) return;
    const error = err instanceof Error ? err : new Error(String(err));
    input.onStatus('error', error.message);
    markFailed?.(error);
  };
  const onReconnecting = () => {
    if (!current()) return;
    input.onStatus('connecting', '重连中');
  };
  const onReconnected = () => {
    if (!current()) return;
    input.onStatus('connected');
  };

  client = new lark.WSClient({
    appId: input.config.appId,
    appSecret: input.config.appSecret,
    domain: input.domain,
    autoReconnect: true,
    loggerLevel: feishuWsLoggerLevel(),
    logger: createLarkWsLogger([
      input.config.appSecret,
      input.config.verificationToken,
      input.config.encryptKey,
    ]),
    onReady,
    onError,
    onReconnecting,
    onReconnected,
  });
  const started = client;
  input.attach(started);

  const eventDispatcher = new lark.EventDispatcher({
    encryptKey: input.config.encryptKey,
    verificationToken: input.config.verificationToken,
  }).register({
    'im.message.receive_v1': async (data) => {
      await input.onEvent(data);
    },
  });
  const startParams = {
    eventDispatcher,
    onReady,
    onError,
    onReconnecting,
    onReconnected,
  };

  const done = new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish('error', new Error('WebSocket handshake timeout'));
    }, FEISHU_WS_HANDSHAKE_TIMEOUT_MS);
    function finish(kind: 'ready' | 'error', error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cancelHandshake = null;
      if (kind === 'ready') resolve();
      else reject(error ?? new Error('WebSocket handshake timeout'));
    }
    cancelHandshake = (error: Error) => finish('error', error);
    markReady = () => finish('ready');
    markFailed = (error: Error) => finish('error', error);

    // Timeout rejects this promise only. A later onReady still reports connected.
    void started.start(startParams).catch((error: unknown) => {
      if (!current()) return;
      const err = error instanceof Error ? error : new Error(String(error));
      input.onStatus('error', err.message);
      markFailed?.(err);
    });
  });

  return {
    done,
    detachAndClose() {
      input.detach();
      try {
        started.close({ force: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`${input.channelName} WebSocket close failed`, { error: message });
      }
    },
    cancel(error: Error) {
      cancelHandshake?.(error);
    },
  };
}
