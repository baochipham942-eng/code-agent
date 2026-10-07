import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, basename, extname, dirname } from 'path';
import { fileURLToPath } from 'url';
import PptxGenJS from 'pptxgenjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
    console.error('Usage: node merge-to-pptx.mjs <slide-deck-dir> [--output filename.pptx]');
    process.exit(1);
  }

  return { dir, output };
}

function findSlideImages(dir) {
  if (!existsSync(dir)) {
    console.error(`Directory not found: ${dir}`);
    process.exit(1);
  }

  const files = readdirSync(dir);
  const slidePattern = /^(\d+)-slide-.*\.(png|jpg|jpeg)$/i;
  const promptsDir = join(dir, 'prompts');
  const hasPrompts = existsSync(promptsDir);

  const slides = files
    .filter((file) => slidePattern.test(file))
    .map((file) => {
      const match = file.match(slidePattern);
      const baseName = file.replace(/\.(png|jpg|jpeg)$/i, '');
      const promptPath = hasPrompts ? join(promptsDir, `${baseName}.md`) : undefined;

      return {
        filename: file,
        path: join(dir, file),
        index: Number.parseInt(match[1], 10),
        promptPath: promptPath && existsSync(promptPath) ? promptPath : undefined,
      };
    })
    .sort((a, b) => a.index - b.index);

  if (slides.length === 0) {
    console.error(`No slide images found in: ${dir}`);
    console.error('Expected format: 01-slide-*.png, 02-slide-*.png, etc.');
    process.exit(1);
  }

  return slides;
}

function findBasePrompt() {
  const basePromptPath = join(__dirname, '..', 'references', 'base-prompt.md');
  if (!existsSync(basePromptPath)) return undefined;
  return readFileSync(basePromptPath, 'utf-8');
}

function detectImageMimeType(buffer) {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  return null;
}

function getTextPreview(buffer) {
  return buffer
    .toString('utf8', 0, Math.min(buffer.length, 32))
    .replace(/[^\x20-\x7e]+/g, ' ')
    .trim();
}

function loadValidatedSlideImage(slide) {
  const imageData = readFileSync(slide.path);
  const detectedMimeType = detectImageMimeType(imageData);

  if (!detectedMimeType) {
    const preview = getTextPreview(imageData);
    throw new Error(
      `Invalid slide image: ${slide.filename} is not a PNG/JPEG file.` +
      (preview ? ` First bytes: "${preview}"` : '')
    );
  }

  const ext = extname(slide.filename).toLowerCase();
  const expectedMimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
  if (expectedMimeType !== detectedMimeType) {
    // CogView 等 API 可能返回 JPEG 但扩展名为 .png，自动修正而非报错
    console.warn(
      `Warning: ${slide.filename} extension ${ext} does not match actual format ${detectedMimeType}. Using detected format.`
    );
  }

  return {
    imageData,
    mimeType: detectedMimeType,
  };
}

async function createPptx(slides, outputPath) {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  pptx.author = 'frontend-slides';
  pptx.subject = 'Generated Slide Deck';

  const basePrompt = findBasePrompt();
  let notesCount = 0;

  for (const slide of slides) {
    const deckSlide = pptx.addSlide();
    const { imageData, mimeType } = loadValidatedSlideImage(slide);
    const base64 = imageData.toString('base64');

    deckSlide.addImage({
      data: `data:${mimeType};base64,${base64}`,
      x: 0,
      y: 0,
      w: '100%',
      h: '100%',
      sizing: { type: 'cover', w: '100%', h: '100%' },
    });

    if (slide.promptPath) {
      const slidePrompt = readFileSync(slide.promptPath, 'utf-8');
      const fullNotes = basePrompt ? `${basePrompt}\n\n---\n\n${slidePrompt}` : slidePrompt;
      deckSlide.addNotes(fullNotes);
      notesCount += 1;
    }

    console.log(`Added: ${slide.filename}${slide.promptPath ? ' (with notes)' : ''}`);
  }

  await pptx.writeFile({ fileName: outputPath });
  console.log(`\nCreated: ${outputPath}`);
  console.log(`Total slides: ${slides.length}`);
  if (notesCount > 0) {
    console.log(`Slides with notes: ${notesCount}${basePrompt ? ' (includes base prompt)' : ''}`);
  }
}

async function main() {
  const { dir, output } = parseArgs();
  const slides = findSlideImages(dir);
  const dirName = basename(dir) === 'slide-deck' ? basename(join(dir, '..')) : basename(dir);
  const outputPath = output || join(dir, `${dirName}.pptx`);

  console.log(`Found ${slides.length} slides in: ${dir}\n`);
  await createPptx(slides, outputPath);
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
