import type { TodoItem } from '../../../shared/contract/planning';
import type { VoiceWorkFailureMarker } from '../../../shared/contract/voice';

export function readVoiceFailureMarker(raw: unknown): VoiceWorkFailureMarker | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const marker = raw as { code?: unknown; kind?: unknown; provider?: unknown; model?: unknown };
  if (
    marker.code === 'PROJECT_SOURCE_TRUST'
    && (marker.kind === 'source_missing' || marker.kind === 'identity_changed' || marker.kind === 'not_trusted')
  ) {
    return { code: 'PROJECT_SOURCE_TRUST', kind: marker.kind };
  }
  if (marker.code === 'MODEL_AUTH') {
    return {
      code: 'MODEL_AUTH',
      ...(typeof marker.provider === 'string' && marker.provider ? { provider: marker.provider } : {}),
      ...(typeof marker.model === 'string' && marker.model ? { model: marker.model } : {}),
    };
  }
  return undefined;
}

export function diffCompletedVoiceTodos(snapshot: Map<string, string>, todos: TodoItem[]): string[] {
  if (!Array.isArray(todos)) return [];
  const freshlyCompleted: string[] = [];
  for (const todo of todos) {
    const content = typeof todo?.content === 'string' ? todo.content.trim() : '';
    if (!content) continue;
    const previous = snapshot.get(content);
    snapshot.set(content, todo.status);
    if (todo.status === 'completed' && previous !== undefined && previous !== 'completed') {
      freshlyCompleted.push(content);
    }
  }
  return freshlyCompleted;
}
