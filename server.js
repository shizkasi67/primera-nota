const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

function generateRoomCode() {
  let code;
  do {
    code = Math.random().toString(36).substring(2, 6).toUpperCase();
  } while (rooms[code]);
  return code;
}

function getQueueNames(room) {
  return room.buzzQueue.map(id => {
    const p = room.players.find(p => p.id === id);
    return p ? p.name : '?';
  });
}

function broadcastQueueUpdate(room, roomCode) {
  io.to(roomCode).emit('queue-update', {
    queue: getQueueNames(room),
    currentGuesser: room.buzzQueue[0]
      ? (room.players.find(p => p.id === room.buzzQueue[0])?.name ?? null)
      : null,
  });
}

io.on('connection', (socket) => {

  // ── HOST: crear sala ──
  socket.on('create-room', ({ hostName }) => {
    const code = generateRoomCode();
    rooms[code] = {
      hostId: socket.id,
      hostName,
      players: [],
      buzzQueue: [],
      buzzedSet: new Set(),
      roundActive: false,
    };
    socket.join(code);
    socket.roomCode = code;
    socket.isHost = true;
    socket.emit('room-created', { code });
  });

  // ── JUGADOR: unirse ──
  socket.on('join-room', ({ code, playerName }) => {
    const room = rooms[code];
    if (!room) {
      socket.emit('join-error', { message: 'Sala no encontrada. Revisá el código.' });
      return;
    }
    const duplicate = room.players.find(
      p => p.name.toLowerCase() === playerName.toLowerCase()
    );
    if (duplicate) {
      socket.emit('join-error', { message: 'Ya hay un jugador con ese nombre.' });
      return;
    }

    room.players.push({ id: socket.id, name: playerName, score: 0 });
    socket.join(code);
    socket.roomCode = code;
    socket.playerName = playerName;
    socket.isHost = false;

    socket.emit('joined-room', { code, players: room.players });
    io.to(code).emit('players-update', { players: room.players });
  });

  // ── HOST: iniciar ronda ──
  socket.on('start-round', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.hostId !== socket.id) return;

    room.buzzQueue = [];
    room.buzzedSet = new Set();
    room.roundActive = true;

    io.to(socket.roomCode).emit('round-started');
  });

  // ── JUGADOR: presionar buzzer ──
  socket.on('buzz', () => {
    const room = rooms[socket.roomCode];
    if (!room || !room.roundActive || socket.isHost) return;
    if (room.buzzedSet.has(socket.id)) return; // ya presionó antes en esta ronda

    room.buzzedSet.add(socket.id);
    room.buzzQueue.push(socket.id);

    const winner = room.players.find(p => p.id === socket.id);
    if (!winner) return;

    if (room.buzzQueue.length === 1) {
      // Primer buzzer → parar música
      io.to(socket.roomCode).emit('buzz-stop', {
        guesserName: winner.name,
        guesserId: socket.id,
        queue: getQueueNames(room),
      });
    } else {
      // Ya había alguien adivinando → actualizar cola
      const position = room.buzzQueue.length;
      io.to(socket.id).emit('queued', { position });
      broadcastQueueUpdate(room, socket.roomCode);
    }
  });

  // ── HOST: resultado (correcto / incorrecto) ──
  socket.on('score-result', ({ correct }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.hostId !== socket.id || room.buzzQueue.length === 0) return;

    const currentId = room.buzzQueue.shift();
    const player = room.players.find(p => p.id === currentId);
    if (player) player.score += correct ? 1 : -1;

    io.to(socket.roomCode).emit('players-update', { players: room.players });

    if (correct) {
      room.roundActive = false;
      room.buzzQueue = [];
      room.buzzedSet = new Set();
      io.to(socket.roomCode).emit('round-won', { winnerName: player?.name });
      return;
    }

    // Incorrecto → siguiente en cola
    if (room.buzzQueue.length > 0) {
      const nextId = room.buzzQueue[0];
      const next = room.players.find(p => p.id === nextId);
      io.to(socket.roomCode).emit('buzz-stop', {
        guesserName: next?.name ?? '?',
        guesserId: nextId,
        queue: getQueueNames(room),
      });
    } else {
      // Cola vacía → reanudar música, los que no presionaron aún pueden hacerlo
      io.to(socket.roomCode).emit('queue-empty', {
        message: 'Nadie adivinó — reanudá la música',
      });
    }
  });

  // ── HOST: omitir ronda ──
  socket.on('skip-round', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.hostId !== socket.id) return;
    room.roundActive = false;
    room.buzzQueue = [];
    room.buzzedSet = new Set();
    io.to(socket.roomCode).emit('round-reset');
  });

  // ── Desconexión ──
  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];

    if (socket.isHost) {
      io.to(code).emit('room-closed', { message: 'El host se desconectó. La sala fue cerrada.' });
      delete rooms[code];
      return;
    }

    // Jugador desconectado
    const wasFirst = room.buzzQueue[0] === socket.id;
    room.buzzQueue = room.buzzQueue.filter(id => id !== socket.id);
    room.buzzedSet.delete(socket.id);
    room.players = room.players.filter(p => p.id !== socket.id);
    io.to(code).emit('players-update', { players: room.players });

    if (wasFirst && room.roundActive) {
      if (room.buzzQueue.length > 0) {
        const nextId = room.buzzQueue[0];
        const next = room.players.find(p => p.id === nextId);
        io.to(code).emit('buzz-stop', {
          guesserName: next?.name ?? '?',
          guesserId: nextId,
          queue: getQueueNames(room),
        });
      } else {
        io.to(code).emit('queue-empty', { message: 'Nadie adivinó — reanudá la música' });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Primera Nota corriendo en http://localhost:${PORT}`);
});
