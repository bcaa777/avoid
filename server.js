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
const WORLD = { width: 900, height: 1100 };
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

const POWERUP_RADIUS = 18;
const POWERUP_LIFETIME_MS = 10000; // disappears if not picked in 10s
const POWERUP_SPAWN_MIN_MS = 10000;
const POWERUP_SPAWN_MAX_MS = 20000;
const FREEZE_DURATION_MS = 3000;
const SPEED_BOOST_MULTIPLIER = 1.5;
const SPEED_BOOST_DURATION_MS = 10000;
// Shield: consumes on first hit (no timer)

const ENEMY_SPAWN_SAFE_MS = 1000; // enemies cannot hurt for first 1s

const POINT_RADIUS = 14;
const POINT_LIFETIME_MS = 5000;
const POINT_SPAWN_MIN_MS = 5000;
const POINT_SPAWN_MAX_MS = 10000;
// Add weighted values for points (rarer higher values)
const POINT_VALUE_WEIGHTS = [
	{ value: 1, weight: 0.85 },
	{ value: 2, weight: 0.13 },
	{ value: 5, weight: 0.02 },
];
function pickPointValue() {
	const total = POINT_VALUE_WEIGHTS.reduce((s, it) => s + it.weight, 0);
	let r = Math.random() * total;
	for (const it of POINT_VALUE_WEIGHTS) {
		if ((r -= it.weight) <= 0) return it.value;
	}
	return 1;
}

// Rooms
const rooms = new Map(); // roomId -> room

function createRoom(roomId) {
	const room = {
		id: roomId,
		hostId: null,
		players: new Map(), // socketId -> player
		enemies: [],
		powerups: [],
		points: [],
		roundRunning: false,
		enemyAdder: null,
		winnerAnnouncementUntil: 0,
		roundStartedPlayerCount: 0,
		settings: { ...DEFAULTS },
		freezeUntil: 0,
		nextPowerupAt: 0,
		nextPointAt: 0,
		gameOver: false,
		finalStandings: [],
		explosions: [], // {id,x,y,radius,createdAt}
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

function randomPlayerColor() {
	// Avoid red-like hues (wrap region around 0 deg). Exclude [330, 30].
	let hue = Math.floor(Math.random() * 360);
	if (hue >= 330 || hue <= 30) {
		hue = (hue + 60) % 360; // shift away from red band
	}
	return `hsl(${hue}, 70%, 50%)`;
}
const ENEMY_EMOJIS = ['👾','🧟','🕷️','👻'];
const DEFAULT_PLAYER_EMOJI = '🙂';

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
		spawnSafeUntil: Date.now() + ENEMY_SPAWN_SAFE_MS,
		emoji: ENEMY_EMOJIS[Math.floor(Math.random() * ENEMY_EMOJIS.length)],
	};
}

function spawnPowerup(room) {
	const now = Date.now();
	const types = ['freeze', 'speed', 'immortal', 'bomb', 'shrink'];
	const type = types[Math.floor(Math.random() * types.length)];
	const pos = randomSpawn(POWERUP_RADIUS);
	room.powerups.push({
		id: randomUUID(),
		type,
		x: pos.x,
		y: pos.y,
		r: POWERUP_RADIUS,
		expiresAt: now + POWERUP_LIFETIME_MS,
	});
	room.nextPowerupAt = now + (POWERUP_SPAWN_MIN_MS + Math.floor(Math.random() * (POWERUP_SPAWN_MAX_MS - POWERUP_SPAWN_MIN_MS + 1)));
}

function spawnPoint(room) {
	const now = Date.now();
	const pos = randomSpawn(POINT_RADIUS);
	room.points.push({
		id: randomUUID(),
		x: pos.x,
		y: pos.y,
		r: POINT_RADIUS,
		value: pickPointValue(),
		expiresAt: now + POINT_LIFETIME_MS,
	});
	room.nextPointAt = now + (POINT_SPAWN_MIN_MS + Math.floor(Math.random() * (POINT_SPAWN_MAX_MS - POINT_SPAWN_MIN_MS + 1)));
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
		player.speedBoostUntil = 0;
		player.shield = false;
	}
}

