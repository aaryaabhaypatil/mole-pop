if (typeof SquidlyAPI === 'undefined') {
  const _db = {};
  const _listeners = {};

  window.SquidlyAPI = {
    addSessionInfoListener: (cb) => cb({ user: 'host-mouse', participantActive: false }),
    firebaseSet: (path, value) => {
      _db[path] = value;
      if (_listeners[path]) _listeners[path].forEach(fn => setTimeout(() => fn(value), 0));
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
      btn.textContent = opts.displayValue;
      btn.style.cssText = `
        padding: 6px 14px; border-radius: 6px; border: none; cursor: pointer;
        font-size: 14px; font-weight: 600;
        background: ${opts.type === 'lightGreen' ? '#4caf50' : opts.type === 'action' ? '#e53935' : '#1976d2'};
        color: #fff;
      `;
      btn.addEventListener('click', cb);

      const wrapper = document.createElement('access-button');
      wrapper.dataset.iconKey = key;
      wrapper.setAttribute('access-group', 'controls');
      wrapper.setAttribute('access-order', String(toolbar.children.length + 1));
      wrapper.appendChild(btn);

      wrapper.addEventListener('access-click', (e) => { e.stopPropagation(); cb(); });
      toolbar.appendChild(wrapper);
      return key;
    },
    removeIcon: (key) => {
      const wrapper = document.querySelector(`[data-icon-key="${key}"]`);
      if (wrapper) wrapper.remove();
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
  { holes: 8,  hitsToAdvance: 12, moleTime: 1500, timeLimit: 60 },
];
const MAX_LEVEL = LEVELS.length - 1;

const LEVEL_GAPS = [
  { min: 800,  max: 1400 },
  { min: 700,  max: 1200 },
  { min: 600,  max: 1000 },
  { min: 500,  max: 900  },
  { min: 400,  max: 800  },
];

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
let currentSessionId = null;

// ── Host mole state ──────────────────────────────────────────────────────────
// Each mole pop gets a unique token. A hit is only valid if the token matches.
let activeMoleToken = null;

// ── Participant mole state ───────────────────────────────────────────────────
let pCurrentWrap  = null;
let pCurrentHole  = null;
let pLocalHit     = false;
let pCurrentToken = null; // token of the mole currently shown on participant screen

// ── Switch access: keep toolbar buttons in the 'controls' group ──────────────
// The real Squidly platform creates access-button elements for setIcon calls.
// We watch the whole document for any access-button that appears outside #board
// and isn't already assigned to a holes row, then put it in the controls group.
(function watchControlButtons() {
  // The real Squidly platform uses these group names for toolbar/exit buttons
  const CONTROL_GROUPS = new Set(['apps', 'default']);

  function assignControlGroup(node) {
    if (node.nodeType !== 1) return;
    const tags = node.tagName === 'ACCESS-BUTTON'
      ? [node]
      : [...node.querySelectorAll('access-button')];
    tags.forEach(el => {
      const grp = el.getAttribute('access-group') || '';
      if (CONTROL_GROUPS.has(grp)) {
        el.setAttribute('access-group', 'controls');
      }
    });
  }

  const observer = new MutationObserver(mutations => {
    mutations.forEach(m => m.addedNodes.forEach(assignControlGroup));
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();

SquidlyAPI.addSessionInfoListener((info) => {
  isHost = info.user && info.user.startsWith('host');
  if (isHost) initHost();
  else        initParticipant();
});


// ─── HOST ─────────────────────────────────────────────────────────────────────

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
    width: 120px; height: 110px;
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

  // Participant hit — listens for a token written by the participant.
  // Only acts if the token matches the currently active mole.
  SquidlyAPI.firebaseOnValue('game/participantHitToken', (token) => {
    if (!token) return;
    if (!state.running) return;
    if (token !== activeMoleToken) return; // wrong mole or stale

    // Find the mole on the board and process the hit
    const holes = getHoles();
    for (let i = 0; i < holes.length; i++) {
      const wrap = holes[i].querySelector('.mole-wrap');
      if (wrap && !wrap.classList.contains('whacked')) {
        activeMoleToken = null; // consume token immediately
        processHit(wrap, holes[i], LEVELS[state.level]);
        return;
      }
    }
  });
}

function hostStartGame() {
  if (startIconKey)   { SquidlyAPI.removeIcon(startIconKey);   startIconKey   = null; }
  if (restartIconKey) { SquidlyAPI.removeIcon(restartIconKey); restartIconKey = null; }

  const sessionId = Date.now().toString();

  state = { running: true, score: 0, level: 0, hitsThisLevel: 0, timeLeft: LEVELS[0].timeLimit };
  activeMoleToken = null;

  SquidlyAPI.firebaseSet('game/gameOver',           false);
  SquidlyAPI.firebaseSet('game/levelBreak',         false);
  SquidlyAPI.firebaseSet('game/moleHole',           -1);
  SquidlyAPI.firebaseSet('game/moleToken',          null);
  SquidlyAPI.firebaseSet('game/moleHitBy',          null);
  SquidlyAPI.firebaseSet('game/participantHitToken',null);
  SquidlyAPI.firebaseSet('game/score',              0);
  SquidlyAPI.firebaseSet('game/level',              0);
  SquidlyAPI.firebaseSet('game/hitsThisLevel',      0);
  SquidlyAPI.firebaseSet('game/timeLeft',           state.timeLeft);
  SquidlyAPI.firebaseSet('game/running',            true);
  SquidlyAPI.firebaseSet('game/sessionId',          null);
  SquidlyAPI.firebaseSet('game/sessionId',          sessionId);

  updateHUD();
  overlay.style.display = 'none';
  buildBoard(LEVELS[0].holes);
  hostStartTimer();
  setTimeout(hostPopMole, 800);
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
  if (available.length === 0) { hostSchedulePop(); return; }

  const hole      = available[Math.floor(Math.random() * available.length)];
  const holeIndex = holes.indexOf(hole);

  // Unique token for this mole — written to Firebase so participant can read it
  const token     = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  activeMoleToken = token;

  SquidlyAPI.firebaseSet('game/moleToken',          token);
  SquidlyAPI.firebaseSet('game/moleHole',           holeIndex);
  SquidlyAPI.firebaseSet('game/moleHitBy',          null);
  SquidlyAPI.firebaseSet('game/participantHitToken',null);

  const wrap = createMoleWrap();
  hole.appendChild(wrap);
  requestAnimationFrame(() => requestAnimationFrame(() => wrap.classList.add('up')));

  // Host clicks — process hit directly, no Firebase roundtrip needed
  const onHostHit = (e) => {
    if (e) e.stopPropagation();
    if (activeMoleToken !== token) return; // already consumed
    activeMoleToken = null;
    cursorEl.classList.add('active');
    SquidlyAPI.firebaseSet('game/moleHitBy', 'host');
    processHit(wrap, hole, cfg);
  };

  wrap.addEventListener('mousedown', onHostHit);

  const wrapper = hole.parentElement;
  if (wrapper && wrapper.tagName === 'ACCESS-BUTTON') {
    const accessHandler = (e) => {
      e.stopPropagation();
      if (!hole.querySelector('.mole-wrap')) return;
      wrapper.removeEventListener('access-click', accessHandler);
      onHostHit(null);
    };
    wrapper.addEventListener('access-click', accessHandler);
    setTimeout(() => wrapper.removeEventListener('access-click', accessHandler), cfg.moleTime + 400);
  }

  // Auto-hide if not hit in time
  const t = setTimeout(() => {
    if (activeMoleToken !== token) return; // already hit
    activeMoleToken = null;
    if (hole.contains(wrap)) {
      wrap.classList.remove('up');
      SquidlyAPI.firebaseSet('game/moleHole', -1);
      setTimeout(() => {
        if (hole.contains(wrap)) hole.removeChild(wrap);
        if (state.running) hostSchedulePop();
      }, 300);
    }
  }, cfg.moleTime);
  moleTimers.push(t);
}

function processHit(wrap, hole, cfg) {
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
      if (state.running) hostSchedulePop();
    }, 1200);
  }
}

function hostSchedulePop() {
  if (!state.running) return;
  clearTimeout(popTimeout);
  const gap   = LEVEL_GAPS[state.level] || LEVEL_GAPS[LEVEL_GAPS.length - 1];
  const delay = gap.min + Math.random() * (gap.max - gap.min);
  popTimeout  = setTimeout(hostPopMole, delay);
}

function hostLevelUp() {
  state.level++;
  state.hitsThisLevel = 0;
  activeMoleToken     = null;

  SquidlyAPI.firebaseSet('game/level',         state.level);
  SquidlyAPI.firebaseSet('game/hitsThisLevel', 0);
  SquidlyAPI.firebaseSet('game/moleHole',      -1);
  SquidlyAPI.firebaseSet('game/moleToken',     null);
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
    <img src="./assets/mole.png" alt="Mole" onerror="this.style.display='none'"
      style="width:120px;height:auto;margin-bottom:0.4rem;filter:drop-shadow(0 4px 12px rgba(0,0,0,0.6));"/>
    <h2>Level ${state.level} Complete!</h2>
    ${cardHTML([
      { label: msg.taunt, gold: true },
      { label: msg.tip },
      { label: 'Score so far: <strong style="color:#ffd700;">' + state.score + '</strong>', muted: true },
    ])}
  `;
  overlay.style.display = 'flex';

  if (restartIconKey) SquidlyAPI.removeIcon(restartIconKey);
  restartIconKey = SquidlyAPI.setIcon(1, 0, {
    symbol: 'add', displayValue: 'Next Level', type: 'lightGreen',
  }, () => {
    SquidlyAPI.removeIcon(restartIconKey);
    restartIconKey = null;
    startNextLevel();
  });
}

function startNextLevel() {
  state.running   = true;
  state.timeLeft  = LEVELS[state.level].timeLimit;
  activeMoleToken = null;

  SquidlyAPI.firebaseSet('game/levelBreak', false);
  SquidlyAPI.firebaseSet('game/running',    true);
  SquidlyAPI.firebaseSet('game/timeLeft',   state.timeLeft);

  levelEl.textContent     = 'Level ' + (state.level + 1);
  progressBar.style.width = '0%';

  overlay.style.display = 'none';
  buildBoard(LEVELS[state.level].holes);
  setTimeout(hostPopMole, 800);
}

function hostEndGame() {
  state.running   = false;
  activeMoleToken = null;
  clearTimeout(popTimeout);
  moleTimers.forEach(clearTimeout);
  clearInterval(timerId);

  SquidlyAPI.firebaseSet('game/running',  false);
  SquidlyAPI.firebaseSet('game/gameOver', true);
  SquidlyAPI.firebaseSet('game/score',    state.score);
  SquidlyAPI.firebaseSet('game/level',    state.level);

  showEndOverlay(true);
}


// ─── PARTICIPANT ──────────────────────────────────────────────────────────────

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
    width: 120px; height: 100px;
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

  // All listeners registered exactly once here

  SquidlyAPI.firebaseOnValue('game/sessionId', (sessionId) => {
    if (!sessionId) return;
    currentSessionId = sessionId;
    pCurrentWrap  = null;
    pCurrentHole  = null;
    pLocalHit     = false;
    pCurrentToken = null;
    state = { running: true, score: 0, level: 0, hitsThisLevel: 0, timeLeft: 0 };
    overlay.style.display   = 'none';
    levelEl.textContent     = 'Level 1';
    progressBar.style.width = '0%';
    progressLbl.textContent = '';
    buildBoard(LEVELS[0].holes);
    updateHUD();
    updateProgress();
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
    levelEl.textContent     = 'Level ' + (val + 1);
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
        <img src="./assets/mole.png" alt="Mole" onerror="this.style.display='none'"
          style="width:120px;height:auto;margin-bottom:0.4rem;filter:drop-shadow(0 4px 12px rgba(0,0,0,0.6));"/>
        <h2>Level ${state.level} Complete!</h2>
        ${cardHTML([
          { label: msg.taunt, gold: true },
          { label: msg.tip },
          { label: 'Score so far: <strong style="color:#ffd700;">' + state.score + '</strong>', muted: true },
        ])}
      `;
      overlay.style.display = 'flex';
    } else if (val === false && currentSessionId) {
      overlay.style.display = 'none';
      state.running = true;
      setTimeout(() => buildBoard(LEVELS[state.level].holes), 50);
    }
  });

  // Mole token changes → new mole or mole cleared
  SquidlyAPI.firebaseOnValue('game/moleToken', (token) => {
    if (!currentSessionId) return;

    // Clear any existing mole from the board
    const holes = getHoles();
    holes.forEach(h => {
      const w = h.querySelector('.mole-wrap');
      if (!w) return;
      if (w.classList.contains('whacked')) {
        setTimeout(() => { if (h.contains(w)) h.removeChild(w); }, 600);
      } else {
        h.removeChild(w);
      }
    });

    pCurrentWrap  = null;
    pCurrentHole  = null;
    pLocalHit     = false;
    pCurrentToken = token;

    // token null means mole was cleared, nothing more to do
  });

  // Mole hole index — show the mole in the right hole
  SquidlyAPI.firebaseOnValue('game/moleHole', (holeIndex) => {
    if (!currentSessionId) return;
    if (holeIndex === null || holeIndex < 0) return;
    if (!pCurrentToken) return; // no active token, ignore

    const holes = getHoles();
    if (!holes[holeIndex]) return;

    // Don't spawn a second mole if one is already showing for this token
    if (pCurrentWrap) return;

    const hole = holes[holeIndex];
    const cfg  = LEVELS[state.level];
    const wrap = createMoleWrap();

    pCurrentWrap = wrap;
    pCurrentHole = hole;

    hole.appendChild(wrap);
    requestAnimationFrame(() => requestAnimationFrame(() => wrap.classList.add('up')));

    // Participant hits the mole
    const onParticipantHit = (e) => {
      if (e) e.stopPropagation();
      if (pLocalHit || !state.running) return;
      if (pCurrentWrap !== wrap) return; // stale
      pLocalHit = true;
      cursorEl.classList.add('active');
      whackMole(wrap, hole);
      playSound();
      // Send the token so host knows which mole was hit
      SquidlyAPI.firebaseSet('game/participantHitToken', pCurrentToken);
      SquidlyAPI.firebaseSet('game/moleHitBy',           'participant');
    };

    wrap.addEventListener('mousedown', onParticipantHit);

    const wrapper = hole.parentElement;
    if (wrapper && wrapper.tagName === 'ACCESS-BUTTON') {
      const accessHandler = (e) => {
        e.stopPropagation();
        if (!hole.querySelector('.mole-wrap')) return;
        wrapper.removeEventListener('access-click', accessHandler);
        onParticipantHit(null);
      };
      wrapper.addEventListener('access-click', accessHandler);
      setTimeout(() => wrapper.removeEventListener('access-click', accessHandler), cfg.moleTime + 400);
    }
  });

  // Host hit the mole — show whack animation on participant side
  SquidlyAPI.firebaseOnValue('game/moleHitBy', (hitBy) => {
    if (!currentSessionId) return;
    if (hitBy !== 'host') return;
    if (pLocalHit) return;
    if (!pCurrentWrap || !pCurrentHole) return;
    pLocalHit = true;
    const wrap = pCurrentWrap;
    const hole = pCurrentHole;
    if (!hole.contains(wrap)) hole.appendChild(wrap);
    whackMole(wrap, hole);
    playSound();
  });

  SquidlyAPI.firebaseOnValue('game/gameOver', val => {
    if (!currentSessionId) return;
    if (val === true) {
      state.running = false;
      showEndOverlay(false);
    }
  });
}


