/**
 * ADR-041 P1 — session markdown export redaction after managed profile cookie import.
 * Producers are domains-only; this suite also injects adversarial cookie/token payloads
 * into toolExecution shapes to ensure export remains fail-closed.
 */
import { describe, expect, it } from 'vitest';
import { exportSessionToMarkdown } from '../../../src/host/session/exportMarkdown';
import { finalizeBrowserActionResult } from '../../../src/host/tools/vision/browserActionFinalize';

const LEAK_COOKIE_VALUE = 'LEAKED_COOKIE_VALUE_xyz789_do_not_export';
const LEAK_AUTH_TOKEN = 'LEAKED_RELAY_AUTH_TOKEN_abc123_do_not_export';
const LEAK_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.LEAKED_JWT_PAYLOAD.signature_do_not_export';

function assertNoSecrets(markdown: string): void {
  expect(markdown).not.toContain(LEAK_COOKIE_VALUE);
  expect(markdown).not.toContain(LEAK_AUTH_TOKEN);
  expect(markdown).not.toContain(LEAK_JWT);
  expect(markdown).not.toMatch(/cookie-value-1/i);
  // Cookie header bodies should not survive whole-document guard.
  expect(markdown).not.toMatch(/Set-Cookie:\s*sid=/i);
  expect(markdown).not.toMatch(/Cookie:\s*sid=/i);
}

