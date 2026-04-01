// ============================================================================
// ErrorClassifier Tests
// ============================================================================

import { describe, it, expect } from 'vitest';
import { classifyError } from '../../../src/main/model/errorClassifier';
import type { ErrorClass } from '../../../src/main/model/errorClassifier';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function httpError(status: number, message = 'error'): unknown {
  return { status, message };
}

function msgError(message: string): unknown {
  return new Error(message);
}

// --------------------------------------------------------------------------
// Status-code classification
// --------------------------------------------------------------------------

describe('classifyError – status codes', () => {
  it('status 413 → overflow', () => {
    expect(classifyError(httpError(413))).toBe<ErrorClass>('overflow');
  });

  it('status 429 → rate_limit', () => {
    expect(classifyError(httpError(429))).toBe<ErrorClass>('rate_limit');
  });

  it('status 401 → auth', () => {
    expect(classifyError(httpError(401))).toBe<ErrorClass>('auth');
  });

  it('status 403 → auth', () => {
    expect(classifyError(httpError(403))).toBe<ErrorClass>('auth');
  });

  it('status 500 → unavailable', () => {
    expect(classifyError(httpError(500))).toBe<ErrorClass>('unavailable');
  });

  it('status 502 → unavailable', () => {
    expect(classifyError(httpError(502))).toBe<ErrorClass>('unavailable');
  });

  it('status 503 → unavailable', () => {
    expect(classifyError(httpError(503))).toBe<ErrorClass>('unavailable');
  });

  it('status 504 → unavailable', () => {
    expect(classifyError(httpError(504))).toBe<ErrorClass>('unavailable');
  });
});

// --------------------------------------------------------------------------
// Message-pattern classification
// --------------------------------------------------------------------------

describe('classifyError – message patterns', () => {
  // overflow
  it('"context_length_exceeded" → overflow', () => {
    expect(classifyError(msgError('context_length_exceeded'))).toBe<ErrorClass>('overflow');
  });

  it('"maximum context length" → overflow', () => {
    expect(classifyError(msgError('maximum context length reached'))).toBe<ErrorClass>('overflow');
  });

  it('"prompt is too long" → overflow', () => {
    expect(classifyError(msgError('prompt is too long for model'))).toBe<ErrorClass>('overflow');
  });

  it('"request too large" → overflow', () => {
    expect(classifyError(msgError('request too large'))).toBe<ErrorClass>('overflow');
  });

  it('"token limit" → overflow', () => {
    expect(classifyError(msgError('You have exceeded the token limit'))).toBe<ErrorClass>('overflow');
  });

  // rate_limit
  it('"rate limit" → rate_limit', () => {
    expect(classifyError(msgError('rate limit exceeded'))).toBe<ErrorClass>('rate_limit');
  });

  it('"too many requests" → rate_limit', () => {
    expect(classifyError(msgError('too many requests'))).toBe<ErrorClass>('rate_limit');
  });

  it('"quota exceeded" → rate_limit', () => {
    expect(classifyError(msgError('quota exceeded for this month'))).toBe<ErrorClass>('rate_limit');
  });

  // auth
  it('"invalid_api_key" → auth', () => {
    expect(classifyError(msgError('invalid_api_key supplied'))).toBe<ErrorClass>('auth');
  });

  it('"authentication_error" → auth', () => {
    expect(classifyError(msgError('authentication_error'))).toBe<ErrorClass>('auth');
  });

  it('"invalid token" → auth', () => {
    expect(classifyError(msgError('invalid token'))).toBe<ErrorClass>('auth');
  });

  it('"unauthorized" → auth', () => {
    expect(classifyError(msgError('unauthorized access'))).toBe<ErrorClass>('auth');
  });

  it('"forbidden" → auth', () => {
    expect(classifyError(msgError('forbidden'))).toBe<ErrorClass>('auth');
  });

  // network
  it('"ECONNRESET" (uppercase) → network', () => {
    expect(classifyError(msgError('ECONNRESET'))).toBe<ErrorClass>('network');
  });

  it('"econnrefused" → network', () => {
    expect(classifyError(msgError('connect ECONNREFUSED 127.0.0.1:8080'))).toBe<ErrorClass>('network');
  });

  it('"etimedout" → network', () => {
    expect(classifyError(msgError('connect ETIMEDOUT'))).toBe<ErrorClass>('network');
  });

  it('"socket hang up" → network', () => {
    expect(classifyError(msgError('socket hang up'))).toBe<ErrorClass>('network');
  });

  it('"network error" → network', () => {
    expect(classifyError(msgError('network error'))).toBe<ErrorClass>('network');
  });

  it('"fetch failed" → network', () => {
    expect(classifyError(msgError('fetch failed'))).toBe<ErrorClass>('network');
  });

  // unavailable
  it('"service unavailable" → unavailable', () => {
    expect(classifyError(msgError('service unavailable'))).toBe<ErrorClass>('unavailable');
  });

  it('"bad gateway" → unavailable', () => {
    expect(classifyError(msgError('bad gateway'))).toBe<ErrorClass>('unavailable');
  });

  it('"gateway timeout" → unavailable', () => {
    expect(classifyError(msgError('gateway timeout'))).toBe<ErrorClass>('unavailable');
  });

  it('"internal server error" → unavailable', () => {
    expect(classifyError(msgError('internal server error'))).toBe<ErrorClass>('unavailable');
  });
});

// --------------------------------------------------------------------------
// Unknown / edge cases
// --------------------------------------------------------------------------

describe('classifyError – unknown and edge cases', () => {
  it('unrecognised message → unknown', () => {
    expect(classifyError(msgError('something completely different'))).toBe<ErrorClass>('unknown');
  });

  it('null → unknown', () => {
    expect(classifyError(null)).toBe<ErrorClass>('unknown');
  });

  it('undefined → unknown', () => {
    expect(classifyError(undefined)).toBe<ErrorClass>('unknown');
  });

  it('plain string → unknown when unrecognised', () => {
    expect(classifyError('mystery error')).toBe<ErrorClass>('unknown');
  });

  it('status code takes priority over message', () => {
    // status 413 should win even if message says "network error"
    expect(classifyError({ status: 413, message: 'network error' })).toBe<ErrorClass>('overflow');
  });

  it('statusCode field is also accepted', () => {
    expect(classifyError({ statusCode: 429, message: '' })).toBe<ErrorClass>('rate_limit');
  });
});
