import type { SkillRecommendation } from '../../../shared/contract/skillRepository';
import {
  SKILL_REGISTRY_MARKETPLACE_ID,
  type SkillRegistryEntry,
  type SkillRegistryListItem,
} from '../../../shared/contract/skillRegistry';

const DEFAULT_CAP = 2;
const ASCII_BOUNDARY = '[A-Za-z0-9_]';
const HAN_RE = /\p{Script=Han}/u;

export interface SkillRegistryDraftRecommendationOptions {
  alreadyRecommendedSkillNames?: ReadonlySet<string>;
  cap?: number;
}

interface CandidateMatch {
  entry: SkillRegistryEntry;
  matchedTerms: string[];
  score: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function isChineseTerm(term: string): boolean {
  return HAN_RE.test(term);
}

function isMatchableTerm(term: string): boolean {
  const normalized = normalizeText(term);
  if (!normalized) return false;
  return isChineseTerm(normalized) || normalized.length >= 3;
}

function matchesTerm(input: string, term: string): boolean {
  const normalizedTerm = normalizeText(term);
  if (!isMatchableTerm(normalizedTerm)) return false;
  if (isChineseTerm(normalizedTerm)) {
    return input.includes(normalizedTerm);
  }
  const pattern = new RegExp(
    `(^|(?<!${ASCII_BOUNDARY}))${escapeRegExp(normalizedTerm)}($|(?!${ASCII_BOUNDARY}))`,
    'i',
  );
  return pattern.test(input);
}

function getEntryTerms(entry: SkillRegistryEntry): string[] {
  return [
    entry.name,
    ...(entry.keywords ?? []),
    ...(entry.domains ?? []),
    ...(entry.tags ?? []),
  ];
}

function toRecommendation(match: CandidateMatch): SkillRecommendation {
  return {
    skillName: match.entry.name,
    libraryId: `${match.entry.name}@${SKILL_REGISTRY_MARKETPLACE_ID}`,
    reason: `Matched marketplace signals: ${match.matchedTerms.slice(0, 3).join(', ')}`,
    score: match.score,
    action: 'install',
    displayName: match.entry.displayName,
  };
}

export function matchSkillRegistryDraftRecommendations(
  draftText: string,
  items: SkillRegistryListItem[],
  options: SkillRegistryDraftRecommendationOptions = {},
): SkillRecommendation[] {
  const input = normalizeText(draftText);
  if (!input) return [];

  const alreadyRecommended = options.alreadyRecommendedSkillNames ?? new Set<string>();
  const cap = options.cap ?? DEFAULT_CAP;

  return items
    .filter((item) => !item.installed)
    .filter((item) => !alreadyRecommended.has(item.entry.name))
    .map<CandidateMatch | null>((item) => {
      const matchedTerms = Array.from(new Set(
        getEntryTerms(item.entry)
          .map(normalizeText)
          .filter((term) => matchesTerm(input, term)),
      ));
      if (matchedTerms.length === 0) return null;
      return {
        entry: item.entry,
        matchedTerms,
        score: Math.min(0.98, 0.5 + matchedTerms.length * 0.12),
      };
    })
    .filter((match): match is CandidateMatch => Boolean(match))
    .sort((left, right) =>
      right.matchedTerms.length - left.matchedTerms.length
      || left.entry.name.localeCompare(right.entry.name)
    )
    .slice(0, cap)
    .map(toRecommendation);
}
