const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { randomUUID } = require('crypto');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');

// Server setup
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
	perMessageDeflate: { threshold: 256 },
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
const SESSION_SECRET = process.env.SESSION_SECRET || randomUUID();
app.use(cookieParser(SESSION_SECRET));

// Admin auth setup (bcrypt-protected password)
let ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_BCRYPT || '';
if (!ADMIN_PASSWORD_HASH) {
	const plain = process.env.ADMIN_PASSWORD;
	if (plain && typeof plain === 'string') {
		ADMIN_PASSWORD_HASH = bcrypt.hashSync(plain, 10);
	} else {
		const generated = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
		ADMIN_PASSWORD_HASH = bcrypt.hashSync(generated, 10);
		console.log('[admin] Generated admin password (set ADMIN_PASSWORD or ADMIN_PASSWORD_BCRYPT to override):', generated);
	}
}
function isAdmin(req) { return req.signedCookies && req.signedCookies.admin === '1'; }
function requireAdmin(req, res, next) { if (!isAdmin(req)) return res.status(401).send('Unauthorized'); next(); }

// Public rooms listing for lobby
app.get('/api/rooms', (_req, res) => {
	const list = Array.from(rooms.values())
		.filter(r => r.isPublic)
		.map(r => ({
			id: r.id,
			roundRunning: !!r.roundRunning,
			gameOver: !!r.gameOver,
			playerCount: r.players.size,
			players: Array.from(r.players.values()).map(p => ({ name: p.name, score: p.score }))
		}));
	res.json({ rooms: list });
});

// Game constants (mobile-first portrait)
const WORLD = { width: 900, height: 1100 };
let TICK_RATE = 60;
let BROADCAST_RATE = 30;
const DEFAULTS = {
	playerRadius: 20,
	enemyRadius: 20,
	playerMaxSpeed: 340,
	playerAccel: 1200,
	enemySpeedMin: 140,
	enemySpeedMax: 240,
	enemySpawnIntervalMs: 10000,
	friction: 0.9,
 	pointsToWin: 100,
};
// Network config (admin-tunable)
const NET_CONFIG = {
	inputSendRateHz: 30,   // client throttle recommendation
	maxInputRateHz: 90,    // server will ignore faster than this
};

const POWERUP_RADIUS = 27; // 1.5x larger
const POWERUP_LIFETIME_MS = 10000; // disappears if not picked in 10s
const POWERUP_SPAWN_MIN_MS = 10000;
const POWERUP_SPAWN_MAX_MS = 20000;
const FREEZE_DURATION_MS = 3000;
const SPEED_BOOST_MULTIPLIER = 1.5;
const SPEED_BOOST_DURATION_MS = 10000;
// Base bump strength for player-vs-player collisions
const PLAYER_BUMP_BASE_MULTIPLIER = 2;
// Dash mechanic
const DASH_DURATION_MS = 300;
const DASH_COOLDOWN_MS = 2000;
const DASH_SPEED_MULTIPLIER = 2;
// Shield: consumes on first hit (no timer)

const ENEMY_SPAWN_SAFE_MS = 1000; // enemies cannot hurt for first 1s

const POINT_RADIUS = 28; // 2x larger
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

function powerupSpawnScaleForPlayers(count) {
	if (count <= 2) return 1;
	if (count <= 6) return 0.5;
	return 1 / 3;
}

// Rooms
const rooms = new Map(); // roomId -> room

