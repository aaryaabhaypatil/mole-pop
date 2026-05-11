if (typeof SquidlyAPI === 'undefined') {
  const _db = {};
  const _listeners = {};

  window.SquidlyAPI = {
    addSessionInfoListener: (cb) => cb({ user: 'host-mouse', participantActive: false }),
    firebaseSet: (path, value) => {
      _db[path] = value;
      if (_listeners[path]) _listeners[path].forEach(fn => fn(value));
    },
    firebaseOnValue: (path, cb) => {
      if (!_listeners[path]) _listeners[path] = [];
      _listeners[path].push(cb);
      if (_db[path] !== undefined) cb(_db[path]);
    },
    addCursorListener: () => {},
    setIcon: (x, y, opts, cb) => {
      const key = 'icon_' + Math.random().toString(36).slice(2);
      let toolbar = document.getElementById('_squidly_dev_toolbar');
      if (!toolbar) {
        toolbar = document.createElement('div');
        toolbar.id = '_squidly_dev_toolbar';
        toolbar.style.cssText = `
          position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
          display: flex; gap: 8px; z-index: 9999;
          background: rgba(0,0,0,0.6); padding: 8px 14px; border-radius: 10px;
          font-family: sans-serif;
        `;
        document.body.appendChild(toolbar);
      }
      const btn = document.createElement('button');
      btn.dataset.iconKey = key;
      btn.textContent = opts.displayValue;
      btn.style.cssText = `
        padding: 6px 14px; border-radius: 6px; border: none; cursor: pointer;
        font-size: 14px; font-weight: 600;
        background: ${opts.type === 'lightGreen' ? '#4caf50' : opts.type === 'action' ? '#e53935' : '#1976d2'};
        color: #fff;
      `;
      btn.addEventListener('click', cb);
      toolbar.appendChild(btn);
      return key;
    },
    removeIcon: (key) => {
      const btn = document.querySelector(`[data-icon-key="${key}"]`);
      if (btn) btn.remove();
    },
    setGridSize: () => {},
    setSettings: () => {},
    getSettings: (path, cb) => cb(null),
    addSettingsListener: () => {},
  };
  console.info('[Dev] SquidlyAPI mock active — running as host');
}

const board       = document.getElementById('board');
const scoreEl     = document.getElementById('score-el');
const timeEl      = document.getElementById('time-el');
const levelEl     = document.getElementById('level-el');
const overlay     = document.getElementById('overlay');
const cursorEl    = document.getElementById('cursor');
const banner      = document.getElementById('level-banner');
const progressBar = document.getElementById('progress-bar');
const progressLbl = document.getElementById('progress-label');

const LEVELS = [
  { holes: 4,  hitsToAdvance: 3,  moleTime: 3000, timeLimit: 45 },
  { holes: 4,  hitsToAdvance: 5,  moleTime: 2500, timeLimit: 45 },
  { holes: 6,  hitsToAdvance: 7,  moleTime: 2000, timeLimit: 50 },
  { holes: 6,  hitsToAdvance: 10, moleTime: 1800, timeLimit: 50 },
  { holes: 8,  hitsToAdvance: 12, moleTime: 1500, timeLimit: 60 }, // 8 holes, 4x2 grid
];
const MAX_LEVEL = LEVELS.length - 1;

let state = {
  running:       false,
  score:         0,
  level:         0,
  hitsThisLevel: 0,
  timeLeft:      0,
};
let timerId        = null;
let moleTimers     = [];
let popTimeout     = null;
let isHost         = false;
let startIconKey   = null;
let restartIconKey = null;
let holeHitLock    = {};

let currentSessionId = null;

SquidlyAPI.addSessionInfoListener((info) => {
  isHost = info.user && info.user.startsWith('host');
  if (isHost) {
    initHost();
  } else {
    initParticipant();
  }
});


