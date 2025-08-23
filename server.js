const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { randomUUID } = require('crypto');

// Server setup
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Game constants (mobile-first portrait)
const WORLD = { width: 900, height: 1600 };
const TICK_RATE = 60;
const BROADCAST_RATE = 30;
const DEFAULTS = {
	playerRadius: 20,
	enemyRadius: 20,
	playerMaxSpeed: 340,
	playerAccel: 1200,
	enemySpeedMin: 140,
	enemySpeedMax: 240,
	enemySpawnIntervalMs: 10000,
	friction: 0.9,
};

// Rooms
const rooms = new Map(); // roomId -> room

function createRoom(roomId) {
	const room = {
		id: roomId,
		hostId: null,
		players: new Map(), // socketId -> player
		enemies: [],
		roundRunning: false,
		enemyAdder: null,
		winnerAnnouncementUntil: 0,
		roundStartedPlayerCount: 0,
		settings: { ...DEFAULTS },
	};
	rooms.set(roomId, room);
	return room;
}

function getRoom(roomId) {
	return rooms.get(roomId);
}

function removeEmptyRoom(roomId) {
	const room = rooms.get(roomId);
	if (!room) return;
	if (room.players.size === 0) {
		if (room.enemyAdder) clearInterval(room.enemyAdder);
		rooms.delete(roomId);
	}
}

function randomColor() {
	const hue = Math.floor(Math.random() * 360);
	return `hsl(${hue}, 70%, 50%)`;
}

function randomSpawn(radius) {
	return {
		x: radius + Math.random() * (WORLD.width - 2 * radius),
		y: radius + Math.random() * (WORLD.height - 2 * radius),
	};
}

function clamp(v, min, max) {
	return Math.max(min, Math.min(max, v));
}

function mag(x, y) {
	return Math.sqrt(x * x + y * y);
}

function normalize(x, y) {
	const m = mag(x, y) || 1;
	return { x: x / m, y: y / m };
}

function resolveCircleCollision(a, b) {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const dist = Math.sqrt(dx * dx + dy * dy) || 0.0001;
	const overlap = a.r + b.r - dist;
	if (overlap > 0) {
		const nx = dx / dist;
		const ny = dy / dist;
		const correction = overlap / 2 + 0.5;
		a.x -= nx * correction;
		a.y -= ny * correction;
		b.x += nx * correction;
		b.y += ny * correction;
		const dvx = b.vx - a.vx;
		const dvy = b.vy - a.vy;
		const vn = dvx * nx + dvy * ny;
		if (vn < 0) {
			const impulse = -vn;
			a.vx -= impulse * nx;
			a.vy -= impulse * ny;
			b.vx += impulse * nx;
			b.vy += impulse * ny;
		}
	}
}

function bounceOffWalls(body) {
	if (body.x - body.r < 0) {
		body.x = body.r;
		body.vx = Math.abs(body.vx);
	}
	if (body.x + body.r > WORLD.width) {
		body.x = WORLD.width - body.r;
		body.vx = -Math.abs(body.vx);
	}
	if (body.y - body.r < 0) {
		body.y = body.r;
		body.vy = Math.abs(body.vy);
	}
	if (body.y + body.r > WORLD.height) {
		body.y = WORLD.height - body.r;
		body.vy = -Math.abs(body.vy);
	}
}

function createEnemy(room) {
	const { enemyRadius, enemySpeedMin, enemySpeedMax } = room.settings;
	const { x, y } = randomSpawn(enemyRadius);
	const angle = Math.random() * Math.PI * 2;
	const speed = enemySpeedMin + Math.random() * (enemySpeedMax - enemySpeedMin);
	return {
		id: randomUUID(),
		x,
		y,
		vx: Math.cos(angle) * speed,
		vy: Math.sin(angle) * speed,
		r: enemyRadius,
		color: '#e63946',
	};
}

function resetPlayersForRound(room) {
	for (const player of room.players.values()) {
		const { x, y } = randomSpawn(room.settings.playerRadius);
		player.x = x;
		player.y = y;
		player.vx = 0;
		player.vy = 0;
		player.r = room.settings.playerRadius;
		player.alive = true;
	}
}

