#!/usr/bin/env npx tsx
// ============================================================================
// PPT 全布局预览脚本
// ============================================================================
// 一键生成所有布局类型的 PPTX → 截图 → 打开查看，闭环验证视觉效果。
//
// 用法：
//   npx tsx src/main/tools/network/ppt/__tests__/preview-all-layouts.ts
//   npx tsx src/main/tools/network/ppt/__tests__/preview-all-layouts.ts --theme neon-green
//   npx tsx src/main/tools/network/ppt/__tests__/preview-all-layouts.ts --vlm
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { createRequire } from 'module';
import type { StructuredSlide } from '../slideSchemas';
import type { PPTTheme } from '../types';

const require = createRequire(import.meta.url);

// ============================================================================
// 示例数据 — 覆盖全部 12 种布局
// ============================================================================

const SAMPLE_SLIDES: StructuredSlide[] = [
  // 1. title
  {
    layout: 'list', title: 'AI Agent 技术全景报告', subtitle: '2026 年度深度分析',
    isTitle: true, content: { points: [] },
  },
  // 2. stats (3 items)
  {
    layout: 'stats', title: '市场规模与增长',
    content: {
      stats: [
        { label: '全球市场', value: '1500亿', description: '年增长率 35%' },
        { label: '中国市场', value: '320亿', description: '占比 21%' },
        { label: '企业用户', value: '50万+', description: '同比翻倍增长' },
      ],
    },
  },
  // 3. stats (2 items) — 测试少量 stat 自适应
  {
    layout: 'stats', title: '核心指标',
    content: {
      stats: [
        { label: '月活用户', value: '1.2亿', description: '环比增长 18%' },
        { label: '日均调用', value: '85亿次', description: 'API 请求峰值' },
      ],
    },
  },
  // 4. cards-2
  {
    layout: 'cards-2', title: '技术架构概览',
    content: {
      mainCard: { title: '混合架构', description: '基于 4 核心角色 + 动态扩展 + Agent Swarm 的三层混合架构，覆盖 100% 场景。核心角色处理 80% 简单任务，动态扩展处理 15% 中等任务，Swarm 处理 5% 复杂任务。' },
      cards: [
        { title: '核心角色', description: 'Coder、Reviewer、Explorer、Planner 四个固定角色' },
        { title: '动态扩展', description: '按需生成专用 Agent（如 DB-Designer）' },
        { title: 'Agent Swarm', description: '最多 50 个并行 Agent + 协调器聚合' },
      ],
    },
  },
  // 5. cards-3
  {
    layout: 'cards-3', title: '三大核心优势',
    content: {
      cards: [
        { title: '高性能', description: '毫秒级响应，支持每秒万级并发请求处理' },
        { title: '高可靠', description: '99.99% 可用性，多机房容灾自动切换' },
        { title: '低成本', description: '智能路由免费模型，成本降低 60%' },
      ],
    },
  },
  // 6. timeline (3 steps)
  {
    layout: 'timeline', title: '实施路线图',
    content: {
      steps: [
        { title: '需求分析', description: '调研用户需求，明确产品定位和技术选型' },
        { title: '原型开发', description: '搭建最小可用产品，快速验证核心交互体验' },
        { title: '全面上线', description: '性能优化、安全加固，正式发布并持续迭代' },
      ],
    },
  },
  // 7. timeline (4 steps) — 测试内容较多的 timeline
  {
    layout: 'timeline', title: '产品演进路径',
    content: {
      steps: [
        { title: 'v1.0 基础版', description: '文件操作和代码搜索基本能力' },
        { title: 'v2.0 网络版', description: '新增网络搜索、MCP 连接、PPT 生成技能' },
        { title: 'v3.0 多Agent', description: '引入子代理系统实现并行任务执行' },
        { title: 'v4.0 自进化', description: '策略优化和工具自创建的自我进化能力' },
      ],
    },
  },
  // 8. comparison
  {
    layout: 'comparison', title: '方案对比分析',
    content: {
      left: { title: '方案 A：云原生', points: ['弹性扩缩容', '按需付费', '全球部署'] },
      right: { title: '方案 B：私有化', points: ['数据安全可控', '定制化强', '一次性投入'] },
    },
  },
  // 9. two-column
  {
    layout: 'two-column', title: '功能清单',
    content: {
      leftPoints: ['智能代码补全', '多语言支持', '实时协作编辑'],
      rightPoints: ['自动化测试', '安全漏洞扫描', 'CI/CD 集成'],
    } as any,
  },
  // 10. list
  {
    layout: 'list', title: '最佳实践建议',
    content: {
      points: [
        '从小规模试点开始，逐步扩展 AI Agent 应用范围',
        '建立完善的评测体系，持续监控模型输出质量',
        '注重数据安全和隐私保护，符合合规要求',
        '培养团队 AI 工程能力，推动文化变革',
      ],
    },
  },
  // 11. quote
  {
    layout: 'quote', title: '',
    content: {
      quote: 'AI 不会取代人类，但会使用 AI 的人将取代不会使用的人。',
      attribution: '—— Karim Lakhani, Harvard Business School',
    },
  },
  // 12. end
  {
    layout: 'list', title: '谢谢观看',
    isEnd: true, content: { points: [] },
  },
];

