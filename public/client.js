(() => {
	const canvas = document.getElementById('game');
	const ctx = canvas.getContext('2d');
	const menu = document.getElementById('menu');
	const nameInput = document.getElementById('nameInput');
	const createBtn = document.getElementById('createBtn');
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
	const applySettings = document.getElementById('applySettings');
	const enemyCountEl = document.getElementById('enemyCount');

	let socket = null;
	let myId = null;
	let state = null;
	let input = { x: 0, y: 0 };
	let worldWidth = 900;
	let worldHeight = 1600;
	let editingSettings = false;
	let pendingSettings = null;
	let settingsInitialized = false;

	function resizeCanvas() {
		const dpr = window.devicePixelRatio || 1;
		canvas.width = Math.floor(window.innerWidth * dpr);
		canvas.height = Math.floor(window.innerHeight * dpr);
		canvas.style.width = window.innerWidth + 'px';
		canvas.style.height = window.innerHeight + 'px';
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	}
	window.addEventListener('resize', resizeCanvas);
	resizeCanvas();

	function connect() {
		socket = io();
		socket.on('init', (data) => {
			myId = data.id;
			if (nameInput.value.trim()) socket.emit('setName', nameInput.value.trim());
		});
		socket.on('roomJoined', ({ roomId, hostId }) => {
			menu.style.display = 'none';
			roomInfo.textContent = `Room: ${roomId}`;
			settingsInitialized = false; // new room → re-init when state arrives
			updateHostControls(hostId);
		});
		socket.on('roomError', ({ message }) => {
			alert(message || 'Room error');
		});
		socket.on('state', (s) => {
			state = s;
			worldWidth = s.world.width;
			worldHeight = s.world.height;
			updateScoreboard();
			updateAnnouncement();
			updateHostControls(s.hostId);
			if (!pendingSettings && !settingsInitialized) {
				prefillSettings();
				settingsInitialized = true;
			}
			updateEnemyCount();
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
		}
		const disabled = !!state.roundRunning;
		[setPlayerRadius, setEnemyRadius, setPlayerMaxSpeed, setEnemyMin, setEnemyMax, setSpawnMs, applySettings]
			.forEach(el => el.disabled = disabled);
	}

	function updateEnemyCount() {
		if (!state || !enemyCountEl) return;
		enemyCountEl.textContent = `Enemies: ${state.enemies.length}`;
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
		} else {
			announcementEl.textContent = '';
		}
	}

	function worldToScreenX(x) {
		const scale = Math.min(canvas.clientWidth / worldWidth, canvas.clientHeight / worldHeight);
		const viewW = worldWidth * scale;
		const offsetX = (canvas.clientWidth - viewW) / 2;
		return offsetX + x * scale;
	}
	function worldToScreenY(y) {
		const scale = Math.min(canvas.clientWidth / worldWidth, canvas.clientHeight / worldHeight);
		const viewH = worldHeight * scale;
		const offsetY = (canvas.clientHeight - viewH) / 2;
		return offsetY + y * scale;
	}
	function radiusToScreen(r) {
		const scale = Math.min(canvas.clientWidth / worldWidth, canvas.clientHeight / worldHeight);
		return r * scale;
	}

	function draw() {
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.fillStyle = '#0b132b';
		ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
		if (!state) return requestAnimationFrame(draw);

		const scale = Math.min(canvas.clientWidth / worldWidth, canvas.clientHeight / worldHeight);
		const viewW = worldWidth * scale;
		const viewH = worldHeight * scale;
		const offsetX = (canvas.clientWidth - viewW) / 2;
		const offsetY = (canvas.clientHeight - viewH) / 2;
		ctx.strokeStyle = 'rgba(255,255,255,0.1)';
		ctx.strokeRect(offsetX, offsetY, viewW, viewH);

		for (const e of state.enemies) {
			ctx.beginPath();
			ctx.fillStyle = e.color || '#e63946';
			ctx.arc(worldToScreenX(e.x), worldToScreenY(e.y), radiusToScreen(e.r), 0, Math.PI * 2);
			ctx.fill();
		}

		for (const p of state.players) {
			const isMe = p.id === myId;
			ctx.beginPath();
			ctx.fillStyle = p.alive ? p.color : 'rgba(200,200,200,0.4)';
			ctx.arc(worldToScreenX(p.x), worldToScreenY(p.y), radiusToScreen(p.r), 0, Math.PI * 2);
			ctx.fill();
			ctx.fillStyle = '#fff';
			ctx.font = '12px system-ui, sans-serif';
			ctx.textAlign = 'center';
			ctx.fillText((isMe ? 'YOU - ' : '') + p.name, worldToScreenX(p.x), worldToScreenY(p.y) - radiusToScreen(p.r) - 6);
		}

		requestAnimationFrame(draw);
	}
	requestAnimationFrame(draw);

	connect();

	function ensureName() {
		if (nameInput.value.trim()) socket.emit('setName', nameInput.value.trim());
	}

	createBtn.addEventListener('click', () => {
		ensureName();
		socket.emit('createRoom');
	});
	joinBtn.addEventListener('click', () => {
		ensureName();
		const code = roomInput.value.trim().toUpperCase();
		if (!code) return alert('Enter room code');
		socket.emit('joinRoom', { roomId: code });
	});
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
		if (payload.enemySpeedMin !== undefined && payload.enemySpeedMax !== undefined && payload.enemySpeedMax < payload.enemySpeedMin) {
			payload.enemySpeedMax = payload.enemySpeedMin;
		}
		pendingSettings = payload;
		settingsInitialized = true; // freeze current inputs until ack
		socket.emit('updateSettings', payload);
	});

	const keys = new Set();
	function recomputeKeyboardInput() {
		let x = 0, y = 0;
		if (keys.has('ArrowLeft') || keys.has('a')) x -= 1;
		if (keys.has('ArrowRight') || keys.has('d')) x += 1;
		if (keys.has('ArrowUp') || keys.has('w')) y -= 1;
		if (keys.has('ArrowDown') || keys.has('s')) y += 1;
		const len = Math.hypot(x, y) || 1;
		input.x = x / len; input.y = y / len;
		if (socket) socket.emit('input', input);
	}
	window.addEventListener('keydown', (e) => { keys.add(e.key); recomputeKeyboardInput(); });
	window.addEventListener('keyup', (e) => { keys.delete(e.key); recomputeKeyboardInput(); });

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
		if (socket) socket.emit('input', input);
	}
	function centerStick() {
		stick.style.transform = 'translate(0,0)';
		input = { x: 0, y: 0 };
		if (socket) socket.emit('input', input);
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
})();
