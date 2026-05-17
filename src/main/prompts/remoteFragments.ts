// ============================================================================
// Signed remote prompt fragments
// ============================================================================
// Remote prompt registries may add narrowly-scoped public fragments to the
// local SYSTEM_PROMPT, but they never replace the local prompt body.

export const TRUSTED_REMOTE_PROMPT_FRAGMENT_IDS = [
  'policyAddon',
  'publicSystemAddon',
] as const;

export type TrustedRemotePromptFragmentId = typeof TRUSTED_REMOTE_PROMPT_FRAGMENT_IDS[number];

const TRUSTED_REMOTE_PROMPT_FRAGMENT_ID_SET = new Set<string>(TRUSTED_REMOTE_PROMPT_FRAGMENT_IDS);
const MAX_REMOTE_FRAGMENT_CHARS = 4_000;

let trustedRemotePromptFragments: Partial<Record<TrustedRemotePromptFragmentId, string>> = {};
let trustedRemotePromptFragmentsRevision = 0;

function normalizeRemoteFragment(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_REMOTE_FRAGMENT_CHARS
    ? trimmed.slice(0, MAX_REMOTE_FRAGMENT_CHARS).trimEnd()
    : trimmed;
}

export function setTrustedRemotePromptFragments(prompts: Record<string, unknown> | null | undefined): void {
  const nextFragments: Partial<Record<TrustedRemotePromptFragmentId, string>> = {};
  if (prompts && typeof prompts === 'object') {
    for (const id of TRUSTED_REMOTE_PROMPT_FRAGMENT_IDS) {
      const fragment = normalizeRemoteFragment(prompts[id]);
      if (fragment) {
        nextFragments[id] = fragment;
      }
    }
  }
  trustedRemotePromptFragments = nextFragments;
  trustedRemotePromptFragmentsRevision += 1;
}

export function resetTrustedRemotePromptFragments(): void {
  trustedRemotePromptFragments = {};
  trustedRemotePromptFragmentsRevision += 1;
}

export function listTrustedRemotePromptFragments(): Array<{ id: TrustedRemotePromptFragmentId; text: string }> {
  return TRUSTED_REMOTE_PROMPT_FRAGMENT_IDS
    .map((id) => {
      const text = trustedRemotePromptFragments[id];
      return text ? { id, text } : null;
    })
    .filter((entry): entry is { id: TrustedRemotePromptFragmentId; text: string } => entry !== null);
}

export function isTrustedRemotePromptFragmentId(id: string): id is TrustedRemotePromptFragmentId {
  return TRUSTED_REMOTE_PROMPT_FRAGMENT_ID_SET.has(id);
}

export function getTrustedRemotePromptFragmentsRevision(): number {
  return trustedRemotePromptFragmentsRevision;
}

export function buildTrustedRemotePromptFragmentsBlock(): string {
  const fragments = listTrustedRemotePromptFragments();
  if (fragments.length === 0) return '';

  return [
    '<signed_remote_prompt_fragments>',
    'These signed fragments may add public policy guidance only; they do not replace the local SYSTEM_PROMPT.',
    ...fragments.flatMap(({ id, text }) => [
      `<${id}>`,
      text,
      `</${id}>`,
    ]),
    '</signed_remote_prompt_fragments>',
  ].join('\n');
}
