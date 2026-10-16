const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ============== GAME CONSTANTS ==============

const FIGURES = {
  bomb:       { name: 'Bomb',       label: '\u{1F4A3}', rate: 100, canMove: false, steps: 0, count: 6 },
  flag:       { name: 'Flag',       label: '\u{1F6A9}', rate: 0,   canMove: false, steps: 0, count: 1 },
  spy:        { name: 'Spy',        label: '1',  rate: 1,  canMove: true, steps: 1, count: 1 },
  scout:      { name: 'Scout',      label: '2',  rate: 2,  canMove: true, steps: 10, count: 8 },
  miner:      { name: 'Miner',      label: '3',  rate: 3,  canMove: true, steps: 1, count: 5 },
  sergeant:   { name: 'Sergeant',   label: '4',  rate: 4,  canMove: true, steps: 1, count: 4 },
  lieutenant: { name: 'Lieutenant', label: '5',  rate: 5,  canMove: true, steps: 1, count: 4 },
  captain:    { name: 'Captain',    label: '6',  rate: 6,  canMove: true, steps: 1, count: 4 },
  major:      { name: 'Major',      label: '7',  rate: 7,  canMove: true, steps: 1, count: 3 },
  colonel:    { name: 'Colonel',    label: '8',  rate: 8,  canMove: true, steps: 1, count: 2 },
  general:    { name: 'General',    label: '9',  rate: 9,  canMove: true, steps: 1, count: 1 },
  marshal:    { name: 'Marshal',    label: '10', rate: 10, canMove: true, steps: 1, count: 1 },
};

const WATER_CELLS = [
  [4,2],[4,3],[5,2],[5,3],
  [4,6],[4,7],[5,6],[5,7]
];

// ============== GAME STATE ==============

let gameState = null;

function createFreshGame() {
  const board = [];
  for (let r = 0; r < 10; r++) {
    board[r] = [];
    for (let c = 0; c < 10; c++) {
      board[r][c] = { type: 'ground', figure: null };
    }
  }
  for (const [r, c] of WATER_CELLS) {
    board[r][c] = { type: 'water', figure: null };
  }
  return {
    board,
    players: {},       // socketId -> { color, ready }
    playerOrder: [],   // [socketId1, socketId2] - first is player1
    spectators: [],    // [socketId, ...]
    phase: 'waiting',  // waiting | placement | playing | gameover
    turn: null,        // 'red' or 'blue'
    capturedRed: [],
    capturedBlue: [],
    winner: null,
    colorAssignment: null, // { first: 'red'|'blue', second: 'red'|'blue' }
  };
}

function resetGame() {
  gameState = createFreshGame();
}

resetGame();

// ============== HELPER FUNCTIONS ==============

function getPlayerColor(socketId) {
  if (gameState.players[socketId]) return gameState.players[socketId].color;
  return null;
}

function getPlacementRows(color) {
  // Red places at bottom (rows 6-9), Blue places at top (rows 0-3)
  if (color === 'red') return [6, 7, 8, 9];
  return [0, 1, 2, 3];
}

function getArmy() {
  const army = [];
  for (const [key, fig] of Object.entries(FIGURES)) {
    for (let i = 0; i < fig.count; i++) {
      army.push(key);
    }
  }
  return army; // 40 pieces
}

function getRemainingToPlace(color) {
  // Count how many of each figure type are already on the board for this color
  const placed = {};
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      const fig = gameState.board[r][c].figure;
      if (fig && fig.color === color) {
        placed[fig.key] = (placed[fig.key] || 0) + 1;
      }
    }
  }
  const remaining = {};
  for (const [key, fig] of Object.entries(FIGURES)) {
    const placedCount = placed[key] || 0;
    const left = fig.count - placedCount;
    if (left > 0) remaining[key] = left;
  }
  return remaining;
}

function allPiecesPlaced(color) {
  const remaining = getRemainingToPlace(color);
  return Object.keys(remaining).length === 0;
}

