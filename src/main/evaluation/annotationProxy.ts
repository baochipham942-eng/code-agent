/**
 * Main process proxy for eval-harness AnnotationStore.
 * Bridges IPC handlers to the file-system annotation store.
 */

import { saveAnnotation, loadAnnotations, getAxialCoding } from '../../../packages/eval-harness/src/index';
import type { Annotation } from '../../../packages/eval-harness/src/runner/AnnotationStore';

export class AnnotationProxy {
  private static instance: AnnotationProxy;

  static getInstance(): AnnotationProxy {
    if (!AnnotationProxy.instance) {
      AnnotationProxy.instance = new AnnotationProxy();
    }
    return AnnotationProxy.instance;
  }

  saveAnnotation(annotation: Annotation): { success: boolean; error?: string } {
    try {
      saveAnnotation(annotation);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  getAxialCoding(): ReturnType<typeof getAxialCoding> {
    return getAxialCoding();
  }

  getAllAnnotations(): ReturnType<typeof loadAnnotations> {
    return loadAnnotations();
  }
}
