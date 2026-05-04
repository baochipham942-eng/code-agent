// Void Harbor - Central State Management
// All game state lives here. Other modules read/write through exported functions.
(() => {

const BUILDING_TYPES = {
  REACTOR: 'reactor',
  DOCK: 'dock',
  FUEL_TANK: 'fuel_tank',
  CARGO_BAY: 'cargo_bay',
  REPAIR_YARD: 'repair_yard',
  DEFENSE_TURRET: 'defense_turret',
  LIFE_SUPPORT: 'life_support',
};

const SHIP_TYPES = {
  FREIGHTER: { name: 'Freighter', color: '#4fc3f7', speed: 0.8, patience: 60, fuelNeed: 30, cargoAmount: 20, repairNeed: 0 },
  TANKER: { name: 'Tanker', color: '#ffb74d', speed: 0.6, patience: 45, fuelNeed: 0, cargoAmount: 0, repairNeed: 0, deliversFuel: 40 },
  REPAIR_SHIP: { name: 'Repair Ship', color: '#81c784', speed: 0.5, patience: 50, fuelNeed: 15, cargoAmount: 0, repairNeed: 0, deliversRepair: 25 },
};

const EVENT_TYPES = {
  STORM: 'storm',
  FIRE: 'fire',
  PIRATE: 'pirate',
  BREACH: 'breach',
  OVERLOAD: 'overload',
};

function createDefaultBuildings() {
  return [
    { id: 'reactor', type: BUILDING_TYPES.REACTOR, name: 'Core Reactor', x: 400, y: 300, w: 80, h: 80, hp: 100, maxHp: 100, level: 1, workers: 3, maxWorkers: 5, powerOutput: 50, active: true, upgrading: false, upgradeProgress: 0 },
    { id: 'dock1', type: BUILDING_TYPES.DOCK, name: 'Dock Alpha', x: 200, y: 150, w: 70, h: 50, hp: 80, maxHp: 80, level: 1, workers: 2, maxWorkers: 4, active: true, dockedShip: null, queue: [], upgrading: false, upgradeProgress: 0 },
    { id: 'dock2', type: BUILDING_TYPES.DOCK, name: 'Dock Beta', x: 600, y: 150, w: 70, h: 50, hp: 80, maxHp: 80, level: 1, workers: 2, maxWorkers: 4, active: true, dockedShip: null, queue: [], upgrading: false, upgradeProgress: 0 },
    { id: 'dock3', type: BUILDING_TYPES.DOCK, name: 'Dock Gamma', x: 400, y: 80, w: 70, h: 50, hp: 80, maxHp: 80, level: 1, workers: 1, maxWorkers: 4, active: true, dockedShip: null, queue: [], upgrading: false, upgradeProgress: 0 },
    { id: 'fuel1', type: BUILDING_TYPES.FUEL_TANK, name: 'Fuel Tank A', x: 150, y: 400, w: 60, h: 60, hp: 70, maxHp: 70, level: 1, workers: 1, maxWorkers: 3, active: true, upgrading: false, upgradeProgress: 0 },
    { id: 'fuel2', type: BUILDING_TYPES.FUEL_TANK, name: 'Fuel Tank B', x: 650, y: 400, w: 60, h: 60, hp: 70, maxHp: 70, level: 1, workers: 1, maxWorkers: 3, active: true, upgrading: false, upgradeProgress: 0 },
    { id: 'cargo1', type: BUILDING_TYPES.CARGO_BAY, name: 'Cargo Bay', x: 300, y: 480, w: 70, h: 60, hp: 75, maxHp: 75, level: 1, workers: 2, maxWorkers: 4, active: true, upgrading: false, upgradeProgress: 0 },
    { id: 'repair1', type: BUILDING_TYPES.REPAIR_YARD, name: 'Repair Yard', x: 500, y: 480, w: 70, h: 60, hp: 75, maxHp: 75, level: 1, workers: 2, maxWorkers: 4, active: true, upgrading: false, upgradeProgress: 0 },
    { id: 'turret1', type: BUILDING_TYPES.DEFENSE_TURRET, name: 'Turret North', x: 400, y: 200, w: 40, h: 40, hp: 60, maxHp: 60, level: 1, workers: 1, maxWorkers: 2, active: true, range: 150, damage: 5, upgrading: false, upgradeProgress: 0 },
    { id: 'turret2', type: BUILDING_TYPES.DEFENSE_TURRET, name: 'Turret South', x: 400, y: 500, w: 40, h: 40, hp: 60, maxHp: 60, level: 1, workers: 1, maxWorkers: 2, active: true, range: 150, damage: 5, upgrading: false, upgradeProgress: 0 },
    { id: 'life1', type: BUILDING_TYPES.LIFE_SUPPORT, name: 'Life Support', x: 300, y: 300, w: 50, h: 50, hp: 80, maxHp: 80, level: 1, workers: 2, maxWorkers: 3, active: true, upgrading: false, upgradeProgress: 0 },
  ];
}

function createInitialState() {
  return {
    tick: 0,
    gameTime: 0,          // seconds of game time elapsed
    maxGameTime: 20 * 60,  // 20 minutes
    paused: true,
    speed: 1,              // 1x, 2x, 3x
    phase: 'menu',         // menu | playing | won | lost

    resources: {
      power: 100,
      maxPower: 200,
      oxygen: 100,
      maxOxygen: 150,
      fuel: 80,
      maxFuel: 200,
      cargo: 50,
      maxCargo: 150,
      repairMaterials: 40,
      maxRepair: 100,
      population: 20,
      morale: 80,          // 0-100
    },

    reputation: 50,        // 0-100
    supplyCompletions: 0,  // need 6 to win
    totalWorkers: 20,
    idleWorkers: 2,

    buildings: createDefaultBuildings(),

    ships: [],             // active ships in the system
    shipIdCounter: 0,
    nextShipTimer: 15,     // seconds until next ship arrives

    activeEvents: [],      // currently active disaster events
    eventQueue: [],        // upcoming events
    nextEventTimer: 20,    // seconds until next random event

    projectiles: [],       // turret projectiles
    pirates: [],           // pirate drones

    log: [],               // event log entries
    maxLogEntries: 50,

    selectedBuilding: null,
    showDebug: false,

    // audio
    audioEnabled: true,

    // stats
    fps: 0,
    frameCount: 0,
    fpsTimer: 0,

    // save
    hasSave: !!localStorage.getItem('void_harbor_save'),
  };
}

let state = createInitialState();

function getState() { return state; }

function setState(newState) { state = newState; }

function resetState() {
  state = createInitialState();
  return state;
}

function addLog(message, severity = 'info') {
  state.log.unshift({ message, severity, time: state.gameTime });
  if (state.log.length > state.maxLogEntries) state.log.pop();
}

function spendResource(type, amount) {
  if (state.resources[type] >= amount) {
    state.resources[type] -= amount;
    return true;
  }
  return false;
}

function addResource(type, amount) {
  state.resources[type] = Math.min(state.resources[type] + amount, state.resources['max' + type.charAt(0).toUpperCase() + type.slice(1)] || 999);
}

function changeMorale(amount) {
  state.resources.morale = Math.max(0, Math.min(100, state.resources.morale + amount));
}

function changeReputation(amount) {
  state.reputation = Math.max(0, Math.min(100, state.reputation + amount));
}

// Save / Load
function saveGame() {
  const data = JSON.parse(JSON.stringify(state));
  data.phase = 'playing';
  data.paused = true;
  localStorage.setItem('void_harbor_save', JSON.stringify(data));
  state.hasSave = true;
  addLog('Game saved.', 'info');
}

function loadGame() {
  const raw = localStorage.getItem('void_harbor_save');
  if (!raw) return false;
  try {
    const data = JSON.parse(raw);
    state = data;
    state.paused = true;
    state.hasSave = true;
    addLog('Game loaded.', 'info');
    return true;
  } catch {
    return false;
  }
}

function clearSave() {
  localStorage.removeItem('void_harbor_save');
  state.hasSave = false;
}

window.VoidHarborState = {
  BUILDING_TYPES,
  SHIP_TYPES,
  EVENT_TYPES,
  createInitialState,
  getState,
  setState,
  resetState,
  addLog,
  spendResource,
  addResource,
  changeMorale,
  changeReputation,
  saveGame,
  loadGame,
  clearSave,
};
})();