function startRound(room) {
	if (room.roundRunning) return;
	if (room.players.size < 1) return;
	room.enemies = [];
	room.powerups = [];
	room.points = [];
	resetPlayersForRound(room);
	room.enemies.push(createEnemy(room));
	room.enemies.push(createEnemy(room));
	room.roundRunning = true;
	room.winnerAnnouncementUntil = 0;
	room.freezeUntil = 0;
	room.roundStartedPlayerCount = room.players.size;
	const now = Date.now();
	room.nextPowerupAt = now + (POWERUP_SPAWN_MIN_MS + Math.floor(Math.random() * (POWERUP_SPAWN_MAX_MS - POWERUP_SPAWN_MIN_MS + 1)));
	room.nextPointAt = now + (POINT_SPAWN_MIN_MS + Math.floor(Math.random() * (POINT_SPAWN_MAX_MS - POINT_SPAWN_MIN_MS + 1)));
	if (room.enemyAdder) clearInterval(room.enemyAdder);
	room.enemyAdder = setInterval(() => {
		if (!room.roundRunning) return;
		room.enemies.push(createEnemy(room));
	}, room.settings.enemySpawnIntervalMs);
}

function computeStandings(room) {
	return Array.from(room.players.values())
		.sort((a, b) => b.score - a.score)
		.map(p => ({ id: p.id, name: p.name, score: p.score }));
}
function endGame(room) {
	room.roundRunning = false;
	if (room.enemyAdder) { clearInterval(room.enemyAdder); room.enemyAdder = null; }
	room.gameOver = true;
	room.finalStandings = computeStandings(room);
	room.winnerAnnouncementUntil = 0;
	room.freezeUntil = 0;
	io.to(room.id).emit('state', buildState(room));
}

function endRound(room) {
	room.roundRunning = false;
	if (room.enemyAdder) {
		clearInterval(room.enemyAdder);
		room.enemyAdder = null;
	}
	room.powerups = [];
	room.points = [];
	const alive = Array.from(room.players.values()).filter(p => p.alive);
	if (alive.length === 1 && room.roundStartedPlayerCount >= 2) {
		alive[0].score += 10; // winner gets 10 points
		if (alive[0].score >= 100) { endGame(room); return; }
		room.winnerAnnouncementUntil = Date.now() + 3000;
	}
	setTimeout(() => {}, 3000);
}

function isFreezeActive(room) {
	return Date.now() < room.freezeUntil;
}

function applyPowerup(room, player, powerup) {
	switch (powerup.type) {
		case 'freeze':
			room.freezeUntil = Date.now() + FREEZE_DURATION_MS;
			break;
		case 'speed':
			player.speedBoostUntil = Date.now() + SPEED_BOOST_DURATION_MS;
			break;
		case 'immortal':
			player.shield = true; // consume on first hit
			break;
		case 'bomb': {
			const blastR = (room.settings.enemyRadius || 20) * 5;
			const cx = powerup.x;
			const cy = powerup.y;
			room.enemies = room.enemies.filter(e => {
				const dx = e.x - cx;
				const dy = e.y - cy;
				return Math.sqrt(dx * dx + dy * dy) > (blastR + e.r * 0.5);
			});
			room.explosions.push({ id: randomUUID(), x: cx, y: cy, radius: blastR, createdAt: Date.now() });
			break;
		}
		case 'shrink': {
			player.shrinkUntil = Date.now() + 10000; // 10s shrink
			break;
		}
	}
}