function startRound(room) {
	if (room.roundRunning) return;
	if (room.players.size < 2) return;
	room.enemies = [];
	resetPlayersForRound(room);
	room.enemies.push(createEnemy(room));
	room.enemies.push(createEnemy(room));
	room.roundRunning = true;
	room.winnerAnnouncementUntil = 0;
	room.roundStartedPlayerCount = room.players.size;
	if (room.enemyAdder) clearInterval(room.enemyAdder);
	room.enemyAdder = setInterval(() => {
		if (!room.roundRunning) return;
		room.enemies.push(createEnemy(room));
	}, room.settings.enemySpawnIntervalMs);
}

function endRound(room) {
	room.roundRunning = false;
	if (room.enemyAdder) {
		clearInterval(room.enemyAdder);
		room.enemyAdder = null;
	}
	const alive = Array.from(room.players.values()).filter(p => p.alive);
	if (alive.length === 1 && room.roundStartedPlayerCount >= 2) {
		alive[0].score += 1;
		room.winnerAnnouncementUntil = Date.now() + 3000;
	}
	setTimeout(() => {}, 3000);
}

function tickPhysics(room, dt) {
	const { playerMaxSpeed, playerAccel, friction } = room.settings;
	for (const player of room.players.values()) {
		if (!player.alive) continue;
		const input = player.input || { x: 0, y: 0 };
		player.vx += input.x * playerAccel * dt;
		player.vy += input.y * playerAccel * dt;
		const speed = mag(player.vx, player.vy);
		if (speed > playerMaxSpeed) {
			const n = playerMaxSpeed / speed;
			player.vx *= n;
			player.vy *= n;
		}
		player.vx *= friction;
		player.vy *= friction;
	}

	for (const player of room.players.values()) {
		if (!player.alive) continue;
		player.x += player.vx * dt;
		player.y += player.vy * dt;
		bounceOffWalls(player);
	}
	for (const enemy of room.enemies) {
		enemy.x += enemy.vx * dt;
		enemy.y += enemy.vy * dt;
		bounceOffWalls(enemy);
	}

	const alivePlayers = Array.from(room.players.values()).filter(p => p.alive);
	for (let i = 0; i < alivePlayers.length; i++) {
		for (let j = i + 1; j < alivePlayers.length; j++) {
			resolveCircleCollision(alivePlayers[i], alivePlayers[j]);
		}
	}
	for (let i = 0; i < room.enemies.length; i++) {
		for (let j = i + 1; j < room.enemies.length; j++) {
			resolveCircleCollision(room.enemies[i], room.enemies[j]);
		}
	}
	for (const enemy of room.enemies) {
		for (const player of room.players.values()) {
			if (!player.alive) continue;
			const dx = enemy.x - player.x;
			const dy = enemy.y - player.y;
			const dist = Math.sqrt(dx * dx + dy * dy);
			if (dist <= enemy.r + player.r) {
				player.alive = false;
				player.vx = 0; player.vy = 0;
			}
		}
	}

	if (room.roundRunning) {
		const aliveCount = Array.from(room.players.values()).filter(p => p.alive).length;
		if (aliveCount <= 1) endRound(room);
	}
}

function buildState(room) {
	return {
		roomId: room.id,
		hostId: room.hostId,
		world: { width: WORLD.width, height: WORLD.height },
		roundRunning: room.roundRunning,
		winnerAnnouncementUntil: room.winnerAnnouncementUntil,
		settings: room.settings,
		players: Array.from(room.players.values()).map(p => ({
			id: p.id,
			name: p.name,
			x: p.x,
			y: p.y,
			r: p.r,
			color: p.color,
			alive: p.alive,
			score: p.score,
		})),
		enemies: room.enemies.map(e => ({ id: e.id, x: e.x, y: e.y, r: e.r, color: e.color })),
	};
}

function generateRoomId() {
	const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
	let id = '';
	for (let i = 0; i < 5; i++) id += chars[Math.floor(Math.random() * chars.length)];
	return id;
}

