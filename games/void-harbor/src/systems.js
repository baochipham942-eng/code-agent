// Void Harbor - Game Systems
// Resource simulation, ship logic, disaster events, combat
(() => {

const {
  getState,
  addLog,
  changeMorale,
  changeReputation,
  BUILDING_TYPES,
  SHIP_TYPES,
  EVENT_TYPES,
} = window.VoidHarborState;

// ─── Resource Production/Consumption per tick (1 tick = ~1s at 1x) ───
function tickResources(dt) {
  const s = getState();
  const r = s.resources;

  // Reactor produces power
  const reactor = s.buildings.find(b => b.type === BUILDING_TYPES.REACTOR);
  if (reactor && reactor.active && reactor.hp > 0) {
    const powerGen = reactor.powerOutput * reactor.level * (reactor.workers / 3) * dt;
    r.power = Math.min(r.power + powerGen, r.maxPower);
  } else {
    // No reactor = slow power drain
    r.power = Math.max(0, r.power - 5 * dt);
  }

  // Life support consumes power, produces oxygen
  const lifeSupport = s.buildings.filter(b => b.type === BUILDING_TYPES.LIFE_SUPPORT);
  for (const ls of lifeSupport) {
    if (ls.active && ls.hp > 0 && r.power > 0) {
      r.power -= 3 * dt;
      r.oxygen = Math.min(r.oxygen + 2 * ls.level * dt, r.maxOxygen);
    }
  }

  // Oxygen consumption by population
  r.oxygen = Math.max(0, r.oxygen - (r.population * 0.05) * dt);

  // Morale effects
  if (r.oxygen < 20) changeMorale(-2 * dt);
  if (r.power < 10) changeMorale(-1 * dt);
  if (r.oxygen > 50 && r.power > 30) changeMorale(0.2 * dt);

  // Clamp
  r.power = Math.max(0, Math.min(r.power, r.maxPower));
  r.oxygen = Math.max(0, Math.min(r.oxygen, r.maxOxygen));
  r.fuel = Math.max(0, Math.min(r.fuel, r.maxFuel));
  r.cargo = Math.max(0, Math.min(r.cargo, r.maxCargo));
  r.repairMaterials = Math.max(0, Math.min(r.repairMaterials, r.maxRepair));
}

// ─── Ship System ───
function tickShips(dt) {
  const s = getState();

  // Spawn new ships
  s.nextShipTimer -= dt;
  if (s.nextShipTimer <= 0) {
    spawnShip();
    s.nextShipTimer = 12 + Math.random() * 18; // 12-30 seconds
  }

  // Update each ship
  for (let i = s.ships.length - 1; i >= 0; i--) {
    const ship = s.ships[i];

    if (ship.state === 'approaching') {
      // Move toward target dock
      const dock = s.buildings.find(b => b.id === ship.targetDock);
      if (dock) {
        const dx = dock.x - ship.x;
        const dy = dock.y - ship.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 5) {
          ship.x = dock.x;
          ship.y = dock.y;
          ship.state = 'docking';
          ship.dockTimer = 2; // 2 seconds to dock
        } else {
          ship.x += (dx / dist) * ship.type.speed * 60 * dt;
          ship.y += (dy / dist) * ship.type.speed * 60 * dt;
        }
      }
    } else if (ship.state === 'docking') {
      ship.dockTimer -= dt;
      if (ship.dockTimer <= 0) {
        ship.state = 'servicing';
        const dock = s.buildings.find(b => b.id === ship.targetDock);
        if (dock) dock.dockedShip = ship.id;
        addLog(`${ship.type.name} ${ship.id} docked at ${ship.targetDock}`, 'info');
      }
    } else if (ship.state === 'servicing') {
      // Service the ship based on its needs
      const dock = s.buildings.find(b => b.id === ship.targetDock);
      const serviceRate = dock ? (dock.workers * 0.5) : 0.5;

      if (ship.type.fuelNeed > 0 && ship.fueled < ship.type.fuelNeed) {
        const take = Math.min(serviceRate * dt, ship.type.fuelNeed - ship.fueled, s.resources.fuel);
        if (take > 0) {
          s.resources.fuel -= take;
          ship.fueled += take;
        }
      }
      if (ship.type.deliversFuel && ship.unloaded < ship.type.deliversFuel) {
        const give = Math.min(serviceRate * dt, ship.type.deliversFuel - ship.unloaded);
        s.resources.fuel = Math.min(s.resources.fuel + give, s.resources.maxFuel);
        ship.unloaded += give;
      }
      if (ship.type.deliversRepair && ship.unloaded < ship.type.deliversRepair) {
        const give = Math.min(serviceRate * dt, ship.type.deliversRepair - ship.unloaded);
        s.resources.repairMaterials = Math.min(s.resources.repairMaterials + give, s.resources.maxRepair);
        ship.unloaded += give;
      }
      if (ship.type.cargoAmount > 0 && ship.cargoLoaded < ship.type.cargoAmount) {
        const load = Math.min(serviceRate * dt, ship.type.cargoAmount - ship.cargoLoaded, s.resources.cargo);
        if (load > 0) {
          s.resources.cargo -= load;
          ship.cargoLoaded += load;
        }
      }

      // Check if service complete
      const fuelDone = ship.type.fuelNeed === 0 || ship.fueled >= ship.type.fuelNeed;
      const cargoDone = ship.type.cargoAmount === 0 || ship.cargoLoaded >= ship.type.cargoAmount;
      const deliverDone = (!ship.type.deliversFuel || ship.unloaded >= ship.type.deliversFuel)
                       && (!ship.type.deliversRepair || ship.unloaded >= ship.type.deliversRepair);

      if (fuelDone && cargoDone && deliverDone) {
        ship.state = 'departing';
        s.supplyCompletions++;
        changeReputation(5);
        addLog(`${ship.type.name} ${ship.id} service complete! (${s.supplyCompletions}/6 supplies)`, 'success');
        const dock = s.buildings.find(b => b.id === ship.targetDock);
        if (dock) dock.dockedShip = null;
      }

      // Patience countdown
      ship.patience -= dt;
      if (ship.patience <= 0) {
        ship.state = 'leaving';
        changeReputation(-8);
        changeMorale(-3);
        addLog(`${ship.type.name} ${ship.id} left due to long wait! Rep -8`, 'warning');
        const dock = s.buildings.find(b => b.id === ship.targetDock);
        if (dock) dock.dockedShip = null;
      }
    } else if (ship.state === 'departing') {
      ship.y -= ship.type.speed * 80 * dt;
      if (ship.y < -50) {
        s.ships.splice(i, 1);
      }
    } else if (ship.state === 'leaving') {
      ship.y -= ship.type.speed * 100 * dt;
      ship.x += (Math.random() - 0.5) * 2;
      if (ship.y < -50 || ship.y > 700) {
        s.ships.splice(i, 1);
      }
    }
  }
}

function spawnShip() {
  const s = getState();
  const types = Object.values(SHIP_TYPES);
  const type = types[Math.floor(Math.random() * types.length)];

  // Find available dock
  const availableDocks = s.buildings.filter(b => b.type === BUILDING_TYPES.DOCK && !b.dockedShip && b.hp > 0);
  if (availableDocks.length === 0) {
    addLog(`${type.name} arrived but no docks available!`, 'warning');
    changeReputation(-2);
    return;
  }

  const dock = availableDocks[Math.floor(Math.random() * availableDocks.length)];
  const ship = {
    id: 'ship_' + (++s.shipIdCounter),
    type,
    x: dock.x + (Math.random() - 0.5) * 100,
    y: -30,
    state: 'approaching',
    targetDock: dock.id,
    patience: type.patience,
    fueled: 0,
    cargoLoaded: 0,
    unloaded: 0,
    dockTimer: 0,
  };
  s.ships.push(ship);
  addLog(`${type.name} ${ship.id} approaching ${dock.name}`, 'info');
}

// ─── Disaster Events ───
function tickEvents(dt) {
  const s = getState();

  s.nextEventTimer -= dt;
  if (s.nextEventTimer <= 0) {
    triggerRandomEvent();
    s.nextEventTimer = 25 + Math.random() * 35; // 25-60 seconds
  }

  // Update active events
  for (let i = s.activeEvents.length - 1; i >= 0; i--) {
    const evt = s.activeEvents[i];
    evt.duration -= dt;

    if (evt.type === EVENT_TYPES.STORM) {
      // Storm damages random buildings
      evt.tickTimer = (evt.tickTimer || 0) + dt;
      if (evt.tickTimer >= 2) {
        evt.tickTimer = 0;
        const b = s.buildings[Math.floor(Math.random() * s.buildings.length)];
        if (b) {
          const dmg = 3 + Math.random() * 5;
          b.hp = Math.max(0, b.hp - dmg);
          if (b.hp <= 0) b.active = false;
        }
        // Drain power
        s.resources.power = Math.max(0, s.resources.power - 3);
      }
    } else if (evt.type === EVENT_TYPES.FIRE) {
      evt.tickTimer = (evt.tickTimer || 0) + dt;
      if (evt.tickTimer >= 1.5) {
        evt.tickTimer = 0;
        const b = s.buildings.find(b => b.id === evt.target);
        if (b) {
          b.hp = Math.max(0, b.hp - 4);
          if (b.hp <= 0) b.active = false;
        }
      }
    } else if (evt.type === EVENT_TYPES.BREACH) {
      evt.tickTimer = (evt.tickTimer || 0) + dt;
      if (evt.tickTimer >= 2) {
        evt.tickTimer = 0;
        s.resources.oxygen = Math.max(0, s.resources.oxygen - 5);
      }
    } else if (evt.type === EVENT_TYPES.OVERLOAD) {
      evt.tickTimer = (evt.tickTimer || 0) + dt;
      if (evt.tickTimer >= 3) {
        evt.tickTimer = 0;
        // Random building goes offline
        const b = s.buildings.filter(b => b.active)[Math.floor(Math.random() * s.buildings.filter(b => b.active).length)];
        if (b && b.type !== BUILDING_TYPES.REACTOR) {
          b.active = false;
          b.reactivateTimer = 5; // 5 seconds to reactivate
          addLog(`${b.name} went offline due to power overload!`, 'warning');
        }
      }
    }

    if (evt.duration <= 0) {
      s.activeEvents.splice(i, 1);
      addLog(`${evt.type} event ended.`, 'info');
    }
  }

  // Update pirates
  for (let i = s.pirates.length - 1; i >= 0; i--) {
    const p = s.pirates[i];
    if (!p.target) {
      // Pick a random building to attack
      p.target = s.buildings[Math.floor(Math.random() * s.buildings.length)];
    }
    const dx = p.target.x - p.x;
    const dy = p.target.y - p.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 20) {
      // Attack building
      p.target.hp = Math.max(0, p.target.hp - 2 * dt);
      if (p.target.hp <= 0) p.target.active = false;
      p.hp -= 0.5 * dt; // self damage
    } else {
      p.x += (dx / dist) * 40 * dt;
      p.y += (dy / dist) * 40 * dt;
    }

    // Turrets shoot pirates
    const turrets = s.buildings.filter(b => b.type === BUILDING_TYPES.DEFENSE_TURRET && b.active && b.hp > 0);
    for (const t of turrets) {
      const tdx = p.x - t.x;
      const tdy = p.y - t.y;
      const tdist = Math.sqrt(tdx * tdx + tdy * tdy);
      if (tdist < t.range) {
        p.hp -= t.damage * dt * (t.workers / 2);
        s.resources.power -= 1 * dt; // turrets consume power
      }
    }

    if (p.hp <= 0) {
      s.pirates.splice(i, 1);
      addLog('Pirate drone destroyed!', 'success');
      changeReputation(2);
    }
  }
}

