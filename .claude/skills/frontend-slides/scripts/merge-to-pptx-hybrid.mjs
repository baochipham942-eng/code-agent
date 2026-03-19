// ============================================================================
// merge-to-pptx-hybrid.mjs
// 混合合成：AI 背景图 + pptxgenjs 真实文字渲染
// 解决纯图片方案中文字乱码问题
// ============================================================================

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import PptxGenJS from 'pptxgenjs';

// ============================================================================
// Args & Discovery
// ============================================================================

function parseArgs() {
  const args = process.argv.slice(2);
  let dir = '';
  let output;

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--output' || args[i] === '-o') {
      output = args[i + 1];
      i += 1;
    } else if (!args[i].startsWith('-')) {
      dir = args[i];
    }
  }

  if (!dir) {
    console.error('Usage: node merge-to-pptx-hybrid.mjs <slide-deck-dir> [--output filename.pptx]');
    process.exit(1);
  }

  return { dir, output };
}

function findSlideImages(dir) {
  const files = readdirSync(dir);
  const slidePattern = /^(\d+)-slide-.*\.(png|jpg|jpeg)$/i;

  return files
    .filter((file) => slidePattern.test(file))
    .map((file) => {
      const match = file.match(slidePattern);
      return {
        filename: file,
        path: join(dir, file),
        index: Number.parseInt(match[1], 10),
      };
    })
    .sort((a, b) => a.index - b.index);
}

function detectImageMimeType(buffer) {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 &&
      buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 &&
      buffer[2] === 0xff) return 'image/jpeg';
  return null;
}

// ============================================================================
// slides.json Loader
// ============================================================================

/**
 * 读取 slides.json — 包含每页的结构化文字内容
 * 格式:
 * [
 *   {
 *     "index": 1,
 *     "layout": "cover",
 *     "title": "标题",
 *     "subtitle": "副标题",
 *     "bullets": ["要点1", "要点2"],
 *     "footnote": "脚注"
 *   }
 * ]
 */