function initHost() {
  showStartOverlay();

  document.addEventListener('mousemove', e => {
    cursorEl.style.left = e.clientX + 'px';
    cursorEl.style.top  = e.clientY + 'px';
  });
  document.addEventListener('mousedown', () => cursorEl.classList.add('active'));
  document.addEventListener('mouseup',   () => cursorEl.classList.remove('active'));

  const participantCursor = document.createElement('div');
  participantCursor.style.cssText = `
    width: 80px; height: 80px;
    position: fixed; top: -9999px; left: -9999px;
    background-image: url('./assets/hammer.png');
    background-size: 100% 100%;
    transform: translate(-20%, -20%);
    pointer-events: none;
    z-index: 998;
    opacity: 0.6;
    filter: hue-rotate(180deg);
  `;
  document.body.appendChild(participantCursor);

  SquidlyAPI.addCursorListener((data) => {
    if (data.source === 'remote' && data.user.startsWith('participant')) {
      participantCursor.style.left = data.x + 'px';
      participantCursor.style.top  = data.y + 'px';
    }
  });

  startIconKey = SquidlyAPI.setIcon(1, 0, {
    symbol:       'add',
    displayValue: 'Start Game',
    type:         'lightGreen',
  }, () => hostStartGame());
}

function hostStartGame() {
  if (startIconKey)   { SquidlyAPI.removeIcon(startIconKey);   startIconKey   = null; }
  if (restartIconKey) { SquidlyAPI.removeIcon(restartIconKey); restartIconKey = null; }

  const sessionId = Date.now().toString();

  state = {
    running:       true,
    score:         0,
    level:         0,
    hitsThisLevel: 0,
    timeLeft:      LEVELS[0].timeLimit,
  };
  holeHitLock = {};

  SquidlyAPI.firebaseSet('game/gameOver',      false);
  SquidlyAPI.firebaseSet('game/levelBreak',    false);
  SquidlyAPI.firebaseSet('game/moleHole',      -1);
  SquidlyAPI.firebaseSet('game/moleHit',       false);
  SquidlyAPI.firebaseSet('game/moleHitBy',     null);
  SquidlyAPI.firebaseSet('game/score',         0);
  SquidlyAPI.firebaseSet('game/level',         0);
  SquidlyAPI.firebaseSet('game/hitsThisLevel', 0);
  SquidlyAPI.firebaseSet('game/timeLeft',      state.timeLeft);
  SquidlyAPI.firebaseSet('game/running',       true);
  SquidlyAPI.firebaseSet('game/sessionId',     sessionId);

  updateHUD();
  overlay.style.display = 'none';
  buildBoard(LEVELS[0].holes);
  hostStartTimer();
  setTimeout(hostPopMole, 600);
}

function hostStartTimer() {
  clearInterval(timerId);
  timerId = setInterval(() => {
    if (!state.running) return;
    state.timeLeft--;
    timeEl.textContent = state.timeLeft + 's';
    SquidlyAPI.firebaseSet('game/timeLeft', state.timeLeft);
    if (state.timeLeft <= 0) {
      clearInterval(timerId);
      hostEndGame();
    }
  }, 1000);
}

function hostPopMole() {
  if (!state.running) return;

  const cfg       = LEVELS[state.level];
  const holes     = getHoles();
  const available = holes.filter(h => !h.querySelector('.mole-wrap'));

  if (available.length === 0) { hostSchedulePop(300); return; }

  const holeIndex = holes.indexOf(available[Math.floor(Math.random() * available.length)]);
  const hole      = holes[holeIndex];

  holeHitLock[holeIndex] = false;
  SquidlyAPI.firebaseSet('game/moleHole',  holeIndex);
  SquidlyAPI.firebaseSet('game/moleHit',   false);
  SquidlyAPI.firebaseSet('game/moleHitBy', null);

  const wrap = createMoleWrap();
  hole.appendChild(wrap);
  requestAnimationFrame(() => requestAnimationFrame(() => wrap.classList.add('up')));

  wrap.addEventListener('mousedown', e => {
    if (holeHitLock[holeIndex] || !state.running) return;
    holeHitLock[holeIndex] = true;
    e.stopPropagation();
    SquidlyAPI.firebaseSet('game/moleHit',   true);
    SquidlyAPI.firebaseSet('game/moleHitBy', 'host');
    processHit(wrap, hole, holeIndex, cfg);
  });

  const wrapper = hole.parentElement;
  if (wrapper && wrapper.tagName === 'ACCESS-BUTTON') {
    const accessHandler = (e) => {
      e.stopPropagation();
      if (holeHitLock[holeIndex] || !state.running) return;
      if (!hole.querySelector('.mole-wrap')) return;
      holeHitLock[holeIndex] = true;
      wrapper.removeEventListener('access-click', accessHandler);
      SquidlyAPI.firebaseSet('game/moleHit',   true);
      SquidlyAPI.firebaseSet('game/moleHitBy', 'host');
      processHit(wrap, hole, holeIndex, cfg);
    };
    wrapper.addEventListener('access-click', accessHandler);
    setTimeout(() => wrapper.removeEventListener('access-click', accessHandler), cfg.moleTime + 400);
  }

  SquidlyAPI.firebaseOnValue('game/moleHit', (hit) => {
    if (hit === true && !holeHitLock[holeIndex] && state.running) {
      holeHitLock[holeIndex] = true;
      processHit(wrap, hole, holeIndex, cfg);
    }
  });

  const t = setTimeout(() => {
    if (!holeHitLock[holeIndex] && hole.contains(wrap)) {
      wrap.classList.remove('up');
      SquidlyAPI.firebaseSet('game/moleHole', -1);
      setTimeout(() => {
        if (hole.contains(wrap)) hole.removeChild(wrap);
        if (state.running) hostPopMole();
      }, 300);
    }
  }, cfg.moleTime);
  moleTimers.push(t);
}

