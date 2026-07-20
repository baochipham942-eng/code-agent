// ============================================================================
// Screenshot Tool - Capture screen/window screenshots with optional AI analysis
// Gen 6: Computer Use capability
// 支持智谱 GLM-4.6V-Flash 视觉分析
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { analyzeImageWithVisionDetailed } from '../../services/desktop/visionAnalysisService';
import { getComputerSurface } from '../../services/desktop/computerSurface';
import { persistBrowserComputerProofFromResult } from '../../session/browserComputerProofStore';
import {
  buildBrowserComputerProof,
  renderBrowserComputerEvidenceCard,
  type BrowserComputerVisualObservation,
} from '../../../shared/utils/browserComputerRedaction';

const execAsync = promisify(exec);

function buildAnalysisFailureMessage(args: {
  outputPath: string;
  sizeBytes: number;
  target: string;
  windowName?: string;
  timestampIso: string;
  reason: string;
}): string {
  return [
    'Screenshot captured, but AI vision analysis failed.',
    'The assistant cannot observe or describe the screen content from this result.',
    `- Path: ${args.outputPath}`,
    `- Size: ${(args.sizeBytes / 1024).toFixed(2)} KB`,
    `- Target: ${args.target}${args.windowName ? ` (${args.windowName})` : ''}`,
    `- Timestamp: ${args.timestampIso}`,
    `- Vision error: ${args.reason}`,
  ].join('\n');
}

function withScreenshotProof(
  result: ToolExecutionResult,
  context: ToolContext,
  args: {
    outputPath: string;
    analyzed: boolean;
    analysisRequested: boolean;
    cannotObserveScreen?: boolean;
  },
): ToolExecutionResult {
  const visualObservation: BrowserComputerVisualObservation = args.analyzed
    ? { observed: true, source: 'analysis' }
    : {
        observed: false,
        source: 'none',
        cannotObserveScreen: true,
        reason: args.analysisRequested ? 'screenshot_analysis_failed' : 'screenshot_path_only',
      };
  const proof = buildBrowserComputerProof({
    evidence: [{
      kind: 'screenshot',
      ref: args.outputPath,
      source: 'screenshot',
      state: args.analyzed ? 'read' : 'fresh',
    }],
    visualObservation,
  });
  const resultWithProof: ToolExecutionResult = {
    ...result,
    metadata: {
      ...(result.metadata || {}),
      evidenceRefs: proof.evidenceRefs,
      browserComputerProof: proof,
      browserComputerEvidenceCard: renderBrowserComputerEvidenceCard(proof),
      ...(visualObservation.cannotObserveScreen ? { cannotObserveScreen: true } : {}),
    },
  };
  persistBrowserComputerProofFromResult(resultWithProof, {
    sessionId: context.sessionId,
    toolCallId: context.currentToolCallId,
    toolName: 'screenshot',
  });
  return resultWithProof;
}

