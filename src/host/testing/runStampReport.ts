import type { EvalRunStamp } from '../../shared/contract/evaluation';

const SPLIT_LABELS: Record<EvalRunStamp['evalSet']['split'], string> = {
  'held-in': '日常集',
  'held-out': '留出集',
  control: '校准集',
  safety: '安全集',
  all: '全部',
};

const DIFFERENCE_LABELS: Record<string, string> = {
  skills: '可用技能',
  plugins: '插件面',
  memory: '长期记忆',
  swarm: '多智能体',
  harness: '运行配置',
  unknown: '未知',
};

function markdownCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

function formatEvalSet(stamp: EvalRunStamp): string {
  const parts = [SPLIT_LABELS[stamp.evalSet.split]];
  if (stamp.evalSet.tags.length) parts.push(`标签：${stamp.evalSet.tags.join('、')}`);
  if (stamp.evalSet.ids.length) parts.push(`指定题：${stamp.evalSet.ids.join('、')}`);
  parts.push(`切分文件版本：${stamp.evalSet.splitsFileSha}`);
  return parts.join('；');
}

function formatScorers(stamp: EvalRunStamp): string {
  const calibration = stamp.scorers.aiReviewCalibration ?? {};
  const aiReview = (stamp.scorers.aiReview ?? []).map((dimension) => (
    `${dimension}（${calibration[dimension] ?? 'uncalibrated'}）`
  ));
  const legacyJudge = stamp.scorers.judge === 'llm'
    ? `；对比实验评审（${stamp.scorers.judgeModel}）`
    : '';
  return `确定性断言${aiReview.length ? `；AI 评审：${aiReview.join('、')}` : ''}${legacyJudge}`;
}

function formatShape(stamp: EvalRunStamp): string {
  const harness = stamp.shape.harness;
  const harnessSummary = harness
    ? [
        `名称：${harness.name}`,
        harness.contextCompression === undefined ? null : `自动压缩：${harness.contextCompression ? '开' : '关'}`,
        harness.compressionPipeline === undefined ? null : `分层压缩：${harness.compressionPipeline ? '开' : '关'}`,
        harness.scaffoldProfile === undefined ? null : `模型引导：${harness.scaffoldProfile ? '开' : '关'}`,
        harness.thinkingInjection === undefined ? null : `思考提示：${harness.thinkingInjection ? '开' : '关'}`,
        harness.hooksEnabled === undefined ? null : `自动检查：${harness.hooksEnabled ? '开' : '关'}`,
        harness.toolMode === undefined ? null : `工具加载：${harness.toolMode === 'deferred' ? '按需' : '全部'}`,
      ].filter((item): item is string => item !== null).join('，')
    : '未单独指定';
  return [
    `技能：${stamp.shape.skills.length ? stamp.shape.skills.join('、') : '无'}`,
    `插件：${stamp.shape.plugins?.length ? stamp.shape.plugins.join('、') : '无'}`,
    `长期记忆：${stamp.shape.memory ? '开' : '关'}`,
    `多智能体：${stamp.shape.swarm ? '开' : '关'}`,
    `运行配置：${harnessSummary}`,
  ].join('；');
}

function formatKeySource(source: EvalRunStamp['keySource']): string {
  if (source === 'none') return '未使用';
  if (source.startsWith('env:')) return `环境变量（${source.slice(4)}）`;
  return `配置文件（${source.slice(5)}）`;
}

export function getRunStampReportRows(stamp: EvalRunStamp): Array<[string, string]> {
  return [
    ['题库版本', stamp.caseBankSha],
    ['答案侧版本', stamp.answerSideSha],
    ['评测集', formatEvalSet(stamp)],
    ['打分器', formatScorers(stamp)],
    ['每题跑几次', String(stamp.k)],
    ['计分规则版本', String(stamp.aggregationRuleVersion)],
    ['提示词版本', stamp.promptVersion],
    ['本轮形态', formatShape(stamp)],
    ['与生产默认的差异', stamp.divergesFromProduction.length
      ? stamp.divergesFromProduction.map((key) => DIFFERENCE_LABELS[key] ?? key).join('、')
      : '无'],
    ['密钥来源', formatKeySource(stamp.keySource)],
    ['价格表版本', String(stamp.priceTableVersion)],
    ['预估费用', `$${stamp.estimatedCostUsd.toFixed(4)}`],
  ].map(([label, value]) => [markdownCell(label), markdownCell(value)]);
}
