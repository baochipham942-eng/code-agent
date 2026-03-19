import { TestCase } from '../../src/types.js';
import { readdir, readFile, stat } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ===== Helper Functions (inline to avoid module resolution issues) =====

const SLIDE_PATTERN = /^(\d+)-slide-.*\.(png|jpg|jpeg)$/i;

interface SlideImage {
  filename: string;
  path: string;
  index: number;
}

async function findRecursive(
  dir: string,
  predicate: (name: string, isDir: boolean) => boolean
): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const fullPath = join(dir, entry.name);
    if (predicate(entry.name, entry.isDirectory())) return fullPath;
    if (entry.isDirectory()) {
      const found = await findRecursive(fullPath, predicate);
      if (found) return found;
    }
  }
  return null;
}

async function findSlideImages(workDir: string): Promise<SlideImage[]> {
  const results: SlideImage[] = [];
  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const fullPath = join(dir, entry.name);
      if (entry.isFile()) {
        const match = entry.name.match(SLIDE_PATTERN);
        if (match) {
          results.push({ filename: entry.name, path: fullPath, index: parseInt(match[1], 10) });
        }
      } else if (entry.isDirectory()) {
        await walk(fullPath);
      }
    }
  }
  await walk(workDir);
  return results.sort((a, b) => a.index - b.index);
}

async function isValidImage(filepath: string): Promise<boolean> {
  const buffer = await readFile(filepath);
  if (buffer.length < 8) return false;
  const isPng = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  return isPng || isJpeg;
}

// ===== Test Case =====

/**
 * SK-01: Skill 路由 — PPT 生成自动挂载 frontend-slides
 *
 * 测试目标：
 * 1. 用户说"帮我做 PPT"时，模型能识别出调用 frontend-slides skill
 * 2. 工作流完整走通：素材整理 → 大纲 → prompt → 图片生成 → 合成 PPTX/PDF
 * 3. 产出质量：outline 结构完整、图片是真实 PNG/JPG、PPTX 可打开
 */
