import Phaser from 'phaser';
import { Preloader } from './scenes/Preloader';
import { TitleScene } from './scenes/TitleScene';
import { Level1Scene } from './scenes/Level1Scene';
import { Level2Scene } from './scenes/Level2Scene';
import { Level3Scene } from './scenes/Level3Scene';
import { UIScene } from './scenes/UIScene';
import { GameOverScene } from './scenes/GameOverScene';
import { VictoryScene } from './scenes/VictoryScene';

/* ------------------------------------------------------------------ */
/*  Global game-state singleton                                        */
/* ------------------------------------------------------------------ */
interface GameState {
  enemiesDefeated: number;
  blocksUsed: number;
  gatesUnlocked: number;
  abilities: {
    doubleJump: boolean;
  };
}

const gameState: GameState = {
  enemiesDefeated: 0,
  blocksUsed: 0,
  gatesUnlocked: 0,
  abilities: {
    doubleJump: false,
  },
};

(globalThis as Record<string, unknown>).gameState = gameState;
(window as Record<string, unknown>).gameState = gameState;

/* ------------------------------------------------------------------ */
/*  Phaser configuration                                               */
/* ------------------------------------------------------------------ */
const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: 960,
  height: 540,
  physics: {
    default: 'arcade',
    arcade: {
      gravity: { x: 0, y: 800 },
      debug: false,
    },
  },
  scene: [
    Preloader,
    TitleScene,
    { key: 'Level1', scene: Level1Scene },
    { key: 'Level2', scene: Level2Scene },
    { key: 'Level3', scene: Level3Scene },
    UIScene,
    GameOverScene,
    VictoryScene,
  ],
};

const game = new Phaser.Game(config);

/* ------------------------------------------------------------------ */
/*  __GAME_META__ – machine-readable descriptor                        */
/* ------------------------------------------------------------------ */
(window as Record<string, unknown>).__GAME_META__ = {
  artifactKind: 'game',
  subtype: 'platformer',
  gameplayMechanics: {
    enemies: [{ stompable: true, defeatReward: 'score' }],
    blocks: [{ bumpableFromBelow: true, reward: 'doubleJump', usedState: 'bumped' }],
    abilities: [{ name: 'doubleJump', acquiredFrom: 'block', effect: 'movement', unlocksRoute: 'highRoute' }],
    gates: [{ requiresAbility: 'doubleJump', blocksAccessTo: 'highRoute' }],
    comboChallenge: [{ requires: ['jump', 'stomp', 'doubleJump'], target: 'reach exit of level 3' }],
  },
};

/* ------------------------------------------------------------------ */
/*  snapshot() – lightweight telemetry for automated grading           */
/* ------------------------------------------------------------------ */
(window as Record<string, unknown>).snapshot = () => {
  const scenes = game.scene.getScenes(true);
  let player = { x: 0, y: 0, vx: 0, vy: 0 };

  for (const scene of scenes) {
    const s = scene as unknown as Record<string, unknown>;
    if (s.player && typeof s.player === 'object') {
      const p = s.player as Phaser.Types.Physics.Arcade.SpriteWithDynamicBody;
      if (p.body) {
        player = {
          x: p.x,
          y: p.y,
          vx: p.body.velocity.x,
          vy: p.body.velocity.y,
        };
        break;
      }
    }
  }

  return {
    player,
    enemiesDefeated: gameState.enemiesDefeated,
    blocksUsed: gameState.blocksUsed,
    gatesUnlocked: gameState.gatesUnlocked,
    abilities: { doubleJump: !!gameState.abilities.doubleJump },
  };
};
