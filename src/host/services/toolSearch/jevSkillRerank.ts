import {
  JEV_MODEL,
  JEV_TIMEOUT_MS,
  skillRerank,
  type JevAnswers,
  type JevNoulAnswer,
  type JevQuestionSpec,
} from '../../../shared/constants/jevQuestions';
import type {
  JevSkillRerankJudge,
  ToolSearchOptions,
} from '../../../shared/contract/toolSearch';
import { getFeatureFlagService } from '../cloud/featureFlagService';
import { resolveProviderApiKey } from '../../model/providers/providerResolution';
import { guardSensitiveText } from '../../security/sensitiveDataGuard';

const JEV_SKILL_RERANK_ENV = 'CODE_AGENT_JEV_SKILL_RERANK';

function isJevSkillRerankEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[JEV_SKILL_RERANK_ENV] === '1' && getFeatureFlagService().isEnabled('jev_skill_rerank');
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function readChoice(answer: JevAnswers[string] | undefined): { choice: string; confidence: number } {
  if (!answer || typeof answer !== 'object' || !('choice' in answer)) {
    throw new Error('Jev skill rerank returned an invalid choice answer');
  }
  const choice = answer as { choice?: unknown; confidence?: unknown };
  if (typeof choice.choice !== 'string' || !isUnitInterval(choice.confidence)) {
    throw new Error('Jev skill rerank returned an invalid choice shape');
  }
  return { choice: choice.choice, confidence: choice.confidence };
}

function readNoul(answer: JevAnswers[string] | undefined, name: string): JevNoulAnswer {
  if (!answer || typeof answer !== 'object' || !('noul' in answer)) {
    throw new Error(`Jev skill rerank returned an invalid ${name} answer`);
  }
  const noul = (answer as { noul?: unknown }).noul;
  if (!isUnitInterval(noul)) throw new Error(`Jev skill rerank returned an invalid ${name} shape`);
  return { noul };
}

function buildQuestions(roster: Array<{ name: string; description: string }>): Record<string, JevQuestionSpec> {
  return {
    ...skillRerank.questions,
    choice: {
      ...skillRerank.questions.choice,
      criteria: Object.fromEntries(roster.map(({ name, description }) => [name, description])),
    },
  };
}

function createJevSkillRerankJudge(): JevSkillRerankJudge {
  return async ({ query, roster }) => {
    const { systemOne } = await import('../../model/providers/typesafeProvider');
    const guard = (value: string) => guardSensitiveText(value, {
      surface: 'telemetry',
      mode: 'model-context',
    });
    const safeRoster = roster.map(({ name, description }) => ({
      name,
      description: guard(description),
    }));
    const answers = await systemOne(
      { query: guard(query), roster: safeRoster },
      buildQuestions(safeRoster),
      { timeoutMs: JEV_TIMEOUT_MS },
    );
    return {
      choice: readChoice(answers.choice),
      nouls: {
        need_skill: readNoul(answers.need_skill, 'need_skill'),
        need_now: readNoul(answers.need_now, 'need_now'),
        none_of_roster: readNoul(answers.none_of_roster, 'none_of_roster'),
      },
    };
  };
}

/** Production wiring stays inert unless both the cloud flag and Jev env gate are on. */
export function resolveJevSkillRerankOptions(
  env: NodeJS.ProcessEnv = process.env,
): ToolSearchOptions['rerank'] | undefined {
  if (!isJevSkillRerankEnabled(env)) return undefined;
  if (!resolveProviderApiKey({ provider: 'typesafe', model: JEV_MODEL })) return undefined;
  return { enabled: true, judge: createJevSkillRerankJudge() };
}
