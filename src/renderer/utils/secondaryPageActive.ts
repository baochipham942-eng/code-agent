import type { useAppStore } from '../stores/appStore';

type AppState = ReturnType<typeof useAppStore.getState>;

/** 会话区被二级页/设置覆盖的开关。App 顶栏收敛与「用户是否正看着会话」共用这一份，避免名单漂移。 */
export type SecondaryPageFlags = Pick<
  AppState,
  | 'expertDetailRoleId' | 'showLibraryPanel' | 'showCapabilityHub' | 'showCronCenter'
  | 'showLocalOpsPanel' | 'showInAppValidation' | 'activeInternalFeatureId'
  | 'showProjectSpacePage' | 'showSettings' | 'showPromptManager' | 'showLab'
  | 'showTimeCapabilityCenter' | 'showActivityPanel' | 'showProjectCollaborationPage'
  | 'showDesktopPanel'
>;

export function isSecondaryPageActive(s: SecondaryPageFlags): boolean {
  return Boolean(
    s.expertDetailRoleId || s.showLibraryPanel
    || s.showCapabilityHub || s.showCronCenter || s.showLocalOpsPanel || s.showInAppValidation
    || s.activeInternalFeatureId
    || s.showProjectSpacePage
    || s.showSettings || s.showPromptManager || s.showLab || s.showTimeCapabilityCenter
    || s.showActivityPanel || s.showProjectCollaborationPage || s.showDesktopPanel,
  );
}