function processHit(wrap, hole, holeIndex, cfg) {
  state.score += 10;
  state.hitsThisLevel++;
  updateHUD();
  updateProgress();

  SquidlyAPI.firebaseSet('game/score',         state.score);
  SquidlyAPI.firebaseSet('game/hitsThisLevel', state.hitsThisLevel);
  SquidlyAPI.firebaseSet('game/moleHole',      -1);

  whackMole(wrap, hole);
  playSound();

  if (state.hitsThisLevel >= cfg.hitsToAdvance && state.level < MAX_LEVEL) {
    setTimeout(hostLevelUp, 200);
  } else {
    setTimeout(() => {
      if (hole.contains(wrap)) hole.removeChild(wrap);
      if (state.running) hostPopMole();
    }, 1200);
  }
}

function hostSchedulePop(delay) {
  if (!state.running) return;
  clearTimeout(popTimeout);
  popTimeout = setTimeout(hostPopMole, delay + Math.random() * 400);
}

function hostLevelUp() {
  state.level++;
  state.hitsThisLevel = 0;
  holeHitLock = {};

  SquidlyAPI.firebaseSet('game/level',         state.level);
  SquidlyAPI.firebaseSet('game/hitsThisLevel', 0);
  SquidlyAPI.firebaseSet('game/moleHole',      -1);
  SquidlyAPI.firebaseSet('game/levelBreak',    true);

  clearTimeout(popTimeout);
  moleTimers.forEach(clearTimeout);
  moleTimers = [];

  showLevelBanner();
  showLevelBreakOverlay();
}

function showLevelBreakOverlay() {
  state.running = false;
  SquidlyAPI.firebaseSet('game/running', false);

  const msg = getLevelBreakMessage(state.level);
  overlay.innerHTML = `
    <div style="font-size:5rem; margin-bottom:0.2rem;">${msg.emoji}</div>
    <h2>Level ${state.level} Complete!</h2>
    <p style="font-weight:700; color:#ffd700;">${msg.taunt}</p>
    <p>${msg.tip}</p>
    <p style="opacity:0.6; font-size:2.5rem; margin-top:0.4rem;">Score so far: <strong style="color:#ffd700;">${state.score}</strong></p>
  `;
  overlay.style.display = 'flex';

  if (restartIconKey) SquidlyAPI.removeIcon(restartIconKey);
  restartIconKey = SquidlyAPI.setIcon(1, 0, {
    symbol:       'add',
    displayValue: 'Next Level',
    type:         'lightGreen',
  }, () => {
    SquidlyAPI.removeIcon(restartIconKey);
    restartIconKey = null;
    startNextLevel();
  });
}

function startNextLevel() {
  state.running  = true;
  state.timeLeft = LEVELS[state.level].timeLimit;
  holeHitLock    = {};

  SquidlyAPI.firebaseSet('game/levelBreak', false);
  SquidlyAPI.firebaseSet('game/running',    true);
  SquidlyAPI.firebaseSet('game/timeLeft',   state.timeLeft);

  levelEl.textContent     = 'Level ' + (state.level + 1);
  progressBar.style.width = '0%';

  overlay.style.display = 'none';
  buildBoard(LEVELS[state.level].holes);
  setTimeout(hostPopMole, 600);
}