// ─── SHARED ───────────────────────────────────────────────────────────────────

function buildBoard(numHoles) {
  board.innerHTML = '';
  moleTimers.forEach(clearTimeout);
  moleTimers = [];

  const cols = numHoles === 8 ? 4 : numHoles <= 4 ? 2 : 3;
  const rows = Math.ceil(numHoles / cols);
  const gap  = 32;

  const maxSizeByHoles = { 4: 240, 6: 240, 8: 170 };
  const maxCap = maxSizeByHoles[numHoles] ?? 240;

  const availableW = window.innerWidth * 0.92;
  const availableH = window.innerHeight - 180;

  const sizeByW = Math.floor((availableW - (cols + 1) * gap) / cols);
  const sizeByH = Math.floor((availableH - (rows + 1) * gap) / rows);
  const size    = Math.min(sizeByW, sizeByH, maxCap);

  board.style.gridTemplateColumns = `repeat(${cols}, ${size}px)`;
  board.style.gap         = gap + 'px';
  board.style.paddingLeft = numHoles >= 6 ? '80px' : '0px';

  for (let i = 0; i < numHoles; i++) {
    const hole = document.createElement('div');
    hole.className    = 'hole';
    hole.style.width  = size + 'px';
    hole.style.height = size + 'px';

    const row = Math.floor(i / cols);

    const wrapper = document.createElement('access-button');
    wrapper.setAttribute('access-group', 'holes-row-' + row);
    wrapper.setAttribute('access-order', String((i % cols) + 1));
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

function cardHTML(items) {
  const rows = items.map(item => {
    let style = 'font-size:1.3rem;';
    if (item.gold)    style += 'font-weight:700; color:#ffd700;';
    if (item.muted)   style += 'opacity:0.6;';
    if (item.heading) style += 'font-weight:700; color:#ffd700; font-size:1.5rem; margin-bottom:0.2rem;';
    return `<p style="${style}">${item.label}</p>`;
  }).join('');

  return `
    <div style="
      display:flex; flex-direction:column; gap:0.6rem;
      background:rgba(255,255,255,0.08); border-radius:12px;
      padding:1.2rem 1.8rem; max-width:420px; width:100%;
      margin-top:0.6rem;
    ">${rows}</div>
  `;
}

function moleImgHTML() {
  return `
    <div style="
      width:120px; height:120px;
      background-image: url('./assets/mole.png');
      background-size: contain;
      background-repeat: no-repeat;
      background-position: center;
      margin-bottom:0.4rem;
      filter:drop-shadow(0 4px 12px rgba(0,0,0,0.6));
    "></div>
  `;
}

function showStartOverlay() {
  overlay.innerHTML = `
    ${moleImgHTML()}
    <h2>Whack-a-Mole!</h2>
    ${cardHTML([
      { label: 'How to Play', heading: true },
      { label: '&nbsp;Click the mole when it pops up' },
      { label: '&nbsp;Each hit scores <strong>10 points</strong>' },
      { label: '&nbsp;Hit enough moles to level up' },
      { label: '&nbsp;Beat the clock before time runs out!' },
      { label: '&nbsp;More holes appear as you progress' },
    ])}
  `;
  overlay.style.display = 'flex';
}

function showWaitingOverlay() {
  overlay.innerHTML = `
    ${moleImgHTML()}
    <h2>Whack-a-Mole!</h2>
    ${cardHTML([
      { label: 'How to Play', heading: true },
      { label: '&nbsp;Click the mole when it pops up' },
      { label: '&nbsp;Each hit scores <strong>10 points</strong>' },
      { label: '&nbsp;Hit enough moles to level up' },
      { label: '&nbsp;Beat the clock before time runs out!' },
      { label: '&nbsp;More holes appear as you progress' },
    ])}
    <p style="opacity:0.5; font-size:1.1rem; margin-top:0.4rem;">Waiting for the host to start…</p>
  `;
  overlay.style.display = 'flex';
}

function showEndOverlay(canRestart) {
  clearTimeout(popTimeout);
  moleTimers.forEach(clearTimeout);
  clearInterval(timerId);

  const great = state.score >= 100;
  overlay.innerHTML = `
    ${moleImgHTML()}
    <h2>Game Over!</h2>
    ${cardHTML([
      { label: great ? 'Nicely done!' : 'The moles win this round…', gold: great },
      { label: 'Level reached: <strong>' + (state.level + 1) + '</strong>' },
      { label: 'Final score: <strong style="color:#ffd700;">' + state.score + '</strong>' },
    ])}
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