function createRoom(roomId) {
	const room = {
		id: roomId,
		hostId: null,
		isPublic: false,
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

function resolvePlayerCollision(a, b, baseMultiplier, now) {
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
			const impulse = -vn * (baseMultiplier || 1);
			// While dashing, impart 2x bounce to the other player
			const aDashing = now < (a.dashUntil || 0);
			const bDashing = now < (b.dashUntil || 0);
			let aScale = 1, bScale = 1;
			if (aDashing && !bDashing) bScale *= 2;
			if (bDashing && !aDashing) aScale *= 2;
			a.vx -= impulse * nx * aScale;
			a.vy -= impulse * ny * aScale;
			b.vx += impulse * nx * bScale;
			b.vy += impulse * ny * bScale;
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
	const pu = {
		id: randomUUID(),
		type,
		x: pos.x,
		y: pos.y,
		r: POWERUP_RADIUS,
		expiresAt: now + POWERUP_LIFETIME_MS,
	};
	room.powerups.push(pu);
	io.to(room.id).emit('powerupAdd', pu);
	const scale = (room.players.size <= 2) ? 1 : (room.players.size <= 6 ? 0.5 : (1/3));
	const min = Math.round(POWERUP_SPAWN_MIN_MS * scale);
	const max = Math.round(POWERUP_SPAWN_MAX_MS * scale);
	room.nextPowerupAt = now + (min + Math.floor(Math.random() * (max - min + 1)));
}

function spawnPoint(room) {
	const now = Date.now();
	const pos = randomSpawn(POINT_RADIUS);
	const pt = {
		id: randomUUID(),
		x: pos.x,
		y: pos.y,
		r: POINT_RADIUS,
		value: pickPointValue(),
		expiresAt: now + POINT_LIFETIME_MS,
	};
	room.points.push(pt);
	io.to(room.id).emit('pointAdd', pt);
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
		player.invincibleUntil = 0;
		player.dashUntil = 0;
		player.dashReadyAt = 0;
	}
}

function startRound(room) {
	if (room.roundRunning) return;
	if (room.players.size < 1) return;
	room.enemies = [];
	room.powerups = [];
	room.points = [];
	io.to(room.id).emit('powerupClear');
	io.to(room.id).emit('pointClear');
	resetPlayersForRound(room);
	room.enemies.push(createEnemy(room));
	room.enemies.push(createEnemy(room));
	room.roundRunning = true;
	room.winnerAnnouncementUntil = 0;
	room.freezeUntil = Date.now() + FREEZE_DURATION_MS;
	room.roundStartedPlayerCount = room.players.size;
	const now = Date.now();
	{
		const scale = powerupSpawnScaleForPlayers(room.players.size);
		const min = Math.round(POWERUP_SPAWN_MIN_MS * scale);
		const max = Math.round(POWERUP_SPAWN_MAX_MS * scale);
		room.nextPowerupAt = now + (min + Math.floor(Math.random() * (max - min + 1)));
	}
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
	io.to(room.id).emit('powerupClear');
	io.to(room.id).emit('pointClear');
	io.to(room.id).emit('state', buildState(room));
	io.to(room.id).emit('powerupSnapshot', { powerups: room.powerups });
	io.to(room.id).emit('pointSnapshot', { points: room.points });
	io.to(room.id).emit('powerupSnapshot', { powerups: room.powerups });
	io.to(room.id).emit('pointSnapshot', { points: room.points });
}

function endRound(room) {
	room.roundRunning = false;
	if (room.enemyAdder) {
		clearInterval(room.enemyAdder);
		room.enemyAdder = null;
	}
	room.powerups = [];
	room.points = [];
	io.to(room.id).emit('powerupClear');
	io.to(room.id).emit('pointClear');
	io.to(room.id).emit('powerupSnapshot', { powerups: room.powerups });
	io.to(room.id).emit('pointSnapshot', { points: room.points });
	const alive = Array.from(room.players.values()).filter(p => p.alive);
	if (alive.length === 1 && room.roundStartedPlayerCount >= 2) {
		alive[0].score += 10; // winner gets 10 points
		if (alive[0].score >= (room.settings.pointsToWin || DEFAULTS.pointsToWin)) { endGame(room); return; }
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
			const blastR = (room.settings.enemyRadius || 20) * 10; // halved radius
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
		let accel = hasBoost ? baseAccel * SPEED_BOOST_MULTIPLIER : baseAccel;
		let maxSpeed = hasBoost ? baseMax * SPEED_BOOST_MULTIPLIER : baseMax;
		if (now < (player.dashUntil || 0)) {
			accel *= DASH_SPEED_MULTIPLIER;
			maxSpeed *= DASH_SPEED_MULTIPLIER;
		}
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
			resolvePlayerCollision(alivePlayers[i], alivePlayers[j], PLAYER_BUMP_BASE_MULTIPLIER, now);
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
	const beforePu = new Set(room.powerups.map(p => p.id));
	room.powerups = room.powerups.filter(pu => pu.expiresAt > now);
	for (const removedId of [...beforePu].filter(id => !room.powerups.find(p => p.id === id))) {
		io.to(room.id).emit('powerupRemove', { id: removedId });
	}
	for (const pu of room.powerups.slice()) {
		for (const player of room.players.values()) {
			if (!player.alive) continue;
			const dx = pu.x - player.x;
			const dy = pu.y - player.y;
			if (Math.sqrt(dx * dx + dy * dy) <= (pu.r + player.r)) {
				applyPowerup(room, player, pu);
				room.powerups = room.powerups.filter(x => x.id !== pu.id);
				io.to(room.id).emit('powerupRemove', { id: pu.id });
				break;
			}
		}
	}
	// Points: expire and pickups
	const beforePts = new Set(room.points.map(p => p.id));
	room.points = room.points.filter(pt => pt.expiresAt > now);
	for (const removedId of [...beforePts].filter(id => !room.points.find(p => p.id === id))) {
		io.to(room.id).emit('pointRemove', { id: removedId });
	}
	for (const pt of room.points.slice()) {
		let ended = false;
		for (const player of room.players.values()) {
			if (!player.alive) continue;
			const dx = pt.x - player.x;
			const dy = pt.y - player.y;
			if (Math.sqrt(dx * dx + dy * dy) <= (pt.r + player.r)) {
				player.score += (pt.value || 1);
				if (player.score >= (room.settings.pointsToWin || DEFAULTS.pointsToWin)) { endGame(room); ended = true; break; }
				room.points = room.points.filter(x => x.id !== pt.id);
				io.to(room.id).emit('pointRemove', { id: pt.id });
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
		now: Date.now(),
		roomId: room.id,
		hostId: room.hostId,
		world: { width: WORLD.width, height: WORLD.height },
		roundRunning: room.roundRunning,
		winnerAnnouncementUntil: room.winnerAnnouncementUntil,
		freezeUntil: room.freezeUntil,
		gameOver: !!room.gameOver,
		finalStandings: room.finalStandings || [],
		explosions: room.explosions.slice(-6),
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
			dashUntil: p.dashUntil || 0,
			dashReadyAt: p.dashReadyAt || 0,
		})),
		enemies: room.enemies.map(e => ({ id: e.id, x: e.x, y: e.y, r: e.r, color: e.color, spawnSafeUntil: e.spawnSafeUntil || 0, emoji: e.emoji || '👾' })),
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
		dashUntil: 0,
		dashReadyAt: 0,
		_lastInputAt: 0,
	};

	socket.emit('init', { id: socket.id, serverTime: Date.now() });
	socket.emit('serverConfig', { tickRateHz: TICK_RATE, broadcastRateHz: BROADCAST_RATE, inputSendRateHz: NET_CONFIG.inputSendRateHz, maxInputRateHz: NET_CONFIG.maxInputRateHz });

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

	socket.on('createRoom', (payload) => {
		let roomId;
		do { roomId = generateRoomId(); } while (rooms.has(roomId));
		const room = createRoom(roomId);
		room.hostId = socket.id;
		room.isPublic = !!(payload && payload.isPublic);
		room.players.set(socket.id, player);
		socket.join(roomId);
		currentRoomId = roomId;
		socket.emit('roomJoined', { roomId, hostId: room.hostId });
		// send initial snapshots and settings to the joining client only
		socket.emit('settingsUpdated', { settings: room.settings });
		if (room.powerups.length) socket.emit('powerupSnapshot', { powerups: room.powerups });
		if (room.points.length) socket.emit('pointSnapshot', { points: room.points });
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
		// send initial snapshots and settings to the joining client only
		socket.emit('settingsUpdated', { settings: room.settings });
		if (room.powerups.length) socket.emit('powerupSnapshot', { powerups: room.powerups });
		if (room.points.length) socket.emit('pointSnapshot', { points: room.points });
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
		applyFinite('pointsToWin', payload.pointsToWin, 10, 10000, true);
		if (s.enemySpeedMax < s.enemySpeedMin) s.enemySpeedMax = s.enemySpeedMin;
		s.playerAccel = Math.max(400, Math.min(4000, Math.round(s.playerMaxSpeed * 3.5)));
		io.to(room.id).emit('settingsUpdated', { settings: room.settings });
	});

	socket.on('input', (vec) => {
		if (!vec || typeof vec.x !== 'number' || typeof vec.y !== 'number') return;
		const now = Date.now();
		const minInterval = Math.max(1, Math.floor(1000 / (NET_CONFIG.maxInputRateHz || 1000)));
		if (now - (player._lastInputAt || 0) < minInterval) return;
		player._lastInputAt = now;
		const n = normalize(vec.x, vec.y);
		player.input = { x: clamp(n.x, -1, 1), y: clamp(n.y, -1, 1) };
	});

	socket.on('dash', () => {
		const now = Date.now();
		if (player.dashUntil && now < player.dashUntil) return; // already dashing
		if (player.dashReadyAt && now < player.dashReadyAt) return; // cooldown
		if (!player.alive) return;
		player.dashUntil = now + DASH_DURATION_MS;
		player.dashReadyAt = now + DASH_COOLDOWN_MS;
		// Instant impulse in facing/move direction; prefer input direction if present
		const hasInput = Math.abs(player.input.x) + Math.abs(player.input.y) > 0.01;
		const dir = hasInput ? normalize(player.input.x, player.input.y) : normalize(player.vx, player.vy || 1);
		const speed = Math.max(1, mag(player.vx, player.vy));
		const impulse = Math.max(220, speed * 0.8);
		player.vx += dir.x * impulse;
		player.vy += dir.y * impulse;
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
		io.to(room.id).emit('powerupClear');
		io.to(room.id).emit('pointClear');
		io.to(room.id).emit('state', buildState(room));
	});
});

