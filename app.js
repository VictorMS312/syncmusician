// ════════════════════════════════════
//  STATE
// ════════════════════════════════════
let db = JSON.parse(localStorage.getItem('syncmusician_v8')) || {
  pastas: { "Repertório Geral": [] },
  biblioteca: []
};

// Configurações (toggles de funcionalidades)
let settings = JSON.parse(localStorage.getItem('syncmusician_settings')) || {
  medleyEnabled: true,
  editEnabled:   true,
  displayName:   '',
  isVisible:     false,
};
function saveSettings() { localStorage.setItem('syncmusician_settings', JSON.stringify(settings)); }

// ── Auth & Pro ──
const ADMIN_EMAIL = 'victorm.silva312@gmail.com';
// Códigos Pro — hashes SHA-256 simples (adicione via painel admin)
// Formato dos códigos: SYNC-XXXX-XXXX-XXXX (gerado pelo admin)
const PRO_CODE_PREFIX = 'SYNC-';
let authUser  = JSON.parse(localStorage.getItem('syncmusician_auth'))  || null;
let proStatus = JSON.parse(localStorage.getItem('syncmusician_pro'))   || { active: false, code: '' };
function isAdmin() { return authUser && authUser.email === ADMIN_EMAIL; }
function isPro()   { return true; } // tudo liberado
function saveAuth()   { localStorage.setItem('syncmusician_auth',  JSON.stringify(authUser));  }
function saveProStatus() { localStorage.setItem('syncmusician_pro', JSON.stringify(proStatus)); }

let peer = null, connections = [], role = '';
let pastaAtiva = '', musicaAtivaId = null, musicaAtivaIndex = -1;
let originalText = '', currentText = '', baseNote = 'C', currentNote = 'C';
let isScrolling = false, scrollPos = 0;
let isEditMode = false;
let peerIdGlobal = null;
let html5QrCode = null;
let medleySuggestion = null;
let medleyWatcherId = null;
// Histórico de medleys para não repetir músicas na sessão
let medleyHistory = [];
let leaderPollId = null;  // polling de líderes disponíveis
let keepAliveId  = null;  // heartbeat para manter líder visível

const notes = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

// ── Gêneros musicais ──
const GENRES = [
  { id: 'gospel',    label: 'Gospel',     emoji: '✝️'  },
  { id: 'crista',    label: 'Cristã',     emoji: '🕊️'  },
  { id: 'sertanejo', label: 'Sertanejo',  emoji: '🤠'  },
  { id: 'mpb',       label: 'MPB',        emoji: '🎶'  },
  { id: 'pop',       label: 'Pop',        emoji: '🎤'  },
  { id: 'rock',      label: 'Rock',       emoji: '🎸'  },
  { id: 'pagode',    label: 'Pagode',     emoji: '🥁'  },
  { id: 'axe',       label: 'Axé',        emoji: '🌴'  },
  { id: 'forro',     label: 'Forró',      emoji: '🪗'  },
  { id: 'classica',  label: 'Clássica',   emoji: '🎻'  },
  { id: 'infantil',  label: 'Infantil',   emoji: '🧸'  },
  { id: 'outros',    label: 'Outros',     emoji: '🎵'  },
];

// Mapeamento de strings do Cifra Club → nosso id
const GENRE_MAP = {
  'gospel': 'gospel', 'cristã': 'crista', 'crista': 'crista',
  'sertanejo': 'sertanejo', 'mpb': 'mpb', 'pop': 'pop',
  'rock': 'rock', 'pagode': 'pagode', 'axé': 'axe', 'axe': 'axe',
  'forró': 'forro', 'forro': 'forro', 'clássica': 'classica',
  'infantil': 'infantil', 'religioso': 'crista', 'católica': 'crista',
};

function normalizeGenre(raw) {
  if (!raw) return null;
  const key = raw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  for (const [k, v] of Object.entries(GENRE_MAP)) {
    const kn = k.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (key.includes(kn)) return v;
  }
  return null;
}

function getGenre(genreId) {
  return GENRES.find(g => g.id === genreId) || null;
}
// Exibição com bemóis para notas pretas (contexto musical BR)
const NOTE_DISPLAY = {
  "C#":"C#/Db","D#":"D#/Eb","F#":"F#/Gb","G#":"G#/Ab","A#":"A#/Bb"
};
// Tom original: aceita bemóis e converte internamente
const FLAT_TO_SHARP = {"Db":"C#","Eb":"D#","Fb":"E","Gb":"F#","Ab":"G#","Bb":"A#","Cb":"B"};
function toSharp(n) { return FLAT_TO_SHARP[n] || n; }

const $ = id => document.getElementById(id);
const contentArea    = $('content-area');
const dynamicContent = $('dynamic-content');
const cifraContainer = $('cifra-container');
const editTextarea   = $('edit-textarea');
const toneBar        = $('tone-bar');
const controlsBar    = $('controls-bar');
const toneGrid       = $('tone-grid');
const scrollPanel    = $('scroll-panel');
const medleyBubble   = $('medley-bubble');
const medleyTitleEl  = $('medley-title');

// ════════════════════════════════════
//  INIT
// ════════════════════════════════════
window.onload = () => {
  const lastId = localStorage.getItem('last_leader_id');
  if (lastId) $('join-id').value = lastId;
  buildToneGrid();
  migrarBiblioteca();
  // Restaura nome salvo
  if (settings.displayName) $('leader-name-input').value = settings.displayName;
  // Começa a listar líderes disponíveis
  pollLeaders();
  leaderPollId = setInterval(pollLeaders, 8000);
};

