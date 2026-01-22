// ============================================================================
// PPT Generate Tool - 生成演示文稿
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

// PPT 引擎类型
type PPTEngine = 'slidev' | 'presenton';

// Slidev 主题
type SlidevTheme = 'default' | 'seriph' | 'apple-basic' | 'dracula' | 'bricks';

interface PPTGenerateParams {
  topic: string;
  content?: string;
  slides_count?: number;
  engine?: PPTEngine;
  theme?: SlidevTheme;
  output_dir?: string;
  need_images?: boolean;
}

export const pptGenerateTool: Tool = {
  name: 'ppt_generate',
  description: `生成演示文稿（PPT）。支持两种引擎：
- **slidev**: 本地生成，基于 Markdown，适合技术演示、代码展示（免费，快速）
- **presenton**: 云端生成，支持 AI 配图，适合商务演示（需要云端服务）

使用场景：
- 技术分享、代码演示 → 选择 slidev
- 商务汇报、需要配图 → 选择 presenton

示例：
\`\`\`
ppt_generate { "topic": "React 18 新特性", "slides_count": 5, "engine": "slidev" }
ppt_generate { "topic": "公司年度总结", "slides_count": 10, "engine": "presenton", "need_images": true }
\`\`\``,
  generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: true,
  permissionLevel: 'file_write',
  inputSchema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: '演示文稿的主题',
      },
      content: {
        type: 'string',
        description: '详细内容大纲（可选，LLM 会自动扩展）',
      },
      slides_count: {
        type: 'number',
        description: '幻灯片数量（默认: 5）',
        default: 5,
      },
      engine: {
        type: 'string',
        enum: ['slidev', 'presenton'],
        description: '生成引擎: slidev（本地，技术演示）或 presenton（云端，商务配图）',
        default: 'slidev',
      },
      theme: {
        type: 'string',
        enum: ['default', 'seriph', 'apple-basic', 'dracula', 'bricks'],
        description: 'Slidev 主题（仅 slidev 引擎有效）',
        default: 'default',
      },
      output_dir: {
        type: 'string',
        description: '输出目录（默认: 当前工作目录）',
      },
      need_images: {
        type: 'boolean',
        description: '是否需要 AI 配图（仅 presenton 引擎有效）',
        default: false,
      },
    },
    required: ['topic'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const {
      topic,
      content,
      slides_count = 5,
      engine = 'slidev',
      theme = 'default',
      output_dir,
      need_images = false,
    } = params as PPTGenerateParams;

    // 确定输出目录
    const outputDir = output_dir || context.workingDirectory;

    try {
      if (engine === 'slidev') {
        return await generateSlidev({
          topic,
          content,
          slides_count,
          theme: theme as SlidevTheme,
          outputDir,
        });
      } else if (engine === 'presenton') {
        return await generatePresenton({
          topic,
          content,
          slides_count,
          needImages: need_images,
          outputDir,
        });
      } else {
        return {
          success: false,
          error: `不支持的引擎: ${engine}，请选择 slidev 或 presenton`,
        };
      }
    } catch (error: any) {
      return {
        success: false,
        error: `PPT 生成失败: ${error.message}`,
      };
    }
  },
};

// ============================================================================
// Slidev 本地生成
// ============================================================================

interface SlidevOptions {
  topic: string;
  content?: string;
  slides_count: number;
  theme: SlidevTheme;
  outputDir: string;
}

async function generateSlidev(options: SlidevOptions): Promise<ToolExecutionResult> {
  const { topic, content, slides_count, theme, outputDir } = options;

  // 创建 Slidev 项目目录
  const projectName = `slides-${Date.now()}`;
  const projectDir = path.join(outputDir, projectName);

  try {
    // 确保目录存在
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }

    // 生成 Markdown 内容
    const slidesContent = generateSlidevMarkdown({
      topic,
      content,
      slides_count,
      theme,
    });

    // 写入 slides.md
    const slidesPath = path.join(projectDir, 'slides.md');
    fs.writeFileSync(slidesPath, slidesContent, 'utf-8');

    // 创建 package.json
    const packageJson = {
      name: projectName,
      private: true,
      scripts: {
        dev: 'slidev',
        build: 'slidev build',
        export: 'slidev export',
      },
      dependencies: {
        '@slidev/cli': '^0.50.0',
        '@slidev/theme-default': '^0.25.0',
      },
    };

    // 如果不是默认主题，添加主题依赖
    if (theme !== 'default') {
      (packageJson.dependencies as Record<string, string>)[`@slidev/theme-${theme}`] = 'latest';
    }

    fs.writeFileSync(
      path.join(projectDir, 'package.json'),
      JSON.stringify(packageJson, null, 2),
      'utf-8'
    );

    return {
      success: true,
      output: `✅ Slidev 演示文稿已创建！

📁 项目目录: ${projectDir}
📄 幻灯片文件: ${slidesPath}
🎨 主题: ${theme}
📊 幻灯片数量: ${slides_count}

下一步：
1. cd ${projectDir}
2. npm install
3. npm run dev

然后在浏览器中打开 http://localhost:3030 预览`,
      metadata: {
        projectDir,
        slidesPath,
        engine: 'slidev',
        theme,
        slides_count,
      },
    };
  } catch (error: any) {
    // 清理失败的目录
    if (fs.existsSync(projectDir)) {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
    throw error;
  }
}

