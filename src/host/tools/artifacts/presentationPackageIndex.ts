import { promises as fsp } from 'node:fs';
import {
  resolvePresentationPackageIndexFromZip,
  type PresentationPackageIndexEntry,
  type PresentationPackageZip,
} from '../../../shared/ooxml/presentationPackageIndex';

interface LoadedPresentationPackage {
  index: PresentationPackageIndexEntry[];
  zip: PresentationPackageZip;
}

/** host 侧唯一文件入口：输入 .pptx 路径，按真实显示顺序返回 package index。 */
export async function resolvePresentationPackageIndex(filePath: string): Promise<PresentationPackageIndexEntry[]> {
  return (await loadPresentationPackageIndex(filePath)).index;
}

/** Workspace inspection 需要同一 zip 的正文；共享加载结果避免第二次解包。 */
export async function loadPresentationPackageIndex(filePath: string): Promise<LoadedPresentationPackage> {
  if (!/\.pptx$/i.test(filePath)) throw new Error('Only .pptx presentations can be resolved');
  const JSZip = require('jszip') as {
    loadAsync(data: Buffer): Promise<PresentationPackageZip>;
  };
  const zip = await JSZip.loadAsync(await fsp.readFile(filePath));
  const index = await resolvePresentationPackageIndexFromZip(zip);
  return { index, zip };
}
