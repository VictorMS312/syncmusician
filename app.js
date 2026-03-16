// ════════════════════════════════════
//  STATE
// ════════════════════════════════════
let db = JSON.parse(localStorage.getItem('syncmusician_v8')) || {
  pastas: { "Repertório Geral": [] },
  biblioteca: []
};

let peer = null, connections = [], role = '';
let pastaAtiva = '', musicaAtivaId = null, musicaAtivaIndex = -1;
let originalText = '', currentText = '', baseNote = 'C', currentNote = 'C';
let isScrolling = false, scrollPos = 0;
let isEditMode = false;
let peerIdGlobal = null;
let html5QrCode = null;
let medleySuggestion = null;
let medleyWatcherId = null;

const notes = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

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
};

function initRole(r) {
  role = r;
  if (role === 'M') {
    const id = $('join-id').value.trim();
    if (!id) { showToast('Digite o ID do Líder'); return; }
    localStorage.setItem('last_leader_id', id);
  }
  peer = new Peer();
  showScreen('screen-app');
  if (role === 'S') setupLeader();
  else setupMusician($('join-id').value.trim());
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}

// ════════════════════════════════════
//  PEER — LEADER
// ════════════════════════════════════
function setupLeader() {
  $('leader-controls').style.display = 'flex';

  peer.on('open', id => {
    peerIdGlobal = id;
    $('status-dot').className = 'status-dot leader';
    $('status-text').textContent = 'LÍDER';
    $('qr-img').src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(id)}`;
    $('qr-id-text').textContent = id;
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
    $('status-dot').className  = 'status-dot offline';
    $('status-text').textContent = 'ERRO';
  });

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
  toneBar.style.display      = 'flex';
  controlsBar.style.display  = 'none';
  scrollPanel.style.display  = 'none';
  contentArea.scrollTop      = 0;
  hideMedley();
}

// ════════════════════════════════════
//  NAVIGATION
// ════════════════════════════════════
function setFABs(view) {
  $('fab-add').style.display  = 'none';
  $('fab-home').style.display = 'none';
  $('fab-back').style.display = 'none';
  $('fab-save').style.display = 'none';
  if (view === 'folders') $('fab-home').style.display = 'flex';
  if (view === 'songs')   $('fab-add').style.display  = 'flex';
  if (view === 'cifra')   $('fab-back').style.display = 'flex';
  if (view === 'edit')  { $('fab-back').style.display = 'flex'; $('fab-save').style.display = 'flex'; }
}

function renderFolders() {
  pastaAtiva = ''; musicaAtivaId = null; musicaAtivaIndex = -1;
  showDynamic(); hideAllPanels(); hideMedley(); stopMedleyWatcher();
  setFABs('folders');
  let html = `<div class="view-header"><div class="view-title">Minhas Pastas</div></div><div class="folders-grid">`;
  Object.keys(db.pastas).forEach(nome => {
    html += `<div class="folder-card" onclick="openFolder('${esc(nome)}')">
      <div class="folder-emoji">📁</div>
      <div class="folder-name">${nome}</div>
      <div class="folder-count">${db.pastas[nome].length} músicas</div>
    </div>`;
  });
  html += `<div class="folder-card new" onclick="createFolder()">
    <div class="folder-emoji">＋</div>
    <div class="folder-name">Nova Pasta</div>
  </div></div>`;
  dynamicContent.innerHTML = html;
}

function openFolder(nome) {
  pastaAtiva = nome;
  showDynamic(); hideAllPanels(); hideMedley(); stopMedleyWatcher();
  setFABs('songs');
  const songs = db.pastas[nome].map(id => db.biblioteca.find(b => b.id === id)).filter(Boolean);
  let html = `<div class="view-header">
    <button class="back-btn" onclick="renderFolders()">← PASTAS</button>
    <div class="view-title">${nome}</div>
  </div><div class="songs-list">`;
  if (!songs.length) {
    html += `<div style="text-align:center;padding:44px;color:var(--text-dim);font-family:var(--font-mono);font-size:12px;">
      Nenhuma música ainda.<br>Toque + para adicionar.</div>`;
  }
  songs.forEach((m, i) => {
    html += `<div class="song-card" onclick="openSong(${i})">
      <div>
        <div class="song-title">${m.title}</div>
        <div class="song-meta">Tom: ${m.originalTone || 'C'}</div>
      </div>
      <div class="song-badge">${m.originalTone || 'C'}</div>
    </div>`;
  });
  html += '</div>';
  dynamicContent.innerHTML = html;
}

function openSong(index) {
  musicaAtivaIndex = index;
  const mId    = db.pastas[pastaAtiva][index];
  musicaAtivaId  = mId;
  const musica = db.biblioteca.find(b => b.id === mId);
  if (!musica) return;

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
    syncMusicians(currentText, currentNote);
  }

  setFABs('cifra');
  hideMedley();
  stopScroll();
  isScrolling = false;
  contentArea.scrollTop = 0; scrollPos = 0;

  if (role === 'S') startMedleyWatcher();
}

function fabBackHandler() {
  if (isEditMode) { cancelEdit(); return; }
  backFromSong();
}

function backFromSong() {
  hideAllPanels(); hideMedley(); stopScroll(); stopMedleyWatcher();
  openFolder(pastaAtiva);
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
function chordify(text) {
  return text.replace(
    /\b([A-G][#b]?(?:m|maj|M|min|dim|aug|sus|add)?[0-9]?)(?=[\s\/()\r\n]|$)/g,
    '<span class="chord">$1</span>'
  );
}

function renderCifra(text) {
  cifraContainer.innerHTML = chordify(text);
}

// ════════════════════════════════════
//  TONE
// ════════════════════════════════════
function buildToneGrid() {
  toneGrid.innerHTML = '';
  notes.forEach(n => {
    const btn = document.createElement('button');
    btn.className = 'btn-tone'; btn.textContent = n;
    btn.onclick = () => { selectTone(n); toggleToneGrid(); };
    toneGrid.appendChild(btn);
  });
}

function updateToneActive() {
  toneGrid.querySelectorAll('.btn-tone').forEach(b => b.classList.toggle('active', b.textContent === currentNote));
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
function toggleEditMode() { isEditMode ? cancelEdit() : enterEditMode(); }
function enterEditMode() {
  isEditMode = true;
  editTextarea.value           = currentText;
  dynamicContent.style.display = 'none';
  cifraContainer.style.display = 'none';
  editTextarea.style.display   = 'block';
  $('btn-edit-toggle').textContent = '✕ CANCELAR';
  setFABs('edit');
}
function cancelEdit() {
  isEditMode = false;
  editTextarea.style.display   = 'none';
  showCifraView();
  $('btn-edit-toggle').textContent = '✎ EDITAR';
  setFABs('cifra');
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
  const ids = db.pastas[pastaAtiva] || [];
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] === musicaAtivaId) continue;
    const m = db.biblioteca.find(b => b.id === ids[i]);
    if (!m) continue;
    if (tonesCompatible(currentNote, m.originalTone || 'C')) {
      return { id: ids[i], indexInPasta: i, title: m.title };
    }
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
  renderLibraryList();
}
function closeLibrary() { $('modal-library').classList.remove('open'); }

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
  const url = $('url-input').value.trim();
  if (!url) return;
  const existing = db.biblioteca.find(m => m.url === url);
  if (existing) { addFromLibrary(existing.id); $('url-input').value = ''; return; }
  const btn = $('btn-import');
  btn.textContent = 'IMPORTANDO...'; btn.disabled = true;
  try {
    const res  = await fetch(`https://syncmusician.onrender.com/get-cifra?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    const id   = Date.now().toString();
    db.biblioteca.push({ id, url, title: data.titulo || 'Sem título', content: data.cifra, originalTone: 'C' });
    db.pastas[pastaAtiva].push(id);
    salvarDB(); closeLibrary(); openFolder(pastaAtiva);
    $('url-input').value = '';
    showToast('Música importada!');
  } catch { showToast('Erro ao importar.'); }
  finally { btn.textContent = 'IMPORTAR LINK'; btn.disabled = false; }
}