function getBoardForPlayer(playerColor) {
  // Returns board state where opponent pieces are hidden (show as 'unknown')
  const view = [];
  for (let r = 0; r < 10; r++) {
    view[r] = [];
    for (let c = 0; c < 10; c++) {
      const cell = gameState.board[r][c];
      if (cell.figure && cell.figure.color !== playerColor) {
        view[r][c] = {
          type: cell.type,
          figure: { color: cell.figure.color, key: 'unknown', hidden: true }
        };
      } else {
        view[r][c] = {
          type: cell.type,
          figure: cell.figure ? { ...cell.figure, hidden: false } : null
        };
      }
    }
  }
  return view;
}

function getBoardForSpectator() {
  // Spectators see all pieces
  const view = [];
  for (let r = 0; r < 10; r++) {
    view[r] = [];
    for (let c = 0; c < 10; c++) {
      const cell = gameState.board[r][c];
      view[r][c] = {
        type: cell.type,
        figure: cell.figure ? { ...cell.figure, hidden: false } : null
      };
    }
  }
  return view;
}

function getAllowedMoves(row, col) {
  const cell = gameState.board[row][col];
  if (!cell.figure || !cell.figure.canMove) return [];

  const figure = cell.figure;
  const moves = [];
  const directions = [[0,1],[0,-1],[1,0],[-1,0]];

  for (const [dr, dc] of directions) {
    for (let step = 1; step <= figure.steps; step++) {
      const nr = row + dr * step;
      const nc = col + dc * step;
      if (nr < 0 || nr >= 10 || nc < 0 || nc >= 10) break;
      const target = gameState.board[nr][nc];
      if (target.type === 'water') break;
      if (target.figure) {
        if (target.figure.color === figure.color) break; // friendly block
        moves.push([nr, nc]); // can attack enemy
        break;
      }
      moves.push([nr, nc]);
    }
  }
  return moves;
}

function resolveCombat(attacker, defender) {
  // Returns: 'attacker_wins', 'defender_wins', 'both_die'
  if (defender.rate === 100) {
    // Bomb
    if (attacker.rate === 3) return 'attacker_wins'; // Miner defuses bomb
    return 'both_die';
  }
  if (defender.rate === 10 && attacker.rate === 1) {
    return 'attacker_wins'; // Spy kills Marshal
  }
  if (attacker.rate > defender.rate) return 'attacker_wins';
  if (attacker.rate === defender.rate) return 'both_die';
  return 'defender_wins';
}

function executeMove(fromRow, fromCol, toRow, toCol) {
  const attacker = gameState.board[fromRow][fromCol].figure;
  const target = gameState.board[toRow][toCol].figure;

  let combatResult = null;
  let attackerFig = { ...attacker };
  let defenderFig = target ? { ...target } : null;

  if (target) {
    const result = resolveCombat(attacker, target);
    combatResult = { result, attacker: attackerFig, defender: defenderFig };

    if (result === 'attacker_wins') {
      if (target.color === 'red') gameState.capturedRed.push(defenderFig);
      else gameState.capturedBlue.push(defenderFig);
      gameState.board[toRow][toCol].figure = attacker;
      gameState.board[fromRow][fromCol].figure = null;

      // Check flag capture
      if (target.key === 'flag') {
        gameState.phase = 'gameover';
        gameState.winner = attacker.color;
      }
    } else if (result === 'defender_wins') {
      if (attacker.color === 'red') gameState.capturedRed.push(attackerFig);
      else gameState.capturedBlue.push(attackerFig);
      gameState.board[fromRow][fromCol].figure = null;
    } else {
      // both_die
      if (attacker.color === 'red') gameState.capturedRed.push(attackerFig);
      else gameState.capturedBlue.push(attackerFig);
      if (target.color === 'red') gameState.capturedRed.push(defenderFig);
      else gameState.capturedBlue.push(defenderFig);
      gameState.board[fromRow][fromCol].figure = null;
      gameState.board[toRow][toCol].figure = null;
    }
  } else {
    gameState.board[toRow][toCol].figure = attacker;
    gameState.board[fromRow][fromCol].figure = null;
  }

  // Check if opponent has any movable pieces left
  if (gameState.phase !== 'gameover') {
    const opponentColor = attacker.color === 'red' ? 'blue' : 'red';
    let hasMovable = false;
    for (let r = 0; r < 10 && !hasMovable; r++) {
      for (let c = 0; c < 10 && !hasMovable; c++) {
        const fig = gameState.board[r][c].figure;
        if (fig && fig.color === opponentColor && fig.canMove) {
          const moves = getAllowedMoves(r, c);
          if (moves.length > 0) hasMovable = true;
        }
      }
    }
    if (!hasMovable) {
      gameState.phase = 'gameover';
      gameState.winner = attacker.color;
    }
  }

  return combatResult;
}