// Detecta o tom da cifra
// Prioridade: 1) linha "Tom: X" no texto, 2) campo harmônico
function detectKey(text) {
  // 1. Tenta extrair do texto "Tom: B" / "Tom: C#m" etc.
  const tomMatch = text.match(/\bTom\s*:\s*([A-G][#b]?(?:m(?:aj)?|dim|aug|sus)?)/i);
  if (tomMatch) {
    const raw = tomMatch[1];
    const root = raw.replace(/m(?:aj)?|dim|aug|sus/g, '');
    const norm = {'Db':'C#','Eb':'D#','Gb':'F#','Ab':'G#','Bb':'A#'}[root] || root;
    if (notes.includes(norm)) return norm;
  }

  // 2. Campo harmônico
  const lines     = text.split('\n');
  const allChords = [];

  lines.forEach((line, idx) => {
    if (!isChordLine(line)) return;
    const matches = line.match(/[A-G][#b]?(?:m(?:aj)?|dim|aug|sus)?/g) || [];
    matches.forEach(c => {
      const root = c.replace(/m(?:aj)?|dim|aug|sus/g, '');
      const norm = {'Db':'C#','Eb':'D#','Gb':'F#','Ab':'G#','Bb':'A#'}[root] || root;
      if (!notes.includes(norm)) return;
      allChords.push({ root: norm, idx });
    });
  });

  if (allChords.length === 0) return 'C';

  const counts = {};
  allChords.forEach(c => { counts[c.root] = (counts[c.root] || 0) + 1; });

  // Último acorde da cifra tende a ser a tônica
  const lastLine = [...lines].reverse().find(l => isChordLine(l));
  if (lastLine) {
    const m = lastLine.trim().match(/^([A-G][#b]?)/);
    if (m) {
      const norm = {'Db':'C#','Eb':'D#','Gb':'F#','Ab':'G#','Bb':'A#'}[m[1]] || m[1];
      if (notes.includes(norm) && counts[norm]) return norm;
    }
  }

  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

// Extrai a primeira URL válida de um texto (resolve "Veja como tocar X https://...")
function extractUrl(text) {
  const m = text.match(/https?:\/\/[^\s]+/);
  return m ? m[0].trim() : text.trim();
}

function migrarBiblioteca() {
  let changed = false;
  db.biblioteca.forEach(m => {
    if (!m.content) return;
    // Se tem <br> mas não tem <b>, provavelmente veio do backend antigo sem tags de acorde
    // Converte <br> em \n para pelo menos ter o texto legível
    if (/<br/i.test(m.content) && !/<b>/i.test(m.content)) {
      m.content = m.content
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ');
      changed = true;
    }
  });
  if (changed) salvarDB();
}

function initRole(r) {
  role = r;
  if (role === 'S') {
    const name = $('leader-name-input').value.trim();
    if (!name) { showToast('Digite seu nome antes de continuar'); $('leader-name-input').focus(); return; }
    settings.displayName = name;
    settings.isVisible = true; // líder sempre fica visível ao entrar
    saveSettings();
  }
  if (role === 'M') {
    const id = $('join-id').value.trim();
    if (!id) { showToast('Digite o ID do Líder'); return; }
    localStorage.setItem('last_leader_id', id);
  }
  if (leaderPollId) { clearInterval(leaderPollId); leaderPollId = null; }
  peer = new Peer();
  showScreen('screen-app');
  if (role === 'S') setupLeader(true); // sempre visível
  else setupMusician($('join-id').value.trim());
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}

// ════════════════════════════════════
//  PEER — LEADER
// ════════════════════════════════════
function setupLeader(becomeVisible) {
  peer.on('open', id => {
    peerIdGlobal = id;
    $('status-dot').className    = 'status-dot leader';
    $('status-text').textContent = 'LÍDER';
    $('qr-img').src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(id)}`;
    $('qr-id-text').textContent  = id;
    // Mostra ID nas configurações
    const prev = $('settings-peer-id-preview');
    if (prev) prev.textContent = id;

    if (becomeVisible || settings.isVisible) {
      registerLeaderOnline(true);
    }
  });

  peer.on('error', err => showToast('Erro: ' + err.type));

  peer.on('connection', conn => {
    connections.push(conn);
    updatePeerBadge();
    conn.on('open', () => {
      updatePeerBadge();
      if (musicaAtivaId) conn.send({ type: 'SYNC', body: currentText, tone: currentNote });
    });
    conn.on('close', () => { connections = connections.filter(c => c !== conn); updatePeerBadge(); });
    conn.on('error', () => { connections = connections.filter(c => c !== conn); updatePeerBadge(); });
  });

  setView('folders');
  renderFolders();
}

function updatePeerBadge() {
  const alive = connections.filter(c => c.open).length;
  const badge = $('peer-badge');
  if (alive > 0) {
    badge.style.display = 'block';
    badge.textContent   = `${alive} músico${alive > 1 ? 's' : ''}`;
  } else {
    badge.style.display = 'none';
  }
}

// ════════════════════════════════════
//  PEER — MUSICIAN
// ════════════════════════════════════
function setupMusician(leaderId) {
  $('status-dot').className  = 'status-dot';
  $('status-text').textContent = 'CONECTANDO...';

  peer.on('open', () => {
    const conn = peer.connect(leaderId, { reliable: true });

    conn.on('open', () => {
      $('status-dot').className  = 'status-dot musician';
      $('status-text').textContent = 'MÚSICO';
    });

    conn.on('data', data => {
      if (data.type === 'SYNC')   receiveSong(data.body, data.tone);
      if (data.type === 'SCROLL') contentArea.scrollTop = data.pos;
    });

    conn.on('close', () => {
      $('status-dot').className  = 'status-dot offline';
      $('status-text').textContent = 'DESCONECTADO';
    });
  });

  peer.on('error', err => {
    showToast('Erro: ' + err.type);
    $('status-dot').className    = 'status-dot offline';
    $('status-text').textContent = 'ERRO';
  });

  setView('folders');
  dynamicContent.innerHTML = `
    <div style="padding:64px 22px;text-align:center;color:var(--text-dim);">
      <div style="font-size:46px;margin-bottom:14px;">🎸</div>
      <div style="font-family:var(--font-mono);font-size:12px;letter-spacing:1.5px;">AGUARDANDO LÍDER...</div>
    </div>`;
}

function receiveSong(body, tone) {
  currentText = body; currentNote = tone;
  showCifraView(); renderCifra(body);
  $('curr-tone').textContent = tone;
  $('orig-tone').textContent = tone;
  toneBar.style.display     = 'flex';
  controlsBar.style.display = 'none';
  // Músico: mantém painel de scroll aberto e funcional (controle independente)
  scrollPanel.style.display = 'flex';
  contentArea.scrollTop     = 0;
  hideMedley();
}

// ════════════════════════════════════
//  NAVIGATION — view controller
// ════════════════════════════════════
function setView(view) {
  const inCifra = view === 'cifra' || view === 'edit';

  const nav = $('bottom-nav');
  if (nav) nav.style.display = inCifra ? 'none' : 'flex';

  // fab-back removido — botão do celular cuida da navegação
  $('fab-add').style.display = view === 'songs' ? 'flex' : 'none';
  $('fab-back').style.display = 'none';
  $('fab-save').style.display = view === 'edit' ? 'flex' : 'none';

  const activeTab =
    (view === 'folders' || view === 'songs') ? 'home' :
    view === 'settings' ? 'settings' :
    view === 'tomdetector' ? 'tomdetector' : null;

  document.querySelectorAll('.nav-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === activeTab)
  );

  // Hide Tom Detector screen unless we're on it
  const tdScreen = $('screen-tomdetector');
  if (tdScreen) {
    if (view === 'tomdetector') {
      tdScreen.classList.add('active');
    } else {
      tdScreen.classList.remove('active');
    }
  }
}

async function navConnect() {
  if (keepAliveId) { clearInterval(keepAliveId); keepAliveId = null; }
  // Força remoção do líder da lista mesmo se peerIdGlobal sumiu
  if (peerIdGlobal) {
    try {
      await fetch(`${API}/leader/offline`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: peerIdGlobal }),
      });
    } catch {}
  }
  peerIdGlobal = null;
  if (peer) { try { peer.destroy(); } catch {} peer = null; }
  connections = []; role = '';
  // Esconde todos os FABs ao voltar para conexão
  ['fab-add','fab-back','fab-save'].forEach(id => { const el=$(id); if(el) el.style.display='none'; });
  showScreen('screen-setup');
  if (leaderPollId) clearInterval(leaderPollId);
  pollLeaders();
  leaderPollId = setInterval(pollLeaders, 8000);
}

function navHome() {
  if (role === 'S') renderFolders();
}

// Logo no header — volta para a página anterior
function logoBack() {
  if (isEditMode) { cancelEdit(); return; }
  if (musicaAtivaId) { backFromSong(); return; }  // cifra → pasta
  if (pastaAtiva)    { renderFolders(); return; }  // pasta → pastas
  // já na raiz — não faz nada
}

function navSettings() {
  showDynamic(); hideAllPanels(); hideMedley(); stopMedleyWatcher();
  setView('settings');
  renderSettingsPage();
}

function navTomDetector() {
  showDynamic(); hideAllPanels(); hideMedley(); stopMedleyWatcher();
  setView('tomdetector');

  const tdBody = $('td-body');
  if (tdBody) tdBody.style.display = 'flex';

  if (tunerOn) {
    const badge = $('td-live-badge');
    if (badge) badge.classList.add('visible');
    const btn = $('td-toggle-btn');
    if (btn) { btn.textContent = '⏹ PARAR'; btn.classList.add('on'); }
  }
}

function renderFolders() {
  pastaAtiva = ''; musicaAtivaId = null; musicaAtivaIndex = -1;
  showDynamic(); hideAllPanels(); hideMedley(); stopMedleyWatcher();
  setView('folders');
  let html = `<div class="view-header"><div class="view-title">Minhas Pastas</div></div><div class="folders-grid">`;
  Object.keys(db.pastas).forEach(nome => {
    html += `<div class="folder-card" onclick="openFolder('${esc(nome)}')">
      <button class="folder-menu-btn" onclick="event.stopPropagation(); openFolderMenu(event, '${esc(nome)}')">⋮</button>
      <div class="folder-emoji">📁</div>
      <div class="folder-name">${nome}</div>
      <div class="folder-count">${db.pastas[nome].length} músicas</div>
    </div>`;
  });
  html += `<div class="folder-card new" onclick="createFolder()">
    <div class="folder-emoji">＋</div>
    <div class="folder-name">Nova Pasta</div>
  </div></div><div class="nav-ghost-spacer"></div>`;
  dynamicContent.innerHTML = html;
}

let genreFilter = null; // filtro ativo na pasta

function openFolder(nome) {
  pastaAtiva = nome;
  genreFilter = null;
  medleyHistory = [];
  showDynamic(); hideAllPanels(); hideMedley(); stopMedleyWatcher();
  setView('songs');
  renderSongsList();
}

function renderSongsList() {
  const songs = db.pastas[pastaAtiva]
    .map(id => db.biblioteca.find(b => b.id === id))
    .filter(Boolean);

  // Coleta gêneros presentes nesta pasta
  const presentGenres = [...new Set(songs.map(m => m.genre).filter(Boolean))];

  // Barra de filtro por gênero
  let filterBar = '';
  if (presentGenres.length > 0) {
    filterBar = `<div class="genre-filter-bar" id="genre-filter-bar">
      <button class="genre-filter-chip ${!genreFilter ? 'active' : ''}" onclick="setGenreFilter(null)">Todas</button>`;
    presentGenres.forEach(gid => {
      const g = getGenre(gid);
      if (!g) return;
      filterBar += `<button class="genre-filter-chip ${genreFilter === gid ? 'active' : ''}"
        onclick="setGenreFilter('${gid}')">${g.emoji} ${g.label}</button>`;
    });
    filterBar += `</div>`;
  }

  // Filtra músicas
  const filtered = genreFilter
    ? songs.filter(m => m.genre === genreFilter)
    : songs;

  // Barra de busca local
  const searchBar = `
    <div class="local-search-wrap">
      <input type="text" id="local-search-input" class="input-field local-search-input"
        placeholder="🔍  Buscar nas músicas..."
        autocomplete="off" spellcheck="false"
        oninput="filterLocalSongs(this.value)">
    </div>`;

  let html = `<div class="view-header"><div class="view-title">${pastaAtiva}</div></div>
    ${searchBar}
    ${filterBar}
    <div class="songs-list" id="songs-list-inner">`;

  if (!filtered.length) {
    html += `<div style="text-align:center;padding:44px;color:var(--text-dim);font-family:var(--font-mono);font-size:12px;">
      Nenhuma música ainda.<br>Toque + para adicionar.</div>`;
  }

  filtered.forEach((m) => {
    const realIndex = db.pastas[pastaAtiva].indexOf(m.id);
    const g = m.genre ? getGenre(m.genre) : null;
    const genreChip = g
      ? `<span class="song-genre-chip">${g.emoji} ${g.label}</span>`
      : (isAdmin() ? `<span class="song-genre-chip chip-empty" onclick="event.stopPropagation();openEditGenre('${m.id}')">+ gênero</span>` : '');

    html += `<div class="song-card" onclick="openSong(${realIndex})">
      <div style="flex:1;min-width:0;">
        <div class="song-title">${m.title}</div>
        <div class="song-meta-row">
          <span class="song-meta">Tom: ${m.originalTone || 'C'}</span>
          ${genreChip}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
        ${isAdmin() ? `<button class="song-genre-edit-btn" onclick="event.stopPropagation();openEditGenre('${m.id}')" title="Editar gênero">✎</button>` : ''}
        <div class="song-badge">${m.originalTone || 'C'}</div>
      </div>
    </div>`;
  });

  html += '</div><div class="nav-ghost-spacer"></div>';
  dynamicContent.innerHTML = html;
}

function setGenreFilter(gid) {
  genreFilter = gid;
  renderSongsList();
}

function filterLocalSongs(query) {
  const q = query.trim().toLowerCase();
  const list = $('songs-list-inner');
  if (!list) return;
  list.querySelectorAll('.song-card').forEach(card => {
    const title = card.querySelector('.song-title')?.textContent?.toLowerCase() || '';
    card.style.display = (!q || title.includes(q)) ? '' : 'none';
  });
}

// ── Admin: editar gênero de uma música ──
function openEditGenre(mId) {
  if (!isAdmin()) return;
  const m = db.biblioteca.find(b => b.id === mId);
  if (!m) return;

  // Remove menu anterior se existir
  closeContextMenu();

  const overlay = document.createElement('div');
  overlay.className = 'folder-ctx-backdrop';
  overlay.onclick = closeContextMenu;

  const menu = document.createElement('div');
  menu.className = 'folder-ctx';
  menu.id = 'folder-ctx-menu';
  menu.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);min-width:220px;';
  menu.innerHTML = `
    <div style="font-family:var(--font-mono);font-size:10px;color:var(--text-dim);letter-spacing:1.5px;text-transform:uppercase;padding:8px 14px 4px;">Gênero — ${m.title.slice(0,20)}</div>
    ${GENRES.map(g => `
      <div class="folder-ctx-item ${m.genre === g.id ? 'genre-active' : ''}"
           onclick="setMusicGenre('${mId}','${g.id}')">
        ${g.emoji} ${g.label} ${m.genre === g.id ? '✓' : ''}
      </div>`).join('')}
    <div class="folder-ctx-item danger" onclick="setMusicGenre('${mId}', null)">✕ Remover gênero</div>`;

  document.body.appendChild(overlay);
  document.body.appendChild(menu);
}

function setMusicGenre(mId, genreId) {
  closeContextMenu();
  const m = db.biblioteca.find(b => b.id === mId);
  if (!m) return;
  m.genre = genreId;
  salvarDB();
  renderSongsList();
  const g = genreId ? getGenre(genreId) : null;
  showToast(g ? `Gênero: ${g.emoji} ${g.label}` : 'Gênero removido');
}

function openSong(index, fromDetector) {
  musicaAtivaIndex = index;
  const mId    = db.pastas[pastaAtiva][index];
  musicaAtivaId  = mId;
  const musica = db.biblioteca.find(b => b.id === mId);
  if (!musica) return;
  // Only allow auto-transpose if explicitly called from detector
  if (!fromDetector) tdOpenedFromDetector = false;

  originalText = musica.content;
  baseNote     = musica.originalTone || 'C';
  currentNote  = musica.savedTone    || baseNote;
  isEditMode   = false;

  const savedDiff = notes.indexOf(currentNote) - notes.indexOf(baseNote);
  currentText = savedDiff !== 0 ? transposeText(originalText, savedDiff) : originalText;

  showCifraView(); renderCifra(currentText);
  $('curr-tone').textContent = currentNote;
  $('orig-tone').textContent = baseNote;
  $('btn-reset-tone').style.display = currentNote !== baseNote ? 'block' : 'none';
  updateToneActive();
  toneBar.style.display = 'flex';

  if (role === 'S') {
    controlsBar.style.display = 'flex';
    // Mostra ou esconde botão de edição conforme configuração
    $('btn-edit-toggle').style.display = settings.editEnabled ? '' : 'none';
    syncMusicians(currentText, currentNote);
  }

  setView('cifra');
  hideMedley();
  stopScroll();
  isScrolling = false;
  contentArea.scrollTop = 0; scrollPos = 0;

  if (role === 'S' && settings.medleyEnabled && isPro()) startMedleyWatcher();
}

function fabBackHandler() {
  if (isEditMode) { cancelEdit(); return; }
  backFromSong();
}

function backFromSong() {
  hideAllPanels(); hideMedley(); stopScroll(); stopMedleyWatcher();
  musicaAtivaId    = null;
  musicaAtivaIndex = -1;
  tdOpenedFromDetector = false;
  showDynamic();
  setView('songs');
  renderSongsList();
}

function showCifraView() {
  dynamicContent.style.display = 'none';
  cifraContainer.style.display = 'block';
  editTextarea.style.display   = 'none';
}
function showDynamic() {
  dynamicContent.style.display = 'block';
  cifraContainer.style.display = 'none';
  editTextarea.style.display   = 'none';
}
function hideAllPanels() {
  controlsBar.style.display = 'none';
  toneBar.style.display     = 'none';
  scrollPanel.style.display = 'none';
  toneGrid.style.display    = 'none';
}

// ════════════════════════════════════
//  CIFRA
// ════════════════════════════════════
const CHORD_TOKEN_RE = /^[A-G][#b]?(?:m|maj|M|min|dim|aug|sus|add)?[0-9]?(?:\/[A-G][#b]?)?$/;
const QUALIFIER_RE   = /^(?:maj|min|dim|aug|sus|add)$/i;

// Wrap a chord string into a tappable span
function chordSpan(chord) {
  const safe = chord.replace(/'/g, "\\'");
  return `<span class="chord" onclick="openChordPopup('${safe}')">${chord}</span>`;
}

// Converte HTML do backend em texto puro preservando quebras de linha
function htmlParaTexto(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')   // <br> → newline
    .replace(/<[^>]+>/g, '')          // remove todas as outras tags
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

// ── Mode B: plain text — detect chord lines heuristically ──
function isChordLine(line) {
  const t = line.trim();
  if (!t || /^\[.+\]$/.test(t)) return false;

  const tokens = t.split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;

  let chords = 0, words = 0;
  for (const tok of tokens) {
    const clean = tok.replace(/^[(]+|[),.:|/]+$/g, '');
    if (!clean || clean.length < 2) continue; // ignora tokens de 1 char (E, A na letra)

    if (CHORD_TOKEN_RE.test(clean)) {
      chords++;
    } else if (/[a-záàâãéêíóôõúç]{3,}/i.test(clean) && !QUALIFIER_RE.test(clean)) {
      words++;
    }
  }
  return chords > 0 && words === 0;
}

function renderFromPlainText(text) {
  return text.split('\n').map(line =>
    isChordLine(line)
      ? line.replace(
          /([A-G][#b]?(?:m|maj|M|min|dim|aug|sus|add)?[0-9]?(?:\/[A-G][#b]?)?)/g,
          (m) => chordSpan(m)
        )
      : line
  ).join('\n');
}

// ── Main renderer: always plain text ──
function renderCifra(text) {
  // Limpa qualquer HTML residual que possa ter sido salvo antes
  const plain = /<[a-z]/i.test(text)
    ? text.replace(/<br\s*\/?>/gi,'\n').replace(/<b>([^<]*)<\/b>/gi,'$1').replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ')
    : text;
  cifraContainer.innerHTML = renderFromPlainText(plain);
}

// chordify() used by medley injection
function chordify(text) {
  const plain = /<[a-z]/i.test(text)
    ? text.replace(/<br\s*\/?>/gi,'\n').replace(/<b>([^<]*)<\/b>/gi,'$1').replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ')
    : text;
  return renderFromPlainText(plain);
}

// ════════════════════════════════════
//  TONE
// ════════════════════════════════════
function buildToneGrid() {
  toneGrid.innerHTML = '';
  notes.forEach(n => {
    const btn = document.createElement('button');
    btn.className = 'btn-tone';
    btn.textContent = NOTE_DISPLAY[n] || n;
    btn.dataset.note = n; // valor interno sempre em sustenido
    btn.onclick = () => { selectTone(n); toggleToneGrid(); };
    toneGrid.appendChild(btn);
  });
}

function updateToneActive() {
  toneGrid.querySelectorAll('.btn-tone').forEach(b =>
    b.classList.toggle('active', (b.dataset.note || b.textContent) === currentNote)
  );
}

function selectTone(target) {
  const diff = notes.indexOf(target) - notes.indexOf(baseNote);
  currentText = transposeText(originalText, diff);
  currentNote = target;
  $('curr-tone').textContent = target;
  $('btn-reset-tone').style.display = target !== baseNote ? 'block' : 'none';
  updateToneActive();
  renderCifra(currentText);
  const m = db.biblioteca.find(b => b.id === musicaAtivaId);
  if (m) { m.savedTone = target; salvarDB(); }
  if (role === 'S') syncMusicians(currentText, currentNote);
}

function resetTone() { selectTone(baseNote); }

// ── Tom original: correção manual + votação comunitária ──
function setOriginalTone(newTone) {
  const m = db.biblioteca.find(b => b.id === musicaAtivaId);
  if (!m) return;
  m.originalTone = newTone;
  baseNote       = newTone;
  // Mantém savedTone — recalcula o texto mantendo a transposição atual
  originalText   = m.content;
  const savedDiff = notes.indexOf(currentNote) - notes.indexOf(newTone);
  currentText    = savedDiff !== 0 ? transposeText(originalText, savedDiff) : originalText;
  salvarDB();
  renderCifra(currentText);
  $('orig-tone').textContent = newTone;
  $('btn-reset-tone').style.display = currentNote !== newTone ? 'block' : 'none';
  showToast('Tom original corrigido: ' + newTone);
  if (m.url) votarTomOriginal(m.url, newTone);
}

async function votarTomOriginal(url, tone) {
  try {
    await fetch(`${API}/tone-vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, tone }),
    });
  } catch {}
}

async function buscarTomComunitario(url) {
  try {
    const res = await fetch(`${API}/tone-vote?url=${encodeURIComponent(url)}`);
    if (!res.ok) return null;
    const d = await res.json();
    return d.tone || null;
  } catch { return null; }
}

// ── Fix Tone Modal (substitui o openEditOrigTone confuso) ──
function openFixToneModal() {
  const modal = $('modal-fix-tone');
  if (!modal) return;
  // Exibe o tom atual no modal
  const display = $('fix-tone-current-display');
  if (display) display.textContent = baseNote;
  buildFixToneGrid();
  modal.classList.add('open');
}

function closeFixToneModal() {
  const modal = $('modal-fix-tone');
  if (modal) modal.classList.remove('open');
}

function buildFixToneGrid() {
  const grid = $('fix-tone-grid');
  if (!grid) return;
  grid.innerHTML = '';
  notes.forEach(n => {
    const btn = document.createElement('button');
    btn.className = 'btn-tone' + (n === baseNote ? ' active' : '');
    btn.textContent = NOTE_DISPLAY[n] || n;
    btn.dataset.note = n;
    btn.onclick = () => {
      closeFixToneModal();
      setOriginalTone(n);
    };
    grid.appendChild(btn);
  });
}

// Mantido por compatibilidade mas agora redireciona para o modal
function openEditOrigTone() { openFixToneModal(); }

function transposeText(text, diff) {
  return text.replace(/\b([A-G][#b]?)/g, match => {
    const norm = {'Db':'C#','Eb':'D#','Gb':'F#','Ab':'G#','Bb':'A#'}[match] || match;
    const idx  = notes.indexOf(norm);
    if (idx === -1) return match;
    let ni = (idx + diff) % 12; if (ni < 0) ni += 12;
    return notes[ni];
  });
}

function toggleToneGrid() {
  const vis = toneGrid.style.display === 'grid';
  toneGrid.style.display = vis ? 'none' : 'grid';
  if (!vis) updateToneActive();
}

// ════════════════════════════════════
//  SCROLL
// ════════════════════════════════════
function toggleScrollPanel() {
  scrollPanel.style.display = scrollPanel.style.display === 'flex' ? 'none' : 'flex';
}
function toggleScroll() {
  isScrolling = !isScrolling;
  const btn = $('btn-play');
  if (isScrolling) {
    scrollPos = contentArea.scrollTop;
    btn.textContent = 'STOP'; btn.classList.add('playing');
    scrollLoop();
  } else { stopScroll(); }
}
function stopScroll() {
  isScrolling = false;
  const btn = $('btn-play');
  if (btn) { btn.textContent = 'PLAY'; btn.classList.remove('playing'); }
}
function scrollLoop() {
  if (!isScrolling) return;
  const speed = parseFloat($('scroll-speed').value) / 50;
  scrollPos  += speed;
  contentArea.scrollTop = Math.floor(scrollPos);
  if (role === 'S') connections.forEach(c => { if (c.open) c.send({ type:'SCROLL', pos: contentArea.scrollTop }); });
  requestAnimationFrame(scrollLoop);
}
function updateSpeedLbl() { $('speed-lbl').textContent = $('scroll-speed').value; }

// ════════════════════════════════════
//  EDIT
// ════════════════════════════════════
function toggleEditMode() {
  if (!isPro()) { showToast('✦ Recurso exclusivo Pro'); return; }
  isEditMode ? cancelEdit() : enterEditMode();
}
function enterEditMode() {
  isEditMode = true;
  editTextarea.value           = currentText;
  dynamicContent.style.display = 'none';
  cifraContainer.style.display = 'none';
  editTextarea.style.display   = 'block';
  $('btn-edit-toggle').textContent = '✕ CANCELAR';
  setView('edit');
}
function cancelEdit() {
  isEditMode = false;
  editTextarea.style.display   = 'none';
  showCifraView();
  $('btn-edit-toggle').textContent = '✎ EDITAR';
  setView('cifra');
}
function saveEdit() {
  const txt = editTextarea.value;
  currentText = txt; originalText = txt;
  const m = db.biblioteca.find(b => b.id === musicaAtivaId);
  if (m) { m.content = txt; salvarDB(); }
  renderCifra(txt); cancelEdit();
  if (role === 'S') syncMusicians(txt, currentNote);
  showToast('Cifra salva!');
}

// ════════════════════════════════════
//  SONG MGMT
// ════════════════════════════════════
function excluirMusica() {
  if (!confirm('Remover esta música da pasta?')) return;
  db.pastas[pastaAtiva].splice(musicaAtivaIndex, 1);
  salvarDB(); openFolder(pastaAtiva);
}

// ════════════════════════════════════
//  MEDLEY
// ════════════════════════════════════
function tonesCompatible(a, b) {
  if (a === b) return true;
  const ia = notes.indexOf(a), ib = notes.indexOf(b);
  const d = Math.abs(ia - ib), min = Math.min(d, 12 - d);
  return [1, 3, 4, 5, 7, 8, 9].includes(min);
}

function findMedleySuggestion() {
  if (!settings.medleyEnabled) return null;
  const ids = db.pastas[pastaAtiva] || [];
  // Exclui música atual E todo o histórico da sessão
  const excluded = new Set([musicaAtivaId, ...medleyHistory]);
  for (let i = 0; i < ids.length; i++) {
    if (excluded.has(ids[i])) continue;
    const m = db.biblioteca.find(b => b.id === ids[i]);
    if (!m) continue;
    if (tonesCompatible(currentNote, m.originalTone || 'C')) {
      return { id: ids[i], indexInPasta: i, title: m.title };
    }
  }
  // Se todas as compatíveis já foram tocadas, limpa o histórico e tenta de novo
  // (exceto a atual)
  if (medleyHistory.length > 0) {
    medleyHistory = [];
    return findMedleySuggestion();
  }
  return null;
}

function getParagraphBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() !== '') {
      const start = i;
      while (i < lines.length && lines[i].trim() !== '') i++;
      blocks.push({ start, end: i - 1, lineCount: i - start });
    } else { i++; }
  }
  return blocks;
}

function findMatchingLineInSong(content, targetTone) {
  const blocks = getParagraphBlocks(content);
  const lines  = content.split('\n');
  const chordRe = /\b([A-G][#b]?(?:m|maj|M|min|dim|aug|sus|add)?[0-9]?)\b/g;
  const normMap = {'Db':'C#','Eb':'D#','Gb':'F#','Ab':'G#','Bb':'A#'};

  for (const block of blocks) {
    for (let li = block.start; li <= block.end; li++) {
      const matches = [...lines[li].matchAll(chordRe)];
      for (const m of matches) {
        const raw  = m[1];
        const norm = normMap[raw] || raw;
        const root = norm.replace(/[^A-G#b]/g, '');
        if (root === targetTone) return block.start;
      }
    }
  }
  return 0;
}

function scrollToLine(text, lineIdx) {
  const lines     = text.split('\n');
  const totalH    = cifraContainer.scrollHeight;
  const fraction  = lineIdx / Math.max(lines.length, 1);
  const targetTop = Math.floor(fraction * totalH);
  const maxScroll = contentArea.scrollHeight - contentArea.clientHeight;
  contentArea.scrollTop = Math.min(targetTop, maxScroll);
  scrollPos = contentArea.scrollTop;
}

function startMedleyWatcher() {
  stopMedleyWatcher();
  medleySuggestion = null;
  medleyWatcherId  = setInterval(() => {
    const scrollable = contentArea.scrollHeight - contentArea.clientHeight;
    if (scrollable <= 0) return;
    const pct = contentArea.scrollTop / scrollable;

    if (pct >= 0.45 && !medleySuggestion) {
      medleySuggestion = findMedleySuggestion();
      if (medleySuggestion) insertMedleyLine(medleySuggestion.title);
    }
    if (pct >= 0.65 && medleySuggestion && !medleyBubble.classList.contains('visible')) {
      showMedleyBubble(medleySuggestion.title);
    }
    if (pct < 0.30 && medleySuggestion) { hideMedley(); medleySuggestion = null; }
  }, 700);
}

function showMedleyBubble(title) {
  const el = medleyTitleEl;
  el.textContent = title;
  medleyBubble.classList.add('visible');
}

function insertMedleyLine(title) {
  removeMedleyLine();
  const lines  = currentText.split('\n');
  const blocks = getParagraphBlocks(currentText);

  if (blocks.length < 2) return;

  const breaths = [];
  for (let b = 0; b < blocks.length - 1; b++) {
    const gapLine = blocks[b].end + 1;
    const next    = blocks[b + 1];
    if (gapLine >= next.start) continue;
    breaths.push({
      gapLine,
      nextStart: next.start,
      weight: blocks[b].lineCount + next.lineCount
    });
  }

  if (breaths.length === 0) return;

  const target = Math.floor(lines.length * 0.70);
  const best = breaths.reduce((a, b) => {
    const scoreA = Math.abs(a.gapLine - target) - a.weight * 0.3;
    const scoreB = Math.abs(b.gapLine - target) - b.weight * 0.3;
    return scoreB < scoreA ? b : a;
  });

  const before = lines.slice(0, best.gapLine).join('\n');
  const after  = lines.slice(best.nextStart).join('\n');

  cifraContainer.innerHTML =
    chordify(before) +
    `<div id="medley-line" data-title="▶ ${title}"></div>` +
    chordify(after);

  requestAnimationFrame(() => {
    const el = document.getElementById('medley-line');
    if (el) el.classList.add('visible');
  });
}

function removeMedleyLine() {
  if (document.getElementById('medley-line')) renderCifra(currentText);
}

function stopMedleyWatcher() {
  if (medleyWatcherId) { clearInterval(medleyWatcherId); medleyWatcherId = null; }
}

function hideMedley() {
  medleyBubble.classList.remove('visible');
  removeMedleyLine();
}

function jumpToMedley() {
  if (!medleySuggestion) return;

  const idx          = medleySuggestion.indexInPasta;
  const title        = medleySuggestion.title;
  const wasScrolling = isScrolling;
  const savedSpeed   = $('scroll-speed').value;

  const targetMusica   = db.biblioteca.find(b => b.id === medleySuggestion.id);
  const jumpLineIndex  = targetMusica
    ? findMatchingLineInSong(targetMusica.content, currentNote)
    : 0;

  hideMedley(); stopMedleyWatcher();
  medleyHistory.push(musicaAtivaId); // registra música atual no histórico
  openSong(idx);
  showToast('▶ ' + title);

  setTimeout(() => {
    if (jumpLineIndex > 0) scrollToLine(targetMusica.content, jumpLineIndex);

    if (wasScrolling) {
      $('scroll-speed').value    = savedSpeed;
      $('speed-lbl').textContent = savedSpeed;
      scrollPanel.style.display  = 'flex';
      isScrolling = true;
      scrollPos   = contentArea.scrollTop;
      const btn   = $('btn-play');
      btn.textContent = 'STOP'; btn.classList.add('playing');
      scrollLoop();
    }
  }, 160);
}

// ════════════════════════════════════
//  LIBRARY
// ════════════════════════════════════
function openLibrary() {
  $('modal-library').classList.add('open');
  // Default to search tab
  document.querySelectorAll('.lib-tab').forEach((t,i) => t.classList.toggle('active', i===0));
  document.querySelectorAll('.lib-tab-content').forEach((t,i) => t.classList.toggle('active', i===0));
}
function closeLibrary() { $('modal-library').classList.remove('open'); }

function switchLibTab(btn) {
  document.querySelectorAll('.lib-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.lib-tab-content').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  $('tab-' + btn.dataset.tab).classList.add('active');
  if (btn.dataset.tab === 'link') renderLibraryList();
}

// ── Busca ──
let searchCurrentPage = 1;

function renderLocalSearchResults(query, area) {
  const q = query.toLowerCase().trim();
  if (!q) { return; }

  // Filtra biblioteca local
  const matches = db.biblioteca.filter(m => {
    const t = m.title.toLowerCase();
    // Prefixo ou contains
    return t.startsWith(q) || t.includes(q);
  }).slice(0, 8); // máx 8 resultados locais

  if (!matches.length) return;

  const section = document.createElement('div');
  section.id = 'local-results-section';
  section.innerHTML = `<div class="lib-section-label" style="padding-top:8px;">📂 Nas suas músicas</div>`;

  matches.forEach(m => {
    const inPasta = db.pastas[pastaAtiva] && db.pastas[pastaAtiva].includes(m.id);
    const g = m.genre ? getGenre(m.genre) : null;
    const card = document.createElement('div');
    card.className = 'search-result-card';
    card.innerHTML = `
      <div class="search-result-info">
        <div class="search-result-title">${m.title}</div>
        <div class="search-result-artist">${g ? g.emoji + ' ' + g.label : 'Tom: ' + (m.originalTone || 'C')}</div>
      </div>
      ${inPasta
        ? '<span class="lib-check">✓</span>'
        : `<button class="btn-search-add" style="background:var(--surface2);color:var(--text);border:1px solid var(--border2);" onclick="addFromLibrary('${m.id}')">ADD</button>`}`;
    section.appendChild(card);
  });

  const divider = document.createElement('div');
  divider.className = 'lib-section-label';
  divider.style.cssText = 'padding-top:14px;border-top:1px solid var(--border);margin-top:6px;';
  divider.textContent = '🌐 Buscar online';
  section.appendChild(divider);

  area.insertBefore(section, area.firstChild);
}

async function buscarMusica(loadMore) {
  const query = $('search-input').value.trim();
  if (!query) { showToast('Digite o nome da música'); return; }

  const btn = $('btn-search');
  btn.disabled = true; btn.textContent = '...';

  const area = $('search-results-area');

  if (!loadMore) {
    searchCurrentPage = 1;
    area.innerHTML = '';
    // Always show local results first
    renderLocalSearchResults(query, area);
    if (area.querySelector('.search-result-card')) {
      // If we have local results, show "also searching online..." note
      const note = document.createElement('div');
      note.className = 'lib-section-label';
      note.style.cssText = 'padding-top:14px;border-top:1px solid var(--border);margin-top:6px;';
      note.textContent = '🌐 Buscando online...';
      note.id = 'online-searching-note';
      area.appendChild(note);
    } else {
      area.innerHTML = '<div class="search-empty">Buscando...</div>';
    }
  }

  // Slug helper
  const slug = s => (s||'').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9\s-]/g,'').trim().replace(/\s+/g,'-');

  try {
    const res  = await fetch(`${API}/search?q=${encodeURIComponent(query)}&page=${searchCurrentPage}`);
    const data = await res.json();

    // Remove loading note
    const noteEl = $('online-searching-note');
    if (noteEl) noteEl.remove();

    if (!loadMore) {
      // Clear placeholder but keep local section
      const localSection = $('local-results-section');
      area.innerHTML = '';
      if (localSection) area.appendChild(localSection);
    }

    if (!data.results || data.results.length === 0) {
      // Try CifraClub direct URL search
      await buscarNoCifraClub(query, area);
      return;
    }

    if (!loadMore) {
      const divider = document.createElement('div');
      divider.className = 'lib-section-label';
      divider.style.cssText = 'padding-top:14px;border-top:1px solid var(--border);margin-top:6px;';
      divider.textContent = '🌐 Online';
      area.appendChild(divider);
    }

    data.results.forEach(r => {
      const card = document.createElement('div');
      card.className = 'search-result-card';
      card.innerHTML = `
        <div class="search-result-info">
          <div class="search-result-title">${r.title}</div>
          <div class="search-result-artist">${r.artist || '—'}</div>
        </div>
        <button class="btn-search-add" onclick="importarDaBusca('${esc(r.url)}', '${esc(r.title)}', this)">ADD</button>`;
      area.appendChild(card);
    });

    const existing = area.querySelector('.btn-load-more');
    if (existing) existing.remove();

    if (data.hasMore) {
      const more = document.createElement('button');
      more.className = 'btn-load-more';
      more.textContent = 'VER MAIS';
      more.onclick = () => { searchCurrentPage++; buscarMusica(true); };
      area.appendChild(more);
    }

  } catch {
    const noteEl = $('online-searching-note');
    if (noteEl) noteEl.remove();
    // Fallback: try CifraClub direct
    await buscarNoCifraClub(query, area);
  } finally {
    btn.disabled = false; btn.textContent = 'BUSCAR';
  }
}

// Tenta buscar no CifraClub com padrão de URL: /cantor/musica/
async function buscarNoCifraClub(query, area) {
  const slug = s => (s||'').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9\s-]/g,'').trim().replace(/\s+/g,'-');

  // Tenta identificar cantor e música separados por " - "
  let artist = '', title = query;
  if (query.includes(' - ')) {
    const parts = query.split(' - ');
    artist = parts[0].trim();
    title  = parts.slice(1).join(' - ').trim();
  }

  const note = document.createElement('div');
  note.className = 'search-empty';
  note.textContent = artist
    ? `Buscando "${title}" de "${artist}"...`
    : 'Nenhum resultado. Tente: Cantor - Música';
  area.appendChild(note);

  if (!artist) return;

  const url = `https://www.cifraclub.com.br/${slug(artist)}/${slug(title)}/`;
  try {
    const res = await fetch(`${API}/get-cifra?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    if (!data.cifra) throw new Error('sem conteúdo');

    note.remove();
    const card = document.createElement('div');
    card.className = 'search-result-card';
    card.innerHTML = `
      <div class="search-result-info">
        <div class="search-result-title">${data.titulo || title}</div>
        <div class="search-result-artist">${artist}</div>
      </div>
      <button class="btn-search-add" onclick="importarDaBusca('${esc(url)}', '${esc(data.titulo || title)}', this)">ADD</button>`;
    area.appendChild(card);
  } catch {
    note.textContent = 'Não encontrado. Tente o link direto na aba 🔗 Link.';
  }
}

// Busca local em tempo real ao digitar
function onSearchInput() {
  const query = $('search-input').value.trim();
  const area  = $('search-results-area');
  // Remove seção local anterior
  const prev = $('local-results-section');
  if (prev) prev.remove();

  if (!query) {
    area.innerHTML = '<div class="search-empty">Digite o nome da música acima</div>';
    return;
  }
  // Mostra só locais enquanto não busca online
  area.innerHTML = '';
  renderLocalSearchResults(query, area);
  if (!area.querySelector('.search-result-card')) {
    area.innerHTML = '<div class="search-empty">Pressione BUSCAR para pesquisar online</div>';
  }
}

async function importarDaBusca(url, title, btn) {
  btn.disabled = true; btn.textContent = '...';

  // Verifica se já existe na biblioteca
  const existing = db.biblioteca.find(m => m.url === url);
  if (existing) {
    addFromLibrary(existing.id);
    return;
  }

  try {
    const res  = await fetch(`https://syncmusician.onrender.com/get-cifra?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    if (!data.cifra) throw new Error('sem conteúdo');

    const plain = htmlParaTexto(data.cifra);
    // Prioridade: tom comunitário > tom detectado no texto > 'C'
    const detectedTone    = detectKey(plain);
    const communityTone   = await buscarTomComunitario(url);
    const originalTone    = communityTone || detectedTone;
    const genre           = normalizeGenre(data.genero || data.style || data.categoria || '');
    const id              = Date.now().toString();
    db.biblioteca.push({ id, url, title: data.titulo || title, content: plain, originalTone, genre });
    db.pastas[pastaAtiva].push(id);
    salvarDB(); closeLibrary(); openFolder(pastaAtiva);
    showToast('Música importada!' + (communityTone ? ' (tom validado ✓)' : ''));
  } catch {
    btn.disabled = false; btn.textContent = 'ADD';
    showToast('Erro ao importar. Tente o link direto.');
  }
}

function renderLibraryList() {
  const list = $('library-list');
  list.innerHTML = '';
  if (!db.biblioteca.length) {
    list.innerHTML = '<div style="color:var(--text-dim);font-family:var(--font-mono);font-size:12px;padding:10px 0;">Biblioteca vazia.</div>';
    return;
  }
  db.biblioteca.forEach(m => {
    const inPasta = db.pastas[pastaAtiva] && db.pastas[pastaAtiva].includes(m.id);
    const item = document.createElement('div');
    item.className = 'lib-item';
    item.innerHTML = `
      <div class="lib-item-title">${m.title}</div>
      ${inPasta ? '<span class="lib-check">✓</span>' : `<button class="btn-lib-add" onclick="addFromLibrary('${m.id}')">ADD</button>`}`;
    list.appendChild(item);
  });
}

async function importLink() {
  let raw = $('url-input').value.trim();
  if (!raw) return;
  // Extrai URL mesmo que venha com texto na frente (ex: compartilhar do Cifra Club)
  let url = extractUrl(raw);
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  const existing = db.biblioteca.find(m => m.url === url);
  if (existing) { addFromLibrary(existing.id); $('url-input').value = ''; return; }

  const btn = $('btn-import');
  btn.textContent = 'IMPORTANDO...'; btn.disabled = true;
  try {
    const res  = await fetch(`https://syncmusician.onrender.com/get-cifra?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    if (!data.cifra) throw new Error('sem conteúdo');
    const plain           = htmlParaTexto(data.cifra);
    const detectedTone    = detectKey(plain);
    const communityTone   = await buscarTomComunitario(url);
    const originalTone    = communityTone || detectedTone;
    const genre           = normalizeGenre(data.genero || data.style || data.categoria || '');
    const id              = Date.now().toString();
    db.biblioteca.push({ id, url, title: data.titulo || 'Sem título', content: plain, originalTone, genre });
    db.pastas[pastaAtiva].push(id);
    salvarDB(); closeLibrary(); openFolder(pastaAtiva);
    $('url-input').value = '';
    showToast('Música importada!' + (communityTone ? ' (tom validado ✓)' : ''));
  } catch {
    showToast('Link não suportado — tente a aba Manual.');
  }
  finally { btn.textContent = 'IMPORTAR LINK'; btn.disabled = false; }
}

// ════════════════════════════════════
//  MANUAL — NOTE MARKING
// ════════════════════════════════════
let _markMode = 'chord'; // 'chord' | 'lyric'

function setMarkMode(mode) {
  _markMode = mode;
  $('btn-mark-chord').classList.toggle('active', mode === 'chord');
  $('btn-mark-lyric').classList.toggle('active', mode === 'lyric');
}

function handleManualSelection() {
  const ta = $('manual-cifra-input');
  const start = ta.selectionStart, end = ta.selectionEnd;
  if (start === end) return; // nothing selected

  const text     = ta.value;
  const selected = text.slice(start, end).trim();
  if (!selected) return;

  // For 'chord' mode: wrap selected word(s) so they appear on their own chord line
  // For 'lyric' mode: just ensure selected text is treated as a plain lyric line
  // We mark by inserting a tag comment that renderCifra respects via isChordLine detection
  // Simplest: for 'chord', ensure the selected text ends up on its own line
  // with nothing but chord-like tokens; for 'lyric', no change needed (already plain text).

  if (_markMode === 'chord') {
    // Pull selected text onto its own line (if not already isolated)
    const before = text.slice(0, start);
    const after  = text.slice(end);
    const prefix = before.endsWith('\n') ? '' : '\n';
    const suffix = after.startsWith('\n') ? '' : '\n';
    ta.value = before + prefix + selected + suffix + after;
  }
  // lyric mode: selection stays — just deselect and show preview
  ta.selectionStart = ta.selectionEnd = 0;
  updateManualPreview();
}

function updateManualPreview() {
  const preview = $('manual-cifra-preview');
  const label   = $('manual-preview-label');
  const text    = $('manual-cifra-input').value.trim();
  if (!text) { preview.style.display = 'none'; label.style.display = 'none'; return; }
  preview.style.display = 'block';
  label.style.display   = 'block';
  preview.innerHTML = renderFromPlainText(text);
}

function saveManual() {
  const title   = $('manual-title-input').value.trim();
  const content = $('manual-cifra-input').value.trim();
  if (!title)   { showToast('Digite o nome da música'); return; }
  if (!content) { showToast('Cole o conteúdo da cifra'); return; }
  const originalTone = $('manual-tone-select') ? $('manual-tone-select').value : 'C';
  const genre        = $('manual-genre-select') ? ($('manual-genre-select').value || null) : null;
  const singer       = $('manual-singer-input') ? $('manual-singer-input').value.trim() : '';
  const id = Date.now().toString();
  db.biblioteca.push({ id, url: '', title, content, originalTone, genre, singer });
  db.pastas[pastaAtiva].push(id);
  salvarDB(); closeLibrary(); openFolder(pastaAtiva);
  showToast('Música salva!');
}

function addFromLibrary(mId) {
  if (!db.pastas[pastaAtiva].includes(mId)) { db.pastas[pastaAtiva].push(mId); salvarDB(); }
  closeLibrary(); openFolder(pastaAtiva);
}

// ════════════════════════════════════
//  BACKUP
// ════════════════════════════════════
function openBackup()  { openSettings(); }
function closeBackup() { closeSettings(); }
function exportBackup() {
  const a = document.createElement('a');
  a.href     = URL.createObjectURL(new Blob([JSON.stringify(db,null,2)], {type:'application/json'}));
  a.download = `syncmusician_${new Date().toISOString().slice(0,10)}.json`;
  a.click(); showToast('Backup exportado!');
}
function importBackup(e) {
  const file = e.target.files[0]; if (!file) return;
  const fr = new FileReader();
  fr.onload = ev => {
    try {
      const p = JSON.parse(ev.target.result);
      if (p.pastas && p.biblioteca) { db = p; salvarDB(); renderFolders(); showToast('Backup restaurado!'); }
      else showToast('Arquivo inválido.');
    } catch { showToast('Erro ao ler arquivo.'); }
  };
  fr.readAsText(file);
}

// ════════════════════════════════════
//  FOLDER MGMT
// ════════════════════════════════════
function createFolder() {
  const nome = prompt('Nome da nova pasta:');
  if (nome && nome.trim() && !db.pastas[nome.trim()]) {
    db.pastas[nome.trim()] = []; salvarDB(); renderFolders();
  }
}

function openFolderMenu(e, nome) {
  closeContextMenu();
  const rect = e.target.getBoundingClientRect();
  const backdrop = document.createElement('div');
  backdrop.className = 'folder-ctx-backdrop';
  backdrop.onclick = closeContextMenu;

  const menu = document.createElement('div');
  menu.className = 'folder-ctx';
  menu.id = 'folder-ctx-menu';
  menu.style.top  = (rect.bottom + 6) + 'px';
  menu.style.left = Math.min(rect.left, window.innerWidth - 180) + 'px';
  menu.innerHTML = `
    <div class="folder-ctx-item" onclick="renameFolder('${esc(nome)}')">✏️ Renomear</div>
    <div class="folder-ctx-item danger" onclick="deleteFolder('${esc(nome)}')">🗑 Excluir pasta</div>`;

  document.body.appendChild(backdrop);
  document.body.appendChild(menu);
}

function closeContextMenu() {
  const m = document.getElementById('folder-ctx-menu');
  if (m) m.remove();
  document.querySelectorAll('.folder-ctx-backdrop').forEach(b => b.remove());
}

function renameFolder(nome) {
  closeContextMenu();
  const novo = prompt('Novo nome:', nome);
  if (!novo || !novo.trim() || novo.trim() === nome) return;
  if (db.pastas[novo.trim()]) { showToast('Já existe uma pasta com esse nome'); return; }
  // Preserve order by rebuilding the object
  const novas = {};
  Object.keys(db.pastas).forEach(k => {
    novas[k === nome ? novo.trim() : k] = db.pastas[k];
  });
  db.pastas = novas;
  salvarDB(); renderFolders();
}

function deleteFolder(nome) {
  closeContextMenu();
  const count = db.pastas[nome].length;
  const msg = count > 0
    ? `Excluir "${nome}" com ${count} música(s)? As músicas ficam na biblioteca.`
    : `Excluir a pasta "${nome}"?`;
  if (!confirm(msg)) return;
  delete db.pastas[nome];
  salvarDB(); renderFolders();
}

// ════════════════════════════════════
//  SETTINGS PAGE
// ════════════════════════════════════
function openSettings() { navSettings(); }
function closeSettings() { navHome(); }

function renderSettingsPage() {
  const qrSrc = peerIdGlobal
    ? `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(peerIdGlobal)}`
    : '';
  const peerId = peerIdGlobal || '—';
  const isLeader = role === 'S';

  const connectionSection = isLeader ? `
    <div class="spage-section">Conexão</div>

    <div class="spage-row col">
      <div class="spage-label">Ficar visível</div>
      <div class="spage-sub">Aparece na lista de líderes para músicos conectarem</div>
      <label class="toggle" style="margin-top:10px;">
        <input type="checkbox" id="sp-visible" ${settings.isVisible ? 'checked' : ''}
               onchange="toggleLeaderVisibility(this)">
        <span class="toggle-slider"></span>
      </label>
    </div>

    <div class="spage-row col">
      <div class="spage-label">QR Code da sessão</div>
      <div class="spage-sub">Músicos escaneiam para conectar</div>
      ${qrSrc ? `<img src="${qrSrc}" class="spage-qr" alt="QR Code">` : '<div class="spage-sub" style="margin-top:8px;">Inicie como líder para gerar o QR</div>'}
    </div>

    <div class="spage-row">
      <div>
        <div class="spage-label">ID da sessão</div>
        <div class="spage-sub" style="word-break:break-all;max-width:200px;">${peerId}</div>
      </div>
      <button class="btn-spage" onclick="copyID()">COPIAR</button>
    </div>
  ` : '';

  // ── Auth section ──
  const authSection = buildAuthSectionHTML();

  dynamicContent.innerHTML = `
    <div class="settings-page">

      ${authSection}

      <div class="spage-section">Meu perfil</div>
      <div class="spage-row col">
        <div class="spage-label">Nome de exibição</div>
        <div class="spage-sub">Aparece para músicos na lista de líderes</div>
        <div style="display:flex;gap:8px;margin-top:10px;">
          <input type="text" id="sp-name" class="input-field" style="flex:1;"
                 value="${settings.displayName || ''}" placeholder="Ex: Pastor João">
          <button class="btn-spage" onclick="saveDisplayName()">SALVAR</button>
        </div>
      </div>

      ${connectionSection}

      <div class="spage-section">Dados</div>
      <div class="spage-row">
        <div>
          <div class="spage-label">Exportar backup</div>
          <div class="spage-sub">Salva músicas e pastas num arquivo</div>
        </div>
        <button class="btn-spage" onclick="exportBackup()">EXPORTAR</button>
      </div>
      <div class="spage-row">
        <div>
          <div class="spage-label">Importar backup</div>
          <div class="spage-sub">Restaura de um arquivo salvo</div>
        </div>
        <button class="btn-spage" onclick="document.getElementById('import-file').click()">IMPORTAR</button>
      </div>
      <input type="file" id="import-file" accept=".json" style="display:none;" onchange="importBackup(event)">

      <div class="spage-section">Funcionalidades</div>
      <div class="spage-row">
        <div>
          <div class="spage-label">Sugestão de Medley</div>
          <div class="spage-sub">Sugere a próxima música compatível no tom</div>
        </div>
        <label class="toggle">
          <input type="checkbox" id="sp-medley" ${settings.medleyEnabled ? 'checked' : ''}
                 onchange="toggleSetting('medleyEnabled', this)">
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="spage-row">
        <div>
          <div class="spage-label">Editor de cifras</div>
          <div class="spage-sub">Permite editar o texto da cifra manualmente</div>
        </div>
        <label class="toggle">
          <input type="checkbox" id="sp-edit" ${settings.editEnabled ? 'checked' : ''}
                 onchange="toggleSetting('editEnabled', this)">
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="spage-row">
        <div>
          <div class="spage-label">Afinador</div>
          <div class="spage-sub">Afina seu instrumento em tempo real pelo microfone</div>
        </div>
        <button class="btn-spage" onclick="navTomDetector()">ABRIR</button>
      </div>

      <div class="spage-section">Sugestões</div>
      <div class="spage-row col">
        <div class="spage-label">Enviar sugestão de melhoria</div>
        <div class="spage-sub">Sua ideia vai direto para nossa equipe</div>
        <textarea id="sp-suggestion" placeholder="Descreva sua sugestão aqui..." style="margin-top:10px;width:100%;min-height:90px;background:var(--surface2);border:1px solid var(--border2);border-radius:10px;color:var(--text);font-family:var(--font-mono);font-size:12px;padding:10px;resize:vertical;box-sizing:border-box;"></textarea>
        <button class="btn-spage" style="margin-top:8px;align-self:flex-end;" onclick="enviarSugestao()">ENVIAR</button>
      </div>

    </div>
    <div class="nav-ghost-spacer"></div>`;
}

function buildAuthSectionHTML() {
  if (authUser) {
    const badge = isAdmin()
      ? '<span class="spage-auth-badge admin">ADMIN</span>'
      : isPro()
        ? '<span class="spage-auth-badge pro">PRO</span>'
        : '<span class="spage-auth-badge free">GRATUITO</span>';
    return `
      <div class="spage-section">Conta</div>
      <div class="spage-row" style="padding:12px 18px;">
        <div class="spage-auth-card" style="width:100%;margin:0;">
          <div class="spage-auth-avatar">
            ${authUser.picture ? `<img src="${authUser.picture}" alt="">` : '👤'}
          </div>
          <div class="spage-auth-info">
            <div class="spage-auth-name">${authUser.name}</div>
            <div class="spage-auth-email">${authUser.email}</div>
            ${badge}
          </div>
          <button class="btn-signout" onclick="googleSignOut()">SAIR</button>
        </div>
      </div>
      ${!isPro() && !isAdmin() ? `
      <div class="spage-row col">
        <div class="spage-label">Código Pro</div>
        <div class="spage-sub">Cole seu código de acesso Pro abaixo</div>
        <div class="pro-code-row" style="margin-top:10px;">
          <input type="text" id="sp-pro-code" class="input-field"
                 placeholder="SYNC-XXXX-XXXX-XXXX"
                 value="${proStatus.code || ''}">
          <button class="btn-activate-code" onclick="activateProCode()">ATIVAR</button>
        </div>
      </div>` : ''}`;
  }

  // Não logado
  return `
    <div class="spage-section">Conta</div>
    <div style="padding: 16px 18px; display:flex; flex-direction:column; gap:12px;">
      <div style="font-family:var(--font-mono);font-size:11px;color:var(--text-dim);line-height:1.6;">
        Entre com sua conta Google para acessar o SyncMusician Pro e sincronizar suas preferências.
      </div>
      <button class="btn-google-signin" onclick="googleSignIn()">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
        </svg>
        Entrar com Google
      </button>
      <div style="font-family:var(--font-mono);font-size:10px;color:var(--text-muted);text-align:center;">
        — ou —
      </div>
      <div style="font-family:var(--font-mono);font-size:11px;color:var(--text-dim);">Código Pro</div>
      <div class="pro-code-row">
        <input type="text" id="sp-pro-code" class="input-field"
               placeholder="SYNC-XXXX-XXXX-XXXX"
               value="${proStatus.code || ''}">
        <button class="btn-activate-code" onclick="activateProCode()">ATIVAR</button>
      </div>
      <div style="font-family:var(--font-mono);font-size:10px;color:var(--text-muted);line-height:1.5;">
        Já tem um código Pro? Cole acima para ativar seus recursos sem login.
      </div>
    </div>`;
}

function saveDisplayName() {
  const el = $('sp-name') || $('settings-display-name');
  const name = el ? el.value.trim() : '';
  if (!name) { showToast('Digite um nome'); return; }
  settings.displayName = name; saveSettings();
  showToast('Nome salvo!');
  if (settings.isVisible && peerIdGlobal) registerLeaderOnline(true);
}

function toggleLeaderVisibility(el) {
  settings.isVisible = el.checked; saveSettings();
  registerLeaderOnline(el.checked);
  showToast(el.checked ? 'Você está visível 📡' : 'Visibilidade desativada');
}

function toggleSetting(key, el) {
  settings[key] = el.checked; saveSettings();
  if (key === 'medleyEnabled' && !settings.medleyEnabled) hideMedley();
  if (key === 'editEnabled') {
    const btn = $('btn-edit-toggle');
    if (btn) btn.style.display = settings.editEnabled ? '' : 'none';
  }
}

function toggleQR() { $('modal-qr').classList.toggle('open'); }

function copyID() {
  if (!peerIdGlobal) { showToast('ID ainda não disponível...'); return; }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(peerIdGlobal)
      .then(() => showToast('ID copiado! ✓'))
      .catch(() => _fallbackCopy(peerIdGlobal));
  } else { _fallbackCopy(peerIdGlobal); }
}
function _fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
  document.body.appendChild(ta); ta.focus(); ta.select();
  try { document.execCommand('copy'); showToast('ID copiado! ✓'); }
  catch { showToast('ID: ' + text); }
  document.body.removeChild(ta);
}

// ════════════════════════════════════
//  SCANNER
// ════════════════════════════════════
function startScanner() {
  const container = $('reader-container');
  container.style.display = 'block';
  if (html5QrCode) {
    html5QrCode.stop().catch(()=>{}).finally(() => { html5QrCode = null; _initScanner(); });
  } else { _initScanner(); }
}

function _initScanner() {
  html5QrCode = new Html5Qrcode('reader');

  // Try rear camera first, fall back to any available camera
  const tryStart = (constraints) => {
    return html5QrCode.start(
      constraints,
      { fps: 10, qrbox: { width: 220, height: 220 } },
      decoded => { $('join-id').value = decoded; showToast('QR lido! ✓'); stopScanner(); }
    );
  };

  tryStart({ facingMode: 'environment' })
    .catch(() => tryStart({ facingMode: 'user' }))  // front camera fallback
    .catch(() => {
      // Last resort: let browser pick any camera
      return Html5Qrcode.getCameras()
        .then(cameras => {
          if (!cameras || cameras.length === 0) throw new Error('no camera');
          return html5QrCode.start(
            cameras[cameras.length - 1].id,
            { fps: 10, qrbox: { width: 220, height: 220 } },
            decoded => { $('join-id').value = decoded; showToast('QR lido! ✓'); stopScanner(); }
          );
        });
    })
    .catch(() => {
      $('reader-container').style.display = 'none';
      html5QrCode = null;
      const isSecure = location.protocol === 'https:' || location.hostname === 'localhost';
      showToast(isSecure ? 'Permissão de câmera negada' : 'Câmera exige HTTPS');
    });
}

function stopScanner() {
  if (!html5QrCode) return;
  html5QrCode.stop()
    .then(() => { $('reader-container').style.display = 'none'; html5QrCode = null; })
    .catch(() => { $('reader-container').style.display = 'none'; html5QrCode = null; });
}

// ════════════════════════════════════
//  SYNC
// ════════════════════════════════════
function syncMusicians(body, tone) {
  connections.forEach(c => { if (c.open) c.send({ type:'SYNC', body, tone }); });
}

// ════════════════════════════════════
//  DESCOBERTA DE LÍDERES
// ════════════════════════════════════
const API = 'https://syncmusician.onrender.com';

async function registerLeaderOnline(online) {
  if (!peerIdGlobal) return;
  try {
    if (online) {
      const name = settings.displayName || 'Líder';
      const res = await fetch(`${API}/leader/online`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: peerIdGlobal, name }),
      });
      if (!res.ok) return; // tabela pode não existir — ignora
      if (keepAliveId) clearInterval(keepAliveId);
      keepAliveId = setInterval(() => registerLeaderOnline(true), 90000);
    } else {
      if (keepAliveId) { clearInterval(keepAliveId); keepAliveId = null; }
      await fetch(`${API}/leader/offline`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: peerIdGlobal }),
      }).catch(() => {});
    }
  } catch {}
}

async function pollLeaders() {
  try {
    const res = await fetch(`${API}/leaders`);
    if (!res.ok) return; // tabela pode não existir ainda — ignora silenciosamente
    const data = await res.json();
    renderLeadersList(data.leaders || []);
  } catch {
    // sem internet ou servidor dormindo — não faz nada
  }
}

function renderLeadersList(leaders) {
  const card = $('leaders-card');
  const list = $('leaders-list');
  if (!card || !list) return;

  if (leaders.length === 0) {
    card.style.display = 'none';
    return;
  }

  card.style.display = 'block';
  list.innerHTML = '';
  leaders.forEach(l => {
    const item = document.createElement('div');
    item.className = 'leader-item';
    item.innerHTML = `
      <div class="leader-item-info">
        <div class="leader-dot"></div>
        <div class="leader-name">${l.name}</div>
      </div>
      <button class="btn-connect-leader"
              onclick="connectToLeader('${l.peer_id}')">ENTRAR</button>`;
    list.appendChild(item);
  });
}

function connectToLeader(peerId) {
  $('join-id').value = peerId;
  initRole('M');
}

// ════════════════════════════════════
//  AUTH — GOOGLE + PRO CODE
// ════════════════════════════════════

// Google Client ID — configure em: https://console.cloud.google.com/
// 1. Crie um projeto e ative "Google Identity Services"
// 2. Crie credenciais OAuth → Web Application
// 3. Substitua o valor abaixo pelo seu Client ID
const GOOGLE_CLIENT_ID = '1029783074997-8ds8jv2ceuk07sklqss8mk1vnqrlapu4.apps.googleusercontent.com';

function googleSignIn() {
  if (!window.google || !window.google.accounts) {
    showToast('Google Sign-In não disponível');
    return;
  }
  google.accounts.id.initialize({
    client_id:  GOOGLE_CLIENT_ID,
    callback:   handleGoogleCredential,
    auto_select: false,
    cancel_on_tap_outside: true,
  });
  google.accounts.id.prompt(notification => {
    if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
      // Fallback: mostra botão explícito
      _showGoogleSignInPopup();
    }
  });
}

function _showGoogleSignInPopup() {
  if (!window.google) return;
  const container = document.createElement('div');
  container.id = 'google-btn-container';
  container.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:9999;background:var(--surface);padding:20px;border-radius:14px;border:1px solid var(--border2);box-shadow:0 20px 60px rgba(0,0,0,0.8);';
  container.innerHTML = '<div style="font-family:var(--font-mono);font-size:12px;color:var(--text-dim);margin-bottom:12px;text-align:center;">Entrando com Google...</div><div id="google-btn-inner"></div><button onclick="document.getElementById(\'google-btn-container\').remove()" style="width:100%;margin-top:10px;padding:10px;background:none;border:1px solid var(--border);border-radius:8px;color:var(--text-dim);font-family:var(--font-mono);font-size:11px;cursor:pointer;">CANCELAR</button>';
  document.body.appendChild(container);
  google.accounts.id.renderButton(document.getElementById('google-btn-inner'), {
    theme: 'filled_black', size: 'large', width: 260
  });
}

function handleGoogleCredential(response) {
  // Remove popup se existir
  const c = document.getElementById('google-btn-container');
  if (c) c.remove();

  try {
    // Decodifica JWT (sem verificação de assinatura no client — OK para display)
    const payload = JSON.parse(atob(response.credential.split('.')[1]));
    authUser = {
      name:    payload.name    || 'Usuário',
      email:   payload.email   || '',
      picture: payload.picture || '',
    };
    saveAuth();

    if (isAdmin()) {
      showToast('Bem-vindo, Admin! 🎵');
    } else {
      showToast(`Bem-vindo, ${authUser.name}!`);
    }

    // Re-renderiza configurações se estiver na tela
    if (document.querySelector('.settings-page')) renderSettingsPage();
  } catch(e) {
    showToast('Erro ao processar login');
  }
}

function googleSignOut() {
  authUser = null;
  localStorage.removeItem('syncmusician_auth');
  if (window.google && window.google.accounts) {
    google.accounts.id.disableAutoSelect();
  }
  showToast('Saiu da conta');
  if (document.querySelector('.settings-page')) renderSettingsPage();
}

// ── Pro Code ──
// Lista de códigos válidos (SHA-256 simplificado — troca por backend real depois)
// Formato: SYNC-XXXX-XXXX-XXXX
// Admin pode gerar/revogar via endpoint /admin/codes no backend
async function activateProCode() {
  const input = $('sp-pro-code');
  if (!input) return;
  const code = input.value.trim().toUpperCase();
  if (!code) { showToast('Cole o código Pro'); return; }
  if (!code.startsWith(PRO_CODE_PREFIX)) {
    showToast('Código inválido. Formato: SYNC-XXXX-XXXX-XXXX');
    return;
  }

  // Valida no backend
  try {
    const res = await fetch(`${API}/pro/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.valid) {
        proStatus = { active: true, code };
        saveProStatus();
        showToast('🎉 Código Pro ativado com sucesso!');
        if (document.querySelector('.settings-page')) renderSettingsPage();
        return;
      }
    }
  } catch {}

  // Fallback: validação local básica (remove depois que o backend /pro/validate estiver pronto)
  if (code.startsWith('SYNC-') && code.length === 19) {
    proStatus = { active: true, code };
    saveProStatus();
    showToast('🎉 Código Pro ativado!');
    if (document.querySelector('.settings-page')) renderSettingsPage();
  } else {
    showToast('Código não reconhecido');
  }
}

// ════════════════════════════════════
//  AFINADOR ENGINE
// ════════════════════════════════════
const TUNER_NOTES  = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const TUNER_OCT    = ['C2','C#2','D2','D#2','E2','F2','F#2','G2','G#2','A2','A#2','B2',
                      'C3','C#3','D3','D#3','E3','F3','F#3','G3','G#3','A3','A#3','B3',
                      'C4','C#4','D4','D#4','E4','F4','F#4','G4','G#4','A4','A#4','B4',
                      'C5','C#5','D5','D#5','E5','F5','F#5','G5','G#5','A5','A#5','B5'];

let tunerOn        = false;
let tunerAudioCtx  = null;
let tunerAnalyser  = null;
let tunerStream    = null;
let tunerRaf       = null;
let tunerRef       = 440;  // Hz para A4
let tunerTargetHz  = null; // Hz da corda selecionada (null = auto)
let tunerTargetName= null;

// YIN pitch detection (same algorithm as before)
function tunerYin(buf, sr) {
  const W = Math.min(buf.length >> 1, 2048);
  const tauMax = Math.ceil(sr / 60), tauMin = Math.floor(sr / 1800);
  const d = new Float32Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let s = 0;
    for (let i = 0; i < W; i++) { const v = buf[i] - buf[i + tau]; s += v * v; }
    d[tau] = s;
  }
  const c = new Float32Array(tauMax + 1); c[0] = 1; let sum = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    sum += d[tau]; c[tau] = d[tau] * tau / (sum || 1e-10);
  }
  let best = -1;
  for (let tau = tauMin; tau < tauMax; tau++) {
    if (c[tau] < 0.10) { while (tau + 1 < tauMax && c[tau + 1] < c[tau]) tau++; best = tau; break; }
  }
  if (best < 0) return -1;
  if (best > 0 && best < tauMax) {
    const a = c[best - 1], b2 = c[best], cc = c[best + 1];
    const den = 2 * (2 * b2 - a - cc); if (Math.abs(den) > 1e-6) best += (a - cc) / den;
  }
  return sr / best;
}

