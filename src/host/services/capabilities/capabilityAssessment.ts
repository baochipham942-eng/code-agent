import type {
  CapabilityAssessmentInfo,
  CapabilityCenterItem,
} from '../../../shared/contract/capability';

function normalizeAssessmentText(item: CapabilityCenterItem): string {
  return [
    item.id,
    item.kind,
    item.name,
    item.summary,
    item.description,
    item.source.label,
    item.source.path,
    item.source.url,
    ...item.tags,
    ...(item.audit.notes || []),
  ].filter(Boolean).join(' ').toLowerCase();
}

function buildCapabilityAssessment(item: CapabilityCenterItem): CapabilityAssessmentInfo | undefined {
  const text = normalizeAssessmentText(item);

  if (/(yyb|androws|应用宝|小程序|mini[-_ ]?program|wechat mini)/i.test(text)) {
    return {
      priority: 'P2',
      portability: 'reference_only',
      recommendedUse: '只作为 Windows 应用链路和小程序 adapter 的产品 spec 参考，Mac runtime 暂不启用。',
      evidenceRefs: ['marvis:yyb-androws-miniprogram', item.id],
    };
  }

  if (/(browser|agent-browser|computer|desktop|mac-desktop|浏览器|桌面|计算机控制)/i.test(text)) {
    return {
      priority: 'P0',
      portability: 'native',
      recommendedUse: '用于登录态、表单、多页网页操作、截图观察和 macOS 桌面自动化；纯阅读任务优先走轻量读取。',
      evidenceRefs: ['marvis:browser-computer-desktop', item.id],
    };
  }

  if (/(excel|xlsx|docx|document|office|ppt|pptx|slide|frontend-slides|pdf|word|文档|办公)/i.test(text)) {
    return {
      priority: 'P1',
      portability: 'native',
      recommendedUse: '用于办公文档和数据产物生成；先读取/分析源材料，生成后必须回读或做结构校验。',
      evidenceRefs: ['marvis:file-search-ripgrep-office', item.id],
    };
  }

  if (/(file|search|ripgrep|rg|grep|glob|read_file|read text|文件|搜索|检索)/i.test(text)) {
    return {
      priority: 'P1',
      portability: 'native',
      recommendedUse: '用于文件读取、检索、摘要和代码库定位；读搜任务先用轻量工具，编辑和生成再升级到 skill。',
      evidenceRefs: ['marvis:file-search-ripgrep-office', item.id],
    };
  }

  return undefined;
}

export function withCapabilityAssessment(item: CapabilityCenterItem): CapabilityCenterItem {
  if (item.assessment) {
    return item;
  }

  const assessment = buildCapabilityAssessment(item);
  return assessment ? { ...item, assessment } : item;
}
