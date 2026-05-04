// Void Harbor - UI Management
// Handles DOM interactions, panel updates, button clicks
(() => {

const {
  getState,
  addLog,
  spendResource,
  saveGame,
  loadGame,
  clearSave,
  resetState,
  EVENT_TYPES,
} = window.VoidHarborState;
const { triggerEvent } = window.VoidHarborSystems;
const { initRenderer, resizeCanvas } = window.VoidHarborRender;

let audioCtx = null;

function initUI() {
  initRenderer(document.getElementById('game-canvas'));
  bindButtons();
  bindCanvasClick();
  window.addEventListener('resize', () => resizeCanvas());
  syncSaveButtons();
  updateUI();
}

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function playBeep(freq = 440, duration = 0.1, type = 'sine') {
  const s = getState();
  if (!s.audioEnabled) return;
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.value = 0.1;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.stop(ctx.currentTime + duration);
  } catch (e) { /* ignore audio errors */ }
}

function bindButtons() {
  // Start menu
  document.getElementById('btn-new-game').addEventListener('click', () => {
    const s = getState();
    s.phase = 'playing';
    s.paused = false;
    document.getElementById('start-menu').classList.add('hidden');
    addLog('Welcome to Void Harbor! Manage your space port.', 'info');
    playBeep(660, 0.2);
  });

  document.getElementById('btn-continue').addEventListener('click', () => {
    if (loadGame()) {
      const s = getState();
      s.phase = 'playing';
      s.paused = false;
      document.getElementById('start-menu').classList.add('hidden');
      playBeep(660, 0.2);
    }
  });

  document.getElementById('btn-clear-save-menu').addEventListener('click', () => {
    clearSave();
    syncSaveButtons();
    addLog('Save cleared.', 'info');
    playBeep(220, 0.12, 'triangle');
  });

  // Bottom bar buttons
  document.getElementById('btn-pause').addEventListener('click', () => {
    const s = getState();
    s.paused = !s.paused;
    document.getElementById('btn-pause').textContent = s.paused ? '▶ Resume' : '⏸ Pause';
    playBeep(330, 0.1);
  });

  document.getElementById('btn-speed1').addEventListener('click', () => { getState().speed = 1; updateSpeedButtons(); });
  document.getElementById('btn-speed2').addEventListener('click', () => { getState().speed = 2; updateSpeedButtons(); });
  document.getElementById('btn-speed3').addEventListener('click', () => { getState().speed = 3; updateSpeedButtons(); });

  document.getElementById('btn-save').addEventListener('click', () => {
    saveGame();
    syncSaveButtons();
    playBeep(550, 0.15);
  });
  document.getElementById('btn-clear-save').addEventListener('click', () => {
    clearSave();
    syncSaveButtons();
    addLog('Save cleared.', 'info');
    playBeep(220, 0.12, 'triangle');
  });
  document.getElementById('btn-restart').addEventListener('click', () => {
    if (confirm('Restart game? All progress will be lost.')) {
      resetState();
      const s = getState();
      s.phase = 'playing';
      s.paused = false;
      document.getElementById('start-menu').classList.add('hidden');
      document.getElementById('result-panel').classList.add('hidden');
      addLog('Game restarted.', 'info');
    }
  });

  document.getElementById('btn-sound').addEventListener('click', () => {
    const s = getState();
    s.audioEnabled = !s.audioEnabled;
    document.getElementById('btn-sound').textContent = s.audioEnabled ? '🔊' : '🔇';
  });

  // Debug panel toggle
  document.getElementById('debug-toggle').addEventListener('click', () => {
    const s = getState();
    s.showDebug = !s.showDebug;
    document.getElementById('debug-panel').classList.toggle('hidden', !s.showDebug);
  });

  // Debug event triggers
  document.getElementById('dbg-storm').addEventListener('click', () => { triggerEvent(EVENT_TYPES.STORM); playBeep(200, 0.3, 'sawtooth'); });
  document.getElementById('dbg-fire').addEventListener('click', () => { triggerEvent(EVENT_TYPES.FIRE); playBeep(300, 0.2, 'square'); });
  document.getElementById('dbg-pirate').addEventListener('click', () => { triggerEvent(EVENT_TYPES.PIRATE); playBeep(150, 0.3, 'sawtooth'); });
  document.getElementById('dbg-breach').addEventListener('click', () => { triggerEvent(EVENT_TYPES.BREACH); playBeep(250, 0.2, 'triangle'); });
  document.getElementById('dbg-overload').addEventListener('click', () => { triggerEvent(EVENT_TYPES.OVERLOAD); playBeep(180, 0.3, 'square'); });

  // Building panel buttons
  document.getElementById('btn-add-worker').addEventListener('click', () => {
    const s = getState();
    const b = s.buildings.find(bb => bb.id === s.selectedBuilding);
    if (b && s.idleWorkers > 0 && b.workers < b.maxWorkers) {
      b.workers++;
      s.idleWorkers--;
      playBeep(500, 0.1);
      updateBuildingPanel(b);
    }
  });

  document.getElementById('btn-remove-worker').addEventListener('click', () => {
    const s = getState();
    const b = s.buildings.find(bb => bb.id === s.selectedBuilding);
    if (b && b.workers > 0) {
      b.workers--;
      s.idleWorkers++;
      playBeep(400, 0.1);
      updateBuildingPanel(b);
    }
  });

  document.getElementById('btn-upgrade').addEventListener('click', () => {
    const s = getState();
    const b = s.buildings.find(bb => bb.id === s.selectedBuilding);
    if (b && !b.upgrading && b.level < 3) {
      const cost = b.level * 15;
      if (spendResource('cargo', cost)) {
        b.upgrading = true;
        b.upgradeProgress = 0;
        addLog(`Upgrading ${b.name}... (cost: ${cost} cargo)`, 'info');
        playBeep(600, 0.2);
      } else {
        addLog(`Not enough cargo to upgrade! Need ${cost}.`, 'warning');
      }
    }
  });

  document.getElementById('btn-repair').addEventListener('click', () => {
    const s = getState();
    const b = s.buildings.find(bb => bb.id === s.selectedBuilding);
    if (b && b.hp < b.maxHp) {
      const repairAmt = 20;
      if (spendResource('repairMaterials', repairAmt)) {
        b.hp = Math.min(b.maxHp, b.hp + 30);
        if (b.hp > 0) b.active = true;
        addLog(`Repaired ${b.name} (+30 HP)`, 'info');
        playBeep(700, 0.15);
        updateBuildingPanel(b);
      } else {
        addLog('Not enough repair materials!', 'warning');
      }
    }
  });

  document.getElementById('btn-close-panel').addEventListener('click', () => {
    getState().selectedBuilding = null;
    document.getElementById('building-panel').classList.add('hidden');
  });

  // Result panel
  document.getElementById('btn-result-restart').addEventListener('click', () => {
    resetState();
    const s = getState();
    s.phase = 'playing';
    s.paused = false;
    document.getElementById('result-panel').classList.add('hidden');
    document.getElementById('start-menu').classList.add('hidden');
    addLog('Game restarted.', 'info');
  });

  document.getElementById('btn-result-menu').addEventListener('click', () => {
    resetState();
    document.getElementById('result-panel').classList.add('hidden');
    document.getElementById('start-menu').classList.remove('hidden');
  });
}

function syncSaveButtons() {
  const s = getState();
  const hasSave = !!localStorage.getItem('void_harbor_save') || s.hasSave;
  const continueBtn = document.getElementById('btn-continue');
  const clearMenuBtn = document.getElementById('btn-clear-save-menu');
  if (continueBtn) continueBtn.style.display = hasSave ? '' : 'none';
  if (clearMenuBtn) clearMenuBtn.style.display = hasSave ? '' : 'none';
}

function bindCanvasClick() {
  const canvas = document.getElementById('game-canvas');
  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const s = getState();

    // Check building clicks
    for (const b of s.buildings) {
      if (mx >= b.x - b.w / 2 && mx <= b.x + b.w / 2 &&
          my >= b.y - b.h / 2 && my <= b.y + b.h / 2) {
        s.selectedBuilding = b.id;
        updateBuildingPanel(b);
        document.getElementById('building-panel').classList.remove('hidden');
        playBeep(440, 0.05);
        return;
      }
    }
    // Click empty space = deselect
    s.selectedBuilding = null;
    document.getElementById('building-panel').classList.add('hidden');
  });
}

