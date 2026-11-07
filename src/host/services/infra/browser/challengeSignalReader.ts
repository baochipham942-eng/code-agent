// 主路径人机验证门的只读信号读取：标题 + 标题行 + frame URL。
// 不调用 getDomSnapshot（它会改写 target-ref 注册表），只用 page 的只读 API。

export interface ChallengeSignalPage {
  title(): Promise<string>;
  frames?: () => Array<{ url(): string }>;
  $$eval?: <T>(selector: string, fn: (els: Element[]) => T) => Promise<T>;
}

export interface ChallengeSignals {
  title: string;
  headings: string[];
  frameUrls: string[];
}

/** 读不到（page 缺 frames/$$eval 等）时返回 null，调用方负责带原因降级。 */
export async function readChallengeSignals(page: ChallengeSignalPage): Promise<ChallengeSignals | null> {
  if (typeof page.frames !== 'function' || typeof page.$$eval !== 'function') return null;
  const frameUrls = page.frames().map((frame) => frame.url());
  const headings = await page.$$eval(
    'h1, h2, h3',
    (els) => els.slice(0, 20).map((el) => (el.textContent || '').trim()),
  );
  return { title: await page.title(), headings, frameUrls };
}