function addFromLibrary(mId) {
  if (!db.pastas[pastaAtiva].includes(mId)) { db.pastas[pastaAtiva].push(mId); salvarDB(); }
  closeLibrary(); openFolder(pastaAtiva);
}

// ════════════════════════════════════
//  BACKUP
// ════════════════════════════════════
function openBackup()  { $('modal-backup').classList.add('open'); }
function closeBackup() { $('modal-backup').classList.remove('open'); }
function exportBackup() {
  const a = document.createElement('a');
  a.href     = URL.createObjectURL(new Blob([JSON.stringify(db,null,2)], {type:'application/json'}));
  a.download = `syncmusician_${new Date().toISOString().slice(0,10)}.json`;
  a.click(); closeBackup(); showToast('Backup exportado!');
}
function importBackup(e) {
  const file = e.target.files[0]; if (!file) return;
  const fr = new FileReader();
  fr.onload = ev => {
    try {
      const p = JSON.parse(ev.target.result);
      if (p.pastas && p.biblioteca) { db = p; salvarDB(); closeBackup(); renderFolders(); showToast('Backup restaurado!'); }
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

// ════════════════════════════════════
//  QR & COPY
// ════════════════════════════════════
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
  html5QrCode.start(
    { facingMode: 'environment' },
    { fps: 10, qrbox: { width: 230, height: 230 } },
    decoded => { $('join-id').value = decoded; showToast('QR lido! ✓'); stopScanner(); }
  ).catch(err => {
    $('reader-container').style.display = 'none';
    const isSecure = location.protocol === 'https:' || location.hostname === 'localhost';
    showToast(isSecure ? 'Permissão de câmera negada' : 'Câmera exige HTTPS ou localhost');
  });
}
function stopScanner() {
  if (!html5QrCode) return;
  html5QrCode.stop()
    .then(() => { $('reader-container').style.display = 'none'; html5QrCode = null; })
    .catch(() => { $('reader-container').style.display = 'none'; });
}

// ════════════════════════════════════
//  SYNC
// ════════════════════════════════════
function syncMusicians(body, tone) {
  connections.forEach(c => { if (c.open) c.send({ type:'SYNC', body, tone }); });
}

// ════════════════════════════════════
//  UTILS
// ════════════════════════════════════
function goHome()   { location.reload(); }
function salvarDB() { localStorage.setItem('syncmusician_v8', JSON.stringify(db)); }
function esc(s)     { return s.replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }

let toastT;
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 2500);
}

$('modal-library').addEventListener('click', e => { if (e.target === $('modal-library')) closeLibrary(); });
