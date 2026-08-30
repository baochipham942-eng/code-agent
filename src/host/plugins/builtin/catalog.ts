import type { PluginEntry, PluginManifest } from '../types';
import {
  manifest as imageProcessManifest,
  default as imageProcessEntry,
} from './imageProcess';
import {
  manifest as audioProcessingManifest,
  default as audioProcessingEntry,
} from './audioProcessing';
import {
  manifest as videoGenerationManifest,
  default as videoGenerationEntry,
} from './videoGeneration';
import {
  manifest as imageCreationManifest,
  default as imageCreationEntry,
} from './imageCreation';
import {
  manifest as musicGenerationManifest,
  default as musicGenerationEntry,
} from './musicGeneration';
import {
  manifest as browserControlManifest,
  default as browserControlEntry,
} from './browserControl';
import {
  manifest as computerUseManifest,
  default as computerUseEntry,
} from './computerUse';
import {
  manifest as photoArchiveManifest,
  default as photoArchiveEntry,
} from './photoArchive';
import { isBuiltinCapabilityId, type BuiltinCapabilityId } from './builtinCapabilityIds';

interface BuiltinPluginDescriptor {
  manifest: PluginManifest & { id: BuiltinCapabilityId };
  entry: PluginEntry;
  previewToolNames: readonly string[];
}

function builtinPlugin(
  manifest: PluginManifest,
  entry: PluginEntry,
  previewToolNames: readonly string[],
): BuiltinPluginDescriptor {
  const id = manifest.id;
  if (!isBuiltinCapabilityId(id)) {
    throw new Error(`Unknown builtin plugin id: ${id}`);
  }
  return {
    manifest: { ...manifest, id },
    entry,
    previewToolNames,
  };
}

export const BUILTIN_PLUGIN_CATALOG: readonly BuiltinPluginDescriptor[] = [
  builtinPlugin(imageProcessManifest, imageProcessEntry, ['image_process']),
  builtinPlugin(audioProcessingManifest, audioProcessingEntry, ['text_to_speech']),
  builtinPlugin(videoGenerationManifest, videoGenerationEntry, ['video_generate']),
  builtinPlugin(imageCreationManifest, imageCreationEntry, ['image_generate', 'image_annotate']),
  builtinPlugin(musicGenerationManifest, musicGenerationEntry, ['music_generate']),
  builtinPlugin(
    browserControlManifest,
    browserControlEntry,
    ['Browser', 'browser_action', 'browser_navigate', 'validate_html_in_app'],
  ),
  builtinPlugin(computerUseManifest, computerUseEntry, ['cua-driver', 'screenshot', 'ocr_search']),
  builtinPlugin(photoArchiveManifest, photoArchiveEntry, ['photo_archive']),
];

export function findBuiltinPlugin(pluginId: string): BuiltinPluginDescriptor | undefined {
  return BUILTIN_PLUGIN_CATALOG.find(({ manifest }) => manifest.id === pluginId);
}
