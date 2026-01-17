# Minesweeper Game

A classic Minesweeper game built with HTML, CSS, and JavaScript. Features multiple difficulty levels, hints, and a clean, modern interface.

## Features

- 🎮 **Classic Minesweeper gameplay** with all original rules
- 📊 **Three difficulty levels**: Easy (9×9, 10 mines), Medium (16×16, 40 mines), Hard (16×30, 99 mines)
- 🚩 **Flag placement** with right-click
- 💡 **Hint system** to help when stuck
- ⏱️ **Timer** to track your progress
- 🎯 **Double-click chord reveal** for experienced players
- 📱 **Responsive design** that works on desktop and mobile
- 🎨 **Modern UI** with smooth animations and visual feedback

## How to Play

1. **Left-click** a cell to reveal it
2. **Right-click** a cell to place or remove a flag
3. **Double-click** on revealed numbers to reveal adjacent cells (if enough flags are placed)
4. **Reveal all non-mine cells** to win the game
5. **Avoid mines** - clicking on a mine ends the game

## Installation

1. Clone or download this repository
2. Navigate to the minesweeper directory:
   ```bash
   cd minesweeper
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Start the development server:
   ```bash
   npm run dev
   ```
5. Open your browser and go to `http://localhost:5173`

## Build for Production

```bash
npm run build
```

The built files will be in the `dist` directory.

## Project Structure

```
minesweeper/
├── public/
│   └── index.html          # Main HTML file
├── src/
│   ├── index.js           # Main game logic
│   └── style.css          # Game styles
├── package.json           # Project dependencies
├── vite.config.js         # Build configuration
└── README.md             # This file
```

## Game Controls

- **New Game**: Start a fresh game with current difficulty
- **Difficulty**: Switch between Easy, Medium, and Hard
- **Hint**: Get a visual hint for a safe cell

## Technical Details

- Built with vanilla JavaScript (no frameworks)
- Uses CSS Grid for the game board layout
- Implements recursive reveal for empty cells
- Includes chord reveal (double-click) functionality
- Responsive design with media queries

## License

MIT License - feel free to use and modify!

## Credits

Made with ❤️ by Code Agent

Font Awesome icons used for visual elements.