function sendStateToAll() {
  for (const [sid, player] of Object.entries(gameState.players)) {
    const sock = io.sockets.sockets.get(sid);
    if (sock) {
      sock.emit('game_state', {
        board: getBoardForPlayer(player.color),
        phase: gameState.phase,
        turn: gameState.turn,
        myColor: player.color,
        role: 'player',
        ready: player.ready,
        opponentReady: getOpponentReady(sid),
        remaining: getRemainingToPlace(player.color),
        capturedRed: gameState.capturedRed,
        capturedBlue: gameState.capturedBlue,
        winner: gameState.winner,
      });
    }
  }
  for (const sid of gameState.spectators) {
    const sock = io.sockets.sockets.get(sid);
    if (sock) {
      sock.emit('game_state', {
        board: getBoardForSpectator(),
        phase: gameState.phase,
        turn: gameState.turn,
        myColor: null,
        role: 'spectator',
        remaining: {},
        capturedRed: gameState.capturedRed,
        capturedBlue: gameState.capturedBlue,
        winner: gameState.winner,
      });
    }
  }
}

function getOpponentReady(socketId) {
  for (const [sid, player] of Object.entries(gameState.players)) {
    if (sid !== socketId) return player.ready;
  }
  return false;
}

// ============== SOCKET.IO ==============

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  const playerCount = Object.keys(gameState.players).length;

  if (playerCount < 2 && (gameState.phase === 'waiting' || gameState.phase === 'placement')) {
    // Assign as player
    if (playerCount === 0) {
      // First player - randomly assign colors
      const colors = Math.random() < 0.5 ? ['red', 'blue'] : ['blue', 'red'];
      gameState.colorAssignment = { first: colors[0], second: colors[1] };
      gameState.players[socket.id] = { color: colors[0], ready: false };
      gameState.playerOrder.push(socket.id);
      console.log(`Player 1 assigned: ${colors[0]}`);
    } else {
      // Second player gets remaining color
      gameState.players[socket.id] = { color: gameState.colorAssignment.second, ready: false };
      gameState.playerOrder.push(socket.id);
      gameState.phase = 'placement';
      console.log(`Player 2 assigned: ${gameState.colorAssignment.second}`);
    }
  } else {
    // Spectator
    gameState.spectators.push(socket.id);
    console.log(`Spectator connected: ${socket.id}`);
  }

  sendStateToAll();

  // --- PLACEMENT ---
  socket.on('place_figure', (data) => {
    const { figureKey, row, col } = data;
    const color = getPlayerColor(socket.id);
    if (!color || gameState.phase !== 'placement') return;
    if (gameState.players[socket.id].ready) return; // already locked in

    const allowedRows = getPlacementRows(color);
    if (!allowedRows.includes(row)) return;
    if (col < 0 || col >= 10) return;
    if (gameState.board[row][col].type === 'water') return;

    // Check if player has remaining of this figure
    const remaining = getRemainingToPlace(color);
    if (!remaining[figureKey] || remaining[figureKey] <= 0) return;

    // Check cell is empty or has own figure (replace not allowed - must remove first)
    if (gameState.board[row][col].figure) return;

    const figDef = FIGURES[figureKey];
    gameState.board[row][col].figure = {
      key: figureKey,
      name: figDef.name,
      label: figDef.label,
      rate: figDef.rate,
      canMove: figDef.canMove,
      steps: figDef.steps,
      color: color,
    };

    sendStateToAll();
  });

  socket.on('remove_figure', (data) => {
    const { row, col } = data;
    const color = getPlayerColor(socket.id);
    if (!color || gameState.phase !== 'placement') return;
    if (gameState.players[socket.id].ready) return;

    const cell = gameState.board[row][col];
    if (!cell.figure || cell.figure.color !== color) return;

    cell.figure = null;
    sendStateToAll();
  });

  socket.on('ready', () => {
    const color = getPlayerColor(socket.id);
    if (!color || gameState.phase !== 'placement') return;

    if (!allPiecesPlaced(color)) return;

    gameState.players[socket.id].ready = true;

    // Check if both ready
    const allReady = Object.values(gameState.players).every(p => p.ready);
    if (allReady && Object.keys(gameState.players).length === 2) {
      gameState.phase = 'playing';
      gameState.turn = 'red'; // Red always goes first
    }

    sendStateToAll();
  });

  socket.on('unready', () => {
    const color = getPlayerColor(socket.id);
    if (!color || gameState.phase !== 'placement') return;
    gameState.players[socket.id].ready = false;
    sendStateToAll();
  });

  // --- MOVEMENT ---
  socket.on('get_moves', (data) => {
    const { row, col } = data;
    const color = getPlayerColor(socket.id);
    if (!color || gameState.phase !== 'playing') return;
    if (gameState.turn !== color) return;

    const cell = gameState.board[row][col];
    if (!cell.figure || cell.figure.color !== color) return;

    const moves = getAllowedMoves(row, col);
    socket.emit('allowed_moves', { row, col, moves });
  });

  socket.on('move', (data) => {
    const { fromRow, fromCol, toRow, toCol } = data;
    const color = getPlayerColor(socket.id);
    if (!color || gameState.phase !== 'playing') return;
    if (gameState.turn !== color) return;

    const cell = gameState.board[fromRow][fromCol];
    if (!cell.figure || cell.figure.color !== color) return;

    const moves = getAllowedMoves(fromRow, fromCol);
    const valid = moves.some(([r, c]) => r === toRow && c === toCol);
    if (!valid) return;

    const combatResult = executeMove(fromRow, fromCol, toRow, toCol);

    // Switch turn
    if (gameState.phase === 'playing') {
      gameState.turn = gameState.turn === 'red' ? 'blue' : 'red';
    }

    // Send combat result to both players so they can show it briefly
    if (combatResult) {
      for (const [sid, player] of Object.entries(gameState.players)) {
        const sock = io.sockets.sockets.get(sid);
        if (sock) {
          sock.emit('combat_result', {
            fromRow, fromCol, toRow, toCol,
            result: combatResult.result,
            attacker: combatResult.attacker,
            defender: combatResult.defender,
          });
        }
      }
      for (const sid of gameState.spectators) {
        const sock = io.sockets.sockets.get(sid);
        if (sock) {
          sock.emit('combat_result', {
            fromRow, fromCol, toRow, toCol,
            result: combatResult.result,
            attacker: combatResult.attacker,
            defender: combatResult.defender,
          });
        }
      }
    }

    sendStateToAll();
  });

  // --- RESTART ---
  socket.on('restart', () => {
    resetGame();
    // Re-assign all connected sockets
    const allSockets = Array.from(io.sockets.sockets.keys());
    for (const sid of allSockets) {
      const sock = io.sockets.sockets.get(sid);
      if (sock) {
        sock.emit('game_reset');
      }
    }
    // After reset, clients will reconnect or re-register
    // Simplest: tell everyone to reload
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
    if (gameState.players[socket.id]) {
      delete gameState.players[socket.id];
      const idx = gameState.playerOrder.indexOf(socket.id);
      if (idx !== -1) gameState.playerOrder.splice(idx, 1);

      // If a player leaves during a game, end it
      if (gameState.phase === 'playing') {
        const remainingPlayers = Object.values(gameState.players);
        if (remainingPlayers.length === 1) {
          gameState.phase = 'gameover';
          gameState.winner = remainingPlayers[0].color;
          sendStateToAll();
        }
      } else if (gameState.phase === 'placement') {
        // Revert to waiting if only 1 player left
        if (Object.keys(gameState.players).length < 2) {
          // Keep the remaining player's placement, just wait for another
        }
      }
    } else {
      const idx = gameState.spectators.indexOf(socket.id);
      if (idx !== -1) gameState.spectators.splice(idx, 1);
    }
    sendStateToAll();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Stratego server running on http://0.0.0.0:${PORT}`);
});
