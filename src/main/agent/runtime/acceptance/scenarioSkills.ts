import type {
  ScenarioAcceptanceArtifact,
  ScenarioAcceptanceIssue,
  ScenarioAcceptanceSeverity,
  ScenarioAcceptanceSkill,
  ScenarioAcceptanceSkillId,
} from '../../../../shared/contract/scenarioAcceptance';

export interface ScenarioAcceptanceIssueTemplate {
  code: string;
  severity: ScenarioAcceptanceSeverity;
  title: string;
  message: string;
  repairInstruction: string;
}

const SKILLS: readonly ScenarioAcceptanceSkill[] = [
  {
    id: 'frontend_ui',
    title: 'Frontend UI',
    description: '验收 HTML / Web 交付物的响应式、可见性、基础交互状态和视觉 smoke 入口。',
    appliesTo: ['generic_html', 'web_snapshot', 'file'],
    issueCodes: ['missing_viewport', 'layout_overflow', 'weak_responsive_layout'],
    reviewDimensions: ['responsive layout', 'visible state', 'interaction affordance'],
    promptSnippet: 'Check viewport safety, responsive constraints, non-overlapping visible states, and basic interactive affordances before delivery.',
  },
  {
    id: 'admin_console',
    title: 'Admin Console',
    description: '验收后台类页面的信息密度、筛选、批量操作和详情工作流。',
    appliesTo: ['generic_html', 'web_snapshot', 'file'],
    issueCodes: ['missing_data_surface', 'missing_filter_controls', 'missing_bulk_actions', 'missing_detail_panel'],
    reviewDimensions: ['data surface', 'operator workflow', 'state consistency'],
    promptSnippet: 'Admin surfaces should expose scannable data, filtering, repeated actions, and a clear detail or drawer workflow.',
  },
  {
    id: 'document_report',
    title: 'Document Report',
    description: '验收文档和报告的结构、证据、结论分层与可读性。',
    appliesTo: ['document', 'handoff', 'file', 'message_draft'],
    issueCodes: ['weak_document_structure', 'missing_evidence'],
    reviewDimensions: ['structure', 'evidence', 'readability'],
    promptSnippet: 'Reports need clear headings, traceable evidence, and conclusions separated from assumptions or analysis.',
  },
  {
    id: 'research_evidence',
    title: 'Research Evidence',
    description: '验收研究型输出的来源可信度、事实追溯和未证实结论标记。',
    appliesTo: ['document', 'handoff', 'message_draft', 'web_snapshot', 'file'],
    issueCodes: ['missing_evidence', 'unmarked_uncertainty'],
    reviewDimensions: ['source quality', 'fact traceability', 'uncertainty marking'],
    promptSnippet: 'Research claims need URLs, file paths, issue keys, or explicit evidence markers; uncertain claims should be labeled.',
  },
  {
    id: 'deployment_share',
    title: 'Deployment Share',
    description: '验收部署/分享交付物的目标、预览、安全边界和回滚提示。',
    appliesTo: ['document', 'message_draft', 'generic_html', 'file'],
    issueCodes: ['unsafe_deploy_target', 'missing_deploy_target'],
    reviewDimensions: ['target clarity', 'preview safety', 'rollback readiness'],
    promptSnippet: 'Deployment handoff must separate preview from production, name the target, and include rollback or cleanup guidance.',
  },
  {
    id: 'game_generation',
    title: 'Game Generation',
    description: '复用现有 game/platformer 生成验收链路的 issue code 和修复策略。',
    appliesTo: ['game_artifact', 'generic_html', 'file'],
    issueCodes: ['missing_test_contract', 'missing_contract_smoke', 'frontend_visual_smoke_failed'],
    reviewDimensions: ['playable contract', 'runtime smoke', 'repair monotonicity'],
    promptSnippet: 'Game artifacts need a playable contract, deterministic smoke evidence, and repairs scoped to generated artifact output.',
  },
];

export const SCENARIO_ACCEPTANCE_SKILLS = SKILLS;

