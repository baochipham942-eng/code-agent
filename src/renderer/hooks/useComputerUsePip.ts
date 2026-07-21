import { useSurfaceExecutionPip } from './useSurfaceExecutionPip';

export { useSurfaceExecutionPip } from './useSurfaceExecutionPip';

/** Compatibility entrypoint retained for App and downstream imports. */
export function useComputerUsePip(): void {
  useSurfaceExecutionPip();
}
