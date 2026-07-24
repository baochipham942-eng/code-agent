import { describe, expect, it } from 'vitest';
import {
  encodeSecretRef,
  extractSecrets,
  parseSecretRef,
  resolveSecretRefs,
} from '../../../src/host/mcp/secretRef';

describe('MCP secret references', () => {
  describe('parseSecretRef / encodeSecretRef', () => {
    it('parses a valid secret reference', () => {
      expect(parseSecretRef('secureref:feishu.appSecret')).toEqual({
        integrationId: 'feishu',
        field: 'appSecret',
      });
    });

    it.each(['plain-text', '', 'secureref:'])('returns null for non-reference value %j', (value) => {
      expect(parseSecretRef(value)).toBeNull();
    });

    it.each([
      ['bad.id', 'field'],
      ['bad:id', 'field'],
      ['id', 'bad.field'],
      ['id', 'bad:field'],
    ])('rejects ambiguous id/field delimiters: %s / %s', (integrationId, field) => {
      expect(() => encodeSecretRef(integrationId, field)).toThrow();
    });
  });

  describe('resolveSecretRefs', () => {
    it('preserves plaintext values', () => {
      expect(resolveSecretRefs({ APP_ID: 'cli_app_id' }, () => null)).toEqual({
        APP_ID: 'cli_app_id',
      });
    });

    it('replaces a reference with its stored value', () => {
      expect(resolveSecretRefs(
        { APP_SECRET: 'secureref:mcp_feishu.APP_SECRET' },
        () => ({ APP_SECRET: 'resolved-secret' }),
      )).toEqual({ APP_SECRET: 'resolved-secret' });
    });

    it('fails closed when the integration lookup returns null', () => {
      expect(() => resolveSecretRefs(
        { APP_SECRET: 'secureref:mcp_feishu.APP_SECRET' },
        () => null,
      )).toThrow(/mcp_feishu\.APP_SECRET/);
    });

    it('fails closed when the integration field is absent', () => {
      expect(() => resolveSecretRefs(
        { APP_SECRET: 'secureref:mcp_feishu.APP_SECRET' },
        () => ({ APP_ID: 'cli_app_id' }),
      )).toThrow(/mcp_feishu\.APP_SECRET/);
    });

    it('never includes stored secret values in resolution errors', () => {
      const fakeSecret = 'SENSITIVE_TEST_SECRET_7f3a';
      let error: unknown;
      try {
        resolveSecretRefs(
          { APP_SECRET: 'secureref:mcp_feishu.APP_SECRET' },
          () => ({ ANOTHER_SECRET: fakeSecret }),
        );
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(fakeSecret);
    });

    it('resolves mixed plaintext and reference values independently', () => {
      expect(resolveSecretRefs(
        {
          APP_ID: 'cli_app_id',
          APP_SECRET: 'secureref:mcp_feishu.APP_SECRET',
        },
        () => ({ APP_SECRET: 'resolved-secret' }),
      )).toEqual({
        APP_ID: 'cli_app_id',
        APP_SECRET: 'resolved-secret',
      });
    });
  });

  describe('extractSecrets', () => {
    it('extracts only marked keys and leaves non-sensitive values readable', () => {
      expect(extractSecrets(
        {
          APP_ID: 'cli_app_id',
          APP_SECRET: 'raw-secret',
        },
        ['APP_SECRET'],
        'mcp_feishu',
      )).toEqual({
        sanitized: {
          APP_ID: 'cli_app_id',
          APP_SECRET: 'secureref:mcp_feishu.APP_SECRET',
        },
        extracted: {
          APP_SECRET: 'raw-secret',
        },
      });
    });
  });
});
