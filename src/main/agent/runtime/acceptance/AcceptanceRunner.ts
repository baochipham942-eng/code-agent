import type {
  ScenarioAcceptanceArtifact,
  ScenarioAcceptanceCheck,
  ScenarioAcceptanceIssue,
  ScenarioAcceptanceResult,
  ScenarioAcceptanceSkillId,
  RunScenarioAcceptanceInput,
} from '../../../../shared/contract/scenarioAcceptance';
import {
  artifactText,
  createScenarioIssue,
  getScenarioAcceptanceSkill,
  inferScenarioAcceptanceSkillIds,
} from './scenarioSkills';
import { inferArtifactRepairIssueCodesFromText } from '../artifactRepairSpec';

type CheckFn = (artifact: ScenarioAcceptanceArtifact, reviewId: string) => ScenarioAcceptanceIssue[];

function compact(value: string, max = 180): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}...`;
}

function issueId(reviewId: string, artifact: ScenarioAcceptanceArtifact, code: string): string {
  return `${reviewId}:${artifact.id}:${code}`.replace(/\s+/g, '-');
}

function textHasEvidence(text: string): boolean {
  return /(https?:\/\/|\/Users\/|\.\/|\.\.\/|[A-Z]{2,}-\d+|github\.com|commit\s+[0-9a-f]{7,40}|#\d+|参考|引用|证据|source:|来源)/i.test(text);
}

function checkFrontendUi(artifact: ScenarioAcceptanceArtifact, reviewId: string): ScenarioAcceptanceIssue[] {
  const html = artifact.content?.html || artifactText(artifact);
  if (!html.trim()) return [];
  const issues: ScenarioAcceptanceIssue[] = [];
  if (!/<meta[^>]+name=["']viewport["']/i.test(html)) {
    issues.push(createScenarioIssue({
      id: issueId(reviewId, artifact, 'missing_viewport'),
      skillId: 'frontend_ui',
      artifactId: artifact.id,
      code: 'missing_viewport',
      evidence: ['No viewport meta tag found in HTML preview.'],
      anchor: { kind: 'artifact', filePath: artifact.filePath },
    }));
  }
  const fixedWidth = html.match(/(?:width|min-width)\s*:\s*(?:1[0-9]{3}|[2-9][0-9]{3,})px/i);
  if (fixedWidth) {
    issues.push(createScenarioIssue({
      id: issueId(reviewId, artifact, 'layout_overflow'),
      skillId: 'frontend_ui',
      artifactId: artifact.id,
      code: 'layout_overflow',
      evidence: [compact(fixedWidth[0])],
      anchor: { kind: 'text_quote', filePath: artifact.filePath, quote: fixedWidth[0] },
    }));
  }
  if (!/(max-width|minmax\(|@media|clamp\(|flex-wrap|grid-template-columns|container-type)/i.test(html)) {
    issues.push(createScenarioIssue({
      id: issueId(reviewId, artifact, 'weak_responsive_layout'),
      skillId: 'frontend_ui',
      artifactId: artifact.id,
      code: 'weak_responsive_layout',
      evidence: ['No obvious responsive CSS constraint detected.'],
      anchor: { kind: 'artifact', filePath: artifact.filePath },
    }));
  }
  return issues;
}

function checkAdminConsole(artifact: ScenarioAcceptanceArtifact, reviewId: string): ScenarioAcceptanceIssue[] {
  const text = artifactText(artifact);
  if (!text.trim()) return [];
  const issues: ScenarioAcceptanceIssue[] = [];
  if (!/(<table\b|role=["']?table|data-grid|\btable\b|\bgrid\b|\blist\b|列表|表格)/i.test(text)) {
    issues.push(createScenarioIssue({
      id: issueId(reviewId, artifact, 'missing_data_surface'),
      skillId: 'admin_console',
      artifactId: artifact.id,
      code: 'missing_data_surface',
      evidence: ['No table, list, or grid data surface detected.'],
      anchor: { kind: 'artifact', filePath: artifact.filePath },
    }));
  }
  if (!/(search|filter|筛选|搜索|segment|status filter|状态)/i.test(text)) {
    issues.push(createScenarioIssue({
      id: issueId(reviewId, artifact, 'missing_filter_controls'),
      skillId: 'admin_console',
      artifactId: artifact.id,
      code: 'missing_filter_controls',
      evidence: ['No search or filter control detected.'],
      anchor: { kind: 'artifact', filePath: artifact.filePath },
    }));
  }
  if (!/(checkbox|selected|bulk|batch|批量|全选|多选)/i.test(text)) {
    issues.push(createScenarioIssue({
      id: issueId(reviewId, artifact, 'missing_bulk_actions'),
      skillId: 'admin_console',
      artifactId: artifact.id,
      code: 'missing_bulk_actions',
      evidence: ['No row selection or bulk action affordance detected.'],
      anchor: { kind: 'artifact', filePath: artifact.filePath },
    }));
  }
  if (!/(drawer|details?|side\s*panel|aside|详情|抽屉|侧栏)/i.test(text)) {
    issues.push(createScenarioIssue({
      id: issueId(reviewId, artifact, 'missing_detail_panel'),
      skillId: 'admin_console',
      artifactId: artifact.id,
      code: 'missing_detail_panel',
      evidence: ['No detail panel, drawer, or expandable workflow detected.'],
      anchor: { kind: 'artifact', filePath: artifact.filePath },
    }));
  }
  return issues;
}

function checkDocumentReport(artifact: ScenarioAcceptanceArtifact, reviewId: string): ScenarioAcceptanceIssue[] {
  const text = artifactText(artifact);
  if (!text.trim()) return [];
  const issues: ScenarioAcceptanceIssue[] = [];
  const headingCount = (text.match(/^#{1,3}\s+\S/gm) || []).length;
  if (text.length > 500 && headingCount < 2) {
    issues.push(createScenarioIssue({
      id: issueId(reviewId, artifact, 'weak_document_structure'),
      skillId: 'document_report',
      artifactId: artifact.id,
      code: 'weak_document_structure',
      evidence: [`Long document has only ${headingCount} markdown headings.`],
      anchor: { kind: 'artifact', filePath: artifact.filePath },
    }));
  }
  if (/(结论|判断|建议|规划|原因|because|therefore|should)/i.test(text) && !textHasEvidence(text)) {
    issues.push(createScenarioIssue({
      id: issueId(reviewId, artifact, 'missing_evidence'),
      skillId: 'document_report',
      artifactId: artifact.id,
      code: 'missing_evidence',
      evidence: ['Document contains conclusions but no traceable source marker.'],
      anchor: { kind: 'artifact', filePath: artifact.filePath },
    }));
  }
  return issues;
}

function checkResearchEvidence(artifact: ScenarioAcceptanceArtifact, reviewId: string): ScenarioAcceptanceIssue[] {
  const text = artifactText(artifact);
  if (!text.trim()) return [];
  const issues: ScenarioAcceptanceIssue[] = [];
  if (!textHasEvidence(text)) {
    issues.push(createScenarioIssue({
      id: issueId(reviewId, artifact, 'missing_evidence'),
      skillId: 'research_evidence',
      artifactId: artifact.id,
      code: 'missing_evidence',
      evidence: ['Research output has no URL, path, issue key, commit, or source marker.'],
      anchor: { kind: 'artifact', filePath: artifact.filePath },
    }));
  }
  if (/(最新|全部|一定|confirmed|always|never|must)\b/i.test(text) && !/(推断|可能|未证实|assumption|source|evidence|引用|证据)/i.test(text)) {
    issues.push(createScenarioIssue({
      id: issueId(reviewId, artifact, 'unmarked_uncertainty'),
      skillId: 'research_evidence',
      artifactId: artifact.id,
      code: 'unmarked_uncertainty',
      evidence: ['Strong claim detected without uncertainty or evidence boundary marker.'],
      anchor: { kind: 'artifact', filePath: artifact.filePath },
    }));
  }
  return issues;
}

function checkDeploymentShare(artifact: ScenarioAcceptanceArtifact, reviewId: string): ScenarioAcceptanceIssue[] {
  const text = artifactText(artifact);
  if (!text.trim()) return [];
  const issues: ScenarioAcceptanceIssue[] = [];
  if (/(production|prod\b|上线|正式环境|部署到|publish)/i.test(text) && !/(preview|预览|rollback|回滚|cleanup|清理|staging|灰度)/i.test(text)) {
    issues.push(createScenarioIssue({
      id: issueId(reviewId, artifact, 'unsafe_deploy_target'),
      skillId: 'deployment_share',
      artifactId: artifact.id,
      code: 'unsafe_deploy_target',
      evidence: ['Deployment wording references production without preview or rollback boundary.'],
      anchor: { kind: 'artifact', filePath: artifact.filePath },
    }));
  }
  if (/(deploy|deployment|部署|发布|分享)/i.test(text) && !/(https?:\/\/|vercel|cloudflare|pages|github pages|本地|localhost|artifact|路径|path)/i.test(text)) {
    issues.push(createScenarioIssue({
      id: issueId(reviewId, artifact, 'missing_deploy_target'),
      skillId: 'deployment_share',
      artifactId: artifact.id,
      code: 'missing_deploy_target',
      evidence: ['Deployment/share output does not name a concrete target or URL.'],
      anchor: { kind: 'artifact', filePath: artifact.filePath },
    }));
  }
  return issues;
}

function checkGameGeneration(artifact: ScenarioAcceptanceArtifact, reviewId: string): ScenarioAcceptanceIssue[] {
  const text = artifactText(artifact);
  if (!text.trim()) return [];
  const issues: ScenarioAcceptanceIssue[] = [];
  const inferredCodes = inferArtifactRepairIssueCodesFromText(text).filter(
    (code) => code !== 'generic_validation_failure',
  );
  for (const code of inferredCodes) {
    issues.push(createScenarioIssue({
      id: issueId(reviewId, artifact, String(code)),
      skillId: 'game_generation',
      artifactId: artifact.id,
      code: String(code),
      evidence: [compact(text)],
      anchor: { kind: 'artifact', filePath: artifact.filePath },
    }));
  }
  if (/__(?:GAME|INTERACTIVE)_META__/i.test(text) && !/window\.__(?:GAME|INTERACTIVE)_TEST__/.test(text)) {
    issues.push(createScenarioIssue({
      id: issueId(reviewId, artifact, 'missing_test_contract'),
      skillId: 'game_generation',
      artifactId: artifact.id,
      code: 'missing_test_contract',
      evidence: ['Game metadata exists but no game/interactive test contract was found.'],
      anchor: { kind: 'artifact', filePath: artifact.filePath },
    }));
  } else if (/window\.__(?:GAME|INTERACTIVE)_TEST__/.test(text) && !/runSmokeTest\s*\(/.test(text)) {
    issues.push(createScenarioIssue({
      id: issueId(reviewId, artifact, 'missing_contract_smoke'),
      skillId: 'game_generation',
      artifactId: artifact.id,
      code: 'missing_contract_smoke',
      evidence: ['Game test contract exists but no runSmokeTest() was found.'],
      anchor: { kind: 'artifact', filePath: artifact.filePath },
    }));
  }
  return dedupeIssues(issues);
}

const CHECKERS: Record<ScenarioAcceptanceSkillId, CheckFn> = {
  frontend_ui: checkFrontendUi,
  admin_console: checkAdminConsole,
  document_report: checkDocumentReport,
  research_evidence: checkResearchEvidence,
  deployment_share: checkDeploymentShare,
  game_generation: checkGameGeneration,
};

function dedupeIssues(issues: ScenarioAcceptanceIssue[]): ScenarioAcceptanceIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.artifactId}:${issue.skillId}:${issue.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function summarize(status: ScenarioAcceptanceResult['status'], issues: ScenarioAcceptanceIssue[]): string {
  if (status === 'pass') return 'Delivery review passed.';
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const warnings = issues.length - errors;
  return `Delivery review found ${errors} error${errors === 1 ? '' : 's'} and ${warnings} warning${warnings === 1 ? '' : 's'}.`;
}

function scoreIssues(issues: ScenarioAcceptanceIssue[]): number {
  const penalty = issues.reduce((sum, issue) => sum + (issue.severity === 'error' ? 25 : 10), 0);
  return Math.max(0, 100 - penalty);
}

function statusForIssues(issues: ScenarioAcceptanceIssue[]): ScenarioAcceptanceResult['status'] {
  if (issues.length === 0) return 'pass';
  if (issues.some((issue) => issue.code === 'unsafe_deploy_target') || issues.filter((issue) => issue.severity === 'error').length >= 3) {
    return 'blocked';
  }
  return 'needs_work';
}

export function runScenarioAcceptance(input: RunScenarioAcceptanceInput): ScenarioAcceptanceResult {
  const createdAt = Date.now();
  const reviewId = `delivery-review:${input.sessionId ?? 'local'}:${createdAt}`;
  const selectedIds = input.selectedSkillIds?.length
    ? input.selectedSkillIds
    : inferScenarioAcceptanceSkillIds(input.artifacts);
  const skills = selectedIds
    .map((id) => getScenarioAcceptanceSkill(id))
    .filter((skill): skill is NonNullable<typeof skill> => Boolean(skill));

  const checks: ScenarioAcceptanceCheck[] = [];
  const issues: ScenarioAcceptanceIssue[] = [];
  for (const skill of skills) {
    const checker = CHECKERS[skill.id];
    const applicable = input.artifacts.filter((artifact) => skill.appliesTo.includes(artifact.kind));
    checks.push({
      id: `${reviewId}:${skill.id}:applies`,
      skillId: skill.id,
      label: `${skill.title} applies to ${applicable.length} artifact${applicable.length === 1 ? '' : 's'}`,
      passed: applicable.length > 0,
    });
    for (const artifact of applicable) {
      const before = issues.length;
      issues.push(...checker(artifact, reviewId));
      checks.push({
        id: `${reviewId}:${skill.id}:${artifact.id}`,
        skillId: skill.id,
        artifactId: artifact.id,
        label: `${skill.title} check for ${artifact.title}`,
        passed: issues.length === before,
      });
    }
  }

  const deduped = dedupeIssues(issues);
  const status = statusForIssues(deduped);
  const score = scoreIssues(deduped);

  return {
    id: reviewId,
    status,
    score,
    summary: summarize(status, deduped),
    skills,
    issues: deduped,
    checks,
    createdAt,
  };
}

export { listScenarioAcceptanceSkills } from './scenarioSkills';
