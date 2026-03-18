import { existsSync, readdirSync, readFileSync } from 'fs';
import { writeFile } from 'fs/promises';
import { join, basename } from 'path';
import { PDFDocument } from 'pdf-lib';

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
    console.error('Usage: node merge-to-pdf.mjs <slide-deck-dir> [--output filename.pdf]');
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

async function createPdf(slides, outputPath) {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setAuthor('frontend-slides');
  pdfDoc.setSubject('Generated Slide Deck');

  for (const slide of slides) {
    const imageData = readFileSync(slide.path);
    const ext = slide.filename.toLowerCase();
    const image = ext.endsWith('.png')
      ? await pdfDoc.embedPng(imageData)
      : await pdfDoc.embedJpg(imageData);

    const { width, height } = image;
    const page = pdfDoc.addPage([width, height]);
    page.drawImage(image, { x: 0, y: 0, width, height });
    console.log(`Added: ${slide.filename}${slide.promptPath ? ' (prompt available)' : ''}`);
  }

  const pdfBytes = await pdfDoc.save();
  await writeFile(outputPath, pdfBytes);
  console.log(`\nCreated: ${outputPath}`);
  console.log(`Total pages: ${slides.length}`);
}

async function main() {
  const { dir, output } = parseArgs();
  const slides = findSlideImages(dir);
  const dirName = basename(dir) === 'slide-deck' ? basename(join(dir, '..')) : basename(dir);
  const outputPath = output || join(dir, `${dirName}.pdf`);

  console.log(`Found ${slides.length} slides in: ${dir}\n`);
  await createPdf(slides, outputPath);
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
