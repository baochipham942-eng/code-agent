// ============================================================================
// Screenshot Tool - Capture screen/window screenshots
// Gen 6: Computer Use capability
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../ToolRegistry';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';

const execAsync = promisify(exec);

export const screenshotTool: Tool = {
  name: 'screenshot',
  description: `Capture a screenshot of the screen or a specific window.

Use this tool to:
- Capture the full screen for visual context
- Capture a specific application window
- Save screenshots for documentation or debugging

Parameters:
- target (optional): 'screen' (default) or 'window'
- windowName (optional): Name of window to capture (if target is 'window')
- outputPath (optional): Where to save the screenshot

Returns the path to the saved screenshot file.`,
  generations: ['gen6', 'gen7', 'gen8'],
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
    },
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const target = (params.target as string) || 'screen';
    const windowName = params.windowName as string | undefined;
    const region = params.region as { x: number; y: number; width: number; height: number } | undefined;

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

      return {
        success: true,
        output: `Screenshot captured successfully:
- Path: ${outputPath}
- Size: ${(stats.size / 1024).toFixed(2)} KB
- Target: ${target}${windowName ? ` (${windowName})` : ''}
- Timestamp: ${new Date(timestamp).toISOString()}`,
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to capture screenshot: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  },
};