io.on('connection', (socket) => {
	let currentRoomId = null;
	const player = {
		id: socket.id,
		name: `Player-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
		color: randomColor(),
		x: 0,
		y: 0,
		vx: 0,
		vy: 0,
		r: DEFAULTS.playerRadius,
		alive: false,
		score: 0,
		input: { x: 0, y: 0 },
	};

	socket.emit('init', { id: socket.id });

	socket.on('setName', (newName) => {
		if (typeof newName === 'string' && newName.trim().length > 0) {
			player.name = newName.trim().slice(0, 24);
			if (currentRoomId) io.to(currentRoomId).emit('state', buildState(getRoom(currentRoomId)));
		}
	});

	socket.on('createRoom', () => {
		let roomId;
		do { roomId = generateRoomId(); } while (rooms.has(roomId));
		const room = createRoom(roomId);
		room.hostId = socket.id;
		room.players.set(socket.id, player);
		socket.join(roomId);
		currentRoomId = roomId;
		socket.emit('roomJoined', { roomId, hostId: room.hostId });
		io.to(roomId).emit('state', buildState(room));
	});

	socket.on('joinRoom', ({ roomId }) => {
		if (!roomId || typeof roomId !== 'string') return;
		const room = getRoom(roomId.toUpperCase());
		if (!room) {
			socket.emit('roomError', { message: 'Room not found' });
			return;
		}
		room.players.set(socket.id, player);
		socket.join(room.id);
		currentRoomId = room.id;
		socket.emit('roomJoined', { roomId: room.id, hostId: room.hostId });
		io.to(room.id).emit('state', buildState(room));
	});

	socket.on('hostStart', () => {
		if (!currentRoomId) return;
		const room = getRoom(currentRoomId);
		if (!room || room.hostId !== socket.id) return;
		startRound(room);
		io.to(room.id).emit('state', buildState(room));
	});

	socket.on('updateSettings', (payload) => {
		if (!currentRoomId) return;
		const room = getRoom(currentRoomId);
		if (!room || room.hostId !== socket.id) return;
		if (room.roundRunning) return; // only before round starts
		if (!payload || typeof payload !== 'object') return;
		const s = room.settings;
		// Validate and apply
		if (typeof payload.playerRadius === 'number') s.playerRadius = clamp(Math.round(payload.playerRadius), 8, 80);
		if (typeof payload.enemyRadius === 'number') s.enemyRadius = clamp(Math.round(payload.enemyRadius), 8, 80);
		if (typeof payload.playerMaxSpeed === 'number') s.playerMaxSpeed = clamp(Math.round(payload.playerMaxSpeed), 80, 1000);
		if (typeof payload.enemySpeedMin === 'number') s.enemySpeedMin = clamp(Math.round(payload.enemySpeedMin), 40, 1200);
		if (typeof payload.enemySpeedMax === 'number') s.enemySpeedMax = clamp(Math.round(payload.enemySpeedMax), s.enemySpeedMin, 1600);
		if (typeof payload.enemySpawnIntervalMs === 'number') s.enemySpawnIntervalMs = clamp(Math.round(payload.enemySpawnIntervalMs), 1000, 60000);
		// Optionally keep acceleration proportional to max speed
		s.playerAccel = Math.max(400, Math.min(4000, Math.round(s.playerMaxSpeed * 3.5)));
		io.to(room.id).emit('state', buildState(room));
	});

	socket.on('input', (vec) => {
		if (!vec || typeof vec.x !== 'number' || typeof vec.y !== 'number') return;
		const n = normalize(vec.x, vec.y);
		player.input = { x: clamp(n.x, -1, 1), y: clamp(n.y, -1, 1) };
	});

	socket.on('disconnect', () => {
		if (!currentRoomId) return;
		const room = getRoom(currentRoomId);
		if (!room) return;
		const wasHost = room.hostId === socket.id;
		room.players.delete(socket.id);
		if (wasHost) {
			const next = room.players.keys().next();
			room.hostId = next.done ? null : next.value;
		}
		if (room.roundRunning) {
			const aliveCount = Array.from(room.players.values()).filter(p => p.alive).length;
			if (aliveCount <= 1) endRound(room);
		}
		io.to(room.id).emit('state', buildState(room));
		removeEmptyRoom(room.id);
	});
});

// Game loops
setInterval(() => {
	const dt = 1 / TICK_RATE;
	for (const room of rooms.values()) {
		if (room.roundRunning) tickPhysics(room, dt);
	}
}, Math.floor(1000 / TICK_RATE));

setInterval(() => {
	for (const room of rooms.values()) {
		io.to(room.id).emit('state', buildState(room));
	}
}, Math.floor(1000 / BROADCAST_RATE));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
	console.log(`Server listening on http://localhost:${PORT}`);
});
