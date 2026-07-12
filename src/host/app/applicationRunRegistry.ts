import { RunRegistry } from '../runtime/runRegistry';

/** One registry owner per application process. Web and desktop bootstrap both use this factory. */
let applicationRunRegistry: RunRegistry | null = null;

export function getApplicationRunRegistry(): RunRegistry {
  applicationRunRegistry ??= new RunRegistry();
  return applicationRunRegistry;
}

export function getConfiguredApplicationRunRegistry(): RunRegistry | null {
  return applicationRunRegistry;
}

export function resetApplicationRunRegistryForTests(): void {
  applicationRunRegistry?.clear();
  applicationRunRegistry = null;
}