function hostEndGame() {
  state.running = false;
  clearTimeout(popTimeout);
  moleTimers.forEach(clearTimeout);
  clearInterval(timerId);

  SquidlyAPI.firebaseSet('game/running',  false);
  SquidlyAPI.firebaseSet('game/gameOver', true);
  SquidlyAPI.firebaseSet('game/score',    state.score);
  SquidlyAPI.firebaseSet('game/level',    state.level);

  showEndOverlay(true);
}


function initParticipant() {
  cursorEl.style.display = 'block';
  document.addEventListener('mousemove', e => {
    cursorEl.style.left = e.clientX + 'px';
    cursorEl.style.top  = e.clientY + 'px';
  });
  document.addEventListener('mousedown', () => cursorEl.classList.add('active'));
  document.addEventListener('mouseup',   () => cursorEl.classList.remove('active'));

  const hostCursor = document.createElement('div');
  hostCursor.style.cssText = `
    width: 80px; height: 80px;
    position: fixed; top: -9999px; left: -9999px;
    background-image: url('./assets/hammer.png');
    background-size: 100% 100%;
    transform: translate(-20%, -20%);
    pointer-events: none;
    z-index: 998;
    opacity: 0.6;
    filter: hue-rotate(180deg);
  `;
  document.body.appendChild(hostCursor);

  SquidlyAPI.addCursorListener((data) => {
    if (data.source === 'remote' && data.user.startsWith('host')) {
      hostCursor.style.left = data.x + 'px';
      hostCursor.style.top  = data.y + 'px';
    }
  });

  showWaitingOverlay();

  SquidlyAPI.firebaseOnValue('game/sessionId', (sessionId) => {
    if (!sessionId) return;

    currentSessionId = sessionId;
    state = {
      running:       true,
      score:         0,
      level:         0,
      hitsThisLevel: 0,
      timeLeft:      0,
    };

    overlay.style.display = 'none';
    buildBoard(LEVELS[0].holes);
    updateHUD();
  });

  SquidlyAPI.firebaseOnValue('game/running', running => {
    if (!currentSessionId) return;
    if (running === true && !state.running) {
      state.running = true;
      overlay.style.display = 'none';
    }
  });

  SquidlyAPI.firebaseOnValue('game/score', val => {
    if (!currentSessionId || val === null) return;
    state.score = val;
    scoreEl.textContent = String(val).padStart(2, '0');
  });

  SquidlyAPI.firebaseOnValue('game/timeLeft', val => {
    if (!currentSessionId || val === null) return;
    timeEl.textContent = val + 's';
  });

  SquidlyAPI.firebaseOnValue('game/level', val => {
    if (!currentSessionId || val === null) return;
    state.level = val;
    levelEl.textContent = 'Level ' + (val + 1);
    progressBar.style.width = '0%';
  });

  SquidlyAPI.firebaseOnValue('game/hitsThisLevel', val => {
    if (!currentSessionId || val === null) return;
    state.hitsThisLevel = val;
    updateProgress();
  });

  SquidlyAPI.firebaseOnValue('game/levelBreak', val => {
    if (!currentSessionId) return;
    if (val === true) {
      state.running = false;
      showLevelBanner();

      const msg = getLevelBreakMessage(state.level);
      overlay.innerHTML = `
        <div style="font-size:5rem; margin-bottom:0.2rem;">${msg.emoji}</div>
        <h2>Level ${state.level} Complete!</h2>
        <p style="font-weight:700; color:#ffd700;">${msg.taunt}</p>
        <p>${msg.tip}</p>
        <p style="opacity:0.6; font-size:2.5rem; margin-top:0.4rem;">Score so far: <strong style="color:#ffd700;">${state.score}</strong></p>
      `;
      overlay.style.display = 'flex';
    } else if (val === false && currentSessionId) {
      overlay.style.display = 'none';
      state.running = true;
      setTimeout(() => buildBoard(LEVELS[state.level].holes), 50);
    }
  });

  SquidlyAPI.firebaseOnValue('game/moleHole', holeIndex => {
    if (!currentSessionId) return;
    const holes = getHoles();
    holes.forEach(h => {
      const w = h.querySelector('.mole-wrap');
      if (w) h.removeChild(w);
    });

    if (holeIndex !== null && holeIndex >= 0 && holes[holeIndex]) {
      const hole = holes[holeIndex];
      const wrap = createMoleWrap();
      hole.appendChild(wrap);
      requestAnimationFrame(() => requestAnimationFrame(() => wrap.classList.add('up')));

      const cfg = LEVELS[state.level];
      let localHit = false;

      wrap.addEventListener('mousedown', e => {
        if (localHit || !state.running) return;
        localHit = true;
        e.stopPropagation();
        whackMole(wrap, hole);
        playSound();
        SquidlyAPI.firebaseSet('game/moleHit',   true);
        SquidlyAPI.firebaseSet('game/moleHitBy', 'participant');
      });

      const wrapper = hole.parentElement;
      if (wrapper && wrapper.tagName === 'ACCESS-BUTTON') {
        const accessHandler = (e) => {
          e.stopPropagation();
          if (localHit || !state.running) return;
          if (!hole.querySelector('.mole-wrap')) return;
          localHit = true;
          wrapper.removeEventListener('access-click', accessHandler);
          whackMole(wrap, hole);
          playSound();
          SquidlyAPI.firebaseSet('game/moleHit',   true);
          SquidlyAPI.firebaseSet('game/moleHitBy', 'participant');
        };
        wrapper.addEventListener('access-click', accessHandler);
        setTimeout(() => wrapper.removeEventListener('access-click', accessHandler), cfg.moleTime + 400);
      }
    }
  });

  SquidlyAPI.firebaseOnValue('game/gameOver', val => {
    if (!currentSessionId) return;
    if (val === true) {
      state.running = false;
      showEndOverlay(false);
    }
  });
}