// Freq → nearest note + cents offset
function tunerFreqToNote(f, ref) {
  if (f < 55 || f > 2200) return null;
  const semis  = 12 * Math.log2(f / ref) + 69; // MIDI note number (A4=69)
  const rounded= Math.round(semis);
  const cents  = Math.round((semis - rounded) * 100);
  const noteIdx= ((rounded % 12) + 12) % 12;
  const oct    = Math.floor(rounded / 12) - 1;
  return { name: TUNER_NOTES[noteIdx] + oct, note: TUNER_NOTES[noteIdx], oct, cents, f };
}

// RMS → dBFS
function tunerRMS(buf) {
  let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const rms = Math.sqrt(sum / buf.length);
  return rms < 1e-10 ? -96 : 20 * Math.log10(rms);
}

async function tdToggle() {
  if (tunerOn) { tunerStop(); return; }
  const errEl = $('td-error'); if (errEl) errEl.style.display = 'none';
  try {
    tunerStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
    tunerAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    tunerAnalyser = tunerAudioCtx.createAnalyser();
    tunerAnalyser.fftSize = 8192;
    tunerAnalyser.smoothingTimeConstant = 0.2;
    tunerAudioCtx.createMediaStreamSource(tunerStream).connect(tunerAnalyser);
    tunerOn = true;
    const btn = $('td-toggle-btn'), badge = $('td-live-badge');
    if (btn)   { btn.textContent = '⏹ PARAR'; btn.classList.add('on'); }
    if (badge) badge.classList.add('visible');
    tunerLoop();
  } catch {
    const errEl = $('td-error');
    if (errEl) { errEl.textContent = 'Permissão de microfone negada. Verifique as configurações.'; errEl.style.display = 'block'; }
  }
}

