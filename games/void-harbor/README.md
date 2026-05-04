# Void Harbor

A single-page browser game: top-down space port management + fleet tactics + disaster emergency.

## How to Run

1. Open `index.html` directly in a browser, or start a small static server from this repository root:
   ```bash
   python3 -m http.server 8099 --directory games/void-harbor
   ```
2. If you use the server, open `http://127.0.0.1:8099/` in a modern browser.
3. No build tools, no backend, no external assets, and no runtime dependencies are required.

## Gameplay

### Objective
Complete **6 fleet supply operations** and maintain **reputation ≥ 60** within 20 minutes.

### Controls
- **Click buildings** on canvas to inspect, assign workers, upgrade, or repair.
- **Bottom bar**: Pause/Resume, Speed (1x/2x/3x), Save, Restart, Sound toggle.
- **Save controls**: Save the current run, continue from localStorage, or clear the saved run.
- **Debug panel** (🐛 button): Shows tick, entities, events, FPS. Provides buttons to manually trigger disasters.

### Resources
| Resource | Description |
|----------|-------------|
| ⚡ Power | Produced by Reactor. Powers all buildings and defenses. |
| 💨 Oxygen | Produced by Life Support. Consumed by population. |
| ⛽ Fuel | Supplied by Tanker ships. Required to fuel departing ships. |
| 📦 Cargo | Loaded onto Freighter ships. Also used for upgrades. |
| 🔧 Repair | Delivered by Repair Ships. Used to fix damaged buildings. |
| 😊 Morale | Drops when resources low or disasters hit. Game over at 0. |
| ⭐ Reputation | Grows on successful supplies, drops when ships leave angry. |

### Buildings
| Building | Function |
|----------|----------|
| ⚛ Core Reactor | Generates power. If destroyed = game over. |
| 🚀 Dock (×3) | Ships dock here for servicing. |
| ⛽ Fuel Tank (×2) | Stores fuel. |
| 📦 Cargo Bay | Stores cargo. |
| 🔧 Repair Yard | Stores repair materials. |
| 🔫 Defense Turret (×2) | Shoots pirate drones. Consumes power. |
| 💨 Life Support | Produces oxygen. Consumes power. |

### Ships
| Ship | Needs |
|------|-------|
| Freighter | Needs fuel, loads cargo |
| Tanker | Delivers fuel |
| Repair Ship | Delivers repair materials |

### Disasters
- **Space Storm**: Damages random buildings, drains power.
- **Fire**: Continuously damages a specific building.
- **Pirate Drones**: Fly in and attack buildings. Turrets can shoot them down.
- **Hull Breach**: Rapidly depletes oxygen.
- **Power Overload**: Random buildings go offline temporarily.

### Win/Lose Conditions
- **Win**: 6 supply completions + reputation ≥ 60.
- **Lose**: Reactor destroyed, morale = 0, reputation < 20, or time runs out without winning.

## File Structure

```
games/void-harbor/
├── index.html          # Main HTML with UI layout
├── styles.css          # All styling
├── README.md           # This file
└── src/
    ├── game.js         # Game loop, main entry point
    ├── state.js        # Central state management, save/load
    ├── render.js       # Canvas rendering (buildings, ships, effects)
    ├── systems.js      # Game systems (resources, ships, disasters, combat)
    └── ui.js           # UI interactions, button bindings, DOM updates
```

## Architecture

- **state.js**: Single source of truth. All game state lives here. Other modules import getter/setter functions.
- **systems.js**: Pure game logic. Resource production/consumption, ship AI, disaster events, combat resolution, win/lose checks.
- **render.js**: Canvas drawing. Reads state and renders buildings, ships, pirates, visual effects. No state mutation.
- **ui.js**: DOM event handling. Button clicks, canvas clicks, panel updates. Bridges user input to state changes.
- **game.js**: Main loop. Calls `gameTick()` then `render()` then `updateUI()` on each frame.

## Verified

- [x] JS syntax valid
- [x] Local static server returns `index.html` and script files
- [x] Direct `file://` opening works because scripts use classic ordered loading
- [x] Browser opens and displays the start menu
- [x] Clicking "New Game" starts simulation and hides the start menu
- [x] Debug panel opens and triggers storm plus pirate events
- [x] Save and clear-save actions write/remove localStorage
- [x] Console has no runtime exceptions during the smoke path above

## Known Limitations

- Canvas size adapts to window but building positions are fixed (not scaled).
- Ship service progress is simplified (no partial cargo visualization).
- Sound is basic WebAudio beeps (no music or complex SFX).
- No tutorial or onboarding beyond the start menu instructions.
- Mobile layout is functional but not optimized for touch.