function triggerRandomEvent() {
  const s = getState();
  const events = [EVENT_TYPES.STORM, EVENT_TYPES.FIRE, EVENT_TYPES.PIRATE, EVENT_TYPES.BREACH, EVENT_TYPES.OVERLOAD];
  const type = events[Math.floor(Math.random() * events.length)];
  triggerEvent(type);
}

function triggerEvent(type) {
  const s = getState();

  switch (type) {
    case EVENT_TYPES.STORM:
      s.activeEvents.push({ type, duration: 15 + Math.random() * 10, tickTimer: 0 });
      addLog('⚠ Space storm approaching! Buildings taking damage!', 'danger');
      changeMorale(-5);
      break;
    case EVENT_TYPES.FIRE: {
      const target = s.buildings[Math.floor(Math.random() * s.buildings.length)];
      s.activeEvents.push({ type, duration: 10, target: target.id, tickTimer: 0 });
      addLog(`🔥 Fire at ${target.name}! Send repair crews!`, 'danger');
      changeMorale(-3);
      break;
    }
    case EVENT_TYPES.PIRATE: {
      const count = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < count; i++) {
        s.pirates.push({
          x: Math.random() > 0.5 ? -20 : 820,
          y: 100 + Math.random() * 400,
          hp: 20 + Math.random() * 15,
          maxHp: 35,
          target: null,
        });
      }
      addLog(`🏴‍☠️ ${count} pirate drone(s) detected!`, 'danger');
      changeMorale(-4);
      break;
    }
    case EVENT_TYPES.BREACH:
      s.activeEvents.push({ type, duration: 8, tickTimer: 0 });
      addLog('💥 Hull breach detected! Oxygen depleting!', 'danger');
      changeMorale(-6);
      break;
    case EVENT_TYPES.OVERLOAD:
      s.activeEvents.push({ type, duration: 12, tickTimer: 0 });
      addLog('⚡ Power overload! Buildings going offline!', 'danger');
      break;
  }
}