// Admin routes
app.get('/admin', (req, res) => {
	if (!isAdmin(req)) {
		res.setHeader('Content-Type', 'text/html; charset=utf-8');
		res.end(`<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Admin Login</title><style>body{font-family:system-ui, -apple-system, Segoe UI, Roboto, sans-serif;background:#0b132b;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}form{background:#111827;padding:24px;border-radius:12px;min-width:320px;box-shadow:0 10px 30px rgba(0,0,0,0.4)}h1{margin:0 0 12px;font-size:20px}input,button{width:100%;padding:10px 12px;border-radius:8px;border:none;margin-top:10px}input{background:#0f172a;color:#fff}button{background:#2563eb;color:#fff;font-weight:600;cursor:pointer}#err{color:#f87171;margin-top:10px;height:18px}</style></head><body><form id="f"><h1>Admin Login</h1><input type="password" id="pw" placeholder="Password" autofocus/><div id="err"></div><button type="submit">Sign in</button></form><script>document.getElementById('f').addEventListener('submit', async (e)=>{e.preventDefault();const pw=document.getElementById('pw').value;const r=await fetch('/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})});if(r.ok){location.href='/admin';}else{document.getElementById('err').textContent='Invalid password';}});</script></body></html>`);
		return;
	}
	res.setHeader('Content-Type', 'text/html; charset=utf-8');
	res.end(`<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Admin</title><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b132b;color:#e5e7eb;margin:0}header{position:sticky;top:0;background:#0f172a;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,0.08);display:flex;justify-content:space-between;align-items:center}main{padding:16px;max-width:900px;margin:0 auto}h2{color:#fff;margin:20px 0 8px}section{background:#111827;padding:16px;border-radius:12px;margin-bottom:16px;border:1px solid rgba(255,255,255,0.06)}label{display:block;margin:10px 0 6px}input{background:#0f172a;border:none;color:#fff;padding:8px 10px;border-radius:8px;width:180px}button{background:#2563eb;color:#fff;border:none;padding:10px 14px;border-radius:8px;cursor:pointer;margin-top:10px}small{color:#9ca3af}</style></head><body><header><div>⚙️ Admin</div><button id="logout">Log out</button></header><main><section><h2>Network</h2><div><label>Tick rate (Hz) <input id="tickRate" type="number" min="5" max="240" step="1"></label></div><div><label>Broadcast rate (Hz) <input id="broadcastRate" type="number" min="1" max="240" step="1"></label></div><div><label>Client input send rate (Hz) <input id="inputSendRate" type="number" min="5" max="240" step="1"></label></div><div><label>Server max input accept rate (Hz) <input id="maxInputRate" type="number" min="5" max="500" step="1"></label></div><button id="saveNetwork">Save network</button></section><section><h2>Game defaults</h2><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px 16px"><label>Player radius <input id="playerRadius" type="number" min="8" max="80" step="1"></label><label>Enemy radius <input id="enemyRadius" type="number" min="8" max="80" step="1"></label><label>Player max speed <input id="playerMaxSpeed" type="number" min="80" max="1000" step="1"></label><label>Enemy min speed <input id="enemySpeedMin" type="number" min="40" max="1600" step="1"></label><label>Enemy max speed <input id="enemySpeedMax" type="number" min="40" max="1600" step="1"></label><label>Enemy spawn interval (ms) <input id="enemySpawnIntervalMs" type="number" min="200" max="60000" step="50"></label><label>Friction (0-1) <input id="friction" type="number" min="0.5" max="0.99" step="0.01"></label><label>Points to win <input id="pointsToWin" type="number" min="10" max="10000" step="1"></label></div><div><label><input id="applyToRooms" type="checkbox" checked> Apply to idle rooms now</label></div><button id="saveDefaults">Save defaults</button><div><small>Defaults apply to new rooms. Optionally updates rooms not in a running round.</small></div></section></main><script src="/admin/app.js"></script></body></html>`);
});

