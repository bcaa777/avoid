(() => {
	const canvas = document.getElementById('game');
	const ctx = canvas.getContext('2d');
	const menu = document.getElementById('menu');
	const nameInput = document.getElementById('nameInput');
	const emojiInput = document.getElementById('emojiInput');
	const createBtn = document.getElementById('createBtn');
	const publicToggle = document.getElementById('publicToggle');
	const refreshRoomsBtn = document.getElementById('refreshRooms');
	const roomsList = document.getElementById('roomsList');
	const joinBtn = document.getElementById('joinBtn');
	const roomInput = document.getElementById('roomInput');
	const scoreboardEl = document.getElementById('scoreboard');
	const announcementEl = document.getElementById('announcement');
	const joystick = document.getElementById('joystick');
	const stick = document.getElementById('stick');
	const roomInfo = document.getElementById('roomInfo');
	const startBtn = document.getElementById('startBtn');
	const hostControls = document.getElementById('hostControls');
	const settingsToggle = document.getElementById('settingsToggle');
	const settingsPanel = document.getElementById('settingsPanel');
	const setPlayerRadius = document.getElementById('setPlayerRadius');
	const setEnemyRadius = document.getElementById('setEnemyRadius');
	const setPlayerMaxSpeed = document.getElementById('setPlayerMaxSpeed');
	const setEnemyMin = document.getElementById('setEnemyMin');
	const setEnemyMax = document.getElementById('setEnemyMax');
	const setSpawnMs = document.getElementById('setSpawnMs');
	const setPointsToWin = document.getElementById('setPointsToWin');
	const applySettings = document.getElementById('applySettings');
	const enemyCountEl = document.getElementById('enemyCount');
	const victoryPanel = document.getElementById('victoryPanel');
	const victoryList = document.getElementById('victoryList');
	const restartGameBtn = document.getElementById('restartGame');
	const dashBtn = document.getElementById('dashBtn');

	// Prefill emoji from localStorage and send updates immediately when changed
	function sendEmoji() {
		if (!socket || !emojiInput) return;
		const val = (emojiInput.value || '').trim();
		if (!val) return;
		localStorage.setItem('playerEmoji', val);
		socket.emit('setEmoji', val);
	}
	if (emojiInput) {
		const savedEmoji = localStorage.getItem('playerEmoji');
		if (savedEmoji && !emojiInput.value) emojiInput.value = savedEmoji;
		emojiInput.addEventListener('input', sendEmoji);
		emojiInput.addEventListener('change', sendEmoji);
	}

	let socket = null;
	let myId = null;
	let state = null;
	let serverClockSkewMs = 0;
	let input = { x: 0, y: 0 };
	let worldWidth = 900;
	let worldHeight = 1200;
	let editingSettings = false;
	let pendingSettings = null;
	let settingsInitialized = false;
	// Visual effect state
	let prevState = null;
	let currentShake = { x: 0, y: 0 };
	const particles = [];
	let lastGameOverAt = 0;
	let lastExplosionIds = new Set();
	let lastGoUntil = 0;
	// Postprocess glow buffer
	const glowCanvas = document.createElement('canvas');
	const glowCtx = glowCanvas.getContext('2d');

	function resizeCanvas() {
		const dpr = window.devicePixelRatio || 1;
		canvas.width = Math.floor(window.innerWidth * dpr);
		canvas.height = Math.floor(window.innerHeight * dpr);
		canvas.style.width = window.innerWidth + 'px';
		canvas.style.height = window.innerHeight + 'px';
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		// glow buffer in CSS pixels to match drawing coordinates
		glowCanvas.width = canvas.clientWidth;
		glowCanvas.height = canvas.clientHeight;
	}
	window.addEventListener('resize', resizeCanvas);
	resizeCanvas();

	function connect() {
		socket = io();
		socket.on('init', (data) => {
			myId = data.id;
			if (data && typeof data.serverTime === 'number') {
				serverClockSkewMs = (data.serverTime - Date.now());
			}
			if (nameInput.value.trim()) socket.emit('setName', nameInput.value.trim());
			if (emojiInput && emojiInput.value.trim()) socket.emit('setEmoji', emojiInput.value.trim());
			else sendEmoji();
		});
		socket.on('roomJoined', ({ roomId, hostId }) => {
			menu.style.display = 'none';
			roomInfo.textContent = `Room: ${roomId}`;
			settingsInitialized = false; // new room → re-init when state arrives
			updateHostControls(hostId);
			document.getElementById('hud').classList.remove('hidden');
			sendEmoji();
		});
		socket.on('roomError', ({ message }) => {
			alert(message || 'Room error');
		});
		socket.on('state', (s) => {
			// Keep previous snapshot for local-only effects
			prevState = state;
			// merge incremental fields into local state
			if (!state) state = s; else {
				state = {
					...state,
					...s,
					// keep existing settings/powerups/points which now come via dedicated events
					settings: state.settings,
					powerups: state.powerups,
					points: state.points,
				};
			}
			worldWidth = s.world.width;
			worldHeight = s.world.height;
			updateScoreboard();
			// Flash GO when freeze just ended
			if (prevState && prevState.freezeUntil && Date.now() < prevState.freezeUntil && (!s.freezeUntil || Date.now() >= s.freezeUntil)) {
				lastGoUntil = Date.now() + 800;
			}
			updateAnnouncement();
			updateHostControls(s.hostId);
			if (!pendingSettings && !settingsInitialized) {
				prefillSettings();
				settingsInitialized = true;
			}
			updateEnemyCount();
			updateTopbarVisibility();
			updateDashButton();
			updateVictoryPanel();
			// Confetti triggers
			triggerEffects(prevState, state);
			// Spawn local particles for pickups and deaths
			spawnPickupAndDeathParticles(prevState, state);
		});
		// snapshots and deltas for powerups/points
		socket.on('powerupSnapshot', ({ powerups }) => {
			if (!state) state = {};
			state.powerups = Array.isArray(powerups) ? powerups : [];
		});
		socket.on('pointSnapshot', ({ points }) => {
			if (!state) state = {};
			state.points = Array.isArray(points) ? points : [];
		});
		socket.on('powerupAdd', (pu) => {
			if (!state) state = {};
			if (!Array.isArray(state.powerups)) state.powerups = [];
			state.powerups.push(pu);
		});
		socket.on('powerupRemove', ({ id }) => {
			if (state && Array.isArray(state.powerups)) state.powerups = state.powerups.filter(p => p.id !== id);
		});
		socket.on('powerupClear', () => {
			if (!state) state = {};
			state.powerups = [];
		});
		socket.on('pointAdd', (pt) => {
			if (!state) state = {};
			if (!Array.isArray(state.points)) state.points = [];
			state.points.push(pt);
		});
		socket.on('pointRemove', ({ id }) => {
			if (state && Array.isArray(state.points)) state.points = state.points.filter(p => p.id !== id);
		});
		socket.on('pointClear', () => {
			if (!state) state = {};
			state.points = [];
		});
		socket.on('settingsUpdated', ({ settings }) => {
			pendingSettings = null;
			if (!settings) return;
			if (!editingSettings) {
				setPlayerRadius.value = settings.playerRadius;
				setEnemyRadius.value = settings.enemyRadius;
				setPlayerMaxSpeed.value = settings.playerMaxSpeed;
				setEnemyMin.value = settings.enemySpeedMin;
				setEnemyMax.value = settings.enemySpeedMax;
				setSpawnMs.value = settings.enemySpawnIntervalMs;
				if (setPointsToWin) setPointsToWin.value = settings.pointsToWin;
			}
			settingsInitialized = true;
		});
	}

	function updateHostControls(hostId) {
		const isHost = hostId === myId;
		hostControls.classList.toggle('hidden', !isHost);
		if (!isHost) settingsPanel.classList.add('hidden');
	}

	function attachEditListeners() {
		[setPlayerRadius, setEnemyRadius, setPlayerMaxSpeed, setEnemyMin, setEnemyMax, setSpawnMs].forEach(el => {
			el.addEventListener('focus', () => editingSettings = true);
			el.addEventListener('blur', () => editingSettings = false);
		});
	}
	attachEditListeners();

	function prefillSettings() {
		if (!state || !state.settings) return;
		if (!editingSettings) {
			setPlayerRadius.value = state.settings.playerRadius;
			setEnemyRadius.value = state.settings.enemyRadius;
			setPlayerMaxSpeed.value = state.settings.playerMaxSpeed;
			setEnemyMin.value = state.settings.enemySpeedMin;
			setEnemyMax.value = state.settings.enemySpeedMax;
			setSpawnMs.value = state.settings.enemySpawnIntervalMs;
			if (setPointsToWin) setPointsToWin.value = state.settings.pointsToWin;
		}
		const disabled = !!state.roundRunning;
		[setPlayerRadius, setEnemyRadius, setPlayerMaxSpeed, setEnemyMin, setEnemyMax, setSpawnMs, setPointsToWin, applySettings]
			.forEach(el => el.disabled = disabled);
	}

	function updateEnemyCount() {
		if (!state || !enemyCountEl) return;
		enemyCountEl.textContent = `Enemies: ${state.enemies.length}`;
		// Announcement handled in updateAnnouncement()
	}

	function updateScoreboard() {
		if (!state) return;
		const sorted = [...state.players].sort((a, b) => b.score - a.score);
		scoreboardEl.innerHTML = sorted.map(p => {
			const me = p.id === myId;
			return `<div><span style="color:${p.color};">●</span> ${me ? '<b>' + p.name + '</b>' : p.name}: ${p.score}</div>`;
		}).join('');
	}
	function updateAnnouncement() {
		if (!state) return;
		if (state.winnerAnnouncementUntil && Date.now() < state.winnerAnnouncementUntil) {
			const alive = state.players.filter(p => p.alive);
			const msg = alive.length === 1 ? `${alive[0].name} scores!` : 'Round over';
			announcementEl.textContent = msg;
		} else if (!state.roundRunning) {
			announcementEl.textContent = 'Waiting for host to start...';
		} else if (state.freezeUntil && Date.now() < state.freezeUntil) {
			const remain = Math.ceil((state.freezeUntil - Date.now()) / 1000);
			const text = remain >= 3 ? '3' : remain === 2 ? '2' : remain === 1 ? '1' : 'GO';
			announcementEl.textContent = `${text}`;
		} else if (Date.now() < lastGoUntil) {
			announcementEl.textContent = 'GO';
		} else {
			announcementEl.textContent = '';
		}
	}

	function safeInsets() {
		const top = 0;
		const bottom = 0;
		const left = 0;
		const right = 0;
		return { top, bottom, left, right };
	}

	function computeView() {
		const insets = safeInsets();
		const availW = canvas.clientWidth - (insets.left + insets.right);
		const availH = canvas.clientHeight - (insets.top + insets.bottom);
		// Prefer width-based scaling to maximize horizontal usage
		let scale = availW / worldWidth;
		let viewW = worldWidth * scale;
		let viewH = worldHeight * scale;
		if (viewH > availH) {
			// fallback to height if overflow
			scale = availH / worldHeight;
			viewW = worldWidth * scale;
			viewH = worldHeight * scale;
		}
		const offsetX = insets.left + (availW - viewW) / 2;
		const offsetY = insets.top + (availH - viewH) / 2;
		return { scale, viewW, viewH, offsetX, offsetY };
	}

	function updateTopbarVisibility() {
		if (!state) return;
		const running = !!state.roundRunning;
		const host = document.getElementById('hostControls');
		const room = document.getElementById('roomInfo');
		const settingsBtn = document.getElementById('settingsToggle');
		if (running || state.gameOver) {
			room.classList.add('hide-during-round');
			host.classList.add('hide-during-round');
			settingsBtn.classList.add('hide-during-round');
		} else {
			room.classList.remove('hide-during-round');
			host.classList.remove('hide-during-round');
			settingsBtn.classList.remove('hide-during-round');
		}
	}

	function updateDashButton() {
		if (!dashBtn || !state) return;
		const me = (state.players || []).find(p => p.id === myId);
		if (!me) { dashBtn.textContent = 'Dash'; dashBtn.disabled = true; return; }
		const now = (state.now || Date.now()) - serverClockSkewMs;
		const readyAt = me.dashReadyAt || 0;
		const ready = now >= readyAt;
		dashBtn.disabled = !ready;
		dashBtn.textContent = ready ? 'Dash' : 'Recharging…';
	}

	function updateVictoryPanel() {
		if (!state) return;
		if (state.gameOver) {
			victoryPanel.classList.remove('hidden');
			const list = (state.finalStandings || []).map((p, idx) => {
				const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `${idx + 1}.`;
				return `<div>${medal} ${p.name} — ${p.score}</div>`;
			}).join('');
			victoryList.innerHTML = list || '<div>No players</div>';
			// Enable restart for host only
			restartGameBtn.disabled = state.hostId !== myId;
		} else {
			victoryPanel.classList.add('hidden');
			victoryList.innerHTML = '';
		}
	}

	function worldToScreenX(x) {
		const v = computeView();
		return v.offsetX + currentShake.x + x * v.scale;
	}
	function worldToScreenY(y) {
		const v = computeView();
		return v.offsetY + currentShake.y + y * v.scale;
	}
	function radiusToScreen(r) {
		const v = computeView();
		return r * v.scale;
	}

	// ===== Visual helpers =====
	function roundRectPath(x, y, w, h, r) {
		const rr = Math.min(r, Math.min(w, h) / 2);
		ctx.beginPath();
		ctx.moveTo(x + rr, y);
		ctx.arcTo(x + w, y, x + w, y + h, rr);
		ctx.arcTo(x + w, y + h, x, y + h, rr);
		ctx.arcTo(x, y + h, x, y, rr);
		ctx.arcTo(x, y, x + w, y, rr);
		ctx.closePath();
	}

	function drawWorldBackground() {
		const v = computeView();
		const x = v.offsetX + currentShake.x;
		const y = v.offsetY + currentShake.y;
		const w = v.viewW;
		const h = v.viewH;
		// Panel background
		const grad = ctx.createLinearGradient(x, y, x + w, y + h);
		grad.addColorStop(0, 'rgba(255,255,255,0.04)');
		grad.addColorStop(1, 'rgba(0,0,0,0.10)');
		ctx.save();
		roundRectPath(x, y, w, h, Math.max(12, Math.min(w, h) * 0.02));
		ctx.fillStyle = grad;
		ctx.fill();
		ctx.strokeStyle = 'rgba(255,255,255,0.10)';
		ctx.lineWidth = 2;
		ctx.stroke();
		// Subtle grid
		ctx.clip();
		ctx.strokeStyle = 'rgba(255,255,255,0.06)';
		ctx.lineWidth = 1;
		const lines = 14;
		for (let i = 1; i < lines; i++) {
			const xx = x + (w / lines) * i;
			ctx.beginPath(); ctx.moveTo(xx, y); ctx.lineTo(xx, y + h); ctx.stroke();
			const yy = y + (h / lines) * i;
			ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(x + w, yy); ctx.stroke();
		}
		// Vignette
		const vg = ctx.createRadialGradient(x + w / 2, y + h / 2, Math.min(w, h) * 0.4, x + w / 2, y + h / 2, Math.max(w, h) * 0.7);
		vg.addColorStop(0, 'rgba(0,0,0,0)');
		vg.addColorStop(1, 'rgba(0,0,0,0.20)');
		ctx.fillStyle = vg;
		ctx.fillRect(x, y, w, h);
		ctx.restore();
	}

	function drawPowerup(pu) {
		const x = worldToScreenX(pu.x);
		const y = worldToScreenY(pu.y);
		const r = radiusToScreen(pu.r);
		ctx.save();
		switch (pu.type) {
			case 'freeze':
				ctx.fillStyle = '#60a5fa';
				break;
			case 'speed':
				ctx.fillStyle = '#22c55e';
				break;
			case 'immortal':
				ctx.fillStyle = '#f59e0b';
				break;
			case 'bomb':
				ctx.fillStyle = '#ef4444';
				break;
			case 'shrink':
				ctx.fillStyle = '#a78bfa';
				break;
		}
		ctx.beginPath();
		ctx.arc(x, y, r, 0, Math.PI * 2);
		ctx.fill();
		// icon
		ctx.fillStyle = '#0b132b';
		ctx.font = `${Math.max(10, r)}px sans-serif`;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		const icon = pu.type === 'freeze' ? '❄' : pu.type === 'speed' ? '⚡' : pu.type === 'bomb' ? '💣' : pu.type === 'shrink' ? '⇲' : '⛨';
		ctx.fillText(icon, x, y + 1);
		ctx.restore();
	}

	function drawExplosions() {
		if (!state || !state.explosions) return;
		const now = Date.now();
		for (const ex of state.explosions) {
			const age = now - ex.createdAt;
			const life = 900; // longer lifetime
			if (age < 0 || age > life) continue;
			const t = age / life;
			const alpha = 1 - t;
			const baseR = radiusToScreen(ex.radius);
			const ringR = baseR * (0.9 + 0.3 * t);
			ctx.save();
			ctx.strokeStyle = `rgba(239,68,68,${Math.max(0, alpha)})`;
			ctx.lineWidth = Math.max(2, 8 * (1 - t));
			ctx.beginPath();
			ctx.arc(worldToScreenX(ex.x), worldToScreenY(ex.y), ringR, 0, Math.PI * 2);
			ctx.stroke();
			ctx.restore();
		}
	}

	function drawHitbox(x, y, radius, color) {
		ctx.save();
		ctx.beginPath();
		ctx.arc(x, y, radius, 0, Math.PI * 2);
		ctx.strokeStyle = color;
		ctx.lineWidth = Math.max(2, Math.floor(radius * 0.15));
		ctx.stroke();
		ctx.restore();
	}

	// Glowing orb under emojis
	function drawGlowingOrb(x, y, r, fillColor, glowColor) {
		ctx.save();
		// base glow + fill (reduced blur for clearer center)
		ctx.shadowColor = glowColor;
		ctx.shadowBlur = Math.max(6, r * 0.5);
		ctx.fillStyle = fillColor;
		ctx.beginPath();
		ctx.arc(x, y, r, 0, Math.PI * 2);
		ctx.fill();
		// bloom overlay (softer)
		const rg = ctx.createRadialGradient(x, y, Math.max(1, r * 0.18), x, y, r);
		rg.addColorStop(0, 'rgba(255,255,255,0.12)');
		rg.addColorStop(1, 'rgba(255,255,255,0)');
		ctx.fillStyle = rg;
		ctx.beginPath();
		ctx.arc(x, y, r, 0, Math.PI * 2);
		ctx.fill();
		// subtle rim light
		ctx.shadowBlur = 0;
		ctx.strokeStyle = 'rgba(255,255,255,0.22)';
		ctx.lineWidth = Math.max(1, r * 0.07);
		ctx.beginPath();
		ctx.arc(x, y, r, 0, Math.PI * 2);
		ctx.stroke();
		ctx.restore();
	}

	// Particles
	function spawnBurst(screenX, screenY, color, count = 14) {
		for (let i = 0; i < count; i++) {
			const a = Math.random() * Math.PI * 2;
			const sp = 1 + Math.random() * 3;
			particles.push({
				x: screenX,
				y: screenY,
				vx: Math.cos(a) * sp,
				vy: Math.sin(a) * sp,
				life: 600 + Math.random() * 300,
				age: 0,
				size: 2 + Math.random() * 2,
				color,
			});
		}
	}
	function updateAndDrawParticles(dtMs) {
		for (let i = particles.length - 1; i >= 0; i--) {
			const p = particles[i];
			p.age += dtMs;
			if (p.age >= p.life) { particles.splice(i, 1); continue; }
			p.x += p.vx;
			p.y += p.vy;
			p.vx *= 0.98; p.vy *= 0.98;
			const t = p.age / p.life;
			ctx.save();
			ctx.globalAlpha = 1 - t;
			ctx.fillStyle = p.color;
			ctx.beginPath();
			ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
			ctx.fill();
			ctx.restore();
		}
	}

	function spawnPickupAndDeathParticles(prev, curr) {
		if (!prev || !curr) return;
		// Points removed (picked or expired)
		const prevPts = new Map((prev.points || []).map(pt => [pt.id, pt]));
		for (const pt of (curr.points || [])) prevPts.delete(pt.id);
		for (const gone of prevPts.values()) {
			const x = worldToScreenX(gone.x); const y = worldToScreenY(gone.y);
			const col = (gone.value || 1) >= 5 ? '#f472b6' : (gone.value || 1) >= 2 ? '#fb923c' : '#fde047';
			spawnBurst(x, y, col, 18);
			// confetti for big point
			if (typeof confetti === 'function' && (gone.value || 1) >= 5) {
				confetti({ particleCount: 18, spread: 30, startVelocity: 25, origin: { x: x / canvas.clientWidth, y: y / canvas.clientHeight } });
			}
		}
		// Powerups removed (picked or expired)
		const prevPu = new Map((prev.powerups || []).map(pu => [pu.id, pu]));
		for (const pu of (curr.powerups || [])) prevPu.delete(pu.id);
		for (const gone of prevPu.values()) {
			const x = worldToScreenX(gone.x); const y = worldToScreenY(gone.y);
			const col = gone.type === 'freeze' ? '#60a5fa' : gone.type === 'speed' ? '#22c55e' : gone.type === 'bomb' ? '#ef4444' : gone.type === 'shrink' ? '#a78bfa' : '#f59e0b';
			spawnBurst(x, y, col, 16);
			if (typeof confetti === 'function') {
				confetti({ particleCount: 16, spread: 20, startVelocity: 20, scalar: 0.6, origin: { x: x / canvas.clientWidth, y: y / canvas.clientHeight } });
			}
		}
		// Player deaths
		const prevPl = new Map((prev.players || []).map(p => [p.id, p]));
		for (const cur of (curr.players || [])) {
			const old = prevPl.get(cur.id);
			if (old && old.alive && !cur.alive) {
				const x = worldToScreenX(cur.x); const y = worldToScreenY(cur.y);
				spawnBurst(x, y, '#ef4444', 20);
			}
		}
	}

	function triggerEffects(prev, curr) {
		if (!curr) return;
		// Game over confetti fanfare (once per game)
		if (curr.gameOver) {
			const now = Date.now();
			if (now - lastGameOverAt > 2000 && typeof confetti === 'function') {
				lastGameOverAt = now;
				const duration = 1200;
				const end = now + duration;
				(function frame() {
					confetti({ particleCount: 2, angle: 60, spread: 55, origin: { x: 0 }, scalar: 0.9 });
					confetti({ particleCount: 2, angle: 120, spread: 55, origin: { x: 1 }, scalar: 0.9 });
					if (Date.now() < end) requestAnimationFrame(frame);
				})();
			}
		}
		// Explosion confetti (subtle paper bits) for new explosions
		const currIds = new Set((curr.explosions || []).map(e => e.id));
		for (const id of currIds) {
			if (!lastExplosionIds.has(id)) {
				const ex = (curr.explosions || []).find(e => e.id === id);
				if (ex && typeof confetti === 'function') {
					const x = worldToScreenX(ex.x) / canvas.clientWidth;
					const y = worldToScreenY(ex.y) / canvas.clientHeight;
					confetti({ particleCount: 12, spread: 40, startVelocity: 18, scalar: 0.5, origin: { x, y } });
				}
			}
		}
		lastExplosionIds = currIds;
	}

	function computeShake() {
		currentShake.x = 0; currentShake.y = 0;
		if (!state || !state.explosions || state.explosions.length === 0) return;
		const now = Date.now();
		let amp = 0;
		for (const ex of state.explosions) {
			const age = now - ex.createdAt;
			const life = 400;
			if (age < 0 || age > life) continue;
			const t = 1 - age / life;
			amp = Math.max(amp, 8 * t);
		}
		if (amp > 0) {
			currentShake.x = (Math.random() * 2 - 1) * amp;
			currentShake.y = (Math.random() * 2 - 1) * amp;
		}
	}

	function renderGlowSources() {
		glowCtx.clearRect(0, 0, glowCanvas.width, glowCanvas.height);
		if (!state) return;
		// world background highlight (reduced)
		const v = computeView();
		glowCtx.save();
		glowCtx.fillStyle = 'rgba(255,255,255,0.02)';
		glowCtx.fillRect(v.offsetX + currentShake.x, v.offsetY + currentShake.y, v.viewW, v.viewH);
		glowCtx.restore();
		// enemies (ring gradient, transparent center)
		for (const e of state.enemies) {
			const x = worldToScreenX(e.x);
			const y = worldToScreenY(e.y);
			const r = Math.max(6, radiusToScreen(e.r));
			const g = glowCtx.createRadialGradient(x, y, Math.max(1, r * 0.45), x, y, r);
			g.addColorStop(0, 'rgba(239,68,68,0)');
			g.addColorStop(0.7, 'rgba(239,68,68,0.75)');
			g.addColorStop(1, 'rgba(239,68,68,0)');
			glowCtx.fillStyle = g;
			glowCtx.beginPath(); glowCtx.arc(x, y, r, 0, Math.PI * 2); glowCtx.fill();
		}
		// powerups (slightly reduced fill)
		for (const pu of (state.powerups || [])) {
			const x = worldToScreenX(pu.x);
			const y = worldToScreenY(pu.y);
			const r = Math.max(5, radiusToScreen(pu.r));
			const colMid = pu.type === 'freeze' ? 'rgba(96,165,250,0.6)' : pu.type === 'speed' ? 'rgba(34,197,94,0.6)' : pu.type === 'bomb' ? 'rgba(239,68,68,0.65)' : pu.type === 'shrink' ? 'rgba(167,139,250,0.6)' : 'rgba(245,158,11,0.6)';
			const g = glowCtx.createRadialGradient(x, y, Math.max(1, r * 0.4), x, y, r);
			g.addColorStop(0, 'rgba(0,0,0,0)');
			g.addColorStop(0.75, colMid);
			g.addColorStop(1, 'rgba(0,0,0,0)');
			glowCtx.fillStyle = g;
			glowCtx.beginPath(); glowCtx.arc(x, y, r, 0, Math.PI * 2); glowCtx.fill();
		}
		// points (reduced)
		for (const pt of (state.points || [])) {
			const x = worldToScreenX(pt.x);
			const y = worldToScreenY(pt.y);
			const r = Math.max(4, radiusToScreen(pt.r));
			const col = pt.value >= 5 ? 'rgba(244,114,182,0.55)' : pt.value >= 2 ? 'rgba(251,146,60,0.52)' : 'rgba(253,224,71,0.5)';
			const g = glowCtx.createRadialGradient(x, y, Math.max(1, r * 0.35), x, y, r);
			g.addColorStop(0, 'rgba(0,0,0,0)');
			g.addColorStop(0.8, col);
			g.addColorStop(1, 'rgba(0,0,0,0)');
			glowCtx.fillStyle = g;
			glowCtx.beginPath(); glowCtx.arc(x, y, r, 0, Math.PI * 2); glowCtx.fill();
		}
		// players (ring gradient using player color)
		for (const p of state.players) {
			const x = worldToScreenX(p.x);
			const y = worldToScreenY(p.y);
			const r = Math.max(6, radiusToScreen(p.r));
			const base = (p.color || 'hsl(140,70%,50%)');
			// try to convert hsl/hsl string to rgba by overlaying a greenish alpha
			const mid = 'rgba(34,197,94,0.68)';
			const g = glowCtx.createRadialGradient(x, y, Math.max(1, r * 0.45), x, y, r);
			g.addColorStop(0, 'rgba(0,0,0,0)');
			g.addColorStop(0.7, mid);
			g.addColorStop(1, 'rgba(0,0,0,0)');
			glowCtx.fillStyle = g;
			glowCtx.beginPath(); glowCtx.arc(x, y, r, 0, Math.PI * 2); glowCtx.fill();
		}
		// explosions (unchanged stroke, but uses postblur)
		for (const ex of (state.explosions || [])) {
			const age = Date.now() - ex.createdAt;
			if (age > 600) continue;
			glowCtx.beginPath();
			glowCtx.strokeStyle = 'rgba(239,68,68,0.75)';
			glowCtx.lineWidth = Math.max(5, radiusToScreen(ex.radius) * 0.18);
			glowCtx.arc(worldToScreenX(ex.x), worldToScreenY(ex.y), Math.max(8, radiusToScreen(ex.radius) * 0.8), 0, Math.PI * 2);
			glowCtx.stroke();
		}
	}

	function compositeGlow() {
		ctx.save();
		ctx.globalCompositeOperation = 'lighter';
		ctx.filter = 'blur(10px)';
		ctx.drawImage(glowCanvas, 0, 0);
		ctx.filter = 'blur(3px)';
		ctx.drawImage(glowCanvas, 0, 0);
		ctx.filter = 'none';
		ctx.globalCompositeOperation = 'source-over';
		ctx.restore();
	}

	function draw() {
		const frameStart = performance.now();
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.fillStyle = '#0b132b';
		ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
		if (!state) return requestAnimationFrame(draw);

		// Camera shake from recent explosions
		computeShake();
		// World background panel
		drawWorldBackground();

		const v = computeView();
		ctx.strokeStyle = 'rgba(255,255,255,0.1)';
		ctx.strokeRect(v.offsetX + currentShake.x, v.offsetY + currentShake.y, v.viewW, v.viewH);

		const now = Date.now();
		for (const e of state.enemies) {
			const protectedNow = e.spawnSafeUntil && now < e.spawnSafeUntil;
			const ex = worldToScreenX(e.x);
			const ey = worldToScreenY(e.y);
			const r = radiusToScreen(e.r);
			// filled glowing orb
			drawGlowingOrb(ex, ey, r, (e.color || '#ef4444'), 'rgba(239,68,68,0.55)');
			if (protectedNow) {
				const pulse = 0.7 + 0.3 * Math.sin(now / 120);
				ctx.save();
				ctx.beginPath();
				ctx.arc(ex, ey, r + 6 * pulse, 0, Math.PI * 2);
				ctx.strokeStyle = `rgba(255,255,255,${0.6 * pulse})`;
				ctx.lineWidth = 2;
				ctx.setLineDash([6, 4]);
				ctx.stroke();
				ctx.setLineDash([]);
				ctx.restore();
			}
			// dark inner backdrop for emoji legibility
			ctx.save();
			ctx.fillStyle = 'rgba(0,0,0,0.28)';
			ctx.beginPath(); ctx.arc(ex, ey, r * 0.62, 0, Math.PI * 2); ctx.fill();
			ctx.restore();
			ctx.save();
			ctx.font = `${Math.max(14, r * 1.6)}px system-ui, apple color emoji, segoe ui emoji`;
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.shadowColor = 'rgba(0,0,0,0.55)';
			ctx.shadowBlur = Math.max(4, r * 0.5);
			ctx.shadowOffsetY = Math.max(1, Math.floor(r * 0.10));
			ctx.shadowOffsetX = 0;
			//ctx.fillText(e.emoji || '👾', ex, ey + 1);
			ctx.restore();
		}

		for (const pu of (state.powerups || [])) {
			const x = worldToScreenX(pu.x);
			const y = worldToScreenY(pu.y);
			const r = radiusToScreen(pu.r);
			drawHitbox(x, y, r, '#eab308');
			const pulse = 0.9 + 0.2 * Math.sin(now / 160 + (pu.id.charCodeAt(0) % 10));
			ctx.save();
			ctx.font = `${Math.max(14, r * 1.8 * pulse)}px system-ui, apple color emoji, segoe ui emoji`;
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.shadowColor = 'rgba(255,255,255,0.35)';
			ctx.shadowBlur = 12;
			const icon = pu.type === 'freeze' ? '❄️' : pu.type === 'speed' ? '⚡' : pu.type === 'bomb' ? '💣' : pu.type === 'shrink' ? '↘️' : '🛡️';
			ctx.fillText(icon, x, y + 1);
			ctx.restore();
		}
		drawExplosions();
		for (const pt of (state.points || [])) {
			const x = worldToScreenX(pt.x);
			const y = worldToScreenY(pt.y);
			const r = radiusToScreen(pt.r);
			// draw circle for visibility
			ctx.beginPath();
			const col = pt.value >= 5 ? '#f472b6' : pt.value >= 2 ? '#fb923c' : '#fde047';
			ctx.fillStyle = col;
			ctx.arc(x, y, r, 0, Math.PI * 2);
			ctx.fill();
			ctx.fillStyle = '#0b132b';
			ctx.font = `${Math.max(12, r)}px system-ui, sans-serif`;
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.fillText('+' + (pt.value || 1), x, y + 1);
		}
		for (const p of state.players) {
			const isMe = p.id === myId;
			const x = worldToScreenX(p.x);
			const y = worldToScreenY(p.y);
			const r = radiusToScreen(p.r);
			// choose color based on alive state
			const fillCol = p.alive ? (p.color || '#22c55e') : '#9ca3af';
			const glowCol = p.alive ? 'rgba(34,197,94,0.5)' : 'rgba(156,163,175,0.5)';
			// filled glowing orb using chosen color
			drawGlowingOrb(x, y, r, fillCol, glowCol);
			// aura effects
			if (p.shield) {
				ctx.beginPath();
				ctx.arc(x, y, r + 6, 0, Math.PI * 2);
				ctx.strokeStyle = '#f59e0b';
				ctx.lineWidth = 3;
				ctx.stroke();
			}
			if (p.speedBoostUntil && now < p.speedBoostUntil) {
				ctx.beginPath();
				ctx.arc(x, y, r + 10, 0, Math.PI * 2);
				ctx.strokeStyle = '#22c55e';
				ctx.lineWidth = 2;
				ctx.setLineDash([6, 4]);
				ctx.stroke();
				ctx.setLineDash([]);
			}
			// dark inner backdrop for emoji legibility
			ctx.save();
			ctx.fillStyle = 'rgba(0,0,0,0.28)';
			ctx.beginPath(); ctx.arc(x, y, r * 0.62, 0, Math.PI * 2); ctx.fill();
			ctx.restore();
			// draw player emoji with stronger drop shadow onto circle
			ctx.save();
			ctx.font = `${Math.max(16, r * 1.6)}px system-ui, apple color emoji, segoe ui emoji`;
			ctx.textAlign = 'center';
			ctx.shadowColor = 'rgba(0,0,0,0.6)';
			ctx.shadowBlur = Math.max(4, r * 0.5);
			ctx.shadowOffsetY = Math.max(1, Math.floor(r * 0.10));
			ctx.shadowOffsetX = 0;
			ctx.fillText(p.emoji || '🙂', x, y + 1);
			ctx.restore();
			ctx.fillStyle = p.alive ? '#fff' : '#cbd5e1';
			ctx.font = '12px system-ui, sans-serif';
			ctx.textAlign = 'center';
			ctx.fillText((isMe ? 'YOU - ' : '') + p.name, x, y - r - 6);
		}

		// Postprocess glow compose
		renderGlowSources();
		compositeGlow();
		// Draw explosion rings on top for visibility
		drawExplosions();

		// Particles update/draw (approximate dt from frame time)
		const frameEnd = performance.now();
		updateAndDrawParticles(frameEnd - frameStart);

		requestAnimationFrame(draw);
	}
	requestAnimationFrame(draw);

	connect();

	function ensureName() {
		if (nameInput.value.trim()) socket.emit('setName', nameInput.value.trim());
		if (emojiInput && emojiInput.value.trim()) socket.emit('setEmoji', emojiInput.value.trim());
	}

	createBtn.addEventListener('click', () => {
		ensureName();
		const isPublic = !!(publicToggle && publicToggle.checked);
		socket.emit('createRoom', { isPublic });
	});
	joinBtn.addEventListener('click', () => {
		ensureName();
		const code = roomInput.value.trim().toUpperCase();
		if (!code) return alert('Enter room code');
		socket.emit('joinRoom', { roomId: code });
	});

	async function fetchRooms() {
		try {
			const res = await fetch('/api/rooms');
			const data = await res.json();
			renderRooms(data.rooms || []);
		} catch {}
	}

	function renderRooms(rooms) {
		if (!roomsList) return;
		if (!rooms || rooms.length === 0) {
			roomsList.innerHTML = '<div class="hint">No public rooms yet</div>';
			return;
		}
		roomsList.innerHTML = rooms.map(r => {
			const players = (r.players || []).map(p => `${p.name} (${p.score})`).join(', ');
			const status = r.gameOver ? 'Game over' : (r.roundRunning ? 'In round' : 'Lobby');
			return `<div class="room"><div><div><b>${r.id}</b> · <span class="meta">${status} · ${r.playerCount} players</span></div><div class="meta">${players}</div></div><div><button data-room="${r.id}" class="joinRoomBtn">Join</button></div></div>`;
		}).join('');
		roomsList.querySelectorAll('.joinRoomBtn').forEach(btn => {
			btn.addEventListener('click', () => {
				const rid = btn.getAttribute('data-room');
				if (!rid) return;
				ensureName();
				socket.emit('joinRoom', { roomId: rid });
			});
		});
	}

	if (refreshRoomsBtn) {
		refreshRoomsBtn.addEventListener('click', fetchRooms);
	}
	// Auto-refresh lobby while menu is visible
	let lobbyTimer = null;
	function startLobbyPolling() {
		if (lobbyTimer) return;
		fetchRooms();
		lobbyTimer = setInterval(fetchRooms, 4000);
	}
	function stopLobbyPolling() {
		if (lobbyTimer) { clearInterval(lobbyTimer); lobbyTimer = null; }
	}

	// Start lobby polling immediately on load
	startLobbyPolling();
	startBtn.addEventListener('click', () => {
		socket.emit('hostStart');
	});
	settingsToggle.addEventListener('click', () => {
		settingsPanel.classList.toggle('hidden');
	});
	applySettings.addEventListener('click', () => {
		if (!state) return;
		const payload = {};
		const addIfValid = (key, valStr) => {
			if (valStr === '' || valStr === null || valStr === undefined) return;
			const n = Number(valStr);
			if (Number.isFinite(n)) payload[key] = n;
		};
		addIfValid('playerRadius', setPlayerRadius.value);
		addIfValid('enemyRadius', setEnemyRadius.value);
		addIfValid('playerMaxSpeed', setPlayerMaxSpeed.value);
		addIfValid('enemySpeedMin', setEnemyMin.value);
		addIfValid('enemySpeedMax', setEnemyMax.value);
		addIfValid('enemySpawnIntervalMs', setSpawnMs.value);
		addIfValid('pointsToWin', setPointsToWin && setPointsToWin.value);
		if (payload.enemySpeedMin !== undefined && payload.enemySpeedMax !== undefined && payload.enemySpeedMax < payload.enemySpeedMin) {
			payload.enemySpeedMax = payload.enemySpeedMin;
		}
		pendingSettings = payload;
		settingsInitialized = true; // freeze current inputs until ack
		socket.emit('updateSettings', payload);
		// auto-hide settings panel on apply
		settingsPanel.classList.add('hidden');
	});

	const keys = new Set();
	let lastInputSentAt = 0;
	const INPUT_INTERVAL_MS = Math.floor(1000 / 30);
	function sendThrottledInput() {
		const now = Date.now();
		if (now - lastInputSentAt < INPUT_INTERVAL_MS) return;
		lastInputSentAt = now;
		if (socket) socket.emit('input', input);
	}
	function recomputeKeyboardInput() {
		let x = 0, y = 0;
		if (keys.has('ArrowLeft') || keys.has('KeyA')) x -= 1;
		if (keys.has('ArrowRight') || keys.has('KeyD')) x += 1;
		if (keys.has('ArrowUp') || keys.has('KeyW')) y -= 1;
		if (keys.has('ArrowDown') || keys.has('KeyS')) y += 1;
		const len = Math.hypot(x, y) || 1;
		input.x = x / len; input.y = y / len;
		sendThrottledInput();
	}
	window.addEventListener('keydown', (e) => {
		keys.add(e.code);
		if (e.key === 'Shift' || e.code === 'Space') {
			e.preventDefault();
			if (socket) socket.emit('dash');
		}
		recomputeKeyboardInput();
	});
	window.addEventListener('keyup', (e) => { keys.delete(e.code); recomputeKeyboardInput(); });

	let joyActive = false;
	let joyStart = { x: 0, y: 0 };
	const baseRect = () => joystick.getBoundingClientRect();
	function setStickPos(dx, dy) {
		const maxR = joystick.clientWidth / 2 - stick.clientWidth / 2;
		const len = Math.hypot(dx, dy);
		const scale = len > maxR ? maxR / len : 1;
		stick.style.transform = `translate(${dx * scale}px, ${dy * scale}px)`;
	}
	function sendJoystick(dx, dy) {
		const maxR = joystick.clientWidth / 2;
		const nx = dx / maxR;
		const ny = dy / maxR;
		const len = Math.hypot(nx, ny) || 1;
		input.x = Math.max(-1, Math.min(1, nx / len));
		input.y = Math.max(-1, Math.min(1, ny / len));
		sendThrottledInput();
	}
	function centerStick() {
		stick.style.transform = 'translate(0,0)';
		input = { x: 0, y: 0 };
		sendThrottledInput();
	}

	joystick.addEventListener('pointerdown', (e) => {
		joystick.setPointerCapture(e.pointerId);
		joyActive = true;
		const rect = baseRect();
		joyStart.x = rect.left + rect.width / 2;
		joyStart.y = rect.top + rect.height / 2;
		setStickPos(0, 0);
	});
	joystick.addEventListener('pointermove', (e) => {
		if (!joyActive) return;
		const dx = e.clientX - joyStart.x;
		const dy = e.clientY - joyStart.y;
		setStickPos(dx, dy);
		sendJoystick(dx, dy);
	});
	joystick.addEventListener('pointerup', () => { joyActive = false; centerStick(); });
	joystick.addEventListener('pointercancel', () => { joyActive = false; centerStick(); });

	if (dashBtn) {
		const doDash = () => { if (socket) socket.emit('dash'); };
		dashBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); doDash(); });
		dashBtn.addEventListener('click', (e) => { e.preventDefault(); doDash(); });
	}

	restartGameBtn.addEventListener('click', () => {
		if (!socket) return;
		socket.emit('hostRestartGame');
	});
})();