const ISSUE_TEMPLATES: Record<string, ScenarioAcceptanceIssueTemplate> = {
  missing_viewport: {
    code: 'missing_viewport',
    severity: 'warning',
    title: '缺少移动端 viewport',
    message: 'HTML 预览没有声明 viewport，移动端尺寸和缩放验收不可靠。',
    repairInstruction: 'Add a viewport meta tag and verify the layout at mobile and desktop widths.',
  },
  layout_overflow: {
    code: 'layout_overflow',
    severity: 'error',
    title: '存在固定宽度溢出风险',
    message: '页面里出现大固定宽度或 min-width，容易在窄屏裁切。',
    repairInstruction: 'Replace fixed wide dimensions with responsive constraints such as max-width, minmax grid tracks, or container-relative sizing.',
  },
  weak_responsive_layout: {
    code: 'weak_responsive_layout',
    severity: 'warning',
    title: '响应式约束不足',
    message: '页面没有明显的响应式约束，交付前需要补移动端布局保护。',
    repairInstruction: 'Add responsive grid/flex constraints, max-width rules, and at least one mobile breakpoint or container-aware layout rule.',
  },
  missing_data_surface: {
    code: 'missing_data_surface',
    severity: 'error',
    title: '后台页缺少核心数据面',
    message: '后台/管理台交付物没有表格、列表或网格数据面，无法支撑重复操作。',
    repairInstruction: 'Add a scannable data surface with rows, statuses, timestamps, owners, or comparable operational fields.',
  },
  missing_filter_controls: {
    code: 'missing_filter_controls',
    severity: 'warning',
    title: '后台页缺少筛选入口',
    message: '管理台场景没有搜索、筛选、标签或状态过滤控件。',
    repairInstruction: 'Add search or filter controls that map to the main data surface and expose the most common operator pivots.',
  },
  missing_bulk_actions: {
    code: 'missing_bulk_actions',
    severity: 'warning',
    title: '后台页缺少批量动作',
    message: '管理台场景没有选择框、批量操作条或重复动作入口。',
    repairInstruction: 'Add row selection and one restrained bulk action area for repeated operational workflows.',
  },
  missing_detail_panel: {
    code: 'missing_detail_panel',
    severity: 'warning',
    title: '后台页缺少详情工作流',
    message: '管理台场景没有详情抽屉、侧栏或可展开行，用户难以从列表进入处理状态。',
    repairInstruction: 'Add a detail drawer, side panel, or expandable row that shows the selected record and next actions.',
  },
  weak_document_structure: {
    code: 'weak_document_structure',
    severity: 'warning',
    title: '文档结构不足',
    message: '长文档缺少足够标题或段落结构，阅读和复核成本偏高。',
    repairInstruction: 'Split the document into clear sections with concise headings and keep conclusion, evidence, and assumptions separate.',
  },
  missing_evidence: {
    code: 'missing_evidence',
    severity: 'error',
    title: '缺少可追溯证据',
    message: '输出包含判断或研究结论，但没有 URL、文件路径、issue key、commit 或引用标记。',
    repairInstruction: 'Attach concrete sources for each important claim, or mark the claim as analysis when direct evidence is unavailable.',
  },
  unmarked_uncertainty: {
    code: 'unmarked_uncertainty',
    severity: 'warning',
    title: '未标记不确定结论',
    message: '输出里有强断言，但没有说明证据边界或不确定性。',
    repairInstruction: 'Label inferred, stale, or partially verified claims and separate them from directly evidenced facts.',
  },
  unsafe_deploy_target: {
    code: 'unsafe_deploy_target',
    severity: 'error',
    title: '部署目标边界不清',
    message: '交付物提到上线或生产部署，但没有区分 preview、production、回滚或清理边界。',
    repairInstruction: 'Split preview deployment from production deployment, name the target, and add rollback or cleanup instructions.',
  },
  missing_deploy_target: {
    code: 'missing_deploy_target',
    severity: 'warning',
    title: '缺少部署目标',
    message: '部署/分享交付物没有说明目标平台、URL 或预览位置。',
    repairInstruction: 'Name the target platform and include the expected preview URL or artifact path.',
  },
  missing_test_contract: {
    code: 'missing_test_contract',
    severity: 'error',
    title: '游戏缺少测试合约',
    message: '游戏交付物没有暴露 window.__GAME_TEST__ 或 window.__INTERACTIVE_TEST__。',
    repairInstruction: 'Expose a deterministic test contract with start(), snapshot(), and runSmokeTest() on the same rendered window.',
  },
  missing_contract_smoke: {
    code: 'missing_contract_smoke',
    severity: 'error',
    title: '游戏缺少 smoke 入口',
    message: '游戏交付物没有 runSmokeTest()，无法证明核心玩法可以被机器复查。',
    repairInstruction: 'Add runSmokeTest() that drives real controls and returns structured checks, failures, and coverage.',
  },
  frontend_visual_smoke_failed: {
    code: 'frontend_visual_smoke_failed',
    severity: 'error',
    title: '浏览器视觉 smoke 未通过',
    message: '交付物存在浏览器渲染或可见性问题，需要修复真实页面。',
    repairInstruction: 'Resolve console/page errors, verify nonblank rendered content, and keep the contract attached to the rendered state.',
  },
};

