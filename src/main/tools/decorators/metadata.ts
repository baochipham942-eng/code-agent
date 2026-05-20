// ============================================================================
// Decorator Metadata Helpers
// ============================================================================

import 'reflect-metadata';

export function getDecoratorMetadata<T>(metadataKey: symbol, target: object): T | undefined {
  const metadata: unknown = Reflect.getMetadata(metadataKey, target);
  return metadata as T | undefined;
}
