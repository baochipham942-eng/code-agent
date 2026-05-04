// Void Harbor - Game Loop
// Main entry point: initializes everything, runs the game loop
(() => {

const { getState } = window.VoidHarborState;
const { gameTick } = window.VoidHarborSystems;
const { render } = window.VoidHarborRender;
const { initUI, updateUI } = window.VoidHarborUI;

let lastTime = 0;
let uiUpdateTimer = 0;
const UI_UPDATE_INTERVAL = 200; // ms between UI updates

function gameLoop(timestamp) {
  const s = getState();

  // Delta time (capped to avoid spiral of death)
  const dt = Math.min((timestamp - lastTime) / 1000, 0.1);
  lastTime = timestamp;

  // FPS counter
  s.frameCount++;
  s.fpsTimer += dt;
  if (s.fpsTimer >= 1) {
    s.fps = s.frameCount;
    s.frameCount = 0;
    s.fpsTimer = 0;
  }

  // Game tick
  if (s.phase === 'playing') {
    gameTick(dt);
  }

  // Render every frame
  render();

  // Update UI less frequently (DOM updates are expensive)
  uiUpdateTimer += dt * 1000;
  if (uiUpdateTimer >= UI_UPDATE_INTERVAL) {
    uiUpdateTimer = 0;
    updateUI();
  }

  requestAnimationFrame(gameLoop);
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  initUI();
  lastTime = performance.now();
  requestAnimationFrame(gameLoop);
  console.log('[Void Harbor] Game initialized. Ready to play.');
});
})();
