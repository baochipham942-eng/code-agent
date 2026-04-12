// ============================================================================
// Artifact Extractor - 从消息内容中提取可视化产物
// ============================================================================

import type { Artifact } from '../../shared/contract/message';

let artifactCounter = 0;

/**
 * 扫描消息内容中的代码块，提取 artifact（chart / spreadsheet / mermaid / generative_ui）
 */
export function extractArtifacts(content: string): Artifact[] {
  const artifacts: Artifact[] = [];
  let match;

  // Match ```chart blocks
  const chartRegex = /```chart\n([\s\S]*?)```/g;
  while ((match = chartRegex.exec(content)) !== null) {
    artifacts.push({
      id: `artifact_${++artifactCounter}`,
      type: 'chart',
      content: match[1].trim(),
      version: 1,
      title: tryExtractTitle(match[1]),
    });
  }

  // Match ```spreadsheet blocks
  const spreadsheetRegex = /```spreadsheet\n([\s\S]*?)```/g;
  while ((match = spreadsheetRegex.exec(content)) !== null) {
    artifacts.push({
      id: `artifact_${++artifactCounter}`,
      type: 'spreadsheet',
      content: match[1].trim(),
      version: 1,
      title: tryExtractTitle(match[1]),
    });
  }

  // Match ```mermaid blocks
  const mermaidRegex = /```mermaid\n([\s\S]*?)```/g;
  while ((match = mermaidRegex.exec(content)) !== null) {
    artifacts.push({
      id: `artifact_${++artifactCounter}`,
      type: 'mermaid',
      content: match[1].trim(),
      version: 1,
    });
  }

  // Match ```html blocks (generative_ui) - only substantial HTML (>500 chars)
  const htmlRegex = /```html\n([\s\S]*?)```/g;
  while ((match = htmlRegex.exec(content)) !== null) {
    if (match[1].length > 500) {
      artifacts.push({
        id: `artifact_${++artifactCounter}`,
        type: 'generative_ui',
        content: match[1].trim(),
        version: 1,
        title: tryExtractHtmlTitle(match[1]),
      });
    }
  }

  return artifacts;
}

function tryExtractTitle(json: string): string | undefined {
  try {
    const parsed = JSON.parse(json);
    return parsed.title;
  } catch {
    return undefined;
  }
}

function tryExtractHtmlTitle(html: string): string | undefined {
  const titleMatch = html.match(/<title>(.*?)<\/title>/i);
  return titleMatch?.[1];
}