app.get('/admin/app.js', requireAdmin, (_req, res) => {
	res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
	res.end(`(function(){async function fetchCfg(){const r=await fetch('/api/admin/config');return r.json()}function setVal(id,v){const el=document.getElementById(id);if(el) el.value=v}function num(id){const v=Number(document.getElementById(id).value);return Number.isFinite(v)?v:undefined}async function load(){const cfg=await fetchCfg();setVal('tickRate',cfg.network.tickRateHz);setVal('broadcastRate',cfg.network.broadcastRateHz);setVal('inputSendRate',cfg.network.inputSendRateHz);setVal('maxInputRate',cfg.network.maxInputRateHz);const d=cfg.defaults;['playerRadius','enemyRadius','playerMaxSpeed','enemySpeedMin','enemySpeedMax','enemySpawnIntervalMs','pointsToWin'].forEach(k=>setVal(k,d[k]));setVal('friction',d.friction)}document.getElementById('logout').onclick=async()=>{await fetch('/admin/logout',{method:'POST'});location.href='/admin'};document.getElementById('saveNetwork').onclick=async()=>{const payload={network:{tickRateHz:num('tickRate'),broadcastRateHz:num('broadcastRate'),inputSendRateHz:num('inputSendRate'),maxInputRateHz:num('maxInputRate')}};await fetch('/api/admin/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});alert('Network updated')};document.getElementById('saveDefaults').onclick=async()=>{const payload={defaults:{playerRadius:num('playerRadius'),enemyRadius:num('enemyRadius'),playerMaxSpeed:num('playerMaxSpeed'),enemySpeedMin:num('enemySpeedMin'),enemySpeedMax:num('enemySpeedMax'),enemySpawnIntervalMs:num('enemySpawnIntervalMs'),friction:Number(document.getElementById('friction').value),pointsToWin:num('pointsToWin')},applyToRooms:document.getElementById('applyToRooms').checked};await fetch('/api/admin/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});alert('Defaults updated')};load();})();`);
});

