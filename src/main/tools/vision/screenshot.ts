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
import { analyzeImageWithVision } from '../../services/desktop/visionAnalysisService';

const execAsync = promisify(exec);

export const screenshotTool: Tool = {
  name: 'screenshot',
  description: `Capture a screenshot of the screen or a specific window, with optional AI analysis.

Use this tool to:
- Capture the full screen for visual context
- Capture a specific application window
- Save screenshots for documentation or debugging
- Analyze screen content with AI (OCR, UI understanding)

Parameters:
- target (optional): 'screen' (default) or 'window'
- windowName (optional): Name of window to capture (if target is 'window')
- outputPath (optional): Where to save the screenshot
- analyze (optional): Enable AI analysis (default: false)
- prompt (optional): Custom analysis prompt (default: describe content)

Returns the path to the saved screenshot file and optional AI analysis.`,
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
          // Capture specific window by name
          // First, get window ID using AppleScript
          const getWindowIdScript = `
            tell application "System Events"
              set frontApp to first application process whose frontmost is true
              set windowId to id of first window of frontApp
              return windowId
            end tell
          `;
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

      let output = `Screenshot captured successfully:
- Path: ${outputPath}
- Size: ${(stats.size / 1024).toFixed(2)} KB
- Target: ${target}${windowName ? ` (${windowName})` : ''}
- Timestamp: ${new Date(timestamp).toISOString()}`;

      // 如果启用分析，进行视觉分析
      let analysis: string | null = null;
      if (analyze) {
        context.emit?.('tool_output', {
          tool: 'screenshot',
          message: '🔍 正在分析截图内容...',
        });

        analysis = await analyzeImageWithVision({
          imagePath: outputPath,
          prompt: analysisPrompt,
          source: 'screenshot',
        });
        if (analysis) {
          output += `\n\n📝 AI 分析结果:\n${analysis}`;
        }
      }

      return {
        success: true,
        output,
        metadata: {
          path: outputPath,
          size: stats.size,
          target,
          windowName,
          analyzed: !!analysis,
          analysis,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to capture screenshot: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  },
};