function updateBuildingPanel(b) {
  document.getElementById('bp-name').textContent = b.name;
  document.getElementById('bp-type').textContent = b.type;
  document.getElementById('bp-level').textContent = b.level;
  document.getElementById('bp-hp').textContent = `${Math.round(b.hp)}/${b.maxHp}`;
  document.getElementById('bp-workers').textContent = `${b.workers}/${b.maxWorkers}`;
  document.getElementById('bp-status').textContent = b.hp <= 0 ? 'DESTROYED' : (b.active ? 'Online' : 'Offline');
  document.getElementById('bp-status').className = b.hp <= 0 ? 'status-destroyed' : (b.active ? 'status-online' : 'status-offline');

  const upgradeCost = b.level * 15;
  document.getElementById('btn-upgrade').textContent = b.upgrading ? `Upgrading... ${Math.round(b.upgradeProgress * 10)}%` : (b.level >= 3 ? 'MAX LEVEL' : `Upgrade (${upgradeCost} cargo)`);
  document.getElementById('btn-upgrade').disabled = b.upgrading || b.level >= 3;
}

function updateSpeedButtons() {
  const s = getState();
  document.getElementById('btn-speed1').classList.toggle('active', s.speed === 1);
  document.getElementById('btn-speed2').classList.toggle('active', s.speed === 2);
  document.getElementById('btn-speed3').classList.toggle('active', s.speed === 3);
}