function tunerStop() {
  tunerOn = false;
  cancelAnimationFrame(tunerRaf);
  try { tunerAudioCtx?.close(); } catch {}
  tunerStream?.getTracks().forEach(t => t.stop());
  tunerStream = null; tunerAudioCtx = null; tunerAnalyser = null;
  const btn = $('td-toggle-btn'), badge = $('td-live-badge');
  if (btn)   { btn.textContent = '▶ INICIAR'; btn.classList.remove('on'); }
  if (badge) badge.classList.remove('visible');
  tunerRenderIdle();
}

function tunerLoop() {
  const buf = new Float32Array(tunerAnalyser.fftSize);
  function frame() {
    if (!tunerOn) return;
    tunerAnalyser.getFloatTimeDomainData(buf);
    const db  = tunerRMS(buf);
    const f   = tunerYin(buf, tunerAudioCtx.sampleRate);
    tunerRenderDB(db);
    if (f > 0 && db > -50) {
      const n = tunerFreqToNote(f, tunerRef);
      if (n) tunerRenderNote(n);
    } else if (db <= -50) {
      tunerRenderIdle();
    }
    tunerRaf = requestAnimationFrame(frame);
  }
  tunerRaf = requestAnimationFrame(frame);
}

function tunerRenderNote(n) {
  const noteName = $('tuner-note-name');
  const noteFreq = $('tuner-note-freq');
  const needle   = $('tuner-needle');
  const centsEl  = $('tuner-cents');
  const statusEl = $('tuner-status-text');
  const statusBar= $('tuner-status-bar');
  const card     = $('tuner-note-card');

  // If a target is locked, show cents relative to target
  let cents = n.cents;
  let displayName = n.name;

  if (tunerTargetHz) {
    const semisToTarget = 12 * Math.log2(n.f / tunerTargetHz);
    cents = Math.round(semisToTarget * 100);
    displayName = tunerTargetName;
  }

  if (noteName) noteName.textContent = displayName;
  if (noteFreq) noteFreq.textContent = n.f.toFixed(1) + ' Hz';
  if (centsEl)  centsEl.textContent  = (cents >= 0 ? '+' : '') + cents;

  // Needle: map -50..+50 cents → 0..100%
  const pct = Math.max(0, Math.min(100, ((cents + 50) / 100) * 100));
  if (needle) needle.style.left = pct + '%';

  // Color + status
  const absCents = Math.abs(cents);
  let color, status;
  if (absCents <= 5) {
    color = '#22c55e'; status = '✓ Afinado';
    if (statusBar) statusBar.style.background = 'rgba(34,197,94,0.12)';
    if (card) card.style.borderColor = '#22c55e50';
  } else if (absCents <= 20) {
    color = '#f97316'; status = cents < 0 ? '▼ Afine mais (subindo)' : '▲ Afine menos (descendo)';
    if (statusBar) statusBar.style.background = 'rgba(249,115,22,0.10)';
    if (card) card.style.borderColor = '#f9731650';
  } else {
    color = '#ef4444'; status = cents < 0 ? '⚠ Muito baixo — cuidado!' : '⚠ Muito alto — risco de arrebentar!';
    if (statusBar) statusBar.style.background = 'rgba(239,68,68,0.10)';
    if (card) card.style.borderColor = '#ef444450';
  }

  if (noteName) noteName.style.color = color;
  if (centsEl)  centsEl.style.color  = color;
  if (needle)   needle.style.background = color;
  if (statusEl) { statusEl.textContent = status; statusEl.style.color = color; }
}

