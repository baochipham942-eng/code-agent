import { createRequire } from 'module';
import { resolveExistingNodeModule, type RuntimeAssetResolverOptions } from './runtimeAssetResolver';

const runtimeRequire = typeof require === 'function' ? require : createRequire(import.meta.url);

export interface OptionalNodeModuleLoadOptions extends RuntimeAssetResolverOptions {
  allowBareModule?: boolean;
}

export interface OptionalNodeModuleLoadResult<T> {
  ok: boolean;
  module?: T;
  path?: string;
  error?: string;
  missingPackage?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingModuleError(message: string, name: string): boolean {
  return new RegExp(`Cannot find (?:package|module) ['"]?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(message)
    || /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/i.test(message);
}

export function requireOptionalNodeModule<T>(
  name: string,
  options: OptionalNodeModuleLoadOptions = {},
): OptionalNodeModuleLoadResult<T> {
  const resolvedPath = resolveExistingNodeModule(name, options);
  const errors: string[] = [];

  if (resolvedPath) {
    try {
      return {
        ok: true,
        module: runtimeRequire(resolvedPath) as T,
        path: resolvedPath,
      };
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }

  if (options.allowBareModule !== false) {
    try {
      return {
        ok: true,
        module: runtimeRequire(name) as T,
        path: name,
      };
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }

  const joined = errors.join('; ');
  return {
    ok: false,
    error: joined || `${name} is unavailable in this runtime.`,
    missingPackage: !resolvedPath || isMissingModuleError(joined, name),
  };
}
