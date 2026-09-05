export const BUILTIN_CAPABILITY_IDS = [
  'builtin.imageProcess',
  'builtin.audioProcessing',
  'builtin.videoGeneration',
  'builtin.imageCreation',
  'builtin.musicGeneration',
  'builtin.browserControl',
  'builtin.computerUse',
  'builtin.photoArchive',
] as const;

export type BuiltinCapabilityId = (typeof BUILTIN_CAPABILITY_IDS)[number];

export const COMPUTER_USE_CAPABILITY_ID: BuiltinCapabilityId = 'builtin.computerUse';

export function isBuiltinCapabilityId(pluginId: string): pluginId is BuiltinCapabilityId {
  return BUILTIN_CAPABILITY_IDS.some((id) => id === pluginId);
}