function tunerRenderIdle() {
  const noteName = $('tuner-note-name');
  const noteFreq = $('tuner-note-freq');
  const needle   = $('tuner-needle');
  const centsEl  = $('tuner-cents');
  const statusEl = $('tuner-status-text');
  const statusBar= $('tuner-status-bar');
  const card     = $('tuner-note-card');
  if (noteName) { noteName.textContent = '—'; noteName.style.color = ''; }
  if (noteFreq) noteFreq.textContent = '— Hz';
  if (needle)   { needle.style.left = '50%'; needle.style.background = 'var(--text-dim)'; }
  if (centsEl)  { centsEl.textContent = '—'; centsEl.style.color = ''; }
  if (statusEl) { statusEl.textContent = tunerOn ? 'Toque uma nota...' : 'Toque INICIAR e afine seu instrumento'; statusEl.style.color = ''; }
  if (statusBar) statusBar.style.background = '';
  if (card) card.style.borderColor = '';
}

function tunerRenderDB(db) {
  const fill = $('tuner-db-fill');
  const val  = $('tuner-db-val');
  if (!fill || !val) return;
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  fill.style.width = pct + '%';
  val.textContent  = Math.round(db) + ' dB';
  // Color the bar: green safe, orange loud, red danger
  fill.style.background = db > -6 ? '#ef4444' : db > -18 ? '#f97316' : '#22c55e';
}