function buildBoard(numHoles) {
  board.innerHTML = '';
  moleTimers.forEach(clearTimeout);
  moleTimers = [];

  // 8 holes → 4 columns × 2 rows; everything else uses the existing logic
  const cols = numHoles === 8 ? 4 : numHoles <= 4 ? 2 : 3;
  const rows = Math.ceil(numHoles / cols);
  const gap  = 32;

  const maxSizeByHoles = {
    4: 200,
    6: 240,
    8: 170,  // 4x2 grid — sized to fit comfortably
  };
  const maxCap = maxSizeByHoles[numHoles] ?? 200;

  const availableW = window.innerWidth * 0.92;
  const availableH = window.innerHeight - 180;

  const sizeByW = Math.floor((availableW - (cols + 1) * gap) / cols);
  const sizeByH = Math.floor((availableH - (rows + 1) * gap) / rows);
  const size    = Math.min(sizeByW, sizeByH, maxCap);

  board.style.gridTemplateColumns = `repeat(${cols}, ${size}px)`;
  board.style.gap        = gap + 'px';
  board.style.paddingLeft = numHoles >= 6 ? '80px' : '0px';

  for (let i = 0; i < numHoles; i++) {
    const hole = document.createElement('div');
    hole.className    = 'hole';
    hole.style.width  = size + 'px';
    hole.style.height = size + 'px';

    const wrapper = document.createElement('access-button');
    wrapper.setAttribute('access-group', 'holes');
    wrapper.setAttribute('access-order', String(i + 1));
    wrapper.appendChild(hole);

    board.appendChild(wrapper);
  }
}

function getHoles() {
  return [...board.querySelectorAll('.hole')];
}

function createMoleWrap() {
  const wrap = document.createElement('div');
  wrap.className = 'mole-wrap';
  const img = document.createElement('img');
  img.src = './assets/mole.png';
  img.className = 'mole-img';
  img.alt = 'mole';
  img.onerror = () => { wrap.innerHTML = '<span class="mole-emoji">🐹</span>'; };
  wrap.appendChild(img);
  return wrap;
}

function whackMole(wrap, hole) {
  const img = wrap.querySelector('img');
  if (img) {
    img.src = './assets/mole-whacked.png';
    img.onerror = () => { wrap.innerHTML = '<span class="mole-emoji">😵</span>'; };
  }
  wrap.classList.add('whacked');
  hole.classList.add('whacked');
  setTimeout(() => hole.classList.remove('whacked'), 200);
}

function playSound() {
  try { new Audio('./assets/smash.mp3').play(); } catch(e) {}
}

function updateHUD() {
  scoreEl.textContent = String(state.score).padStart(2, '0');
  timeEl.textContent  = state.timeLeft + 's';
  levelEl.textContent = 'Level ' + (state.level + 1);
}