// ============================================================================
// PPTX 生成
// ============================================================================

async function generatePptx(slides: StructuredSlide[], themeName: string, outputPath: string): Promise<void> {
  // Dynamic imports for project modules
  const { getThemeConfig } = await import('../themes');
  const { registerSlideMasters } = await import('../slideMasters');
  const { fillStructuredSlide, selectMasterForStructuredSlide, resetLayoutRotation } = await import('../layouts');

   
  const PptxGenJS = require('pptxgenjs');
  const pptx = new PptxGenJS();
  const themeConfig = getThemeConfig(themeName);

  pptx.author = 'Preview Script';
  pptx.title = `Layout Preview - ${themeName}`;

  registerSlideMasters(pptx, themeConfig);
  resetLayoutRotation();

  for (let i = 0; i < slides.length; i++) {
    const slideData = slides[i];
    const master = selectMasterForStructuredSlide(slideData);
    const slide = pptx.addSlide({ masterName: master });
    fillStructuredSlide(pptx, slide, slideData, themeConfig, i, null, []);
  }

  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  await pptx.writeFile({ fileName: outputPath });
}

// ============================================================================
// 截图（复用 visualReview.ts 逻辑）
// ============================================================================

async function takeScreenshots(pptxPath: string, outputDir: string): Promise<string[]> {
  const { isLibreOfficeAvailable, convertToScreenshots } = await import('../visualReview');

  if (!isLibreOfficeAvailable()) {
    console.log('  ⚠ LibreOffice 未安装，跳过截图。直接打开 PPTX 文件查看。');
    return [];
  }

  return convertToScreenshots(pptxPath, outputDir);
}

// ============================================================================
// VLM 审查（可选）
// ============================================================================

interface VlmResult {
  slideIndex: number;
  layout: string;
  score: number;
  issues: string[];
}