export const screenshotTool: Tool = {
  name: 'screenshot',
  description: `Capture a screenshot of the screen or a specific window, with optional AI analysis.

IMPORTANT — visibility caveat: by default the assistant only gets back a file path. The image bytes are NOT injected into the conversation. To actually see what's on screen you must either:
  (a) call this tool with analyze=true (and optionally a prompt), or
  (b) chain the image_analyze tool on the returned path afterward.
Without one of those two, do NOT claim you observed UI state, success, or content — you only have a saved PNG you cannot read.

Use this tool to:
- Capture the full screen for visual context
- Capture a specific application window
- Save screenshots for documentation or debugging
- Analyze screen content with AI (OCR, UI understanding)

Parameters:
- target (optional): 'screen' (default) or 'window'
- windowName (optional): Name of window to capture (if target is 'window')
- outputPath (optional): Where to save the screenshot
- analyze (optional): Enable AI analysis (default: false). REQUIRED if you intend to verify what is on screen.
- prompt (optional): Custom analysis prompt (default: describe content)

Returns the path to the saved screenshot file, plus AI analysis if analyze=true.`,
  requiresPermission: true,
  permissionLevel: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        enum: ['screen', 'window'],
        description: 'What to capture: full screen or specific window',
      },
      windowName: {
        type: 'string',
        description: 'Name of the window to capture (for window target)',
      },
      outputPath: {
        type: 'string',
        description: 'Path to save the screenshot (default: temp directory)',
      },
      region: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
        },
        description: 'Specific region to capture (x, y, width, height)',
      },
      analyze: {
        type: 'boolean',
        description: 'Enable AI analysis of screenshot content (default: false)',
      },
      prompt: {
        type: 'string',
        description: 'Custom prompt for AI analysis (default: describe and analyze the screenshot)',
      },
    },
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const target = (params.target as string) || 'screen';
    const windowName = params.windowName as string | undefined;
    const region = params.region as { x: number; y: number; width: number; height: number } | undefined;
    const analyze = params.analyze as boolean | undefined;
    const analysisPrompt = (params.prompt as string) || '请描述并分析这个截图的内容，包括界面元素、文字、按钮等。如果包含代码或文档，请提取关键信息。';

    // Generate output path
    const timestamp = Date.now();
    const defaultPath = path.join(
      context.workingDirectory,
      '.screenshots',
      `screenshot_${timestamp}.png`
    );
    const outputPath = (params.outputPath as string) || defaultPath;

    // Ensure output directory exists
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    try {
      // macOS screenshot command
      if (process.platform === 'darwin') {
        let command: string;

        if (target === 'window' && windowName) {
          command = `screencapture -l$(osascript -e 'tell app "${windowName}" to id of window 1') "${outputPath}"`;
        } else if (region) {
          // Capture specific region
          command = `screencapture -R${region.x},${region.y},${region.width},${region.height} "${outputPath}"`;
        } else {
          // Capture full screen
          command = `screencapture -x "${outputPath}"`;
        }

        await execAsync(command);
      }
      // Linux screenshot command
      else if (process.platform === 'linux') {
        let command: string;

        if (region) {
          command = `import -window root -crop ${region.width}x${region.height}+${region.x}+${region.y} "${outputPath}"`;
        } else {
          command = `import -window root "${outputPath}"`;
        }

        await execAsync(command);
      }
      // Windows screenshot (PowerShell)
      else if (process.platform === 'win32') {
        const psCommand = `
          Add-Type -AssemblyName System.Windows.Forms
          [System.Windows.Forms.Screen]::PrimaryScreen | ForEach-Object {
            $bitmap = New-Object System.Drawing.Bitmap($_.Bounds.Width, $_.Bounds.Height)
            $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
            $graphics.CopyFromScreen($_.Bounds.Location, [System.Drawing.Point]::Empty, $_.Bounds.Size)
            $bitmap.Save("${outputPath.replace(/\\/g, '\\\\')}")
          }
        `;
        await execAsync(`powershell -Command "${psCommand}"`);
      } else {
        return {
          success: false,
          error: `Unsupported platform: ${process.platform}`,
        };
      }

      // Verify the file was created
      if (!fs.existsSync(outputPath)) {
        return {
          success: false,
          error: 'Screenshot was not created',
        };
      }

      const stats = fs.statSync(outputPath);
      const timestampIso = new Date(timestamp).toISOString();

      let output = `Screenshot captured successfully:
- Path: ${outputPath}
- Size: ${(stats.size / 1024).toFixed(2)} KB
- Target: ${target}${windowName ? ` (${windowName})` : ''}
- Timestamp: ${timestampIso}`;

      // 如果启用分析，进行视觉分析
      let analysis: string | null = null;
      // 分析图像的尺寸记账（供下游坐标变换把图像坐标换算回逻辑屏幕点）
      let visionDims: {
        originalWidth: number | null;
        originalHeight: number | null;
        analyzedWidth: number | null;
        analyzedHeight: number | null;
      } | null = null;
      if (analyze) {
        context.emit?.('tool_output', {
          tool: 'screenshot',
          message: '🔍 正在分析截图内容...',
        });

        // 实测主显示器 backingScaleFactor，让降采样按真实 DPI 换算（缺省回退 FALLBACK_SCALE_FACTOR）
        const displayInfo = await getComputerSurface().getDisplayInfo().catch(() => null);

        const analysisResult = await analyzeImageWithVisionDetailed({
          imagePath: outputPath,
          prompt: analysisPrompt,
          source: 'screenshot',
          scaleFactorHint: displayInfo?.backingScaleFactor,
        });

        if (!analysisResult.ok) {
          return withScreenshotProof({
            success: false,
            error: buildAnalysisFailureMessage({
              outputPath,
              sizeBytes: stats.size,
              target,
              windowName,
              timestampIso,
              reason: analysisResult.error,
            }),
            outputPath,
            metadata: {
              path: outputPath,
              size: stats.size,
              target,
              windowName,
              analyzed: false,
              analysisRequested: true,
              analysis: null,
              visionAnalysis: analysisResult,
              cannotObserveScreen: true,
              originalWidth: analysisResult.originalWidth,
              originalHeight: analysisResult.originalHeight,
              analyzedWidth: analysisResult.analyzedWidth,
              analyzedHeight: analysisResult.analyzedHeight,
            },
          }, context, {
            outputPath,
            analyzed: false,
            analysisRequested: true,
            cannotObserveScreen: true,
          });
        }

        analysis = analysisResult.analysis;
        visionDims = {
          originalWidth: analysisResult.originalWidth,
          originalHeight: analysisResult.originalHeight,
          analyzedWidth: analysisResult.analyzedWidth,
          analyzedHeight: analysisResult.analyzedHeight,
        };
        // 记账给 computerSurface：后续 coordSpace='image' 的 click 没带 imageWidth/Height 时兜底
        getComputerSurface().setLastAnalyzedImageDims(
          analysisResult.analyzedWidth && analysisResult.analyzedHeight
            ? { width: analysisResult.analyzedWidth, height: analysisResult.analyzedHeight }
            : null,
        );
        if (analysis) {
          output += `\n\n📝 AI 分析结果:\n${analysis}`;
        }
        if (visionDims.analyzedWidth && visionDims.analyzedHeight) {
          output += `\n\n- Analyzed at: ${visionDims.analyzedWidth}x${visionDims.analyzedHeight}`
            + ` (source ${visionDims.originalWidth ?? '?'}x${visionDims.originalHeight ?? '?'})`;
        }
      }

      return withScreenshotProof({
        success: true,
        output,
        outputPath,
        metadata: {
          path: outputPath,
          size: stats.size,
          target,
          windowName,
          analyzed: !!analysis,
          analysisRequested: !!analyze,
          analysis,
          originalWidth: visionDims?.originalWidth ?? null,
          originalHeight: visionDims?.originalHeight ?? null,
          analyzedWidth: visionDims?.analyzedWidth ?? null,
          analyzedHeight: visionDims?.analyzedHeight ?? null,
        },
      }, context, {
        outputPath,
        analyzed: !!analysis,
        analysisRequested: !!analyze,
        cannotObserveScreen: !analysis,
      });
    } catch (error) {
      return {
        success: false,
        error: `Failed to capture screenshot: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  },
};
