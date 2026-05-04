// Void Harbor - Canvas Renderer
// All drawing logic lives here. Reads state, draws to canvas.
(() => {

const { getState, BUILDING_TYPES, EVENT_TYPES } = window.VoidHarborState;

let canvas, ctx;
let starField = [];

function initRenderer(canvasEl) {
  canvas = canvasEl;
  ctx = canvas.getContext('2d');
  generateStarField();
  resizeCanvas();
}

function resizeCanvas() {
  const container = canvas.parentElement;
  canvas.width = container.clientWidth;
  canvas.height = container.clientHeight;
}

function generateStarField() {
  starField = [];
  for (let i = 0; i < 120; i++) {
    starField.push({
      x: Math.random(),
      y: Math.random(),
      size: 0.5 + Math.random() * 1.5,
      brightness: 0.3 + Math.random() * 0.7,
      twinkleSpeed: 0.5 + Math.random() * 2,
    });
  }
}

const BUILDING_COLORS = {
  [BUILDING_TYPES.REACTOR]: '#ff6b6b',
  [BUILDING_TYPES.DOCK]: '#4fc3f7',
  [BUILDING_TYPES.FUEL_TANK]: '#ffb74d',
  [BUILDING_TYPES.CARGO_BAY]: '#ce93d8',
  [BUILDING_TYPES.REPAIR_YARD]: '#81c784',
  [BUILDING_TYPES.DEFENSE_TURRET]: '#ef5350',
  [BUILDING_TYPES.LIFE_SUPPORT]: '#4dd0e1',
};

const BUILDING_ICONS = {
  [BUILDING_TYPES.REACTOR]: '⚛',
  [BUILDING_TYPES.DOCK]: '🚀',
  [BUILDING_TYPES.FUEL_TANK]: '⛽',
  [BUILDING_TYPES.CARGO_BAY]: '📦',
  [BUILDING_TYPES.REPAIR_YARD]: '🔧',
  [BUILDING_TYPES.DEFENSE_TURRET]: '🔫',
  [BUILDING_TYPES.LIFE_SUPPORT]: '💨',
};

function render() {
  const s = getState();
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;

  // Scale game world (800x600) to fit canvas
  const worldW = 800, worldH = 600;
  const scale = Math.min(w / worldW, h / worldH);
  const offsetX = (w - worldW * scale) / 2;
  const offsetY = (h - worldH * scale) / 2;

  ctx.save();
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);

  // Clear
  ctx.fillStyle = '#0a0e1a';
  ctx.fillRect(0, 0, w, h);

  // Stars
  const time = s.gameTime;
  for (const star of starField) {
    const twinkle = 0.5 + 0.5 * Math.sin(time * star.twinkleSpeed);
    ctx.globalAlpha = star.brightness * twinkle;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(star.x * worldW, star.y * worldH, star.size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Grid lines (subtle)
  ctx.strokeStyle = 'rgba(50, 70, 120, 0.15)';
  ctx.lineWidth = 0.5;
  const gridSize = 50;
  for (let x = 0; x < worldW; x += gridSize) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, worldH);
    ctx.stroke();
  }
  for (let y = 0; y < worldH; y += gridSize) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(worldW, y);
    ctx.stroke();
  }

  // Harbor ring (decorative)
  ctx.strokeStyle = 'rgba(79, 195, 247, 0.2)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(worldW / 2, worldH / 2, 180, 0, Math.PI * 2);
  ctx.stroke();

  // Buildings
  for (const b of s.buildings) {
    drawBuilding(b, s);
  }

  // Ships
  for (const ship of s.ships) {
    drawShip(ship);
  }

  // Pirates
  for (const p of s.pirates) {
    drawPirate(p);
  }

  // Active event effects
  for (const evt of s.activeEvents) {
    drawEventEffect(evt, worldW, worldH);
  }

  // Selection highlight
  if (s.selectedBuilding) {
    const b = s.buildings.find(bb => bb.id === s.selectedBuilding);
    if (b) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.strokeRect(b.x - b.w / 2 - 4, b.y - b.h / 2 - 4, b.w + 8, b.h + 8);
      ctx.setLineDash([]);
    }
  }

  ctx.restore();
}

function drawBuilding(b, s) {
  const x = b.x - b.w / 2;
  const y = b.y - b.h / 2;
  const color = BUILDING_COLORS[b.type] || '#888';

  // Shadow / glow
  if (b.active && b.hp > 0) {
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
  }

  // Body
  ctx.fillStyle = b.hp <= 0 ? '#333' : (b.active ? color : '#555');
  ctx.globalAlpha = b.hp <= 0 ? 0.4 : (b.hp < b.maxHp * 0.3 ? 0.6 : 1);
  ctx.fillRect(x, y, b.w, b.h);

  // HP bar
  if (b.hp < b.maxHp) {
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#333';
    ctx.fillRect(x, y - 8, b.w, 4);
    const hpRatio = b.hp / b.maxHp;
    ctx.fillStyle = hpRatio > 0.5 ? '#4caf50' : (hpRatio > 0.25 ? '#ff9800' : '#f44336');
    ctx.fillRect(x, y - 8, b.w * hpRatio, 4);
  }

  // Icon
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;
  ctx.font = '18px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  ctx.fillText(BUILDING_ICONS[b.type] || '?', b.x, b.y);

  // Name
  ctx.font = '9px monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fillText(b.name, b.x, b.y + b.h / 2 + 12);

  // Workers indicator
  ctx.font = '8px monospace';
  ctx.fillStyle = '#aaa';
  ctx.fillText(`👷${b.workers}/${b.maxWorkers}`, b.x, b.y + b.h / 2 + 22);

  // Upgrade indicator
  if (b.upgrading) {
    ctx.fillStyle = '#ffeb3b';
    ctx.fillRect(x, y + b.h + 2, b.w * (b.upgradeProgress / 10), 3);
    ctx.font = '8px monospace';
    ctx.fillText('⬆', b.x, b.y - b.h / 2 - 14);
  }

  // Docked ship indicator
  if (b.dockedShip) {
    ctx.font = '10px sans-serif';
    ctx.fillStyle = '#4fc3f7';
    ctx.fillText('🛸', b.x, b.y - b.h / 2 - 10);
  }
}