export const SK01: TestCase = {
  id: 'SK-01',
  name: 'PPT 生成自动路由 frontend-slides skill',
  category: 'generation',
  complexity: 'L4',

  prompt: `帮我做一个关于 "AI Agent 架构演进" 的 5 页 PPT。

内容要点：
1. 封面：AI Agent 架构演进 — 从规则到自主
2. 第一代：基于规则的 Chatbot（关键词匹配、决策树）
3. 第二代：LLM + Tool Use（ReAct 循环、Function Calling）
4. 第三代：Multi-Agent 协作（角色分工、消息传递、共享记忆）
5. 未来展望：自主进化 Agent（自我改进、元认知）

风格偏好：blueprint
受众：技术团队（experts）
语言：中文
页数：5 页

所有信息已提供完毕，不需要再用 AskUserQuestion 确认，直接按 frontend-slides skill 的工作流开始生成。
从第 1 步（整理素材）开始，按顺序走完 6 步流程直到生成 PPTX。`,

  // 不使用 fixture，PPT 生成不需要预置项目
  fixture: undefined,

  // 使用 Kimi K2.5（GLM 0ki key 不支持图像生成）
  cliOptions: {
    provider: 'moonshot',
    model: 'kimi-k2.5',
  },

  // 将项目级 frontend-slides skill 和脚本复制到测试工作区
  // __dirname → tests/e2e/claude-e2e/test-cases/agent-benchmark/ (5 levels from project root)
  setupCommands: [
    'mkdir -p .claude/skills/frontend-slides/scripts .claude/skills/ppt',
    `cp "${__dirname}/../../../../../.claude/skills/frontend-slides/SKILL.md" .claude/skills/frontend-slides/SKILL.md`,
    `cp "${__dirname}/../../../../../.claude/skills/frontend-slides/scripts/merge-to-pptx.mjs" .claude/skills/frontend-slides/scripts/`,
    `cp "${__dirname}/../../../../../.claude/skills/frontend-slides/scripts/merge-to-pdf.mjs" .claude/skills/frontend-slides/scripts/`,
    `cp "${__dirname}/../../../../../.claude/skills/ppt/SKILL.md" .claude/skills/ppt/SKILL.md`,
  ],

  validations: [
    // 1. slide-deck 目录必须存在且包含主题子目录
    {
      type: 'custom',
      message: 'slide-deck 目录应存在',
      custom: async (ctx) => {
        const slideDeckDir = join(ctx.workDir, 'slide-deck');
        try {
          const entries = await readdir(slideDeckDir);
          const topicDirs = entries.filter(e => !e.startsWith('.'));
          return {
            passed: topicDirs.length > 0,
            validation: { type: 'custom', message: 'slide-deck/<topic> 目录存在' },
            message: topicDirs.length > 0
              ? `Found topic dir: ${topicDirs[0]}`
              : 'slide-deck/ exists but no topic subdirectory',
          };
        } catch {
          return {
            passed: false,
            validation: { type: 'custom', message: 'slide-deck 目录应存在' },
            message: 'slide-deck/ directory not found',
          };
        }
      },
    },

    // 2. outline.md 存在且包含关键结构
    {
      type: 'custom',
      message: 'outline.md 应存在且结构完整',
      custom: async (ctx) => {
        const outlinePath = await findRecursive(ctx.workDir, (name, isDir) => !isDir && name === 'outline.md');
        if (!outlinePath) {
          return {
            passed: false,
            validation: { type: 'custom', message: 'outline.md 应存在' },
            message: 'outline.md not found',
          };
        }
        const content = (await readFile(outlinePath, 'utf-8')).toLowerCase();
        const hasNumbers = /[1-5]|slide/i.test(content);
        const hasKeyContent = ['agent', 'tool', 'multi'].some(kw => content.includes(kw));
        const passed = hasNumbers && hasKeyContent;
        return {
          passed,
          validation: { type: 'custom', message: 'outline.md 结构完整' },
          message: passed ? undefined : `outline.md missing: ${!hasNumbers ? 'slide numbers' : 'key content'}`,
        };
      },
    },

    // 3. 至少 5 张 slide 图片（真实 PNG/JPG，magic bytes 校验）
    {
      type: 'custom',
      message: '至少 5 张真实 slide 图片',
      custom: async (ctx) => {
        const images = await findSlideImages(ctx.workDir);
        if (images.length < 5) {
          return {
            passed: false,
            validation: { type: 'custom', message: '至少 5 张 slide 图片' },
            message: `Only ${images.length} slide images found (expected >= 5)`,
          };
        }
        const invalidImages: string[] = [];
        for (const img of images) {
          if (!(await isValidImage(img.path))) invalidImages.push(img.filename);
        }
        if (invalidImages.length > 0) {
          return {
            passed: false,
            validation: { type: 'custom', message: 'slide 图片必须是真实 PNG/JPG' },
            message: `Invalid images (not real PNG/JPG): ${invalidImages.join(', ')}`,
          };
        }
        return {
          passed: true,
          validation: { type: 'custom', message: '至少 5 张真实 slide 图片' },
          message: `${images.length} valid slide images`,
        };
      },
    },

    // 4. PPTX 文件存在且大小合理（>10KB）
    {
      type: 'custom',
      message: 'PPTX 文件存在且大小合理',
      custom: async (ctx) => {
        const pptxPath = await findRecursive(ctx.workDir, (name, isDir) => !isDir && name.endsWith('.pptx'));
        if (!pptxPath) {
          return {
            passed: false,
            validation: { type: 'custom', message: 'PPTX 文件应存在' },
            message: 'No .pptx file found',
          };
        }
        const stats = await stat(pptxPath);
        const sizeKB = Math.round(stats.size / 1024);
        const passed = stats.size > 10240;
        return {
          passed,
          validation: { type: 'custom', message: 'PPTX 大小合理' },
          message: passed ? `PPTX: ${sizeKB}KB` : `PPTX too small: ${sizeKB}KB (expected > 10KB)`,
        };
      },
    },

    // 5. prompts/ 目录存在且至少 5 个 prompt 文件
    {
      type: 'custom',
      message: 'prompts/ 目录应包含逐页 prompt',
      custom: async (ctx) => {
        const promptsDir = await findRecursive(ctx.workDir, (name, isDir) => isDir && name === 'prompts');
        if (!promptsDir) {
          return {
            passed: false,
            validation: { type: 'custom', message: 'prompts/ 目录应存在' },
            message: 'prompts/ directory not found',
          };
        }
        const entries = await readdir(promptsDir);
        const mdFiles = entries.filter(e => e.endsWith('.md'));
        const passed = mdFiles.length >= 5;
        return {
          passed,
          validation: { type: 'custom', message: 'prompts/ 至少 5 个文件' },
          message: passed ? `${mdFiles.length} prompt files` : `Only ${mdFiles.length} prompt files (expected >= 5)`,
        };
      },
    },
  ],

  // 过程验证：确保使用了 Skill 工具和 image_generate
  processValidations: [
    {
      type: 'tool-used',
      tool: 'Skill',
      message: '应调用 Skill 工具激活 frontend-slides',
    },
    {
      type: 'tool-used',
      tool: 'image_generate',
      message: '应调用 image_generate 生成 slide 图片',
    },
    {
      type: 'tool-count-min',
      tool: 'image_generate',
      toolFilter: 'image_generate',
      count: 5,
      message: '至少调用 5 次 image_generate（对应 5 页 slide）',
    },
  ],

  expectedBehavior: {
    requiredTools: ['Skill', 'image_generate'],
    toolCallRange: { min: 10, max: 80 },
  },

  tags: ['skill', 'ppt', 'frontend-slides', 'image-generation', 'agent-benchmark'],
  timeout: 600000, // 10 分钟，图片生成较慢
  nudgeOnMissingFile: false,
};

export default SK01;