function tickPhysics(room, dt) {
	const now = Date.now();
	const freeze = isFreezeActive(room);
	for (const player of room.players.values()) {
		if (!player.alive) continue;
		const input = player.input || { x: 0, y: 0 };
		const hasBoost = now < (player.speedBoostUntil || 0);
		const shrunk = now < (player.shrinkUntil || 0);
		const baseAccel = room.settings.playerAccel;
		const baseMax = room.settings.playerMaxSpeed;
		const accel = hasBoost ? baseAccel * SPEED_BOOST_MULTIPLIER : baseAccel;
		const maxSpeed = hasBoost ? baseMax * SPEED_BOOST_MULTIPLIER : baseMax;
		player.vx += input.x * accel * dt;
		player.vy += input.y * accel * dt;
		const speed = mag(player.vx, player.vy);
		if (speed > maxSpeed) {
			const n = maxSpeed / speed;
			player.vx *= n;
			player.vy *= n;
		}
		player.vx *= room.settings.friction;
		player.vy *= room.settings.friction;
		// apply shrink size
		player.r = shrunk ? Math.max(8, Math.round(room.settings.playerRadius * 0.5)) : room.settings.playerRadius;
	}

	for (const player of room.players.values()) {
		if (!player.alive) continue;
		player.x += player.vx * dt;
		player.y += player.vy * dt;
		bounceOffWalls(player);
	}

	if (!freeze) {
		for (const enemy of room.enemies) {
			enemy.x += enemy.vx * dt;
			enemy.y += enemy.vy * dt;
			bounceOffWalls(enemy);
		}
	}

	const alivePlayers = Array.from(room.players.values()).filter(p => p.alive);
	for (let i = 0; i < alivePlayers.length; i++) {
		for (let j = i + 1; j < alivePlayers.length; j++) {
			resolveCircleCollision(alivePlayers[i], alivePlayers[j]);
		}
	}
	if (!freeze) {
		for (let i = 0; i < room.enemies.length; i++) {
			for (let j = i + 1; j < room.enemies.length; j++) {
				resolveCircleCollision(room.enemies[i], room.enemies[j]);
			}
		}
	}
	for (const enemy of room.enemies) {
		for (const player of room.players.values()) {
			if (!player.alive) continue;
			const dx = enemy.x - player.x;
			const dy = enemy.y - player.y;
			const dist = Math.sqrt(dx * dx + dy * dy);
			if (dist <= enemy.r + player.r) {
				// ignore if enemy in spawn protection
				if (now < (enemy.spawnSafeUntil || 0)) continue;
				// invulnerability frames prevent kill
				if (now < (player.invincibleUntil || 0)) continue;
				// If player has shield, consume and knock enemy away, grant brief i-frames
				if (player.shield) {
					player.shield = false;
					player.invincibleUntil = now + 450; // ~0.45s i-frames
					const nx = (dx || 0.0001) / (dist || 1);
					const ny = (dy || 0.0001) / (dist || 1);
					// Reposition enemy just outside player to avoid immediate re-collision
					const separation = player.r + enemy.r + 2;
					enemy.x = player.x + nx * separation;
					enemy.y = player.y + ny * separation;
					// Stronger bounce away
					const currentSpeed = Math.hypot(enemy.vx, enemy.vy);
					const baseSpeed = Math.max(room.settings.enemySpeedMin, Math.min(room.settings.enemySpeedMax, currentSpeed));
					const bounceSpeed = baseSpeed * 1.6;
					enemy.vx = nx * bounceSpeed;
					enemy.vy = ny * bounceSpeed;
					continue;
				}
				player.alive = false;
				player.vx = 0; player.vy = 0;
			}
		}
	}

	// Powerups: expire and pickups
	room.powerups = room.powerups.filter(pu => pu.expiresAt > now);
	for (const pu of room.powerups.slice()) {
		for (const player of room.players.values()) {
			if (!player.alive) continue;
			const dx = pu.x - player.x;
			const dy = pu.y - player.y;
			if (Math.sqrt(dx * dx + dy * dy) <= (pu.r + player.r)) {
				applyPowerup(room, player, pu);
				room.powerups = room.powerups.filter(x => x.id !== pu.id);
				break;
			}
		}
	}
	// Points: expire and pickups
	room.points = room.points.filter(pt => pt.expiresAt > now);
	for (const pt of room.points.slice()) {
		let ended = false;
		for (const player of room.players.values()) {
			if (!player.alive) continue;
			const dx = pt.x - player.x;
			const dy = pt.y - player.y;
			if (Math.sqrt(dx * dx + dy * dy) <= (pt.r + player.r)) {
				player.score += (pt.value || 1);
				if (player.score >= 100) { endGame(room); ended = true; break; }
				room.points = room.points.filter(x => x.id !== pt.id);
				break;
			}
		}
		if (ended) break;
	}
	// Spawns
	if (room.roundRunning && now >= room.nextPowerupAt) spawnPowerup(room);
	if (room.roundRunning && now >= room.nextPointAt) spawnPoint(room);

	if (room.roundRunning) {
		const aliveCount = Array.from(room.players.values()).filter(p => p.alive).length;
		const shouldEnd = room.roundStartedPlayerCount >= 2 ? (aliveCount <= 1) : (aliveCount === 0);
		if (shouldEnd) endRound(room);
	}
}

