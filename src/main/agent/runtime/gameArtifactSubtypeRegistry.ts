import { gameSubtypeRegistry } from './game/registry';

// side-effect import — 各 subtype checker 自注册到 gameSubtypeRegistry
import './game/breakout/BreakoutChecker';
import './game/platformer/PlatformerChecker';
import './game/runner/RunnerChecker';

export { gameSubtypeRegistry };