function updateProgress() {
  const cfg = LEVELS[state.level];
  if (state.level >= MAX_LEVEL) {
    progressBar.style.width = '100%';
    progressLbl.textContent = 'max level reached!';
    return;
  }
  const pct = Math.min(100, (state.hitsThisLevel / cfg.hitsToAdvance) * 100);
  progressBar.style.width = pct + '%';
  progressLbl.textContent =
    `${state.hitsThisLevel} / ${cfg.hitsToAdvance} hits to level ${state.level + 2}`;
}

function showLevelBanner() {}

function getLevelBreakMessage(level) {
  const messages = [
    { emoji: '', taunt: 'Too easy? More holes incoming!',   tip: 'Moles are getting sneakier — stay sharp!' },
    { emoji: '', taunt: 'They\'re speeding up!',            tip: 'Watch all 6 holes — they\'ll try to fake you out.' },
    { emoji: '', taunt: 'The moles are furious!',           tip: 'Hit fast — they won\'t stay up for long.' },
    { emoji: '', taunt: 'FINAL LEVEL. 8 holes. Good luck.', tip: 'You\'ll need every bit of speed you\'ve got.' },
  ];
  return messages[Math.min(level - 1, messages.length - 1)];
}

function instructionsHTML() {
  return `
    <div style="
      display:flex; flex-direction:column; gap:0.6rem;
      background:rgba(255,255,255,0.08); border-radius:12px;
      padding:1.2rem 1.8rem; max-width:1000px; width:100%;
      margin-top:0.6rem;
    ">
      <p style="font-weight:700; color:#ffd700; font-size:2rem; margin-bottom:0.2rem;">How to Play</p>
      <p>&nbsp;Click the mole when it pops up</p>
      <p>&nbsp;Each hit scores <strong>10 points</strong></p>
      <p>&nbsp;Hit enough moles to level up</p>
      <p>&nbsp;Beat the clock before time runs out!</p>
      <p>&nbsp;More holes appear as you progress</p>
    </div>
  `;
}

function showStartOverlay() {
  overlay.innerHTML = `
    <img
      src="./assets/mole.png"
      alt="Mole"
      onerror="this.style.display='none'"
      style="width:120px; height:auto; margin-bottom:0.4rem; filter:drop-shadow(0 4px 12px rgba(0,0,0,0.6));"
    />
    <h2>Whack-a-Mole!</h2>
    ${instructionsHTML()}
  `;
  overlay.style.display = 'flex';
}

function showWaitingOverlay() {
  overlay.innerHTML = `
    <img
      src="./assets/mole.png"
      alt="Mole"
      onerror="this.style.display='none'"
      style="width:120px; height:auto; margin-bottom:0.4rem; filter:drop-shadow(0 4px 12px rgba(0,0,0,0.6));"
    />
    <h2>Whack-a-Mole!</h2>
    ${instructionsHTML()}
    <p style="opacity:0.5; font-size:2rem; margin-top:0.6rem;">Waiting for the host to start…</p>
  `;
  overlay.style.display = 'flex';
}

function showEndOverlay(canRestart) {
  clearTimeout(popTimeout);
  moleTimers.forEach(clearTimeout);
  clearInterval(timerId);

  const great = state.score >= 100;
  overlay.innerHTML = `
    <div style="font-size:5rem; margin-bottom:0.2rem;">${great ? '' : ''}</div>
    <h2>Game Over!</h2>
    <p>You reached <strong>Level ${state.level + 1}</strong><br>
       with a score of <strong style="color:#ffd700;">${state.score}</strong>.</p>
    <p>${great ? 'Nicely done!' : 'The moles win this round…'}</p>
  `;
  overlay.style.display = 'flex';

  if (canRestart) {
    restartIconKey = SquidlyAPI.setIcon(1, 0, {
      symbol:       'add',
      displayValue: 'Play Again',
      type:         'lightGreen',
    }, () => {
      SquidlyAPI.firebaseSet('game/gameOver', false);
      if (restartIconKey) {
        SquidlyAPI.removeIcon(restartIconKey);
        restartIconKey = null;
      }
      hostStartGame();
    });
  }
}

function makeAccessButton(label, group, order, callback) {
  const inner = document.createElement('button');
  inner.className = 'btn gold';
  inner.textContent = label;

  const wrapper = document.createElement('access-button');
  wrapper.setAttribute('access-group', group);
  wrapper.setAttribute('access-order', String(order));
  wrapper.appendChild(inner);

  wrapper.addEventListener('access-click', (e) => {
    e.stopPropagation();
    callback();
  });
  inner.addEventListener('click', callback);

  return wrapper;
}