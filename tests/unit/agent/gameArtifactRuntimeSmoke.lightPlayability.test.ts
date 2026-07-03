import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { runLightPlayabilitySmoke } from '../../../src/host/agent/runtime/gameArtifactRuntimeSmoke';
import { validateGameArtifact } from '../../../src/host/agent/runtime/gameArtifactValidator';
import { GAME_VALIDATION_TIMEOUTS } from '../../../src/shared/constants/game';

async function writeTempHtml(content: string, fileName = 'game.html'): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-light-playability-'));
  const filePath = path.join(dir, fileName);
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

// 复刻 dogfood 实锤的失败形态：加载正常、开始屏正常，一按键开始游玩就抛
// 未捕获 ReferenceError（画敌人引用未定义变量），此前 light 契约完全查不出来。
const CRASH_ON_KEYDOWN_GAME = `
  <!doctype html>
  <html>
  <body>
    <canvas id="game" width="400" height="300"></canvas>
    <script>
      const canvas = document.getElementById('game');
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#224';
      ctx.fillRect(0, 0, 400, 300);
      ctx.fillStyle = '#fff';
      ctx.fillText('press any key to start', 120, 150);
      window.addEventListener('keydown', () => {
        ctx.fillRect(enemyX + 18, y + 10, 6, 6); // y is not defined -> uncaught ReferenceError
      });
    </script>
  </body>
  </html>
`;

const HEALTHY_CANVAS_GAME = `
  <!doctype html>
  <html>
  <body>
    <canvas id="game" width="400" height="300"></canvas>
    <script>
      const canvas = document.getElementById('game');
      const ctx = canvas.getContext('2d');
      let x = 20;
      const keys = {};
      window.addEventListener('keydown', (event) => { keys[event.key] = true; });
      window.addEventListener('keyup', (event) => { keys[event.key] = false; });
      function frame() {
        if (keys.ArrowRight) x += 3;
        ctx.fillStyle = '#123';
        ctx.fillRect(0, 0, 400, 300);
        ctx.fillStyle = '#fc0';
        ctx.fillRect(x, 200, 24, 24);
        requestAnimationFrame(frame);
      }
      frame();
    </script>
  </body>
  </html>
`;

const BLANK_CANVAS_PAGE = `
  <!doctype html>
  <html>
  <body>
    <canvas id="game" width="400" height="300"></canvas>
    <script>
      // 有 canvas、有输入监听，但从不绘制任何内容——用户看到的是全空画面。
      window.addEventListener('keydown', () => {});
    </script>
  </body>
  </html>
`;

describe('runLightPlayabilitySmoke', () => {
  it('fails when keyboard input triggers an uncaught runtime error', async () => {
    const filePath = await writeTempHtml(CRASH_ON_KEYDOWN_GAME, 'crash-on-keydown.html');

    const smoke = await runLightPlayabilitySmoke(filePath, GAME_VALIDATION_TIMEOUTS.LIGHT_PLAYABILITY_SMOKE_MS);

    if (smoke.skipped) return; // Playwright 不可用的环境按 skipped 放过，与生产语义一致
    expect(smoke.passed).toBe(false);
    expect(smoke.failures.some((failure) => failure.includes('runtime page errors'))).toBe(true);
    expect(smoke.failures.some((failure) => failure.includes('ReferenceError'))).toBe(true);
  });

  it('passes a healthy canvas game that renders and takes input', async () => {
    const filePath = await writeTempHtml(HEALTHY_CANVAS_GAME, 'healthy.html');

    const smoke = await runLightPlayabilitySmoke(filePath, GAME_VALIDATION_TIMEOUTS.LIGHT_PLAYABILITY_SMOKE_MS);

    if (smoke.skipped) return;
    expect(smoke.passed).toBe(true);
    expect(smoke.checks.some((check) => check.includes('light playability smoke passed'))).toBe(true);
  });

  it('fails when the canvas stays blank before and after input', async () => {
    const filePath = await writeTempHtml(BLANK_CANVAS_PAGE, 'blank.html');

    const smoke = await runLightPlayabilitySmoke(filePath, GAME_VALIDATION_TIMEOUTS.LIGHT_PLAYABILITY_SMOKE_MS);

    if (smoke.skipped) return;
    expect(smoke.passed).toBe(false);
    expect(smoke.failures.some((failure) => failure.includes('nonblank rendered content'))).toBe(true);
  });
});

describe('validateGameArtifact light contract + playability smoke', () => {
  it('light contract now catches the crash-on-play artifact that previously passed', async () => {
    const filePath = await writeTempHtml(
      CRASH_ON_KEYDOWN_GAME.replace(
        '<script>',
        `<script>
          window.__GAME_META__ = { domain: 'game', subtype: 'platformer', controls: { ArrowRight: 'move' } };
        </script>
        <script>`,
      ),
      'crash-light.html',
    );

    const result = await validateGameArtifact(filePath, {
      contractLevel: 'light',
      runLightPlayabilitySmoke: true,
      lightPlayabilitySmokeTimeoutMs: GAME_VALIDATION_TIMEOUTS.LIGHT_PLAYABILITY_SMOKE_MS,
    });

    expect(result.shouldValidate).toBe(true);
    if (result.playabilitySmoke?.skipped) return;
    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.includes('runtime page errors'))).toBe(true);
  });

  it('light contract without the playability flag keeps its previous lenient behavior', async () => {
    const filePath = await writeTempHtml(HEALTHY_CANVAS_GAME, 'healthy-light.html');

    const result = await validateGameArtifact(filePath, { contractLevel: 'light' });

    expect(result.playabilitySmoke).toBeUndefined();
  });
});