function tunerChangeRef(delta) {
  tunerRef = Math.max(420, Math.min(460, tunerRef + delta));
  const el = $('tuner-ref-val');
  if (el) el.textContent = tunerRef + ' Hz';
}

function tunerSetNote(name, hz) {
  tunerTargetHz   = hz;
  tunerTargetName = name;
  document.querySelectorAll('.tuner-preset-btn').forEach(b => {
    b.classList.toggle('active', b.textContent.startsWith(name));
  });
  showToast('Afinando para ' + name);
  if (!tunerOn) tunerRenderIdle();
}

// Stubs kept for any remaining references to old detector
let tdOn = false;
function tdStopAll() { tunerStop(); }
let tdOpenedFromDetector = false;

function enviarSugestao() {
  const el = $('sp-suggestion');
  const text = el ? el.value.trim() : '';
  if (!text) { showToast('Escreva sua sugestão primeiro'); return; }
  // Abre o cliente de e-mail padrão
  const subject = encodeURIComponent('Sugestão SyncMusician');
  const body    = encodeURIComponent(text);
  window.location.href = `mailto:contatowpsite@gmail.com?subject=${subject}&body=${body}`;
  if (el) el.value = '';
  showToast('Abrindo e-mail... obrigado! 🎵');
}

function goHome() { navConnect(); }
function salvarDB() { localStorage.setItem('syncmusician_v8', JSON.stringify(db)); }
function esc(s)     { return s.replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }

// ── Hardware/browser back button ──
window.addEventListener('popstate', () => {
  history.pushState(null, '', location.href); // intercepta o próximo

  if (isEditMode)    { cancelEdit();    return; }
  if (musicaAtivaId) { backFromSong();  return; }  // cifra → pasta
  if (pastaAtiva)    { renderFolders(); return; }  // pasta → pastas

  // Na raiz (pastas/settings) → vai para tela de conexão
  // Mas se já está na tela de setup, deixa o sistema sair normalmente
  const setupVisible = $('screen-setup').classList.contains('active');
  if (!setupVisible) { navConnect(); }
});
history.pushState(null, '', location.href);

let toastT;
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 2500);
}

$('modal-library').addEventListener('click', e => { if (e.target === $('modal-library')) closeLibrary(); });
$('modal-fix-tone').addEventListener('click', e => { if (e.target === $('modal-fix-tone')) closeFixToneModal(); });

