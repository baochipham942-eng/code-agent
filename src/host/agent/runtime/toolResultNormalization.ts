export function detectStructuredToolFailure(output?: string): string | null {
  if (!output) return null;

  const trimmed = output.trim();
  if (!trimmed.startsWith('{')) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (!parsed || Array.isArray(parsed)) {
      return null;
    }

    // OAuth / authorization handshakes are actionable pending states, not hard failures.
    if (parsed.awaiting_authorization === true) {
      return null;
    }

    const explicitFailure =
      parsed.status === 'error' ||
      parsed.success === false ||
      parsed.ok === false;

    const errorMessage =
      typeof parsed.error === 'string' ? parsed.error
        : typeof parsed.message === 'string' && explicitFailure ? parsed.message
          : null;

    if (!explicitFailure && !errorMessage) {
      return null;
    }

    return errorMessage || 'Tool returned a structured error payload';
  } catch {
    return null;
  }
}