function drawShip(ship) {
  ctx.save();
  ctx.translate(ship.x, ship.y);

  // Ship body (triangle)
  ctx.fillStyle = ship.type.color;
  ctx.beginPath();
  ctx.moveTo(0, -12);
  ctx.lineTo(-8, 8);
  ctx.lineTo(8, 8);
  ctx.closePath();
  ctx.fill();

  // ID label
  ctx.font = '8px monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#fff';
  ctx.fillText(ship.type.name[0], 0, 3);

  // Patience bar (if servicing)
  if (ship.state === 'servicing') {
    const ratio = ship.patience / ship.type.patience;
    ctx.fillStyle = '#333';
    ctx.fillRect(-12, 12, 24, 3);
    ctx.fillStyle = ratio > 0.5 ? '#4caf50' : (ratio > 0.25 ? '#ff9800' : '#f44336');
    ctx.fillRect(-12, 12, 24 * ratio, 3);
  }

  // State label
  ctx.font = '7px monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  const stateLabels = { approaching: '▼', docking: '⊕', servicing: '⚙', departing: '▲', leaving: '✕' };
  ctx.fillText(stateLabels[ship.state] || '', 0, 22);

  ctx.restore();
}

function drawPirate(p) {
  ctx.save();
  ctx.translate(p.x, p.y);

  // Pirate body (diamond)
  ctx.fillStyle = '#f44336';
  ctx.beginPath();
  ctx.moveTo(0, -10);
  ctx.lineTo(-8, 0);
  ctx.lineTo(0, 10);
  ctx.lineTo(8, 0);
  ctx.closePath();
  ctx.fill();

  // HP bar
  const ratio = p.hp / p.maxHp;
  ctx.fillStyle = '#333';
  ctx.fillRect(-10, 14, 20, 3);
  ctx.fillStyle = '#f44336';
  ctx.fillRect(-10, 14, 20 * ratio, 3);

  // Glow
  ctx.strokeStyle = 'rgba(244, 67, 54, 0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(0, 0, 14, 0, Math.PI * 2);
  ctx.stroke();

  ctx.restore();
}

function drawEventEffect(evt, w, h) {
  if (evt.type === EVENT_TYPES.STORM) {
    // Storm overlay
    ctx.fillStyle = `rgba(100, 100, 255, ${0.05 + 0.03 * Math.sin(Date.now() / 200)})`;
    ctx.fillRect(0, 0, w, h);
    // Lightning flashes
    if (Math.random() < 0.02) {
      ctx.fillStyle = 'rgba(200, 200, 255, 0.15)';
      ctx.fillRect(0, 0, w, h);
    }
  } else if (evt.type === EVENT_TYPES.FIRE) {
    const b = getState().buildings.find(bb => bb.id === evt.target);
    if (b) {
      // Fire particles
      for (let i = 0; i < 5; i++) {
        const fx = b.x + (Math.random() - 0.5) * b.w;
        const fy = b.y + (Math.random() - 0.5) * b.h - Math.random() * 20;
        const fs = 2 + Math.random() * 4;
        ctx.fillStyle = `rgba(255, ${100 + Math.random() * 155}, 0, ${0.5 + Math.random() * 0.5})`;
        ctx.beginPath();
        ctx.arc(fx, fy, fs, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  } else if (evt.type === EVENT_TYPES.BREACH) {
    // Air leak lines
    ctx.strokeStyle = 'rgba(100, 200, 255, 0.3)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 8; i++) {
      const sx = 300 + Math.random() * 200;
      const sy = 250 + Math.random() * 150;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + (Math.random() - 0.5) * 60, sy + (Math.random() - 0.5) * 60);
      ctx.stroke();
    }
  } else if (evt.type === EVENT_TYPES.OVERLOAD) {
    // Electric arcs from reactor
    const reactor = getState().buildings.find(b => b.type === BUILDING_TYPES.REACTOR);
    if (reactor) {
      ctx.strokeStyle = 'rgba(255, 235, 59, 0.4)';
      ctx.lineWidth = 1;
      for (let i = 0; i < 3; i++) {
        const target = getState().buildings[Math.floor(Math.random() * getState().buildings.length)];
        ctx.beginPath();
        ctx.moveTo(reactor.x, reactor.y);
        const midX = (reactor.x + target.x) / 2 + (Math.random() - 0.5) * 40;
        const midY = (reactor.y + target.y) / 2 + (Math.random() - 0.5) * 40;
        ctx.quadraticCurveTo(midX, midY, target.x, target.y);
        ctx.stroke();
      }
    }
  }
}

window.VoidHarborRender = {
  initRenderer,
  resizeCanvas,
  render,
};
})();
