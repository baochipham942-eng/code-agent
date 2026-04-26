import {
  finishWithError,
  hasFlag,
  parseArgs,
  printJson,
  printKeyValue,
} from './_helpers.ts';
import {
  closeSystemChromeSession,
  formatAcceptanceError,
  launchSystemChromeSession,
} from './browser-computer-system-chrome.ts';

function usage(): void {
  console.log(`Browser / Computer system Chrome CDP smoke

Usage:
  npx tsx scripts/acceptance/browser-computer-system-chrome-smoke.ts -- [options]

Options:
  --visible       Launch system Chrome in visible mode.
  --keep-browser  Keep the Chrome process open after the smoke.
  --json          Print JSON only.
  --help          Show this help.

What it validates:
  - system Chrome starts as the browser acceptance provider
  - Chrome exposes CDP on 127.0.0.1
  - a real isolated page can be opened in that CDP-backed browser
  - DOM readback comes from system Chrome, not Playwright's bundled executable`);
}

function makeSmokeUrl(): string {
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>System Chrome CDP Smoke</title>
  </head>
  <body>
    <main data-provider="system-chrome-cdp">
      <h1>System Chrome CDP Smoke</h1>
      <button id="system-chrome-cdp-button">Ready</button>
    </main>
  </body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (hasFlag(args, 'help')) {
    usage();
    return;
  }

  let session: Awaited<ReturnType<typeof launchSystemChromeSession>> | null = null;
  const failures: string[] = [];

  try {
    session = await launchSystemChromeSession({
      profilePrefix: 'code-agent-browser-computer-system-chrome-',
      visible: hasFlag(args, 'visible'),
    });

    const context = session.browser.contexts()[0] || await session.browser.newContext();
    const page = context.pages()[0] || await context.newPage();
    const smokeUrl = makeSmokeUrl();
    await page.goto(smokeUrl, { waitUntil: 'domcontentloaded' });

    const title = await page.title();
    const heading = await page.locator('h1').innerText({ timeout: 5_000 }).catch(() => '');
    const buttonText = await page.locator('#system-chrome-cdp-button').innerText({ timeout: 5_000 }).catch(() => '');
    const provider = await page.locator('main').getAttribute('data-provider').catch(() => null);

    if (title !== 'System Chrome CDP Smoke') {
      failures.push(`title mismatch: ${title}`);
    }
    if (heading !== 'System Chrome CDP Smoke') {
      failures.push(`heading mismatch: ${heading}`);
    }
    if (buttonText !== 'Ready') {
      failures.push(`button mismatch: ${buttonText}`);
    }
    if (provider !== 'system-chrome-cdp') {
      failures.push(`provider marker mismatch: ${provider || 'missing'}`);
    }

    const result = {
      ok: failures.length === 0,
      chrome: {
        provider: session.provider,
        executable: session.executable,
        cdpPort: session.port,
        mode: hasFlag(args, 'visible') ? 'visible' : 'headless',
      },
      page: {
        url: page.url().slice(0, 80),
        title,
        heading,
        buttonText,
        provider,
      },
      failures,
    };

    if (hasFlag(args, 'json')) {
      printJson(result);
    } else {
      printKeyValue('Browser / Computer System Chrome CDP Smoke Summary', [
        ['provider', result.chrome.provider],
        ['chromeExecutable', result.chrome.executable],
        ['cdpPort', result.chrome.cdpPort],
        ['mode', result.chrome.mode],
        ['title', title],
        ['heading', heading],
        ['buttonText', buttonText],
      ]);

      if (failures.length > 0) {
        console.log('\nFailures');
        for (const failure of failures) {
          console.log(`- ${failure}`);
        }
      } else {
        console.log('\nSystem Chrome CDP smoke passed.');
      }
    }

    if (failures.length > 0) {
      process.exit(1);
    }
  } finally {
    if (session && !hasFlag(args, 'keep-browser')) {
      await session.browser.close().catch(() => undefined);
      await closeSystemChromeSession(session).catch(() => undefined);
    }
  }
}

main().catch((error) => finishWithError(formatAcceptanceError(error)));
