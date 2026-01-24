// ============================================================================
// Components - Index
// ============================================================================

// -----------------------------------------------------------------------------
// Primitives - Basic UI components
// -----------------------------------------------------------------------------
export * from './primitives';

// -----------------------------------------------------------------------------
// Composites - Composite UI components
// -----------------------------------------------------------------------------
export * from './composites';

// -----------------------------------------------------------------------------
// Features - Business Components
// -----------------------------------------------------------------------------
export * from './features';

// -----------------------------------------------------------------------------
// Layout Components
// -----------------------------------------------------------------------------
export { TitleBar } from './TitleBar';
export { Sidebar } from './Sidebar';
export { ChatView } from './ChatView';

// -----------------------------------------------------------------------------
// Panel Components
// -----------------------------------------------------------------------------
export { GenerationBadge } from './GenerationBadge';
export { TodoPanel } from './TodoPanel';
export { WorkspacePanel } from './WorkspacePanel';

// Planning panels (Gen 3+ persistent planning)
export { PlanningPanel } from './PlanningPanel';
export { FindingsPanel } from './FindingsPanel';
export { ErrorsPanel } from './ErrorsPanel';

// Skill management panel
export { SkillsPanel } from './SkillsPanel';

// -----------------------------------------------------------------------------
// Modal Components
// -----------------------------------------------------------------------------
export { ForceUpdateModal } from './ForceUpdateModal';

// -----------------------------------------------------------------------------
// Permission Dialog
// -----------------------------------------------------------------------------
export { PermissionDialog } from './PermissionDialog';

// -----------------------------------------------------------------------------
// Notification Components
// -----------------------------------------------------------------------------
export { UpdateNotification } from './UpdateNotification';