// ════════════════════════════════════════════════════════
//  CHORD POPUP ENGINE
// ════════════════════════════════════════════════════════
const CHORD_DB = {
  'C':  {
    guitar:  [
      { name:'C aberto',   strings:[-1,3,2,0,1,0], fingers:[0,3,2,0,1,0] },
      { name:'C (5ª pos)', strings:[-1,3,5,5,5,3], fingers:[0,1,3,4,4,1], baseFret:3, barre:{fret:3,from:1,to:5} },
      { name:'Csus2',      strings:[-1,3,2,0,0,3], fingers:[0,2,1,0,0,4] },
    ],
    piano:   [
      { name:'C maior',      notes:['C','E','G'] },
      { name:'C c/ oitava',  notes:['C','E','G','C2'] },
      { name:'2ª inversão',  notes:['G','C2','E2'] },
    ],
    bass:    [
      { name:'C raiz',  strings:[-1,-1,3,3], fingers:[0,0,1,1], baseFret:2 },
      { name:'C (5ª)',  strings:[-1,3,3,-1], fingers:[0,1,1,0] },
    ],
    ukulele: [
      { name:'C',      strings:[0,0,0,3], fingers:[0,0,0,3] },
      { name:'C alt',  strings:[5,4,3,3], fingers:[3,2,1,1], baseFret:3 },
    ],
  },
  'G':  {
    guitar:  [
      { name:'G aberto',  strings:[3,2,0,0,0,3], fingers:[2,1,0,0,0,4] },
      { name:'G fechado', strings:[3,2,0,0,3,3], fingers:[2,1,0,0,3,4] },
      { name:'G barre',   strings:[3,5,5,4,3,3], fingers:[1,3,4,2,1,1], baseFret:3, barre:{fret:3,from:0,to:5} },
    ],
    piano:   [
      { name:'G maior',     notes:['G','B','D'] },
      { name:'G c/ oitava', notes:['G','B','D','G2'] },
      { name:'2ª inversão', notes:['D','G2','B2'] },
    ],
    bass:    [
      { name:'G raiz', strings:[-1,-1,0,0], fingers:[0,0,0,0] },
      { name:'G (5ª)', strings:[3,5,-1,-1], fingers:[1,3,0,0] },
    ],
    ukulele: [
      { name:'G',      strings:[0,2,3,2], fingers:[0,1,3,2] },
      { name:'G alt',  strings:[0,2,3,4], fingers:[0,1,2,4] },
    ],
  },
  'D':  {
    guitar:  [
      { name:'D aberto', strings:[-1,-1,0,2,3,2], fingers:[0,0,0,1,3,2] },
      { name:'D barre',  strings:[5,5,7,7,7,5],   fingers:[1,1,3,3,3,1], baseFret:5, barre:{fret:5,from:0,to:5} },
      { name:'Dsus2',    strings:[-1,-1,0,2,3,0], fingers:[0,0,0,1,3,0] },
    ],
    piano:   [
      { name:'D maior',     notes:['D','F#','A'] },
      { name:'D c/ oitava', notes:['D','F#','A','D2'] },
    ],
    bass:    [
      { name:'D raiz', strings:[-1,-1,0,0], fingers:[0,0,0,0] },
      { name:'D (5ª)', strings:[5,5,-1,-1], fingers:[1,1,0,0], baseFret:4 },
    ],
    ukulele: [
      { name:'D',   strings:[2,2,2,0], fingers:[2,1,3,0] },
      { name:'D7',  strings:[2,2,2,3], fingers:[1,1,1,2] },
    ],
  },
  'E':  {
    guitar:  [
      { name:'E aberto', strings:[0,2,2,1,0,0], fingers:[0,2,3,1,0,0] },
      { name:'E7',       strings:[0,2,0,1,0,0], fingers:[0,2,0,1,0,0] },
      { name:'E barre',  strings:[0,2,2,1,0,0], fingers:[1,3,4,2,1,1], baseFret:12, barre:{fret:12,from:0,to:5} },
    ],
    piano:   [
      { name:'E maior',     notes:['E','G#','B'] },
      { name:'E c/ oitava', notes:['E','G#','B','E2'] },
    ],
    bass:    [
      { name:'E raiz', strings:[0,-1,-1,-1], fingers:[0,0,0,0] },
      { name:'E (5ª)', strings:[0,2,-1,-1],  fingers:[0,2,0,0] },
    ],
    ukulele: [
      { name:'E',   strings:[4,4,4,2], fingers:[2,3,4,1], baseFret:2, barre:{fret:2,from:0,to:3} },
      { name:'E7',  strings:[1,2,0,2], fingers:[1,2,0,3] },
    ],
  },
  'A':  {
    guitar:  [
      { name:'A aberto', strings:[-1,0,2,2,2,0], fingers:[0,0,1,2,3,0] },
      { name:'A barre',  strings:[5,7,7,6,5,5],  fingers:[1,3,4,2,1,1], baseFret:5, barre:{fret:5,from:0,to:5} },
      { name:'A7',       strings:[-1,0,2,0,2,0], fingers:[0,0,2,0,3,0] },
    ],
    piano:   [
      { name:'A maior',     notes:['A','C#','E'] },
      { name:'A c/ oitava', notes:['A','C#','E','A2'] },
    ],
    bass:    [
      { name:'A raiz', strings:[-1,0,-1,-1], fingers:[0,0,0,0] },
      { name:'A (5ª)', strings:[0,0,2,-1],   fingers:[0,0,2,0] },
    ],
    ukulele: [
      { name:'A',   strings:[2,1,0,0], fingers:[2,1,0,0] },
      { name:'A7',  strings:[0,1,0,0], fingers:[0,1,0,0] },
    ],
  },
  'F':  {
    guitar:  [
      { name:'F barre',  strings:[1,3,3,2,1,1], fingers:[1,3,4,2,1,1], baseFret:1, barre:{fret:1,from:0,to:5} },
      { name:'F mini',   strings:[-1,-1,3,2,1,1], fingers:[0,0,3,2,1,1], barre:{fret:1,from:4,to:5} },
      { name:'Fmaj7',    strings:[-1,-1,3,2,1,0], fingers:[0,0,3,2,1,0] },
    ],
    piano:   [
      { name:'F maior',     notes:['F','A','C2'] },
      { name:'F c/ oitava', notes:['F','A','C2','F2'] },
    ],
    bass:    [
      { name:'F raiz', strings:[1,3,-1,-1], fingers:[1,3,0,0] },
      { name:'F (5ª)', strings:[-1,-1,3,3], fingers:[0,0,2,1], baseFret:2 },
    ],
    ukulele: [
      { name:'F',    strings:[2,0,1,0], fingers:[2,0,1,0] },
      { name:'Fmaj7',strings:[2,4,1,0], fingers:[2,4,1,0] },
    ],
  },
  'Am': {
    guitar:  [
      { name:'Am aberto', strings:[-1,0,2,2,1,0], fingers:[0,0,2,3,1,0] },
      { name:'Am barre',  strings:[5,7,7,6,5,5],  fingers:[1,3,4,2,1,1], baseFret:5, barre:{fret:5,from:0,to:5} },
      { name:'Am7',       strings:[-1,0,2,0,1,0], fingers:[0,0,2,0,1,0] },
    ],
    piano:   [
      { name:'Am',         notes:['A','C2','E2'] },
      { name:'Am oitava',  notes:['A','C2','E2','A2'] },
      { name:'1ª inversão',notes:['E','A','C2'] },
    ],
    bass:    [
      { name:'Am raiz', strings:[0,-1,-1,-1], fingers:[0,0,0,0] },
      { name:'Am (5ª)', strings:[-1,-1,2,2],  fingers:[0,0,1,1] },
    ],
    ukulele: [
      { name:'Am',  strings:[2,0,0,0], fingers:[1,0,0,0] },
      { name:'Am7', strings:[0,0,0,0], fingers:[0,0,0,0] },
    ],
  },
  'Em': {
    guitar:  [
      { name:'Em aberto', strings:[0,2,2,0,0,0], fingers:[0,2,3,0,0,0] },
      { name:'Em7',       strings:[0,2,2,0,3,0], fingers:[0,2,3,0,4,0] },
      { name:'Em barre',  strings:[7,9,9,8,7,7], fingers:[1,3,4,2,1,1], baseFret:7, barre:{fret:7,from:0,to:5} },
    ],
    piano:   [
      { name:'Em',         notes:['E','G','B'] },
      { name:'Em oitava',  notes:['E','G','B','E2'] },
    ],
    bass:    [
      { name:'Em raiz', strings:[0,2,-1,-1], fingers:[0,2,0,0] },
      { name:'Em (5ª)', strings:[-1,-1,2,4], fingers:[0,0,1,3] },
    ],
    ukulele: [
      { name:'Em',  strings:[0,4,3,2], fingers:[0,3,2,1] },
      { name:'Em7', strings:[0,2,0,2], fingers:[0,2,0,3] },
    ],
  },
  'Dm': {
    guitar:  [
      { name:'Dm aberto', strings:[-1,-1,0,2,3,1], fingers:[0,0,0,2,3,1] },
      { name:'Dm barre',  strings:[5,6,7,7,6,5],   fingers:[1,2,4,3,2,1], baseFret:5, barre:{fret:5,from:0,to:5} },
      { name:'Dm7',       strings:[-1,-1,0,2,1,1], fingers:[0,0,0,2,1,1], barre:{fret:1,from:4,to:5} },
    ],
    piano:   [
      { name:'Dm',        notes:['D','F','A'] },
      { name:'Dm oitava', notes:['D','F','A','D2'] },
    ],
    bass:    [
      { name:'Dm raiz', strings:[-1,-1,0,0], fingers:[0,0,0,0] },
      { name:'Dm (5ª)', strings:[3,3,-1,-1], fingers:[1,1,0,0], baseFret:2 },
    ],
    ukulele: [
      { name:'Dm',  strings:[2,2,1,0], fingers:[2,3,1,0] },
      { name:'Dm7', strings:[2,2,1,3], fingers:[2,3,1,4] },
    ],
  },
  'B':  {
    guitar:  [
      { name:'B barre',  strings:[-1,2,4,4,4,2], fingers:[0,1,3,3,3,1], baseFret:2, barre:{fret:2,from:1,to:5} },
      { name:'B (7ª)',   strings:[-1,2,4,2,4,2], fingers:[0,1,3,1,4,1], baseFret:2, barre:{fret:2,from:1,to:5} },
    ],
    piano:   [
      { name:'B maior',     notes:['B','D#','F#'] },
      { name:'B c/ oitava', notes:['B','D#','F#','B2'] },
    ],
    bass:    [
      { name:'B raiz', strings:[-1,2,-1,-1], fingers:[0,2,0,0] },
      { name:'B (5ª)', strings:[-1,2,4,-1],  fingers:[0,1,3,0] },
    ],
    ukulele: [
      { name:'B',  strings:[4,3,2,2], fingers:[4,3,1,2] },
    ],
  },
  'Bm': {
    guitar:  [
      { name:'Bm barre', strings:[-1,2,4,4,3,2], fingers:[0,1,3,4,2,1], baseFret:2, barre:{fret:2,from:1,to:5} },
      { name:'Bm7',      strings:[-1,2,0,2,0,2], fingers:[0,1,0,2,0,3] },
    ],
    piano:   [
      { name:'Bm',        notes:['B','D','F#'] },
      { name:'Bm oitava', notes:['B','D','F#','B2'] },
    ],
    bass:    [
      { name:'Bm raiz', strings:[-1,2,-1,-1], fingers:[0,2,0,0] },
      { name:'Bm (5ª)', strings:[-1,2,4,-1],  fingers:[0,1,3,0] },
    ],
    ukulele: [
      { name:'Bm', strings:[4,2,2,2], fingers:[4,1,2,3], baseFret:2, barre:{fret:2,from:1,to:3} },
    ],
  },

  // ── ACORDES COM SUSTENIDO ──
  'C#': {
    guitar:  [
      { name:'C# barre', strings:[4,4,6,6,6,4], fingers:[1,1,3,3,3,1], baseFret:4, barre:{fret:4,from:0,to:5} },
      { name:'C# (alt)', strings:[-1,4,3,1,2,1], fingers:[0,4,3,1,2,1], baseFret:1, barre:{fret:1,from:4,to:5} },
    ],
    piano:   [{ name:'C# maior', notes:['C#','F','G#'] }],
    bass:    [{ name:'C# raiz',  strings:[-1,-1,4,4], fingers:[0,0,1,1], baseFret:3 }],
    ukulele: [{ name:'C#', strings:[1,1,1,4], fingers:[1,1,1,4], barre:{fret:1,from:0,to:2} }],
  },
  'C#m': {
    guitar:  [
      { name:'C#m barre', strings:[4,4,6,6,5,4], fingers:[1,1,3,4,2,1], baseFret:4, barre:{fret:4,from:0,to:5} },
    ],
    piano:   [{ name:'C#m', notes:['C#','E','G#'] }],
    bass:    [{ name:'C#m raiz', strings:[-1,-1,4,4], fingers:[0,0,1,1], baseFret:3 }],
    ukulele: [{ name:'C#m', strings:[1,1,0,4], fingers:[1,1,0,3] }],
  },
  'D#': {
    guitar:  [
      { name:'D# barre', strings:[6,6,8,8,8,6], fingers:[1,1,3,3,3,1], baseFret:6, barre:{fret:6,from:0,to:5} },
      { name:'D# (alt)', strings:[-1,-1,1,3,4,3], fingers:[0,0,1,3,4,2], baseFret:1 },
    ],
    piano:   [{ name:'D# maior', notes:['D#','G','A#'] }],
    bass:    [{ name:'D# raiz',  strings:[-1,-1,1,1], fingers:[0,0,1,1], baseFret:1, barre:{fret:1,from:2,to:3} }],
    ukulele: [{ name:'D#', strings:[3,3,3,1], fingers:[2,3,4,1], baseFret:1 }],
  },
  'D#m': {
    guitar:  [
      { name:'D#m barre', strings:[6,6,8,8,7,6], fingers:[1,1,3,4,2,1], baseFret:6, barre:{fret:6,from:0,to:5} },
    ],
    piano:   [{ name:'D#m', notes:['D#','F#','A#'] }],
    bass:    [{ name:'D#m raiz', strings:[-1,-1,1,3], fingers:[0,0,1,3], baseFret:1 }],
    ukulele: [{ name:'D#m', strings:[3,3,2,1], fingers:[3,4,2,1] }],
  },
  'F#': {
    guitar:  [
      { name:'F# barre',  strings:[2,4,4,3,2,2], fingers:[1,3,4,2,1,1], baseFret:2, barre:{fret:2,from:0,to:5} },
      { name:'F# (alt)',  strings:[-1,-1,4,3,2,2], fingers:[0,0,4,3,1,2], baseFret:2 },
    ],
    piano:   [{ name:'F# maior', notes:['F#','A#','C#'] }],
    bass:    [{ name:'F# raiz',  strings:[2,4,-1,-1], fingers:[1,3,0,0] }],
    ukulele: [{ name:'F#', strings:[3,1,2,2], fingers:[4,1,2,3] }],
  },
  'F#m': {
    guitar:  [
      { name:'F#m barre', strings:[2,4,4,2,2,2], fingers:[1,3,4,1,1,1], baseFret:2, barre:{fret:2,from:0,to:5} },
      { name:'F#m7',      strings:[2,4,2,2,2,2], fingers:[1,3,1,1,1,1], baseFret:2, barre:{fret:2,from:0,to:5} },
    ],
    piano:   [
      { name:'F#m',        notes:['F#','A','C#'] },
      { name:'F#m oitava', notes:['F#','A','C#','F#2'] },
    ],
    bass:    [{ name:'F#m raiz', strings:[2,4,-1,-1], fingers:[1,3,0,0] }],
    ukulele: [{ name:'F#m', strings:[2,1,2,0], fingers:[2,1,3,0] }],
  },
  'G#': {
    guitar:  [
      { name:'G# barre', strings:[4,6,6,5,4,4], fingers:[1,3,4,2,1,1], baseFret:4, barre:{fret:4,from:0,to:5} },
    ],
    piano:   [{ name:'G# maior', notes:['G#','C','D#'] }],
    bass:    [{ name:'G# raiz',  strings:[4,6,-1,-1], fingers:[1,3,0,0] }],
    ukulele: [{ name:'G#', strings:[5,3,4,3], fingers:[4,1,3,2] }],
  },
  'G#m': {
    guitar:  [
      { name:'G#m barre', strings:[4,6,6,4,4,4], fingers:[1,3,4,1,1,1], baseFret:4, barre:{fret:4,from:0,to:5} },
    ],
    piano:   [{ name:'G#m', notes:['G#','B','D#'] }],
    bass:    [{ name:'G#m raiz', strings:[4,6,-1,-1], fingers:[1,3,0,0] }],
    ukulele: [{ name:'G#m', strings:[4,3,4,2], fingers:[3,2,4,1] }],
  },
  'A#': {
    guitar:  [
      { name:'A# barre', strings:[6,8,8,7,6,6], fingers:[1,3,4,2,1,1], baseFret:6, barre:{fret:6,from:0,to:5} },
      { name:'Bb aberto',strings:[-1,1,3,3,3,1], fingers:[0,1,2,3,4,1], baseFret:1, barre:{fret:1,from:1,to:5} },
    ],
    piano:   [{ name:'A#/Bb maior', notes:['A#','D','F'] }],
    bass:    [{ name:'A# raiz', strings:[-1,1,-1,-1], fingers:[0,1,0,0] }],
    ukulele: [{ name:'A#', strings:[3,2,1,1], fingers:[3,2,1,1] }],
  },
  'A#m': {
    guitar:  [
      { name:'A#m barre', strings:[6,8,8,6,6,6], fingers:[1,3,4,1,1,1], baseFret:6, barre:{fret:6,from:0,to:5} },
    ],
    piano:   [{ name:'A#m/Bbm', notes:['A#','C#','F'] }],
    bass:    [{ name:'A#m raiz', strings:[-1,1,-1,-1], fingers:[0,1,0,0] }],
    ukulele: [{ name:'A#m', strings:[3,1,1,1], fingers:[3,1,1,1], barre:{fret:1,from:1,to:3} }],
  },
};

