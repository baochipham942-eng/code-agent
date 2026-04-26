import { describe, expect, it } from 'vitest';
import { buildActivityContext } from '../../../src/main/services/activity/activityContextProvider';
import type { AudioSegment, DesktopActivityEvent } from '../../../src/shared/contract';

const NOW = 1_800_000;

function makeEvent(overrides: Partial<DesktopActivityEvent> = {}): DesktopActivityEvent {
  return {
    id: 'event-1',
    capturedAtMs: NOW - 1_000,
    appName: 'Safari',
    bundleId: 'com.apple.Safari',
    windowTitle: 'Activity page',
    browserUrl: 'https://example.com',
    browserTitle: 'Example',
    documentPath: null,
    sessionState: null,
    idleSeconds: 0,
    powerSource: null,
    onAcPower: null,
    batteryPercent: null,
    batteryCharging: null,
    screenshotPath: '/tmp/activity.png',
    analyzeText: 'Visible screenshot text',
    fingerprint: 'fp-1',
    ...overrides,
  };
}

function makeAudioSegment(overrides: Partial<AudioSegment> = {}): AudioSegment {
  return {
    id: 'audio-1',
    start_at_ms: NOW - 2_000,
    end_at_ms: NOW - 1_500,
    duration_ms: 500,
    wav_path: '/tmp/audio.wav',
    transcript: 'Discussing activity context',
    speaker_id: null,
    asr_engine: 'test-asr',
    ...overrides,
  };
}

describe('buildActivityContext', () => {
  it('returns grouped sources for OpenChronicle, native desktop, audio, and screenshot analysis', async () => {
    const current = makeEvent();
    const recent = [
      current,
      makeEvent({
        id: 'event-2',
        capturedAtMs: NOW - 3_000,
        appName: 'Code',
        windowTitle: 'activityContextProvider.ts',
        screenshotPath: null,
        analyzeText: null,
      }),
    ];

    const context = await buildActivityContext({
      nowMs: () => NOW,
      openchronicleContextFetcher: async () => 'OpenChronicle current context',
      nativeDesktopService: {
        getCurrentContext: () => current,
        listRecent: () => recent,
        listAudioSegments: () => [makeAudioSegment()],
      },
    });

    expect(context.generatedAtMs).toBe(NOW);
    expect(context.tokenBudgetHint.maxChars).toBe(context.maxChars);
    expect(context.sources.map((source) => source.source)).toEqual([
      'openchronicle',
      'tauri-native-desktop',
      'audio',
      'screenshot-analysis',
    ]);
    expect(context.sources.every((source) => source.status === 'available')).toBe(true);
    expect(context.sources.find((source) => source.source === 'audio')?.items?.[0]?.text).toBe('Discussing activity context');
    expect(context.sources.find((source) => source.source === 'screenshot-analysis')?.items?.[0]?.text).toBe('Visible screenshot text');
    expect(context.evidenceRefs.map((ref) => ref.source)).toEqual([
      'openchronicle',
      'tauri-native-desktop',
      'tauri-native-desktop',
      'audio',
      'screenshot-analysis',
    ]);
  });

  it('downgrades OpenChronicle failures to an unavailable source', async () => {
    const context = await buildActivityContext({
      nowMs: () => NOW,
      openchronicleContextFetcher: async () => {
        throw new Error('daemon offline');
      },
      nativeDesktopService: {
        getCurrentContext: () => makeEvent(),
        listRecent: () => [makeEvent()],
        listAudioSegments: () => [],
      },
    });

    const openchronicle = context.sources.find((source) => source.source === 'openchronicle');

    expect(openchronicle?.status).toBe('unavailable');
    expect(openchronicle?.confidence).toBe(0);
    expect(openchronicle?.unavailableReason).toContain('daemon offline');
    expect(context.sources.find((source) => source.source === 'tauri-native-desktop')?.status).toBe('available');
  });
});