function loadSlidesData(dir) {
  const jsonPath = join(dir, 'slides.json');
  if (!existsSync(jsonPath)) {
    console.warn('Warning: slides.json not found, falling back to image-only mode');
    return null;
  }

  try {
    const raw = readFileSync(jsonPath, 'utf-8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) throw new Error('slides.json must be an array');
    return data;
  } catch (e) {
    console.error(`Error reading slides.json: ${e.message}`);
    return null;
  }
}

// ============================================================================
// Style Config
// ============================================================================

const STYLE = {
  // 字体优先级：macOS 系统中文字体
  fontFace: 'PingFang SC',
  fontFallback: 'Microsoft YaHei',
  colors: {
    title: 'FFFFFF',
    subtitle: 'CCCCCC',
    bullet: 'E0E0E0',
    footnote: '999999',
    overlay: '000000',
  },
  // 文字区域（百分比转为英寸，基于 10x5.625 英寸的 16:9 画布）
  title: { x: 0.6, y: 0.4, w: 8.8, fontSize: 32, bold: true },
  subtitle: { x: 0.6, y: 1.1, w: 8.8, fontSize: 18 },
  bullets: { x: 0.6, y: 1.8, w: 8.8, h: 3.2, fontSize: 16, lineSpacing: 28 },
  footnote: { x: 0.6, y: 5.0, w: 8.8, fontSize: 11 },
  // Cover 页特殊布局
  cover: {
    title: { x: 0.8, y: 1.5, w: 8.4, fontSize: 40, bold: true },
    subtitle: { x: 0.8, y: 2.6, w: 8.4, fontSize: 20 },
  },
};

// ============================================================================
// Slide Builder
// ============================================================================

function addBackgroundImage(slide, imagePath) {
  const imageData = readFileSync(imagePath);
  const mimeType = detectImageMimeType(imageData);

  if (!mimeType) {
    console.warn(`Warning: ${imagePath} is not a valid image, skipping background`);
    return;
  }

  const base64 = imageData.toString('base64');

  // 添加全页背景图
  slide.addImage({
    data: `data:${mimeType};base64,${base64}`,
    x: 0, y: 0, w: '100%', h: '100%',
    sizing: { type: 'cover', w: '100%', h: '100%' },
  });

  // 半透明遮罩层 — 确保文字可读性
  slide.addShape('rect', {
    x: 0, y: 0, w: '100%', h: '100%',
    fill: { color: STYLE.colors.overlay, transparency: 55 },
  });
}

function addTextContent(slide, data, isCover) {
  const font = STYLE.fontFace;
  const layout = isCover ? STYLE.cover : STYLE;

  // 标题
  if (data.title) {
    const cfg = isCover ? layout.title : layout.title;
    slide.addText(data.title, {
      x: cfg.x, y: cfg.y, w: cfg.w, h: 0.8,
      fontSize: cfg.fontSize,
      fontFace: font,
      bold: cfg.bold || false,
      color: STYLE.colors.title,
      align: isCover ? 'center' : 'left',
      valign: 'middle',
      shadow: { type: 'outer', blur: 6, offset: 2, color: '000000', opacity: 0.5 },
    });
  }

  // 副标题
  if (data.subtitle) {
    const cfg = isCover ? layout.subtitle : STYLE.subtitle;
    slide.addText(data.subtitle, {
      x: cfg.x, y: cfg.y, w: cfg.w, h: 0.6,
      fontSize: cfg.fontSize,
      fontFace: font,
      color: STYLE.colors.subtitle,
      align: isCover ? 'center' : 'left',
      valign: 'middle',
    });
  }

  // 要点列表
  if (data.bullets && data.bullets.length > 0) {
    const bulletTexts = data.bullets.map((text) => ({
      text: `  ${text}`,
      options: {
        fontSize: STYLE.bullets.fontSize,
        fontFace: font,
        color: STYLE.colors.bullet,
        bullet: { type: 'number' },
        lineSpacing: STYLE.bullets.lineSpacing,
        paraSpaceBefore: 6,
      },
    }));

    slide.addText(bulletTexts, {
      x: STYLE.bullets.x,
      y: STYLE.bullets.y,
      w: STYLE.bullets.w,
      h: STYLE.bullets.h,
      valign: 'top',
    });
  }

  // 脚注
  if (data.footnote) {
    slide.addText(data.footnote, {
      x: STYLE.footnote.x, y: STYLE.footnote.y, w: STYLE.footnote.w, h: 0.4,
      fontSize: STYLE.footnote.fontSize,
      fontFace: font,
      color: STYLE.colors.footnote,
      align: 'right',
    });
  }
}

// ============================================================================
// Main
// ============================================================================

async function createHybridPptx(slides, slidesData, outputPath) {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  pptx.author = 'frontend-slides (hybrid)';
  pptx.subject = 'Generated Slide Deck — AI Background + Real Text';

  // 构建 index → data 映射
  const dataMap = new Map();
  if (slidesData) {
    for (const d of slidesData) {
      dataMap.set(d.index, d);
    }
  }

  for (const slide of slides) {
    const deckSlide = pptx.addSlide();
    const data = dataMap.get(slide.index);
    const isCover = data?.layout === 'cover' || slide.index === 1;

    // 1. AI 背景图
    addBackgroundImage(deckSlide, slide.path);

    // 2. 真实文字
    if (data) {
      addTextContent(deckSlide, data, isCover);
    }

    const hasText = data ? ' + text' : ' (image only)';
    console.log(`Added: ${slide.filename}${hasText}`);
  }

  await pptx.writeFile({ fileName: outputPath });
  console.log(`\nCreated (hybrid): ${outputPath}`);
  console.log(`Total slides: ${slides.length}`);
  console.log(`Slides with text overlay: ${dataMap.size}`);
}

async function main() {
  const { dir, output } = parseArgs();

  if (!existsSync(dir)) {
    console.error(`Directory not found: ${dir}`);
    process.exit(1);
  }

  const slides = findSlideImages(dir);
  if (slides.length === 0) {
    console.error(`No slide images found in: ${dir}`);
    process.exit(1);
  }

  const slidesData = loadSlidesData(dir);
  const dirName = basename(dir) === 'slide-deck' ? basename(join(dir, '..')) : basename(dir);
  const outputPath = output || join(dir, `${dirName}.pptx`);

  console.log(`Found ${slides.length} slides in: ${dir}`);
  if (slidesData) {
    console.log(`Loaded ${slidesData.length} text entries from slides.json`);
  }
  console.log('');

  await createHybridPptx(slides, slidesData, outputPath);
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