describe('exportSessionToMarkdown after managed profile cookie import (ADR-041 P1)', () => {
  it('exports happy-path import_profile_cookies result without cookie values', () => {
    const finalized = finalizeBrowserActionResult({
      action: 'import_profile_cookies',
      params: {
        action: 'import_profile_cookies',
        source: 'chrome',
        profileId: 'Default',
        userConfirmed: true,
        domainAllowlist: ['github.com', 'google.com'],
      },
      provider: 'system-chrome-cdp',
      engineRoute: {
        selectedEngine: 'managed',
        reason: 'explicit_managed',
        requestedEngine: 'auto',
        relayAttached: false,
        recovery: null,
      },
      result: {
        success: true,
        output:
          'Imported 30 cookies from chrome/Default (6 domains). Values redacted.',
        metadata: {
          importSource: {
            kind: 'browser-profile-cookies',
            source: 'chrome',
            profileId: 'Default',
          },
          importedCookieCount: 30,
          skippedCookieCount: 718,
          domainCount: 6,
          domains: [
            'github.com',
            '.github.com',
            'google.com',
            '.google.com',
            'accounts.google.com',
            'www.github.com',
          ],
          browserAccountState: {
            status: 'available',
            cookieCount: 30,
            expiredCookieCount: 0,
            domainCount: 6,
            domains: ['github.com', 'google.com'],
            updatedAtMs: 1,
          },
        },
      },
    });

    const result = exportSessionToMarkdown(
      {
        sessionId: 'sess-import-happy',
        startedAt: 1,
        lastActivityAt: 2,
        totalTokens: 0,
        messages: [
          {
            id: 'msg-1',
            role: 'assistant',
            content: 'Imported browser profile cookies for logged-in sites.',
            timestamp: 1,
            metadata: {
              toolExecution: {
                tool: 'browser_action',
                input: {
                  action: 'import_profile_cookies',
                  source: 'chrome',
                  profileId: 'Default',
                  userConfirmed: true,
                  domainAllowlist: ['github.com', 'google.com'],
                },
                output: finalized.output,
                metadata: finalized.metadata,
              },
            },
          },
        ],
      },
      {
        includeToolDetails: true,
        includeMetadata: true,
        includeTimestamps: false,
      },
    );

    expect(result.success).toBe(true);
    expect(result.markdown).toContain('import_profile_cookies');
    expect(result.markdown).toContain('github.com');
    expect(result.markdown).toMatch(/Imported 30 cookies/i);
    expect(result.markdown).toMatch(/Values redacted/i);
    // Happy path must never invent cookie values into export.
    expect(result.markdown).not.toMatch(/"value"\s*:\s*"/);
    expect(result.markdown).not.toMatch(/encrypted_value/i);
    expect(result.markdown).not.toMatch(/keychainPassword/i);
  });

  it('redacts adversarial cookie/token payloads if they land in toolExecution', () => {
    const adversarial = finalizeBrowserActionResult({
      action: 'import_profile_cookies',
      params: {
        action: 'import_profile_cookies',
        source: 'chrome',
        profileId: 'Default',
        userConfirmed: true,
      },
      provider: 'system-chrome-cdp',
      result: {
        success: true,
        output: [
          `Imported cookies. Cookie: sid=${LEAK_COOKIE_VALUE}`,
          `Set-Cookie: sid=${LEAK_COOKIE_VALUE}; Path=/; HttpOnly`,
          `session_cookie=${LEAK_COOKIE_VALUE}`,
          `relay authToken=${LEAK_AUTH_TOKEN}`,
          `Bearer ${LEAK_JWT}`,
        ].join('\n'),
        metadata: {
          authToken: LEAK_AUTH_TOKEN,
          token: LEAK_AUTH_TOKEN,
          cookie: LEAK_COOKIE_VALUE,
          cookies: [
            {
              name: 'sid',
              value: LEAK_COOKIE_VALUE,
              domain: 'github.com',
            },
          ],
          domains: ['github.com'],
          importedCookieCount: 1,
          storageState: {
            cookies: [{ name: 'sid', value: LEAK_COOKIE_VALUE }],
          },
          localStorage: { token: LEAK_AUTH_TOKEN },
          browserAccountState: {
            status: 'available',
            cookieCount: 1,
            domains: ['github.com'],
          },
        },
      },
    });

    const result = exportSessionToMarkdown(
      {
        sessionId: 'sess-import-adversarial',
        startedAt: 1,
        lastActivityAt: 2,
        totalTokens: 0,
        messages: [
          {
            id: 'msg-1',
            role: 'assistant',
            content: `Import done. cookie=${LEAK_COOKIE_VALUE} authToken=${LEAK_AUTH_TOKEN}`,
            timestamp: 1,
            metadata: {
              toolExecution: {
                tool: 'browser_action',
                input: {
                  action: 'import_profile_cookies',
                  source: 'chrome',
                  profileId: 'Default',
                  userConfirmed: true,
                  // Adversarial: value should never appear in export even if present in input.
                  cookieValue: LEAK_COOKIE_VALUE,
                  cookies: [{ name: 'sid', value: LEAK_COOKIE_VALUE }],
                },
                output: adversarial.output,
                metadata: adversarial.metadata,
              },
            },
          },
        ],
      },
      {
        includeToolDetails: true,
        includeMetadata: true,
        includeTimestamps: false,
      },
    );

    expect(result.success).toBe(true);
    assertNoSecrets(result.markdown || '');
    // Tool details export Input/Output only (not full metadata domain lists).
    // Finalizer + guard must still scrub any cookie/token material that did reach those fields.
    expect(result.markdown).toMatch(/\*\*\*REDACTED\*\*\*|\[redacted\]/i);
  });

  it('redacts cookie seed JSON in tool output even without Cookie: header prefix', () => {
    const result = exportSessionToMarkdown(
      {
        sessionId: 'sess-bare-cookie',
        startedAt: 1,
        lastActivityAt: 2,
        totalTokens: 0,
        messages: [
          {
            id: 'msg-1',
            role: 'assistant',
            content: 'Applied managed cookies (summary only).',
            timestamp: 1,
            metadata: {
              toolExecution: {
                tool: 'browser_action',
                input: {
                  action: 'import_profile_cookies',
                  source: 'chrome',
                  profileId: 'Default',
                  userConfirmed: true,
                },
                // Adversarial producer bug: seeds with plaintext values in output JSON.
                output: JSON.stringify({
                  importedCookieCount: 1,
                  domains: ['github.com'],
                  seeds: [{ name: 'sid', value: LEAK_COOKIE_VALUE, domain: 'github.com' }],
                }),
                metadata: {
                  importedCookieCount: 1,
                  domains: ['github.com'],
                  seeds: [{ name: 'sid', value: LEAK_COOKIE_VALUE, domain: 'github.com' }],
                },
              },
            },
          },
        ],
      },
      {
        includeToolDetails: true,
        includeMetadata: false,
        includeTimestamps: false,
      },
    );

    expect(result.success).toBe(true);
    assertNoSecrets(result.markdown || '');
    expect(result.markdown).toContain('github.com');
    expect(result.markdown).toMatch(/\[redacted\]/);
  });

  it('redacts storage_state path/content secrets after managed import round-trip shapes', () => {
    const result = exportSessionToMarkdown(
      {
        sessionId: 'sess-storage-state',
        startedAt: 1,
        lastActivityAt: 2,
        totalTokens: 0,
        messages: [
          {
            id: 'msg-1',
            role: 'assistant',
            content: 'Exported storage state for CI.',
            timestamp: 1,
            metadata: {
              toolExecution: {
                tool: 'browser_action',
                input: {
                  action: 'export_storage_state',
                  storageStatePath:
                    '/Users/linchen/Library/Application Support/code-agent/storage_state_secret.json',
                },
                output: `Storage state exported: storage_state.json\nCookie: sid=${LEAK_COOKIE_VALUE}`,
                metadata: {
                  storageStatePath:
                    '/Users/linchen/Library/Application Support/code-agent/storage_state_secret.json',
                  cookies: [{ name: 'sid', value: LEAK_COOKIE_VALUE }],
                  authToken: LEAK_AUTH_TOKEN,
                  browserAccountState: {
                    status: 'available',
                    cookieCount: 2,
                    domains: ['example.com'],
                  },
                },
              },
            },
          },
        ],
      },
      {
        includeToolDetails: true,
        includeMetadata: true,
        includeTimestamps: false,
      },
    );

    expect(result.success).toBe(true);
    assertNoSecrets(result.markdown || '');
    // Local paths collapse to basename tail (e.g. .../storage_state_secret.json) — absolute home paths must not appear.
    expect(result.markdown).not.toContain('/Users/linchen');
    expect(result.markdown).not.toContain('Application Support');
    expect(result.markdown).toMatch(/\.\.\.\/storage_state_secret\.json|storage_state\.json/);
  });

  it('redacts relay engine metadata authToken in markdown export', () => {
    const finalized = finalizeBrowserActionResult({
      action: 'get_content',
      params: { action: 'get_content', engine: 'relay' },
      provider: 'browser-relay',
      engineRoute: {
        selectedEngine: 'relay',
        reason: 'explicit_relay',
        requestedEngine: 'relay',
        relayAttached: true,
        recovery: null,
      },
      result: {
        success: true,
        output: 'Page content for https://example.com',
        metadata: {
          provider: 'browser-relay',
          authToken: LEAK_AUTH_TOKEN,
          cookie: LEAK_COOKIE_VALUE,
          url: 'https://example.com/dashboard?token=' + LEAK_AUTH_TOKEN,
        },
      },
    });

    const result = exportSessionToMarkdown(
      {
        sessionId: 'sess-relay-export',
        startedAt: 1,
        lastActivityAt: 2,
        totalTokens: 0,
        messages: [
          {
            id: 'msg-1',
            role: 'assistant',
            content: 'Relay get_content ok',
            timestamp: 1,
            metadata: {
              toolExecution: {
                tool: 'browser_action',
                input: { action: 'get_content', engine: 'relay' },
                output: finalized.output,
                metadata: finalized.metadata,
              },
            },
          },
        ],
      },
      {
        includeToolDetails: true,
        includeMetadata: true,
        includeTimestamps: false,
      },
    );

    expect(result.success).toBe(true);
    assertNoSecrets(result.markdown || '');
    expect(result.markdown).toContain('example.com');
  });
});
