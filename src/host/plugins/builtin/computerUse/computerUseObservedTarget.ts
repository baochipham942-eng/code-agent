// Agent runtime cannot import tools/vision (P0-6). The turn lease stays with
// the legacy computer_use module; this is the allowed read for the running label.
export { computerUseObservedTarget } from '../../../tools/vision/computerUseTargetLease';
