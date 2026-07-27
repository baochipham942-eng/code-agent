'use strict';

/**
 * Acceptance-only process preload.
 *
 * Fork/Rewind does not depend on config/plugin/skill hot reload. Some crowded
 * macOS CI/desktop hosts can exhaust the process watcher budget while the
 * standalone web host is booting, long after the HTTP listener and database
 * are ready. Replace fs.watch with an inert FSWatcher-compatible object for
 * this one child process so the smoke measures the requested session behavior.
 */

const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const net = require('node:net');
const tls = require('node:tls');
const { EventEmitter } = require('node:events');

const networkAuditPath = process.env.SESSION_FORK_ACCEPTANCE_NETWORK_AUDIT;
const networkAudit = {
  policy: 'loopback-only',
  preloadPid: process.pid,
  blockedExternalConnectionAttempts: [],
};

function writeNetworkAudit() {
  if (!networkAuditPath) return;
  fs.writeFileSync(networkAuditPath, `${JSON.stringify(networkAudit, null, 2)}\n`, 'utf8');
}

function isLoopbackHost(host) {
  if (host === undefined || host === null || host === '') return true;
  const normalized = String(host).trim().toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost'
    || normalized === '::1'
    || normalized === '0.0.0.0'
    || normalized.startsWith('127.');
}

function recordBlocked(kind, host, port) {
  const error = new Error(
    `Acceptance process blocked external ${kind} connection to ${String(host)}:${String(port ?? '')}`,
  );
  error.code = 'ACCEPTANCE_EXTERNAL_NETWORK_BLOCKED';
  networkAudit.blockedExternalConnectionAttempts.push({
    kind,
    host: String(host),
    port: port === undefined ? null : String(port),
    timestamp: Date.now(),
  });
  writeNetworkAudit();
  throw error;
}

function socketTarget(args) {
  const first = args[0];
  if (typeof first === 'string') return { path: first };
  if (typeof first === 'number') {
    return {
      port: first,
      host: typeof args[1] === 'string' ? args[1] : undefined,
    };
  }
  if (first && typeof first === 'object') {
    return {
      path: first.path,
      port: first.port,
      host: first.host ?? first.hostname,
    };
  }
  return {};
}

function guardSocketCall(kind, original) {
  return function acceptanceLoopbackOnly(...args) {
    const target = socketTarget(args);
    if (!target.path && !isLoopbackHost(target.host)) {
      return recordBlocked(kind, target.host, target.port);
    }
    return original.apply(this, args);
  };
}

net.connect = guardSocketCall('net.connect', net.connect);
net.createConnection = guardSocketCall('net.createConnection', net.createConnection);
tls.connect = guardSocketCall('tls.connect', tls.connect);

if (typeof globalThis.fetch === 'function') {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function acceptanceLoopbackFetch(input, init) {
    const rawUrl = typeof input === 'string' || input instanceof URL
      ? String(input)
      : input && typeof input.url === 'string'
        ? input.url
        : '';
    if (rawUrl) {
      const parsed = new URL(rawUrl);
      if (!isLoopbackHost(parsed.hostname)) {
        return Promise.reject(
          (() => {
            try {
              recordBlocked('fetch', parsed.hostname, parsed.port || undefined);
            } catch (error) {
              return error;
            }
          })(),
        );
      }
    }
    return originalFetch.call(this, input, init);
  };
}

writeNetworkAudit();

class InertWatcher extends EventEmitter {
  constructor(signal) {
    super();
    this.closed = false;
    this.waiters = [];
    if (signal) {
      if (signal.aborted) {
        this.close();
      } else {
        signal.addEventListener('abort', () => this.close(), { once: true });
      }
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const resolve of this.waiters.splice(0)) {
      resolve({ done: true, value: undefined });
    }
    this.emit('close');
  }

  ref() {
    return this;
  }

  unref() {
    return this;
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.close();
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }
}

fs.watch = function acceptanceWatch(_filename, optionsOrListener, maybeListener) {
  const options = optionsOrListener && typeof optionsOrListener === 'object'
    ? optionsOrListener
    : undefined;
  const listener = typeof optionsOrListener === 'function'
    ? optionsOrListener
    : typeof maybeListener === 'function'
      ? maybeListener
      : undefined;
  const watcher = new InertWatcher(options && options.signal);
  if (listener) watcher.on('change', listener);
  return watcher;
};

fsPromises.watch = function acceptancePromisesWatch(_filename, options) {
  return new InertWatcher(options && options.signal);
};
