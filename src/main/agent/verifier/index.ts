// ============================================================================
// Verifier Module - 统一导出
// ============================================================================

export { getVerifierRegistry } from './verifierRegistry';
export type {
  VerifierRegistryImpl,
  TaskVerifier,
  VerificationResult,
  VerificationCheck,
  VerificationContext,
  TaskType,
} from './verifierRegistry';
export { CodeVerifier } from './codeVerifier';
export { PPTVerifier } from './pptVerifier';
export { SearchVerifier } from './searchVerifier';
export { DataVerifier } from './dataVerifier';
export { DocumentVerifier } from './documentVerifier';
export { ImageVerifier } from './imageVerifier';
export { VideoVerifier } from './videoVerifier';
export { GenericVerifier } from './genericVerifier';

// ============================================================================
// Auto-register all built-in verifiers
// ============================================================================

import { getVerifierRegistry } from './verifierRegistry';
import { CodeVerifier } from './codeVerifier';
import { PPTVerifier } from './pptVerifier';
import { SearchVerifier } from './searchVerifier';
import { DataVerifier } from './dataVerifier';
import { DocumentVerifier } from './documentVerifier';
import { ImageVerifier } from './imageVerifier';
import { VideoVerifier } from './videoVerifier';
import { GenericVerifier } from './genericVerifier';

let initialized = false;

export function initializeVerifiers(): void {
  if (initialized) return;

  const registry = getVerifierRegistry();
  registry.register(new CodeVerifier());
  registry.register(new PPTVerifier());
  registry.register(new SearchVerifier());
  registry.register(new DataVerifier());
  registry.register(new DocumentVerifier());
  registry.register(new ImageVerifier());
  registry.register(new VideoVerifier());
  registry.register(new GenericVerifier()); // 通用兜底始终最后

  initialized = true;
}