export function listScenarioAcceptanceSkills(): ScenarioAcceptanceSkill[] {
  return SCENARIO_ACCEPTANCE_SKILLS.map((skill) => ({ ...skill }));
}

export function getScenarioAcceptanceSkill(id: ScenarioAcceptanceSkillId): ScenarioAcceptanceSkill | undefined {
  return SCENARIO_ACCEPTANCE_SKILLS.find((skill) => skill.id === id);
}

export function getScenarioIssueTemplate(code: string): ScenarioAcceptanceIssueTemplate | undefined {
  return ISSUE_TEMPLATES[code];
}

export function createScenarioIssue(
  input: Omit<ScenarioAcceptanceIssue, 'title' | 'message' | 'repairInstruction' | 'severity'> & {
    severity?: ScenarioAcceptanceSeverity;
    title?: string;
    message?: string;
    repairInstruction?: string;
  },
): ScenarioAcceptanceIssue {
  const template = ISSUE_TEMPLATES[input.code];
  return {
    ...input,
    severity: input.severity ?? template?.severity ?? 'warning',
    title: input.title ?? template?.title ?? input.code,
    message: input.message ?? template?.message ?? input.code,
    repairInstruction: input.repairInstruction ?? template?.repairInstruction ?? 'Repair the artifact and rerun delivery review.',
  };
}

export function inferScenarioAcceptanceSkillIds(
  artifacts: readonly ScenarioAcceptanceArtifact[],
): ScenarioAcceptanceSkillId[] {
  const ids = new Set<ScenarioAcceptanceSkillId>();
  for (const artifact of artifacts) {
    const text = artifactText(artifact);
    const titlePath = `${artifact.title} ${artifact.filePath ?? ''}`.toLowerCase();
    const combined = `${titlePath} ${text.toLowerCase()}`;

    if (/__game_meta__|__interactive_meta__|game[_-]?test|platformer|runner|游戏|玩法/.test(combined)) {
      ids.add('game_generation');
    }
    if (/deploy|deployment|vercel|cloudflare|pages|上线|部署|发布|preview url|production/.test(combined)) {
      ids.add('deployment_share');
    }
    if (/admin|console|dashboard|后台|管理台|table|grid|batch|filter|status/.test(combined)) {
      ids.add('admin_console');
    } else if (artifact.kind === 'generic_html' || artifact.kind === 'web_snapshot') {
      ids.add('frontend_ui');
    }
    if (artifact.kind === 'document' || artifact.kind === 'handoff' || artifact.kind === 'message_draft') {
      if (/research|evidence|source|jira|confluence|github|引用|证据|调研|研究/.test(combined)) {
        ids.add('research_evidence');
      } else {
        ids.add('document_report');
      }
    }
  }
  return ids.size > 0 ? [...ids] : ['document_report'];
}

export function artifactText(artifact: ScenarioAcceptanceArtifact): string {
  return [
    artifact.content?.summary,
    artifact.content?.text,
    artifact.content?.html,
    artifact.content?.json,
    artifact.content?.diff,
  ].filter((value): value is string => Boolean(value)).join('\n');
}
