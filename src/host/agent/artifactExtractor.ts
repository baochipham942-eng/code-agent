// ============================================================================
// Artifact Extractor - 从消息内容中提取可视化产物
// ============================================================================

import type { Artifact } from '../../shared/contract/message';

type ArtifactType = Artifact['type'];

function hashString(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function artifactId(type: ArtifactType, content: string, index: number): string {
  return `artifact_${type}_${index}_${hashString(content)}`;
}

function pushArtifact(
  artifacts: Artifact[],
  type: ArtifactType,
  content: string,
  title?: string,
): void {
  artifacts.push({
    id: artifactId(type, content, artifacts.length + 1),
    type,
    content: content.trim(),
    version: 1,
    ...(title ? { title } : {}),
  });
}

/**
 * 扫描消息内容中的代码块，提取 artifact（chart / spreadsheet / mermaid / generative_ui / neo_ui）
 */
export function extractArtifacts(content: string): Artifact[] {
  const artifacts: Artifact[] = [];
  let match;

  // Match ```chart blocks
  const chartRegex = /```chart\n([\s\S]*?)```/g;
  while ((match = chartRegex.exec(content)) !== null) {
    pushArtifact(artifacts, 'chart', match[1], tryExtractTitle(match[1]));
  }

  // Match ```spreadsheet blocks
  const spreadsheetRegex = /```spreadsheet\n([\s\S]*?)```/g;
  while ((match = spreadsheetRegex.exec(content)) !== null) {
    pushArtifact(artifacts, 'spreadsheet', match[1], tryExtractTitle(match[1]));
  }

  // Match ```mermaid blocks
  const mermaidRegex = /```mermaid\n([\s\S]*?)```/g;
  while ((match = mermaidRegex.exec(content)) !== null) {
    pushArtifact(artifacts, 'mermaid', match[1]);
  }

  // Legacy HTML generative UI. Both historical ```html and the prompt's
  // canonical ```generative_ui language are accepted and rebuilt on reload.
  const htmlRegex = /```(?:html|generative_ui)\s*\n([\s\S]*?)```/g;
  while ((match = htmlRegex.exec(content)) !== null) {
    if (match[1].length > 500) {
      pushArtifact(artifacts, 'generative_ui', match[1], tryExtractHtmlTitle(match[1]));
    }
  }

  // Native declarative Generative UI. Validation and Host admission happen in
  // GenerativeUIService; extraction only preserves the durable message artifact.
  const neoUIRegex = /```neo_ui\s*\n([\s\S]*?)```/g;
  while ((match = neoUIRegex.exec(content)) !== null) {
    pushArtifact(artifacts, 'neo_ui', match[1], tryExtractTitle(match[1]));
  }

  // Match ```question-form blocks — design brief 收集表单（先问后做）
  const questionFormRegex = /```question-form\s*\n([\s\S]*?)```/g;
  while ((match = questionFormRegex.exec(content)) !== null) {
    pushArtifact(artifacts, 'question_form', match[1]);
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
