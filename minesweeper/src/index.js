import './style.css';

class Minesweeper {
    constructor() {
        this.board = [];
        this.revealed = [];
        this.flags = [];
        this.gameOver = false;
        this.gameWon = false;
        this.startTime = null;
        this.timerInterval = null;
        this.difficulty = 'easy';
        this.difficultySettings = {
            easy: { rows: 9, cols: 9, mines: 10 },
            medium: { rows: 16, cols: 16, mines: 40 },
            hard: { rows: 16, cols: 30, mines: 99 }
        };
        
        this.init();
    }

    init() {
        this.setupEventListeners();
        this.startNewGame();
    }

    setupEventListeners() {
        // New game button
        document.getElementById('new-game').addEventListener('click', () => {
            this.startNewGame();
        });

        // Difficulty buttons
        document.querySelectorAll('.difficulty-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.difficulty-btn').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                this.difficulty = e.target.dataset.difficulty;
                this.startNewGame();
            });
        });

        // Hint button
        document.getElementById('hint').addEventListener('click', () => {
            this.giveHint();
        });
    }

    startNewGame() {
        this.stopTimer();
        this.gameOver = false;
        this.gameWon = false;
        this.startTime = null;
        
        const settings = this.difficultySettings[this.difficulty];
        this.rows = settings.rows;
        this.cols = settings.cols;
        this.mines = settings.mines;
        this.flagsPlaced = 0;
        
        this.initializeBoard();
        this.placeMines();
        this.calculateNumbers();
        this.renderBoard();
        this.updateUI();
        
        this.setStatusMessage('Click to start!', 'info');
    }

    initializeBoard() {
        this.board = Array(this.rows).fill().map(() => Array(this.cols).fill(0));
        this.revealed = Array(this.rows).fill().map(() => Array(this.cols).fill(false));
        this.flags = Array(this.rows).fill().map(() => Array(this.cols).fill(false));
    }

    placeMines() {
        let minesPlaced = 0;
        while (minesPlaced < this.mines) {
            const row = Math.floor(Math.random() * this.rows);
            const col = Math.floor(Math.random() * this.cols);
            
            if (this.board[row][col] !== -1) {
                this.board[row][col] = -1; // -1 represents a mine
                minesPlaced++;
            }
        }
    }

    calculateNumbers() {
        const directions = [
            [-1, -1], [-1, 0], [-1, 1],
            [0, -1],           [0, 1],
            [1, -1],  [1, 0],  [1, 1]
        ];

        for (let row = 0; row < this.rows; row++) {
            for (let col = 0; col < this.cols; col++) {
                if (this.board[row][col] === -1) continue;
                
                let mineCount = 0;
                for (const [dx, dy] of directions) {
                    const newRow = row + dx;
                    const newCol = col + dy;
                    
                    if (newRow >= 0 && newRow < this.rows && newCol >= 0 && newCol < this.cols) {
                        if (this.board[newRow][newCol] === -1) {
                            mineCount++;
                        }
                    }
                }
                this.board[row][col] = mineCount;
            }
        }
    }

    renderBoard() {
        const boardElement = document.getElementById('game-board');
        boardElement.innerHTML = '';
        boardElement.style.gridTemplateColumns = `repeat(${this.cols}, 1fr)`;
        boardElement.style.gridTemplateRows = `repeat(${this.rows}, 1fr)`;
        
        for (let row = 0; row < this.rows; row++) {
            for (let col = 0; col < this.cols; col++) {
                const cell = document.createElement('div');
                cell.className = 'cell';
                cell.dataset.row = row;
                cell.dataset.col = col;
                
                // Left click to reveal
                cell.addEventListener('click', (e) => {
                    if (e.button === 0) { // Left click only
                        this.revealCell(row, col);
                    }
                });
                
                // Right click to toggle flag
                cell.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    this.toggleFlag(row, col);
                });
                
                // Double click for chord reveal
                cell.addEventListener('dblclick', () => {
                    this.chordReveal(row, col);
                });
                
                boardElement.appendChild(cell);
            }
        }
    }

    revealCell(row, col) {
        if (this.gameOver || this.gameWon || this.flags[row][col]) return;
        
        // Start timer on first click
        if (this.startTime === null) {
            this.startTimer();
        }
        
        if (this.revealed[row][col]) return;
        
        this.revealed[row][col] = true;
        
        const cell = this.getCellElement(row, col);
        const value = this.board[row][col];
        
        if (value === -1) {
            // Mine hit - game over
            cell.classList.add('mine');
            cell.innerHTML = '<i class="fas fa-bomb"></i>';
            this.gameOver = true;
            this.revealAllMines();
            this.stopTimer();
            this.setStatusMessage('Game Over! You hit a mine.', 'error');
            return;
        }
        
        // Reveal number or empty cell
        if (value > 0) {
            cell.classList.add(`number-${value}`);
            cell.textContent = value;
        } else {
            cell.classList.add('empty');
            // Reveal adjacent empty cells
            this.revealAdjacentCells(row, col);
        }
        
        cell.classList.add('revealed');
        
        // Check win condition
        if (this.checkWin()) {
            this.gameWon = true;
            this.stopTimer();
            this.setStatusMessage('Congratulations! You won!', 'success');
        }
    }

    revealAdjacentCells(row, col) {
        const directions = [
            [-1, -1], [-1, 0], [-1, 1],
            [0, -1],           [0, 1],
            [1, -1],  [1, 0],  [1, 1]
        ];
        
        for (const [dx, dy] of directions) {
            const newRow = row + dx;
            const newCol = col + dy;
            
            if (newRow >= 0 && newRow < this.rows && newCol >= 0 && newCol < this.cols) {
                if (!this.revealed[newRow][newCol] && !this.flags[newRow][newCol]) {
                    this.revealCell(newRow, newCol);
                }
            }
        }
    }

    toggleFlag(row, col) {
        if (this.gameOver || this.gameWon || this.revealed[row][col]) return;
        
        this.flags[row][col] = !this.flags[row][col];
        const cell = this.getCellElement(row, col);
        
        if (this.flags[row][col]) {
            cell.classList.add('flag');
            cell.innerHTML = '<i class="fas fa-flag"></i>';
            this.flagsPlaced++;
        } else {
            cell.classList.remove('flag');
            cell.innerHTML = '';
            this.flagsPlaced--;
        }
        
        this.updateUI();
    }

    chordReveal(row, col) {
        if (!this.revealed[row][col] || this.board[row][col] <= 0) return;
        
        const directions = [
            [-1, -1], [-1, 0], [-1, 1],
            [0, -1],           [0, 1],
            [1, -1],  [1, 0],  [1, 1]
        ];
        
        let flagCount = 0;
        for (const [dx, dy] of directions) {
            const newRow = row + dx;
            const newCol = col + dy;
            
            if (newRow >= 0 && newRow < this.rows && newCol >= 0 && newCol < this.cols) {
                if (this.flags[newRow][newCol]) {
                    flagCount++;
                }
            }
        }
        
        if (flagCount === this.board[row][col]) {
            for (const [dx, dy] of directions) {
                const newRow = row + dx;
                const newCol = col + dy;
                
                if (newRow >= 0 && newRow < this.rows && newCol >= 0 && newCol < this.cols) {
                    if (!this.flags[newRow][newCol] && !this.revealed[newRow][newCol]) {
                        this.revealCell(newRow, newCol);
                    }
                }
            }
        }
    }

    revealAllMines() {
        for (let row = 0; row < this.rows; row++) {
            for (let col = 0; col < this.cols; col++) {
                if (this.board[row][col] === -1 && !this.flags[row][col]) {
                    const cell = this.getCellElement(row, col);
                    cell.classList.add('mine');
                    cell.innerHTML = '<i class="fas fa-bomb"></i>';
                }
            }
        }
    }

    checkWin() {
        for (let row = 0; row < this.rows; row++) {
            for (let col = 0; col < this.cols; col++) {
                if (this.board[row][col] !== -1 && !this.revealed[row][col]) {
                    return false;
                }
            }
        }
        return true;
    }

    giveHint() {
        if (this.gameOver || this.gameWon) return;
        
        // Find a safe cell to reveal
        const safeCells = [];
        for (let row = 0; row < this.rows; row++) {
            for (let col = 0; col < this.cols; col++) {
                if (!this.revealed[row][col] && !this.flags[row][col] && this.board[row][col] !== -1) {
                    safeCells.push({ row, col });
                }
            }
        }
        
        if (safeCells.length > 0) {
            const hint = safeCells[Math.floor(Math.random() * safeCells.length)];
            const cell = this.getCellElement(hint.row, hint.col);
            cell.classList.add('hint');
            setTimeout(() => {
                cell.classList.remove('hint');
            }, 1000);
            this.setStatusMessage('Hint: Try this cell!', 'info');
        }
    }

    startTimer() {
        this.startTime = Date.now();
        this.timerInterval = setInterval(() => {
            const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
            document.getElementById('timer').textContent = elapsed.toString().padStart(3, '0');
        }, 1000);
    }

    stopTimer() {
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
    }

    updateUI() {
        document.getElementById('mines-count').textContent = this.mines;
        document.getElementById('flags-count').textContent = this.flagsPlaced;
    }

    setStatusMessage(message, type = 'info') {
        const statusElement = document.getElementById('game-status');
        const messageElement = statusElement.querySelector('.status-message');
        messageElement.textContent = message;
        
        statusElement.className = 'game-status';
        statusElement.classList.add(`status-${type}`);
    }

    getCellElement(row, col) {
        return document.querySelector(`.cell[data-row="${row}"][data-col="${col}"]`);
    }
}

// Initialize the game when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new Minesweeper();
});