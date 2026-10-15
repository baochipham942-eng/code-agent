import path from 'path';
import { getUserConfigDir } from '../../config/configPaths';
import { LIBREOFFICE_ROOT_NAME } from './constants';

export function resolveLibreOfficeRoot(dataDir?: string): string {
  const base = dataDir?.trim() || getUserConfigDir();
  return path.resolve(base, 'runtimes', LIBREOFFICE_ROOT_NAME);
}

export function managedLibreOfficePath(root: string): string {
  return path.join(root, 'LibreOffice.app', 'Contents', 'MacOS', 'soffice');
}

export function readyJsonPath(root: string): string {
  return path.join(root, 'ready.json');
}

export function installLogPath(root: string): string {
  return path.join(root, 'install.log');
}

export function temporaryDmgPath(root: string, fileName: string): string {
  return path.join(root, `.${fileName}.download`);
}

export function mountPath(root: string): string {
  return path.join(root, '.mount');
}