// 生成 Slidev Markdown 内容
function generateSlidevMarkdown(options: {
  topic: string;
  content?: string;
  slides_count: number;
  theme: SlidevTheme;
}): string {
  const { topic, content, slides_count, theme } = options;

  // Frontmatter
  let markdown = `---
theme: ${theme}
title: ${topic}
class: text-center
highlighter: shiki
transition: slide-left
mdc: true
---

# ${topic}

<div class="pt-12">
  <span class="px-2 py-1 rounded cursor-pointer">
    按空格键继续 →
  </span>
</div>

---
`;

  // 如果有内容大纲，解析并生成幻灯片
  if (content) {
    const sections = parseContentOutline(content);
    for (const section of sections.slice(0, slides_count - 2)) {
      markdown += `
# ${section.title}

${section.points.map((p) => `- ${p}`).join('\n')}

---
`;
    }
  } else {
    // 生成占位幻灯片
    for (let i = 1; i <= slides_count - 2; i++) {
      markdown += `
# 第 ${i} 部分

<v-clicks>

- 要点 1
- 要点 2
- 要点 3

</v-clicks>

---
`;
    }
  }

  // 结束幻灯片
  markdown += `
layout: center
class: text-center
---

# 谢谢观看

[查看源码](https://github.com) · [在线演示](https://slidev.dev)
`;

  return markdown;
}

// 解析内容大纲
function parseContentOutline(content: string): Array<{ title: string; points: string[] }> {
  const sections: Array<{ title: string; points: string[] }> = [];
  const lines = content.split('\n').filter((l) => l.trim());

  let currentSection: { title: string; points: string[] } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    // 标题行（以 # 开头或不以 - 开头的独立行）
    if (trimmed.startsWith('#')) {
      if (currentSection) {
        sections.push(currentSection);
      }
      currentSection = {
        title: trimmed.replace(/^#+\s*/, ''),
        points: [],
      };
    } else if (trimmed.startsWith('-') || trimmed.startsWith('*')) {
      // 要点
      if (currentSection) {
        currentSection.points.push(trimmed.replace(/^[-*]\s*/, ''));
      }
    } else if (!currentSection && trimmed) {
      // 第一个非空行作为标题
      currentSection = { title: trimmed, points: [] };
    }
  }

  if (currentSection) {
    sections.push(currentSection);
  }

  return sections;
}

// ============================================================================
// Presenton 云端生成
// ============================================================================

interface PresentonOptions {
  topic: string;
  content?: string;
  slides_count: number;
  needImages: boolean;
  outputDir: string;
}

async function generatePresenton(options: PresentonOptions): Promise<ToolExecutionResult> {
  const { topic, content, slides_count, needImages, outputDir } = options;

  // 调用云端 API
  const apiUrl = process.env.CLOUD_API_URL || 'https://code-agent-beta.vercel.app';
  const endpoint = `${apiUrl}/api/tools`;

  try {
    const response = await fetch(`${endpoint}?action=ppt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        topic,
        content,
        slides_count,
        need_images: needImages,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        error: `云端 API 错误: ${response.status} - ${errorText}`,
      };
    }

    const result = await response.json() as {
      success: boolean;
      error?: string;
      data?: {
        structure: {
          title: string;
          theme: string;
          slides: Array<{ title: string; content: string[]; image_prompt?: string }>;
        };
        markdown: string;
        image_prompts: Array<{ slide: string; prompt: string }>;
      };
    };

    if (!result.success || !result.data) {
      return {
        success: false,
        error: result.error || '云端生成失败',
      };
    }

    // 保存生成的 Markdown 文件
    const projectName = `slides-${Date.now()}`;
    const projectDir = path.join(outputDir, projectName);

    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }

    const slidesPath = path.join(projectDir, 'slides.md');
    fs.writeFileSync(slidesPath, result.data.markdown, 'utf-8');

    // 创建 package.json
    const packageJson = {
      name: projectName,
      private: true,
      scripts: {
        dev: 'slidev',
        build: 'slidev build',
        export: 'slidev export',
      },
      dependencies: {
        '@slidev/cli': '^0.50.0',
        '@slidev/theme-default': '^0.25.0',
      },
    };

    const theme = result.data.structure.theme;
    if (theme && theme !== 'default') {
      (packageJson.dependencies as Record<string, string>)[`@slidev/theme-${theme}`] = 'latest';
    }

    fs.writeFileSync(
      path.join(projectDir, 'package.json'),
      JSON.stringify(packageJson, null, 2),
      'utf-8'
    );

    // 构建输出信息
    let output = `✅ PPT 内容已生成（云端 LLM）！

📁 项目目录: ${projectDir}
📄 幻灯片文件: ${slidesPath}
🎨 主题: ${result.data.structure.theme}
📊 幻灯片数量: ${result.data.structure.slides.length}`;

    // 如果需要配图，显示生成的 prompts
    if (needImages && result.data.image_prompts.length > 0) {
      output += `\n\n🖼️ AI 配图 Prompts（可用于 image_generate 工具）：`;
      for (const img of result.data.image_prompts) {
        output += `\n  - [${img.slide}] ${img.prompt}`;
      }
    }

    output += `\n\n下一步：
1. cd ${projectDir}
2. npm install
3. npm run dev

然后在浏览器中打开 http://localhost:3030 预览`;

    return {
      success: true,
      output,
      metadata: {
        projectDir,
        slidesPath,
        engine: 'presenton',
        theme: result.data.structure.theme,
        slides_count: result.data.structure.slides.length,
        needImages,
        imagePrompts: result.data.image_prompts,
      },
    };
  } catch (error: any) {
    return {
      success: false,
      error: `Presenton 云端调用失败: ${error.message}`,
    };
  }
}
