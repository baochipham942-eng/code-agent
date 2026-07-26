import { chromium } from 'playwright';
const wav = process.argv[2];
const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${wav}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const context = await browser.newContext({ permissions: ['microphone'] });
const page = await context.newPage();
await page.goto('http://localhost:8181/');
await page.waitForTimeout(3000);
const result = await page.evaluate(() => new Promise((resolve) => {
  (async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const gain = ctx.createGain(); gain.gain.value = 0;
      let frames = 0, maxRms = 0;
      proc.onaudioprocess = (e) => {
        const d = e.inputBuffer.getChannelData(0);
        let s = 0; for (let i = 0; i < d.length; i++) s += d[i]*d[i];
        const rms = Math.sqrt(s / d.length);
        if (rms > maxRms) maxRms = rms;
        frames++;
      };
      src.connect(proc); proc.connect(gain); gain.connect(ctx.destination);
      setTimeout(() => resolve({ frames, maxRms, ctxState: ctx.state, rate: ctx.sampleRate }), 9000);
    } catch (err) { resolve({ error: `${err.name}: ${err.message}` }); }
  })();
}));
console.log('PROBE', JSON.stringify(result));
await browser.close();