function updateUI() {
  const s = getState();

  // Resource bar
  document.getElementById('res-power').textContent = `${Math.round(s.resources.power)}/${s.resources.maxPower}`;
  document.getElementById('res-oxygen').textContent = `${Math.round(s.resources.oxygen)}/${s.resources.maxOxygen}`;
  document.getElementById('res-fuel').textContent = `${Math.round(s.resources.fuel)}/${s.resources.maxFuel}`;
  document.getElementById('res-cargo').textContent = `${Math.round(s.resources.cargo)}/${s.resources.maxCargo}`;
  document.getElementById('res-repair').textContent = `${Math.round(s.resources.repairMaterials)}/${s.resources.maxRepair}`;
  document.getElementById('res-morale').textContent = `${Math.round(s.resources.morale)}`;
  document.getElementById('res-reputation').textContent = `${Math.round(s.reputation)}`;
  document.getElementById('res-supplies').textContent = `${s.supplyCompletions}/6`;
  document.getElementById('res-workers').textContent = `${s.totalWorkers} (${s.idleWorkers} idle)`;

  // Resource warnings
  setWarning('res-power', s.resources.power < 20);
  setWarning('res-oxygen', s.resources.oxygen < 25);
  setWarning('res-morale', s.resources.morale < 30);

  // Time
  const remaining = Math.max(0, s.maxGameTime - s.gameTime);
  const min = Math.floor(remaining / 60);
  const sec = Math.floor(remaining % 60);
  document.getElementById('game-time').textContent = `${min}:${sec.toString().padStart(2, '0')}`;

  // Building list (left panel)
  const buildingList = document.getElementById('building-list');
  buildingList.innerHTML = '';
  for (const b of s.buildings) {
    const div = document.createElement('div');
    div.className = 'building-item' + (b.id === s.selectedBuilding ? ' selected' : '');
    div.innerHTML = `
      <span class="bi-name">${b.name}</span>
      <span class="bi-hp ${b.hp <= 0 ? 'hp-dead' : b.hp < b.maxHp * 0.3 ? 'hp-low' : ''}">${Math.round(b.hp)}</span>
      <span class="bi-status ${b.active ? '' : 'offline'}">${b.hp <= 0 ? '✕' : b.active ? '●' : '○'}</span>
    `;
    div.addEventListener('click', () => {
      s.selectedBuilding = b.id;
      updateBuildingPanel(b);
      document.getElementById('building-panel').classList.remove('hidden');
    });
    buildingList.appendChild(div);
  }

  // Ship list
  const shipList = document.getElementById('ship-list');
  shipList.innerHTML = '';
  for (const ship of s.ships) {
    const div = document.createElement('div');
    div.className = 'ship-item';
    div.innerHTML = `<span style="color:${ship.type.color}">${ship.type.name}</span> <span class="ship-state">${ship.state}</span>`;
    shipList.appendChild(div);
  }

  // Event log
  const logEl = document.getElementById('event-log');
  logEl.innerHTML = '';
  for (const entry of s.log.slice(0, 20)) {
    const div = document.createElement('div');
    div.className = `log-entry log-${entry.severity}`;
    div.textContent = entry.message;
    logEl.appendChild(div);
  }

  // Building panel (if selected)
  if (s.selectedBuilding) {
    const b = s.buildings.find(bb => bb.id === s.selectedBuilding);
    if (b) updateBuildingPanel(b);
  }

  // Debug panel
  if (s.showDebug) {
    document.getElementById('dbg-tick').textContent = s.tick;
    document.getElementById('dbg-entities').textContent = `Buildings:${s.buildings.length} Ships:${s.ships.length} Pirates:${s.pirates.length}`;
    document.getElementById('dbg-events').textContent = s.activeEvents.map(e => `${e.type}(${Math.round(e.duration)}s)`).join(', ') || 'None';
    document.getElementById('dbg-fps').textContent = s.fps;
  }

  // Result panel
  if (s.phase === 'won' || s.phase === 'lost') {
    const rp = document.getElementById('result-panel');
    rp.classList.remove('hidden');
    document.getElementById('result-title').textContent = s.phase === 'won' ? '🎉 VICTORY!' : '💀 GAME OVER';
    document.getElementById('result-title').className = s.phase === 'won' ? 'result-win' : 'result-lose';
    document.getElementById('result-stats').innerHTML = `
      <p>Supplies completed: ${s.supplyCompletions}/6</p>
      <p>Final reputation: ${Math.round(s.reputation)}</p>
      <p>Time elapsed: ${Math.floor(s.gameTime / 60)}m ${Math.floor(s.gameTime % 60)}s</p>
      <p>Buildings remaining: ${s.buildings.filter(b => b.hp > 0).length}/${s.buildings.length}</p>
    `;
  }
}

function setWarning(id, show) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('warning', show);
}

window.VoidHarborUI = {
  initUI,
  updateUI,
  playBeep,
};
})();