// ─── Building Repair ───
function tickBuildingRepair(dt) {
  const s = getState();
  for (const b of s.buildings) {
    // Reactivation timer for buildings taken offline by overload
    if (!b.active && b.reactivateTimer > 0 && b.hp > 0) {
      b.reactivateTimer -= dt;
      if (b.reactivateTimer <= 0) {
        b.active = true;
        b.reactivateTimer = 0;
        addLog(`${b.name} back online.`, 'info');
      }
    }

    if (b.hp < b.maxHp && b.hp > 0) {
      // Auto-repair slowly if workers present
      const repairRate = b.workers * 0.3 * dt;
      const repairMat = Math.min(repairRate, s.resources.repairMaterials);
      if (repairMat > 0) {
        s.resources.repairMaterials -= repairMat;
        b.hp = Math.min(b.maxHp, b.hp + repairMat);
      }
    }
    // Upgrade progress
    if (b.upgrading) {
      b.upgradeProgress += dt * 0.5;
      if (b.upgradeProgress >= 10) {
        b.upgrading = false;
        b.upgradeProgress = 0;
        b.level++;
        b.maxHp += 20;
        b.hp = b.maxHp;
        b.maxWorkers++;
        addLog(`${b.name} upgraded to level ${b.level}!`, 'success');
      }
    }
  }
}

