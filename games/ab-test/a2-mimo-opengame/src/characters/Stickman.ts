import Phaser from 'phaser';
import gameConfig from '../gameConfig.json';

interface StickmanGameState {
  lives?: number;
  abilities?: {
    doubleJump?: boolean;
    wallJump?: boolean;
  };
}

type SceneWithControls = Phaser.Scene & {
  cursors?: Phaser.Types.Input.Keyboard.CursorKeys;
  spawn?: { x: number; y: number };
};

function getGameState(): StickmanGameState | undefined {
  return (window as unknown as { gameState?: StickmanGameState }).gameState;
}

export class Stickman extends Phaser.Physics.Arcade.Sprite {
  public usedDoubleJump: boolean = false;

  constructor(scene: Phaser.Scene, x: number, y: number) {
    super(scene, x, y, 'stickman_idle');

    scene.add.existing(this);
    scene.physics.add.existing(this);

    this.setCollideWorldBounds(true);
    this.setSize(20, 44);
    this.setOffset(4, 2);

    const body = this.body as Phaser.Physics.Arcade.Body;
    body.setGravityY(0);
    body.setMaxVelocityY(800);

    this.setTexture('stickman_idle');
  }

  get abilities(): { doubleJump: boolean; wallJump: boolean } {
    const gs = getGameState();
    if (!gs || !gs.abilities) {
      return { doubleJump: false, wallJump: false };
    }
    return {
      doubleJump: Boolean(gs.abilities.doubleJump),
      wallJump: Boolean(gs.abilities.wallJump),
    };
  }

  update(): void {
    const body = this.body as Phaser.Physics.Arcade.Body;
    const cursors = (this.scene as SceneWithControls).cursors;
    const kb = this.scene.input.keyboard;
    if (!cursors || !kb) return;

    const onGround = body.blocked.down;

    // Reset double jump flag on landing
    if (onGround) {
      this.usedDoubleJump = false;
    }

    // Horizontal movement
    const walkSpeed = gameConfig.walkSpeed;
    if (cursors.left.isDown) {
      body.setVelocityX(-walkSpeed);
      this.setFlipX(true);
    } else if (cursors.right.isDown) {
      body.setVelocityX(walkSpeed);
      this.setFlipX(false);
    } else {
      body.setVelocityX(0);
    }

    // Jump input
    const jumpJustPressed = Phaser.Input.Keyboard.JustDown(cursors.up);
    const spaceJustPressed = kb.checkDown(Phaser.Input.Keyboard.KeyCodes.SPACE, 0) &&
      Phaser.Input.Keyboard.JustDown(kb.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE));

    if (jumpJustPressed || spaceJustPressed) {
      this.jump(body, onGround);
    }

    // Texture switching based on state
    if (!onGround) {
      this.setTexture('stickman_jump');
    } else if (Math.abs(body.velocity.x) > 10) {
      this.setTexture('stickman_run');
    } else {
      this.setTexture('stickman_idle');
    }
  }

  private jump(body: Phaser.Physics.Arcade.Body, onGround: boolean): void {
    if (onGround) {
      // First jump — always allowed when grounded
      body.setVelocityY(gameConfig.jumpPower);
      this.usedDoubleJump = false;
    } else if (this.abilities.doubleJump && !this.usedDoubleJump) {
      // Double jump — only if ability unlocked and not yet used this airtime
      body.setVelocityY(gameConfig.doubleJumpPower);
      this.usedDoubleJump = true;
    }
  }

  public unlockDoubleJump(): void {
    // No-op — gameState.abilities is mutated externally
  }

  public takeDamage(scene: Phaser.Scene): void {
    const gs = getGameState();
    if (!gs || typeof gs.lives !== 'number') return;

    gs.lives--;

    if (gs.lives <= 0) {
      scene.scene.start('GameOverScene');
    } else {
      const spawn = (scene as SceneWithControls).spawn;
      if (spawn) {
        this.setPosition(spawn.x, spawn.y);
        this.setVelocity(0, 0);
      }
    }
  }
}
