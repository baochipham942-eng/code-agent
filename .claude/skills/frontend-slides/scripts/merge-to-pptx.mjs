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

async function createPptx(slides, outputPath) {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  pptx.author = 'frontend-slides';
  pptx.subject = 'Generated Slide Deck';

  const basePrompt = findBasePrompt();
  let notesCount = 0;

  for (const slide of slides) {
    const deckSlide = pptx.addSlide();
    const imageData = readFileSync(slide.path);
    const base64 = imageData.toString('base64');
    const ext = extname(slide.filename).toLowerCase().replace('.', '');
    const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';

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