// ─── Check Win/Lose ───
function checkWinLose() {
  const s = getState();

  // Win: 6 supply completions + reputation >= 60
  if (s.supplyCompletions >= 6 && s.reputation >= 60) {
    s.phase = 'won';
    s.paused = true;
    addLog('🎉 Victory! The Void Harbor thrives!', 'success');
    return;
  }

  // Lose conditions
  const reactor = s.buildings.find(b => b.type === BUILDING_TYPES.REACTOR);
  if (reactor && reactor.hp <= 0) {
    s.phase = 'lost';
    s.paused = true;
    addLog('💀 Reactor destroyed. Game Over.', 'danger');
    return;
  }
  if (s.resources.morale <= 0) {
    s.phase = 'lost';
    s.paused = true;
    addLog('💀 Morale collapsed. Game Over.', 'danger');
    return;
  }
  if (s.reputation < 20) {
    s.phase = 'lost';
    s.paused = true;
    addLog('💀 Reputation too low. Game Over.', 'danger');
    return;
  }

  // Time runs out
  if (s.gameTime >= s.maxGameTime) {
    if (s.supplyCompletions >= 6 && s.reputation >= 60) {
      s.phase = 'won';
    } else {
      s.phase = 'lost';
      addLog('💀 Time ran out. Game Over.', 'danger');
    }
    s.paused = true;
  }
}

// ─── Main Tick ───
function gameTick(dt) {
  const s = getState();
  if (s.paused || s.phase !== 'playing') return;

  const scaledDt = dt * s.speed;
  s.gameTime += scaledDt;
  s.tick++;

  tickResources(scaledDt);
  tickShips(scaledDt);
  tickEvents(scaledDt);
  tickBuildingRepair(scaledDt);
  checkWinLose();
}

window.VoidHarborSystems = {
  tickResources,
  tickShips,
  tickEvents,
  triggerEvent,
  tickBuildingRepair,
  checkWinLose,
  gameTick,
};
})();
