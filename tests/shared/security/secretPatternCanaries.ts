import type { SecretPatternId } from '../../../src/shared/security/secretPatterns';

export interface SecretPatternCanary {
  id: SecretPatternId;
  positive: string;
  negative: string;
  rawSecret: string;
}

export const secretPatternCanaries: SecretPatternCanary[] = [
  {
    id: 'url-basic-auth',
    positive: 'fetch https://neo-user:neo-password@example.test/path',
    negative: 'fetch https://example.test/path',
    rawSecret: 'neo-user:neo-password',
  },
  {
    id: 'cookie-header',
    positive: 'Cookie: session_id=session-cookie-secret; theme=dark',
    negative: 'Cookie policy accepted',
    rawSecret: 'session-cookie-secret',
  },
  {
    id: 'session-cookie-assignment',
    positive: 'session_cookie=session-cookie-value-secret',
    negative: 'session cookie assignment docs',
    rawSecret: 'session-cookie-value-secret',
  },
  {
    id: 'openai-key',
    positive: `provider key sk-${'a'.repeat(24)}`,
    negative: 'task id sk-short',
    rawSecret: `sk-${'a'.repeat(24)}`,
  },
  {
    id: 'google-api-key',
    positive: `google key AIza${'A'.repeat(32)}`,
    negative: 'AIza docs prefix only',
    rawSecret: `AIza${'A'.repeat(32)}`,
  },
  {
    id: 'bearer-token',
    positive: `Authorization: Bearer ${'b'.repeat(24)}`,
    negative: 'Authorization: Bearer short',
    rawSecret: `Bearer ${'b'.repeat(24)}`,
  },
  {
    id: 'github-ghp-token',
    positive: `token ghp_${'c'.repeat(36)}`,
    negative: 'token ghp_not-long-enough',
    rawSecret: `ghp_${'c'.repeat(36)}`,
  },
  {
    id: 'github-gho-token',
    positive: `token gho_${'d'.repeat(36)}`,
    negative: 'token gho_not-long-enough',
    rawSecret: `gho_${'d'.repeat(36)}`,
  },
  {
    id: 'github-fine-grained-pat',
    positive: `token github_pat_${'e'.repeat(22)}_${'f'.repeat(59)}`,
    negative: 'token github_pat_docs_example',
    rawSecret: `github_pat_${'e'.repeat(22)}_${'f'.repeat(59)}`,
  },
  {
    id: 'slack-xox-token',
    positive: 'slack xoxb-123456789012-ABCDEFGHIJKL-secretpart',
    negative: 'slack xoxb-short',
    rawSecret: 'xoxb-123456789012-ABCDEFGHIJKL-secretpart',
  },
  {
    id: 'slack-xapp-token',
    positive: 'slack xapp-1-ABCDEF0123456789abcdef0123456789',
    negative: 'slack xapp-docs',
    rawSecret: 'xapp-1-ABCDEF0123456789abcdef0123456789',
  },
  {
    id: 'aws-access-key-id',
    positive: 'aws AKIA1234567890ABCDEF',
    negative: 'aws AKIA123',
    rawSecret: 'AKIA1234567890ABCDEF',
  },
  {
    id: 'url-query-token',
    positive: 'https://example.test/callback?token=url-query-token-secret&next=/done',
    negative: 'https://example.test/callback?theme=tokenized&next=/done',
    rawSecret: 'url-query-token-secret',
  },
  {
    id: 'jwt-token',
    positive: 'jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJuZW8ifQ.c2lnbmF0dXJl',
    negative: 'img data:image/png;base64,eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJuZW8ifQ.c2lnbmF0dXJl',
    rawSecret: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJuZW8ifQ.c2lnbmF0dXJl',
  },
  {
    id: 'pem-private-key',
    positive: [
      '-----BEGIN PRIVATE KEY-----',
      'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
      '-----END PRIVATE KEY-----',
    ].join('\n'),
    negative: [
      '-----BEGIN PUBLIC KEY-----',
      'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
      '-----END PUBLIC KEY-----',
    ].join('\n'),
    rawSecret: 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
  },
];