async function vlmReview(screenshots: string[], slides: StructuredSlide[]): Promise<VlmResult[]> {
  // 读取 .env 中的 API key
  const dotenvPath = path.resolve(process.cwd(), '.env');
  let apiKey = process.env.KIMI_K25_API_KEY || '';
  if (!apiKey && fs.existsSync(dotenvPath)) {
    const envContent = fs.readFileSync(dotenvPath, 'utf8');
    const match = envContent.match(/KIMI_K25_API_KEY=(.+)/);
    if (match) apiKey = match[1].trim();
  }

  if (!apiKey) {
    console.log('  ⚠ 未找到 KIMI_K25_API_KEY，跳过 VLM 审查。');
    return [];
  }

  const https = await import('https');
  const results: VlmResult[] = [];

  for (let i = 0; i < screenshots.length; i++) {
    const imgPath = screenshots[i];
    if (!fs.existsSync(imgPath)) continue;

    const imgBase64 = fs.readFileSync(imgPath).toString('base64');
    const slideLayout = i < slides.length ? slides[i].layout : 'unknown';

    const prompt = `审查这张PPT幻灯片截图。评分1-5分，列出问题。
返回 JSON: {"score": 4, "issues": ["描述1"]}
只返回 JSON。`;

    try {
      const body = JSON.stringify({
        model: 'kimi-k2.5',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${imgBase64}` } },
            ],
          },
        ],
        max_tokens: 500,
      });

      const response = await new Promise<string>((resolve, reject) => {
        const url = new URL('https://cn.haioi.net/v1/chat/completions');
        const req = https.request({
          hostname: url.hostname,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
        }, (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      });

      const parsed = JSON.parse(response);
      const text = parsed.choices?.[0]?.message?.content || '{}';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const review = JSON.parse(jsonMatch[0]);
        results.push({
          slideIndex: i,
          layout: slideLayout,
          score: typeof review.score === 'number' ? Math.min(5, Math.max(1, review.score)) : 3,
          issues: Array.isArray(review.issues) ? review.issues.map(String) : [],
        });
        process.stdout.write(`  [${i + 1}/${screenshots.length}] ${slideLayout}: ${review.score}/5\n`);
      }
    } catch (err: any) {
      console.log(`  [${i + 1}] VLM 调用失败: ${err.message}`);
      results.push({ slideIndex: i, layout: slideLayout, score: 3, issues: ['VLM 调用失败'] });
    }
  }

  return results;
}

// ============================================================================
// 主流程
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const themeArg = args.find((_, i) => args[i - 1] === '--theme') || '';
  const enableVlm = args.includes('--vlm');

  const themes: PPTTheme[] = themeArg
    ? [themeArg as PPTTheme]
    : ['neon-green', 'apple-dark'];

  const outputBase = '/tmp/ppt-preview';
  if (fs.existsSync(outputBase)) {
    fs.rmSync(outputBase, { recursive: true, force: true });
  }
  fs.mkdirSync(outputBase, { recursive: true });

  console.log(`\n🎨 PPT 全布局预览`);
  console.log(`  主题: ${themes.join(', ')}`);
  console.log(`  布局: ${SAMPLE_SLIDES.length} 种`);
  console.log(`  VLM:  ${enableVlm ? '开启' : '关闭'}`);
  console.log('');

  const summaryRows: Array<{ index: number; layout: string; theme: string; screenshot: string; score?: number; issues?: string }> = [];

  for (const themeName of themes) {
    const pptxPath = path.join(outputBase, `${themeName}.pptx`);
    const screenshotDir = path.join(outputBase, `${themeName}_screenshots`);

    // 生成 PPTX
    console.log(`📄 生成 ${themeName}.pptx ...`);
    await generatePptx(SAMPLE_SLIDES, themeName, pptxPath);
    const stats = fs.statSync(pptxPath);
    console.log(`  ✓ ${(stats.size / 1024).toFixed(0)} KB, ${SAMPLE_SLIDES.length} 页\n`);

    // 截图
    console.log(`📸 截图 ${themeName} ...`);
    const screenshots = await takeScreenshots(pptxPath, screenshotDir);

    if (screenshots.length > 0) {
      console.log(`  ✓ ${screenshots.length} 张截图\n`);
    }

    // VLM 审查
    let vlmResults: VlmResult[] = [];
    if (enableVlm && screenshots.length > 0) {
      console.log(`🔍 VLM 审查 ${themeName} ...`);
      vlmResults = await vlmReview(screenshots, SAMPLE_SLIDES);
      console.log('');
    }

    // 汇总
    SAMPLE_SLIDES.forEach((slide, i) => {
      const layoutLabel = slide.isTitle ? 'title' : slide.isEnd ? 'end' : slide.layout;
      const screenshot = i < screenshots.length ? screenshots[i] : '-';
      const vlm = vlmResults.find(r => r.slideIndex === i);
      summaryRows.push({
        index: i + 1,
        layout: layoutLabel,
        theme: themeName,
        screenshot: screenshot !== '-' ? path.basename(screenshot) : '-',
        score: vlm?.score,
        issues: vlm?.issues?.join('; '),
      });
    });
  }

  // 输出汇总表
  console.log('\n' + '='.repeat(80));
  console.log('📊 汇总');
  console.log('='.repeat(80));

  if (enableVlm) {
    console.log(`| #  | Layout      | Theme      | Score | Issues`);
    console.log(`|----|-------------|------------|-------|-------`);
    for (const row of summaryRows) {
      const score = row.score !== undefined ? `${row.score}/5` : '-';
      const issues = row.issues || 'none';
      console.log(`| ${String(row.index).padStart(2)} | ${row.layout.padEnd(11)} | ${row.theme.padEnd(10)} | ${score.padEnd(5)} | ${issues}`);
    }
    const scores = summaryRows.filter(r => r.score !== undefined).map(r => r.score!);
    if (scores.length > 0) {
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      const highIssues = summaryRows.filter(r => r.issues && r.issues !== 'none').length;
      console.log(`\n  平均分: ${avg.toFixed(1)}/5.0, ${highIssues} 个页面有问题`);
      if (avg < 3.5) {
        console.log('  ⚠️ 平均分低于 3.5，需要关注视觉质量！');
      }
    }
  } else {
    console.log(`| #  | Layout      | Theme      | Screenshot`);
    console.log(`|----|-------------|------------|----------`);
    for (const row of summaryRows) {
      console.log(`| ${String(row.index).padStart(2)} | ${row.layout.padEnd(11)} | ${row.theme.padEnd(10)} | ${row.screenshot}`);
    }
  }

  // 打开输出目录
  console.log(`\n📁 输出目录: ${outputBase}`);
  try {
    execSync(`open "${outputBase}"`, { stdio: 'ignore' });
  } catch { /* ignore on non-macOS */ }
}

main().catch(err => {
  console.error('❌ 预览脚本执行失败:', err.message);
  process.exit(1);
});
