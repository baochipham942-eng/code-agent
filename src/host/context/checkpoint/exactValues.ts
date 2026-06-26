export interface ExactFormLiteral {
  literal: string;
  kind: 'backtick' | 'dsn' | 'env' | 'path' | 'flag-sequence' | 'token';
}

function uniqueByLiteral(values: ExactFormLiteral[]): ExactFormLiteral[] {
  const seen = new Set<string>();
  const out: ExactFormLiteral[] = [];
  for (const value of values) {
    if (seen.has(value.literal)) continue;
    seen.add(value.literal);
    out.push(value);
  }
  return out;
}

export function collectExactFormLiterals(text: string): ExactFormLiteral[] {
  const values: ExactFormLiteral[] = [];

  for (const match of text.matchAll(/`[^`\n]+`/g)) {
    values.push({ literal: match[0], kind: 'backtick' });
  }

  for (const match of text.matchAll(/\b[A-Z][A-Z0-9_]{2,}=[^\s,;]+/g)) {
    values.push({ literal: match[0], kind: 'env' });
  }

  for (const match of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s`'")]+/gi)) {
    values.push({ literal: match[0], kind: 'dsn' });
  }

  for (const match of text.matchAll(/(?:^|[\s("'`])((?:\/[A-Za-z0-9._@%+,:=-]+)+\/?)/g)) {
    const literal = match[1].replace(/[.,;:!?]+$/, '');
    if (literal.length > 1) {
      values.push({ literal, kind: 'path' });
    }
  }

  for (const match of text.matchAll(/(?:--[a-z0-9][a-z0-9-]*(?:[= ](?:`[^`]+`|"[^"]+"|'[^']+'|[^\s`'",;]+))?)(?:\s+--[a-z0-9][a-z0-9-]*(?:[= ](?:`[^`]+`|"[^"]+"|'[^']+'|[^\s`'",;]+))?)*/gi)) {
    if (match[0].includes(' ')) {
      values.push({ literal: match[0], kind: 'flag-sequence' });
    }
  }

  for (const match of text.matchAll(/\b(?:sk|hf|ghp|gho|xoxb|xapp)-[A-Za-z0-9_=-]{8,}\b/g)) {
    values.push({ literal: match[0], kind: 'token' });
  }

  return uniqueByLiteral(values);
}

export function validateExactLiteralsPreserved(
  requiredLiterals: Array<string | ExactFormLiteral>,
  candidateText: string,
): { valid: boolean; missing: string[] } {
  const missing = requiredLiterals
    .map((value) => typeof value === 'string' ? value : value.literal)
    .filter((literal) => literal.length > 0 && !candidateText.includes(literal));
  return {
    valid: missing.length === 0,
    missing,
  };
}