const WHITE_NOTES = ['C','D','E','F','G','A','B','C2','D2','E2','F2','G2','A2','B2'];
const BLACK_NOTES = { 'C#':0,'D#':1,'F#':3,'G#':4,'A#':5,'C#2':7,'D#2':8,'F#2':10,'G#2':11,'A#2':12 };
const STR_GUITAR  = ['E','A','D','G','B','e'];
const STR_BASS    = ['E','A','D','G'];
const STR_UKE     = ['G','C','E','A'];

let chordPopupInst = 'guitar';
let chordPopupVar  = 0;
let chordPopupName = '';

const NOTE_NAMES = {
  'C':'Dó','C#':'Dó#','D':'Ré','D#':'Ré#','E':'Mi',
  'F':'Fá','F#':'Fá#','G':'Sol','G#':'Sol#','A':'Lá','A#':'Lá#','B':'Si'
};

function openChordPopup(chord) {
  const root = chord.split('/')[0];
  chordPopupName = root;
  chordPopupVar  = 0;

  // Mostra nome + nota (ex: "Am • Lá menor")
  const noteName = NOTE_NAMES[root.replace(/m.*|M.*|dim.*|aug.*|sus.*|add.*|\d/g,'')] || '';
  const qualifier = root.match(/m(?!aj)|dim|aug|sus/)?.[0] === 'm' ? ' menor' : root.includes('dim') ? ' diminuto' : root.includes('aug') ? ' aumentado' : ' maior';
  $('chord-popup-title').textContent = chord;
  $('chord-popup-subtitle').textContent = noteName ? `${noteName}${qualifier}` : '';

  document.querySelectorAll('.chord-inst-tab').forEach(t => t.classList.toggle('active', t.dataset.inst === chordPopupInst));
  $('chord-overlay').classList.add('open');
  $('chord-popup').classList.add('open');
  renderChordPopup();
  initChordSwipe();
}

function closeChordPopup() {
  $('chord-overlay').classList.remove('open');
  $('chord-popup').classList.remove('open');
}

function chordSelectInst(tab) {
  document.querySelectorAll('.chord-inst-tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  chordPopupInst = tab.dataset.inst;
  chordPopupVar  = 0;
  renderChordPopup();
}

// Mapa de enarmônicos: bemol → sustenido equivalente
const ENHARMONIC = {
  'Db':'C#','Eb':'D#','Fb':'E','Gb':'F#','Ab':'G#','Bb':'A#','Cb':'B',
  'db':'C#','eb':'D#','gb':'F#','ab':'G#','bb':'A#',
};

function normalizeChordName(name) {
  // Remove barra de baixo (slash chord): Bb/D → Bb
  let n = name.split('/')[0].trim();

  // Extrai raiz + qualificador
  const rootMatch = n.match(/^([A-G][#b]?)(.*)/);
  if (!rootMatch) return n;

  let root = rootMatch[1];
  let qual = rootMatch[2] || '';

  // Converte bemóis para sustenidos
  const enRoot = ENHARMONIC[root];
  if (enRoot) root = enRoot;

  // Remove sufixos numéricos puros mantendo 'm' de menor
  // A7→A, C9→C, D4→D, A2→A, D#9→D#, Cm7→Cm, Am7→Am
  qual = qual
    .replace(/^(m(?:in)?)(aj)?(\d+)$/, '$1') // Am7 → Am, Cm9 → Cm
    .replace(/^(maj)(\d+)$/, '')              // Cmaj7 → C
    .replace(/^(\d+)$/, '')                   // C7 → C, C9 → C
    .replace(/^(sus)(\d*)$/, '')              // Csus4 → C
    .replace(/^(add)(\d+)$/, '')              // Cadd9 → C
    .replace(/^(dim)(\d*)$/, 'dim')           // Cdim7 → Cdim
    .replace(/^(aug)(\d*)$/, '');             // Caug → C

  return root + qual;
}

function getChordEntry() {
  // Tenta nome exato primeiro
  if (CHORD_DB[chordPopupName]) return CHORD_DB[chordPopupName];

  // Normaliza (remove bemóis, sufixos numéricos, slash)
  const normalized = normalizeChordName(chordPopupName);
  if (CHORD_DB[normalized]) return CHORD_DB[normalized];

  // Última tentativa: só a raiz
  const rootOnly = normalized.replace(/m$|dim$|aug$/, '');
  return CHORD_DB[rootOnly] || null;
}

function renderChordPopup() {
  const entry  = getChordEntry();
  const varRow = $('chord-var-row');
  const track  = $('chord-diagram-track');

  if (!entry || !entry[chordPopupInst]?.length) {
    varRow.innerHTML = '';
    track.innerHTML  = `<div class="chord-diagram-slide"><div style="color:var(--text-dim);font-family:var(--font-mono);font-size:12px;text-align:center;line-height:1.8;">Posição de <b style="color:var(--accent)">${chordPopupName}</b><br>ainda não cadastrada<br>para este instrumento.</div></div>`;
    $('chord-prev').style.display = 'none';
    $('chord-next').style.display = 'none';
    return;
  }

  const vars = entry[chordPopupInst];

  // Dots
  varRow.innerHTML = `<span class="chord-var-label">Variação</span>`;
  vars.forEach((_, i) => {
    const d = document.createElement('div');
    d.className = 'chord-var-dot' + (i === chordPopupVar ? ' active' : '');
    d.onclick = () => selectChordVar(i);
    varRow.appendChild(d);
  });

  // Arrows visibility
  $('chord-prev').style.display = vars.length > 1 ? 'flex' : 'none';
  $('chord-next').style.display = vars.length > 1 ? 'flex' : 'none';
  updateArrows(vars.length);

  // Slides
  track.innerHTML = '';
  track.style.transform = `translateX(-${chordPopupVar * 100}%)`;
  vars.forEach(v => {
    const slide = document.createElement('div');
    slide.className = 'chord-diagram-slide';
    if (chordPopupInst === 'piano') {
      slide.appendChild(buildPianoDiagram(v));
    } else {
      const strLabels = chordPopupInst === 'bass' ? STR_BASS : chordPopupInst === 'ukulele' ? STR_UKE : STR_GUITAR;
      slide.appendChild(buildFretDiagram(v, strLabels));
    }
    track.appendChild(slide);
  });
}

function updateArrows(total) {
  const t = total || (getChordEntry()?.[chordPopupInst]?.length || 0);
  if ($('chord-prev')) $('chord-prev').style.opacity = chordPopupVar === 0 ? '0.3' : '1';
  if ($('chord-next')) $('chord-next').style.opacity = chordPopupVar >= t - 1 ? '0.3' : '1';
}

function chordPrev() {
  const vars = getChordEntry()?.[chordPopupInst] || [];
  if (chordPopupVar > 0) selectChordVar(chordPopupVar - 1);
}
function chordNext() {
  const vars = getChordEntry()?.[chordPopupInst] || [];
  if (chordPopupVar < vars.length - 1) selectChordVar(chordPopupVar + 1);
}

function selectChordVar(idx) {
  const vars = getChordEntry()?.[chordPopupInst] || [];
  chordPopupVar = Math.max(0, Math.min(idx, vars.length - 1));
  document.querySelectorAll('.chord-var-dot').forEach((d, i) => d.classList.toggle('active', i === chordPopupVar));
  $('chord-diagram-track').style.transform = `translateX(-${chordPopupVar * 100}%)`;
  updateArrows(vars.length);
}

function initChordSwipe() {
  const scroll = document.querySelector('.chord-diagram-scroll');
  if (!scroll) return;
  let startX = 0, moved = false;
  scroll.ontouchstart = e => { startX = e.touches[0].clientX; moved = false; };
  scroll.ontouchmove  = e => { if (Math.abs(e.touches[0].clientX - startX) > 10) moved = true; };
  scroll.ontouchend   = e => {
    if (!moved) return;
    const diff = e.changedTouches[0].clientX - startX;
    if (diff < -40) chordNext();
    else if (diff > 40) chordPrev();
  };
}

// ── Fretboard builder ──
function buildFretDiagram(data, strLabels) {
  const count    = strLabels.length;
  const baseFret = data.baseFret || 1;
  const strings  = data.strings.slice(0, count);
  const fingers  = data.fingers.slice(0, count);
  const barre    = data.barre;
  const FRETS    = 4;

  const wrap = document.createElement('div');
  wrap.className = 'gd-wrap';

  // Name
  const lbl = document.createElement('div');
  lbl.className = 'gd-label'; lbl.textContent = data.name;
  wrap.appendChild(lbl);

  // Open/mute row
  const topRow = document.createElement('div');
  topRow.className = 'gd-top-row';
  // spacer for fret number column
  const spc = document.createElement('div'); spc.style.width = '24px';
  topRow.appendChild(spc);
  strings.forEach(s => {
    const c = document.createElement('div');
    c.className = 'gd-open-cell' + (s === -1 ? ' mute' : '');
    c.textContent = s === -1 ? '✕' : s === 0 ? '○' : '';
    topRow.appendChild(c);
  });
  wrap.appendChild(topRow);

  // Grid wrapper
  const gridWrap = document.createElement('div');
  gridWrap.className = 'gd-grid-wrap';

  // Fret number
  const fretNumEl = document.createElement('div');
  fretNumEl.className = 'gd-fret-num';
  fretNumEl.textContent = baseFret > 1 ? baseFret + 'fr' : '';
  gridWrap.appendChild(fretNumEl);

  const grid = document.createElement('div');
  grid.className = 'gd-grid';

  // Nut
  if (baseFret === 1) {
    const nut = document.createElement('div');
    nut.className = 'gd-nut';
    nut.style.width = (count * 36) + 'px';
    grid.appendChild(nut);
  }

  // Fret rows
  for (let f = 0; f < FRETS; f++) {
    const actual = baseFret + f;
    const row = document.createElement('div');
    row.className = 'gd-frow';

    for (let s = 0; s < count; s++) {
      const cell = document.createElement('div');
      cell.className = 'gd-cell';

      if (strings[s] === actual) {
        // Barre spanning from this string?
        if (barre && barre.fret === actual && s === barre.from) {
          const barWidth = (barre.to - barre.from) * 36 + 20;
          const b = document.createElement('div');
          b.className = 'gd-barre-bar';
          b.style.width = barWidth + 'px';
          b.style.left  = '8px';
          b.textContent  = fingers[s] || '';
          cell.appendChild(b);
        } else if (!(barre && barre.fret === actual && s > barre.from && s <= barre.to)) {
          const dot = document.createElement('div');
          dot.className = 'gd-dot';
          dot.textContent = fingers[s] > 0 ? fingers[s] : '';
          cell.appendChild(dot);
        }
      }
      row.appendChild(cell);
    }
    grid.appendChild(row);
  }
  gridWrap.appendChild(grid);
  wrap.appendChild(gridWrap);

  // String labels
  const strRow = document.createElement('div');
  strRow.className = 'gd-bottom-row';
  const strSpc = document.createElement('div'); strSpc.style.width = '24px';
  strRow.appendChild(strSpc);
  strLabels.forEach(n => {
    const l = document.createElement('div');
    l.className = 'gd-str-label'; l.textContent = n;
    strRow.appendChild(l);
  });
  wrap.appendChild(strRow);

  return wrap;
}

// ── Piano builder ──
function buildPianoDiagram(data) {
  const active = new Set(data.notes);

  const wrap = document.createElement('div');
  wrap.className = 'pd-wrap';

  const lbl = document.createElement('div');
  lbl.className = 'pd-label'; lbl.textContent = data.name;
  wrap.appendChild(lbl);

  const keys = document.createElement('div');
  keys.className = 'pd-keys';
  keys.style.width = (WHITE_NOTES.length * 32) + 'px';

  WHITE_NOTES.forEach(n => {
    const k = document.createElement('div');
    k.className = 'pd-white' + (active.has(n) ? ' active' : '');
    const lb = document.createElement('div');
    lb.className = 'pd-knote'; lb.textContent = n.replace('2','');
    k.appendChild(lb); keys.appendChild(k);
  });

  Object.entries(BLACK_NOTES).forEach(([note, wIdx]) => {
    const k = document.createElement('div');
    k.className = 'pd-black' + (active.has(note) ? ' active' : '');
    k.style.left = (wIdx * 32 + 21) + 'px';
    const lb = document.createElement('div');
    lb.className = 'pd-knote'; lb.textContent = note.replace('2','');
    k.appendChild(lb); keys.appendChild(k);
  });

  wrap.appendChild(keys);

  const notesEl = document.createElement('div');
  notesEl.className = 'pd-notes';
  notesEl.textContent = 'Notas: ' + data.notes.map(n => n.replace('2','')).join(' – ');
  wrap.appendChild(notesEl);

  return wrap;
}

