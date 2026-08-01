import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SurfaceLiveFrameV1 } from '../../../../src/shared/contract/surfaceExecution';
import { SurfaceLiveStreamService } from '../../../../src/host/services/surfaceExecution/SurfaceLiveStreamService';

const startPageScreencast = vi.hoisted(() => vi.fn());

vi.mock('../../../../src/host/services/infra/browser/pageScreencast', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  startPageScreencast,
}));

type FrameEmitter = (frame: {
  base64: string; width: number; height: number; capturedAtMs: number;
}) => void;

const stop = vi.fn(async () => undefined);
let emitFrame: FrameEmitter = () => undefined;

function buildRuntime(session: Record<string, unknown> | null) {
  return { sessions: { get: () => session } } as never;
}

function buildAdapter(input: { running?: boolean; hasPage?: boolean } = {}) {
  const running = input.running ?? true;
  const hasPage = input.hasPage ?? true;
  return {
    findBindingBySurfaceSessionId: () => ({
      browserService: {
        isRunning: () => running,
        getActiveTab: () => (hasPage ? { id: 'tab-1', page: { id: 'page' } } : null),
      },
    }),
  } as never;
}

const RUNNING_BROWSER_SESSION = {
  sessionId: 'surface-1',
  conversationId: 'session-a',
  surface: 'browser',
  state: 'running',
};

const REQUEST = { version: 1 as const, conversationId: 'session-a', surfaceSessionId: 'surface-1' };

describe('SurfaceLiveStreamService（B1-R·R1 帧流归属与生命周期）', () => {
  let published: SurfaceLiveFrameV1[];

  beforeEach(() => {
    published = [];
    stop.mockClear();
    startPageScreencast.mockReset();
    startPageScreencast.mockImplementation(async (
      _page: unknown,
      _options: unknown,
      onFrame: FrameEmitter,
    ) => {
      emitFrame = onFrame;
      return { stop };
    });
  });

  function build(overrides: {
    session?: Record<string, unknown> | null;
    adapter?: ReturnType<typeof buildAdapter>;
  } = {}) {
    return new SurfaceLiveStreamService(
      buildRuntime(overrides.session === undefined ? RUNNING_BROWSER_SESSION : overrides.session),
      overrides.adapter ?? buildAdapter(),
      (frame) => published.push(frame),
    );
  }

  it('归属对得上就开流，帧带会话归属推给 renderer', async () => {
    const service = build();

    expect(await service.start(REQUEST)).toMatchObject({ streaming: true });
    emitFrame({ base64: 'AAAA', width: 960, height: 600, capturedAtMs: 42 });

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      conversationId: 'session-a',
      surfaceSessionId: 'surface-1',
      mimeType: 'image/jpeg',
      dataUrl: 'data:image/jpeg;base64,AAAA',
      width: 960,
    });
  });

  it('会话属于别的对话时拒绝开流——帧里可能有登录态页面，串会话等于泄漏', async () => {
    const service = build({
      session: { ...RUNNING_BROWSER_SESSION, conversationId: 'session-b' },
    });

    expect(await service.start(REQUEST)).toMatchObject({ streaming: false, reason: 'unsupported' });
    expect(startPageScreencast).not.toHaveBeenCalled();
  });

  it('会话不存在 / 不是 browser surface 时拒绝开流', async () => {
    expect(await build({ session: null }).start(REQUEST))
      .toMatchObject({ streaming: false, reason: 'unsupported' });
    expect(await build({ session: { ...RUNNING_BROWSER_SESSION, surface: 'computer' } }).start(REQUEST))
      .toMatchObject({ streaming: false, reason: 'unsupported' });
    expect(startPageScreencast).not.toHaveBeenCalled();
  });

  it('浏览器没在跑 / 没有活动页时给出原因，不抛错', async () => {
    expect(await build({ adapter: buildAdapter({ running: false }) }).start(REQUEST))
      .toMatchObject({ streaming: false, reason: 'not_running' });
    expect(await build({ adapter: buildAdapter({ hasPage: false }) }).start(REQUEST))
      .toMatchObject({ streaming: false, reason: 'no_active_page' });
  });

  it('stop 之后停底层 screencast，并且迟到的帧不再外推', async () => {
    const service = build();
    await service.start(REQUEST);
    emitFrame({ base64: 'AAAA', width: 960, height: 600, capturedAtMs: 1 });

    expect(await service.stop('surface-1')).toMatchObject({ streaming: false });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(service.isStreaming('surface-1')).toBe(false);

    emitFrame({ base64: 'BBBB', width: 960, height: 600, capturedAtMs: 2 });
    expect(published).toHaveLength(1);
  });

  it('重复 start 同一会话不重开流', async () => {
    const service = build();
    await service.start(REQUEST);
    await service.start(REQUEST);

    expect(startPageScreencast).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
  });

  it('同时只维持一条流：换会话开流会先停掉上一条', async () => {
    const service = build();
    await service.start(REQUEST);
    await service.start({ ...REQUEST, surfaceSessionId: 'surface-1' });
    await service.stop('surface-1');

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('底层开流抛错时降级成不可用，不把异常抛给 IPC', async () => {
    startPageScreencast.mockRejectedValueOnce(new Error('CDP unavailable'));

    expect(await build().start(REQUEST))
      .toMatchObject({ streaming: false, reason: 'unsupported' });
  });
});