app.post('/admin/login', (req, res) => {
	const pw = (req.body && req.body.password) || '';
	if (typeof pw !== 'string') return res.status(400).json({ ok: false });
	const ok = bcrypt.compareSync(pw, ADMIN_PASSWORD_HASH);
	if (!ok) return res.status(401).json({ ok: false });
	res.cookie('admin', '1', {
		signed: true,
		httpOnly: true,
		sameSite: 'lax',
		secure: process.env.NODE_ENV === 'production',
		maxAge: 7 * 24 * 60 * 60 * 1000,
	});
	res.json({ ok: true });
});

app.post('/admin/logout', (req, res) => {
	res.clearCookie('admin');
	res.json({ ok: true });
});

app.get('/api/admin/config', requireAdmin, (_req, res) => {
	res.json({
		defaults: DEFAULTS,
		network: { tickRateHz: TICK_RATE, broadcastRateHz: BROADCAST_RATE, inputSendRateHz: NET_CONFIG.inputSendRateHz, maxInputRateHz: NET_CONFIG.maxInputRateHz },
	});
});

app.post('/api/admin/config', requireAdmin, (req, res) => {
	const p = req.body || {};
	if (p.defaults && typeof p.defaults === 'object') {
		const d = p.defaults;
		function applyFinite(key, value, min, max, round = true) {
			if (typeof value !== 'number' || !Number.isFinite(value)) return;
			const v = round ? Math.round(value) : value;
			DEFAULTS[key] = Math.max(min, Math.min(max, v));
		}
		applyFinite('playerRadius', d.playerRadius, 8, 80, true);
		applyFinite('enemyRadius', d.enemyRadius, 8, 80, true);
		applyFinite('playerMaxSpeed', d.playerMaxSpeed, 80, 1000, true);
		applyFinite('enemySpeedMin', d.enemySpeedMin, 40, 1600, true);
		applyFinite('enemySpeedMax', d.enemySpeedMax, 40, 1600, true);
		applyFinite('enemySpawnIntervalMs', d.enemySpawnIntervalMs, 200, 60000, true);
		if (typeof d.friction === 'number' && Number.isFinite(d.friction)) DEFAULTS.friction = Math.max(0.5, Math.min(0.99, d.friction));
		applyFinite('pointsToWin', d.pointsToWin, 10, 10000, true);
		if (DEFAULTS.enemySpeedMax < DEFAULTS.enemySpeedMin) DEFAULTS.enemySpeedMax = DEFAULTS.enemySpeedMin;
	}
	if (p.applyToRooms) {
		for (const room of rooms.values()) {
			if (!room.roundRunning) {
				const s = room.settings;
				Object.assign(s, {
					playerRadius: DEFAULTS.playerRadius,
					enemyRadius: DEFAULTS.enemyRadius,
					playerMaxSpeed: DEFAULTS.playerMaxSpeed,
					enemySpeedMin: DEFAULTS.enemySpeedMin,
					enemySpeedMax: DEFAULTS.enemySpeedMax,
					enemySpawnIntervalMs: DEFAULTS.enemySpawnIntervalMs,
					friction: DEFAULTS.friction,
					pointsToWin: DEFAULTS.pointsToWin,
				});
				s.playerAccel = Math.max(400, Math.min(4000, Math.round(s.playerMaxSpeed * 3.5)));
				io.to(room.id).emit('settingsUpdated', { settings: room.settings });
			}
		}
	}
	if (p.network && typeof p.network === 'object') {
		const n = p.network;
		function applyHz(v, min, max) { return (typeof v === 'number' && Number.isFinite(v)) ? Math.max(min, Math.min(max, Math.round(v))) : undefined; }
		const tr = applyHz(n.tickRateHz, 5, 240);
		const br = applyHz(n.broadcastRateHz, 1, 240);
		const inHz = applyHz(n.inputSendRateHz, 5, 240);
		const maxInHz = applyHz(n.maxInputRateHz, 5, 500);
		if (typeof tr === 'number') TICK_RATE = tr;
		if (typeof br === 'number') BROADCAST_RATE = br;
		if (typeof inHz === 'number') NET_CONFIG.inputSendRateHz = inHz;
		if (typeof maxInHz === 'number') NET_CONFIG.maxInputRateHz = maxInHz;
		restartLoops();
		io.emit('serverConfig', { tickRateHz: TICK_RATE, broadcastRateHz: BROADCAST_RATE, inputSendRateHz: NET_CONFIG.inputSendRateHz, maxInputRateHz: NET_CONFIG.maxInputRateHz });
	}
	res.json({ ok: true });
});

// Game loops (dynamic)
let tickInterval = null;
let broadcastInterval = null;
function restartLoops() {
	if (tickInterval) clearInterval(tickInterval);
	if (broadcastInterval) clearInterval(broadcastInterval);
	tickInterval = setInterval(() => {
		const dt = 1 / TICK_RATE;
		for (const room of rooms.values()) {
			if (room.roundRunning) tickPhysics(room, dt);
		}
	}, Math.floor(1000 / TICK_RATE));
	broadcastInterval = setInterval(() => {
		for (const room of rooms.values()) {
			io.to(room.id).volatile.emit('state', buildState(room));
		}
	}, Math.floor(1000 / BROADCAST_RATE));
}
restartLoops();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
	console.log(`Server listening on http://localhost:${PORT}`);
});
