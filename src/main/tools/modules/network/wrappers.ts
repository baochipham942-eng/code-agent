// ============================================================================
// network/ batch — 31 工具的 wrapper 模式实现（最终批）
//
// 涵盖：HTTP/scraping、文档生成（PDF/DOCX/XLSX/PPT）、媒体（图片/视频/音频/语音）、
// 社交（jira/github_pr/twitter/youtube/学术）、辅助（mermaid/qrcode/chart 等）
//
// 全部 wrapper，依赖大量第三方库 (sharp/playwright/cheerio/openai sdk/anthropic sdk
// /google sdk/youtube-transcript 等)。完成本批后 102 个 tool 全部迁完。
// ============================================================================

// HTTP / Web fetching
// web_fetch / WebFetch / WebSearch 已迁移为 Level 1 native module
// （见 modules/network/{webFetch,webFetchUnified,webSearch}.ts）
// http_request 已迁移为 native ToolModule（见 modules/network/httpRequest.ts）

// Document reading
// ReadDocument / read_docx / read_pdf / read_xlsx 已迁移为 native ToolModule
// （见 modules/network/{readDocument,readDocx,readPdf,readXlsx}.ts）

// Document generation
import { pptGenerateTool } from '../../media/ppt';
import { pptEditTool } from '../../media/ppt/editTool';
import { docxGenerateTool } from '../../document/docxGenerate';
import { excelGenerateTool } from '../../document/excelGenerate';
import { pdfGenerateTool } from '../../media/pdfGenerate';
import { pdfCompressTool } from '../../media/pdfCompress';
import { PdfAutomateTool } from '../../media/pdfAutomate';
import { xlwingsExecuteTool } from '../../document/xlwingsExecute';

// Media generation / processing
import { imageGenerateTool } from '../../media/imageGenerate';
import { imageProcessTool } from '../../media/imageProcess';
import { imageAnalyzeTool } from '../../media/imageAnalyze';
import { imageAnnotateTool } from '../../media/imageAnnotate';
import { videoGenerateTool } from '../../media/videoGenerate';
// text_to_speech 已迁移到 native，见 ./textToSpeech.ts
// speech_to_text 已迁移到 native，见 ./speechToText.ts
import { localSpeechToTextTool } from '../../media/localSpeechToText';

// Visual / chart helpers
// chart_generate / mermaid_export / qrcode_generate 已迁移至原生 ToolModule
// （见 modules/network/{chartGenerate,mermaidExport,qrcodeGenerate}.ts）
import { screenshotPageTool } from '../../web/screenshotPage';

// External integrations
// jira / github_pr / twitter_fetch / youtube_transcript / academic_search 已迁移为 native ToolModule
// （见 modules/network/{jira,githubPr,twitterFetch,youtubeTranscript,academicSearch}.ts）

import { wrapLegacyTool } from '../_helpers/legacyAdapter';

const NET_READ = {
  category: 'network' as const,
  permissionLevel: 'read' as const,
  readOnly: true,
  allowInPlanMode: true,
};
const NET_NETWORK_READ = {
  category: 'network' as const,
  permissionLevel: 'network' as const,
  readOnly: true,
  allowInPlanMode: true,
};
const NET_WRITE = {
  category: 'network' as const,
  permissionLevel: 'write' as const,
};
const NET_NETWORK_WRITE = {
  category: 'network' as const,
  permissionLevel: 'network' as const,
};

// ── HTTP / Web fetching (0) ─────────────────────────────────────────────
// web_fetch / WebFetch / WebSearch / http_request 已全部迁移为 native module

// ── Document reading (0) ────────────────────────────────────────────────
// ReadDocument / read_docx / read_pdf / read_xlsx 已全部迁移为 native

// ── Document generation (8) ─────────────────────────────────────────────
export const pptGenerateModule = wrapLegacyTool(pptGenerateTool, NET_NETWORK_WRITE);
export const pptEditModule = wrapLegacyTool(pptEditTool, NET_WRITE);
export const docxGenerateModule = wrapLegacyTool(docxGenerateTool, NET_WRITE);
export const excelGenerateModule = wrapLegacyTool(excelGenerateTool, NET_WRITE);
export const pdfGenerateModule = wrapLegacyTool(pdfGenerateTool, NET_WRITE);
export const pdfCompressModule = wrapLegacyTool(pdfCompressTool, NET_WRITE);
export const pdfAutomateModule = wrapLegacyTool(PdfAutomateTool, NET_WRITE);
export const xlwingsExecuteModule = wrapLegacyTool(xlwingsExecuteTool, NET_WRITE);

// ── Media (8) ───────────────────────────────────────────────────────────
export const imageGenerateModule = wrapLegacyTool(imageGenerateTool, NET_NETWORK_WRITE);
export const imageProcessModule = wrapLegacyTool(imageProcessTool, NET_WRITE);
export const imageAnalyzeModule = wrapLegacyTool(imageAnalyzeTool, NET_NETWORK_READ);
export const imageAnnotateModule = wrapLegacyTool(imageAnnotateTool, NET_WRITE);
export const videoGenerateModule = wrapLegacyTool(videoGenerateTool, NET_NETWORK_WRITE);
// text_to_speech 已迁移到 native，见 ./textToSpeech.ts
// speech_to_text 已迁移到 native，见 ./speechToText.ts
export const localSpeechToTextModule = wrapLegacyTool(localSpeechToTextTool, NET_READ);

// ── Visual helpers (1) ──────────────────────────────────────────────────
// chart_generate / mermaid_export / qrcode_generate 已迁移为 native
export const screenshotPageModule = wrapLegacyTool(screenshotPageTool, NET_NETWORK_READ);

// ── External integrations (0) ───────────────────────────────────────────
// jira / github_pr / twitter_fetch / youtube_transcript / academic_search 已全部迁移为 native
