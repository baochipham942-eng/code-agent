import type { messages } from '../../i18n';
import { AppIcon } from '../../app/AppIcon';

export function AttachmentSheet({ mode, text, onPick, onOpenSettings }: {
  mode: 'attachment' | 'cameraDenied';
  text: ReturnType<typeof messages>;
  onPick(kind: 'image' | 'file' | 'camera'): void;
  onOpenSettings(): void;
}) {
  if (mode === 'cameraDenied') {
    return <div data-testid="camera-denied">
      <p className="caption">{text.cameraDeniedBody}</p>
      <div className="camera-denied-actions">
        <button type="button" className="primary" data-testid="camera-open-settings" onClick={onOpenSettings}>{text.openSystemSettings}</button>
        <button type="button" data-testid="camera-pick-photo" onClick={() => onPick('image')}>{text.attachPickPhotoInstead}</button>
      </div>
    </div>;
  }
  return <div data-testid="attach-sheet">
    <div className="settings-group">
      <button type="button" className="attach-row" data-testid="attach-photo" onClick={() => onPick('image')}>
        <AppIcon name="image" />
        <span className="attach-row-copy"><span>{text.attachPhoto}</span><span className="row-detail">{text.attachPhotoHint}</span></span>
        <AppIcon name="chevron" />
      </button>
      <button type="button" className="attach-row" data-testid="attach-camera" onClick={() => onPick('camera')}>
        <AppIcon name="camera" />
        <span className="attach-row-copy"><span>{text.attachCamera}</span><span className="row-detail">{text.attachCameraHint}</span></span>
        <AppIcon name="chevron" />
      </button>
      <button type="button" className="attach-row" data-testid="attach-file" onClick={() => onPick('file')}>
        <AppIcon name="file" />
        <span className="attach-row-copy"><span>{text.attachFile}</span><span className="row-detail">{text.attachFileHint}</span></span>
        <AppIcon name="chevron" />
      </button>
    </div>
    <p className="caption">{text.attachDestinationHint}</p>
  </div>;
}