function buildState(room) {
	return {
		roomId: room.id,
		hostId: room.hostId,
		world: { width: WORLD.width, height: WORLD.height },
		roundRunning: room.roundRunning,
		winnerAnnouncementUntil: room.winnerAnnouncementUntil,
		freezeUntil: room.freezeUntil,
		gameOver: !!room.gameOver,
		finalStandings: room.finalStandings || [],
		explosions: room.explosions.slice(-6),
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
			speedBoostUntil: p.speedBoostUntil || 0,
			shield: !!p.shield,
			shrinkUntil: p.shrinkUntil || 0,
			emoji: p.emoji || DEFAULT_PLAYER_EMOJI,
		})),
		enemies: room.enemies.map(e => ({ id: e.id, x: e.x, y: e.y, r: e.r, color: e.color, spawnSafeUntil: e.spawnSafeUntil || 0, emoji: e.emoji || '👾' })),
		powerups: room.powerups.map(pu => ({ id: pu.id, type: pu.type, x: pu.x, y: pu.y, r: pu.r, expiresAt: pu.expiresAt })),
		points: room.points.map(pt => ({ id: pt.id, x: pt.x, y: pt.y, r: pt.r, value: pt.value || 1, expiresAt: pt.expiresAt })),
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
		color: randomPlayerColor(),
		x: 0,
		y: 0,
		vx: 0,
		vy: 0,
		r: DEFAULTS.playerRadius,
		alive: false,
		score: 0,
		speedBoostUntil: 0,
		shield: false,
		invincibleUntil: 0,
		shrinkUntil: 0,
		emoji: DEFAULT_PLAYER_EMOJI,
		input: { x: 0, y: 0 },
	};

	socket.emit('init', { id: socket.id });

	socket.on('setName', (newName) => {
		if (typeof newName === 'string' && newName.trim().length > 0) {
			player.name = newName.trim().slice(0, 24);
			if (currentRoomId) io.to(currentRoomId).emit('state', buildState(getRoom(currentRoomId)));
		}
	});

	socket.on('setEmoji', (emoji) => {
		if (typeof emoji !== 'string') return;
		let trimmed = emoji.trim();
		if (!trimmed) return;
		// Convert to array of Unicode code points and limit length
		const codepoints = Array.from(trimmed);
		const limited = codepoints.slice(0, 2).join('');
		player.emoji = limited || DEFAULT_PLAYER_EMOJI;
		if (currentRoomId) io.to(currentRoomId).emit('state', buildState(getRoom(currentRoomId)));
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
		function applyFinite(key, value, min, max, round = true) {
			if (typeof value !== 'number' || !Number.isFinite(value)) return;
			const v = round ? Math.round(value) : value;
			s[key] = Math.max(min, Math.min(max, v));
		}
		applyFinite('playerRadius', payload.playerRadius, 8, 80, true);
		applyFinite('enemyRadius', payload.enemyRadius, 8, 80, true);
		applyFinite('playerMaxSpeed', payload.playerMaxSpeed, 80, 1000, true);
		applyFinite('enemySpeedMin', payload.enemySpeedMin, 40, 1600, true);
		applyFinite('enemySpeedMax', payload.enemySpeedMax, 40, 1600, true);
		applyFinite('enemySpawnIntervalMs', payload.enemySpawnIntervalMs, 500, 60000, true);
		if (s.enemySpeedMax < s.enemySpeedMin) s.enemySpeedMax = s.enemySpeedMin;
		s.playerAccel = Math.max(400, Math.min(4000, Math.round(s.playerMaxSpeed * 3.5)));
		io.to(room.id).emit('state', buildState(room));
		socket.emit('settingsUpdated', { settings: room.settings });
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

	socket.on('hostRestartGame', () => {
		if (!currentRoomId) return;
		const room = getRoom(currentRoomId);
		if (!room || room.hostId !== socket.id) return;
		// reset room state
		room.roundRunning = false;
		room.gameOver = false;
		room.enemies = [];
		room.powerups = [];
		room.points = [];
		room.winnerAnnouncementUntil = 0;
		room.freezeUntil = 0;
		room.nextPowerupAt = 0;
		room.nextPointAt = 0;
		if (room.enemyAdder) { clearInterval(room.enemyAdder); room.enemyAdder = null; }
		for (const p of room.players.values()) {
			p.score = 0;
			p.alive = false;
			p.vx = 0; p.vy = 0;
			p.speedBoostUntil = 0;
			p.shield = false;
			p.invincibleUntil = 0;
		}
		room.finalStandings = [];
		io.to(room.id).emit('state', buildState(room));
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
