import Phaser from 'phaser';

export class StickEnemy extends Phaser.Physics.Arcade.Sprite {
  private patrolMin: number;
  private patrolMax: number;
  private patrolSpeed: number = 80;
  public isDead: boolean = false;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    patrolMin: number,
    patrolMax: number
  ) {
    super(scene, x, y, 'enemy_walker');

    scene.add.existing(this);
    scene.physics.add.existing(this);

    this.patrolMin = patrolMin;
    this.patrolMax = patrolMax;

    const body = this.body as Phaser.Physics.Arcade.Body;
    body.setCollideWorldBounds(true);
    body.setVelocityX(this.patrolSpeed);
    body.setGravityY(0);
    body.setBounce(0, 0);
    body.setSize(20, 36);
    body.setOffset(4, 6);

    this.setFlipX(false);
  }

  update(): void {
    if (this.isDead) return;

    const body = this.body as Phaser.Physics.Arcade.Body;

    // Patrol: bounce between patrolMin and patrolMax
    if (this.x <= this.patrolMin) {
      body.setVelocityX(this.patrolSpeed);
      this.setFlipX(false);
    } else if (this.x >= this.patrolMax) {
      body.setVelocityX(-this.patrolSpeed);
      this.setFlipX(true);
    }

    // Also reverse if blocked by wall
    if (body.blocked.left) {
      body.setVelocityX(this.patrolSpeed);
      this.setFlipX(false);
    } else if (body.blocked.right) {
      body.setVelocityX(-this.patrolSpeed);
      this.setFlipX(true);
    }
  }

  public stomp(): void {
    this.isDead = true;
    const body = this.body as Phaser.Physics.Arcade.Body;
    body.setVelocity(0, 0);
    body.setEnable(false);

    // Quick shrink + fade then destroy
    this.scene.tweens.add({
      targets: this,
      scaleY: 0.1,
      alpha: 0,
      duration: 300,
      onComplete: () => {
        this.destroy();
      }
    });
  }
}
