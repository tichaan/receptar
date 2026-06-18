'use strict';

/* ─────────────────────────────────────────────
   Score Splitter — frontend app
   ───────────────────────────────────────────── */

const API = '';  // same origin

// ── State ────────────────────────────────────
const state = {
  sessionId: null,
  session: null,        // full session JSON from server
  currentPage: 0,
  mode: 'cut',          // 'cut' | 'select'
  // editing
  imgWidth: 0,
  imgHeight: 0,
  selectedCut: null,    // index into session.pages[n].cuts
  dragState: null,      // {type:'cut', idx, startY, origVal}
  // layout drag
  layoutDrag: null,
};

const PART_COLORS = [
  '#f97316','#22c55e','#3b82f6','#a855f7',
  '#ec4899','#14b8a6','#eab308','#ef4444',
];

// ── Helpers ──────────────────────────────────
function partColor(partName) {
  const parts = state.session?.parts ?? [];
  const idx = parts.indexOf(partName);
  return PART_COLORS[((idx < 0 ? 0 : idx)) % PART_COLORS.length];
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' error' : '');
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

async function apiFetch(url, opts = {}) {
  const resp = await fetch(API + url, opts);
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(body || resp.statusText);
  }
  return resp;
}

async function apiJSON(url, opts = {}) {
  const resp = await apiFetch(url, opts);
  return resp.json();
}

function saveLocal() {
  if (!state.sessionId) return;
  localStorage.setItem('last_session', state.sessionId);
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

// ── Session sync ──────────────────────────────
async function pushSession() {
  if (!state.session) return;
  await apiFetch(`/api/session/${state.sessionId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: state.session }),
  });
}

async function pullSession() {
  state.session = await apiJSON(`/api/session/${state.sessionId}`);
}

// ── Steps ─────────────────────────────────────
const VIEWS = ['upload', 'edit', 'layout', 'export'];
const VIEW_ELS = {
  upload: 'upload-screen',
  edit:   'editor-view',
  layout: 'layout-view',
  export: 'export-view',
};

const App = window.App = {

  async goStep(step) {
    VIEWS.forEach(v => {
      document.getElementById(VIEW_ELS[v]).style.display = 'none';
    });
    document.querySelectorAll('.step-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`btn-step-${step === 'edit' ? 'edit' : step}`).classList.add('active');

    const viewEl = document.getElementById(VIEW_ELS[step]);
    viewEl.style.display = (step === 'upload') ? 'flex' : 'flex';

    if (step === 'edit') {
      await App.renderEditorPage(state.currentPage);
      App.renderSidebarThumbs();
      App.renderPartsListSidebar();
    } else if (step === 'layout') {
      await App.renderLayoutView();
    } else if (step === 'export') {
      App.renderExportView();
    }
  },

  enableSteps() {
    ['edit','layout','export'].forEach(s => {
      document.getElementById(`btn-step-${s}`).disabled = false;
    });
  },

  // ── Upload ──────────────────────────────────

  initUpload() {
    const zone = document.getElementById('drop-zone');
    const input = document.getElementById('file-input');

    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const f = e.dataTransfer.files[0];
      if (f) App.uploadFile(f);
    });
    input.addEventListener('change', () => {
      if (input.files[0]) App.uploadFile(input.files[0]);
    });

    const last = localStorage.getItem('last_session');
    if (last) {
      const div = document.getElementById('recent-sessions');
      div.innerHTML = `<p style="font-size:.8rem;color:var(--text-dim);text-align:center;margin-top:8px">
        Recent: <a href="#" style="color:var(--accent2)" onclick="App.resumeSession('${last}');return false">Resume last session</a>
      </p>`;
    }
  },

  async uploadFile(file) {
    const zone = document.getElementById('drop-zone');
    zone.innerHTML = '<div class="spinner"></div>';
    try {
      const fd = new FormData();
      fd.append('file', file);
      const data = await apiJSON('/api/upload', { method: 'POST', body: fd });
      state.sessionId = data.session_id;
      await pullSession();
      saveLocal();
      App.enableSteps();
      App.goStep('edit');
    } catch (e) {
      toast('Upload failed: ' + e.message, 'error');
      zone.innerHTML = '<p style="color:var(--accent)">Upload failed — try again</p>';
    }
  },

  async resumeSession(sid) {
    try {
      state.sessionId = sid;
      await pullSession();
      App.enableSteps();
      App.goStep('edit');
    } catch (e) {
      toast('Could not resume session', 'error');
    }
  },

  // ── Sidebar ─────────────────────────────────

  renderSidebarThumbs() {
    const list = document.getElementById('page-thumb-list');
    if (!state.session) return;
    list.innerHTML = '';
    for (let i = 0; i < state.session.page_count; i++) {
      const div = document.createElement('div');
      div.className = 'page-thumb' + (i === state.currentPage ? ' active' : '');
      div.dataset.page = i;
      div.innerHTML = `<img src="/api/render/${state.sessionId}/${i}?dpi=60" loading="lazy">
        <div class="page-thumb-label">Page ${i + 1}</div>`;
      div.onclick = () => App.renderEditorPage(i);
      list.appendChild(div);
    }
  },

  renderPartsListSidebar() {
    const list = document.getElementById('parts-list');
    if (!state.session) return;
    list.innerHTML = '';
    state.session.parts.forEach((part, idx) => {
      const div = document.createElement('div');
      div.className = 'part-item';
      div.innerHTML = `
        <div class="part-color-swatch" style="background:${PART_COLORS[idx % PART_COLORS.length]}"></div>
        <input class="part-name-input" value="${escHtml(part)}" data-idx="${idx}"
          onchange="App.renamePart(${idx}, this.value)">
        <button class="btn btn-icon btn-ghost btn-sm" onclick="App.removePart(${idx})" title="Remove">✕</button>
      `;
      list.appendChild(div);
    });
  },

  // ── Parts management ────────────────────────

  addPart() {
    const name = prompt('New part name:', `Part ${state.session.parts.length + 1}`);
    if (!name) return;
    state.session.parts.push(name);
    pushSession();
    App.renderPartsListSidebar();
    App.renderStripAssignment();
  },

  renamePart(idx, newName) {
    const old = state.session.parts[idx];
    state.session.parts[idx] = newName;
    // update strips
    state.session.strips.forEach(s => { if (s.part === old) s.part = newName; });
    // update layout keys
    if (state.session.layout[old] !== undefined) {
      state.session.layout[newName] = state.session.layout[old];
      delete state.session.layout[old];
    }
    pushSession();
    App.renderStripAssignment();
  },

  removePart(idx) {
    const name = state.session.parts[idx];
    if (!confirm(`Remove part "${name}"? Strips assigned to it will become unassigned.`)) return;
    state.session.parts.splice(idx, 1);
    state.session.strips.forEach(s => { if (s.part === name) s.part = ''; });
    delete state.session.layout[name];
    pushSession();
    App.renderPartsListSidebar();
    App.renderStripAssignment();
  },

  // ── Editor page rendering ────────────────────

  async renderEditorPage(pageIdx) {
    state.currentPage = pageIdx;
    document.querySelectorAll('.page-thumb').forEach(el => {
      el.classList.toggle('active', +el.dataset.page === pageIdx);
    });

    const canvas = document.getElementById('page-canvas');
    const container = document.getElementById('canvas-container');
    canvas.style.opacity = '0.4';

    // Load image
    const img = new Image();
    img.src = `/api/render/${state.sessionId}/${pageIdx}?dpi=150&t=${Date.now()}`;
    await new Promise(res => { img.onload = res; img.onerror = res; });

    state.imgWidth  = img.naturalWidth;
    state.imgHeight = img.naturalHeight;

    // Fit to viewport
    const maxW = document.getElementById('main-area').clientWidth - 240;
    const scale = Math.min(1, maxW / state.imgWidth);
    const dispW = Math.round(state.imgWidth * scale);
    const dispH = Math.round(state.imgHeight * scale);

    canvas.width  = dispW;
    canvas.height = dispH;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, dispW, dispH);
    canvas.style.opacity = '1';

    // Sync rotation controls
    const rot = state.session.pages[pageIdx].rotation ?? 0;
    document.getElementById('rot-range').value = rot;
    document.getElementById('rot-num').value = rot;

    App.renderCutLines();
    App.renderStripAssignment();
  },

  // ── Cut lines (SVG overlay) ──────────────────

  renderCutLines() {
    const svg = document.getElementById('overlay-svg');
    const canvas = document.getElementById('page-canvas');
    const W = canvas.width;
    const H = canvas.height;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = '';

    const cuts = state.session.pages[state.currentPage].cuts ?? [];
    cuts.sort((a, b) => a - b);

    cuts.forEach((yFrac, i) => {
      const y = yFrac * H;

      const line = document.createElementNS('http://www.w3.org/2000/svg','line');
      line.setAttribute('x1', 0); line.setAttribute('x2', W);
      line.setAttribute('y1', y); line.setAttribute('y2', y);
      line.classList.add('cut-line');
      if (state.selectedCut === i) line.classList.add('hovered');

      // Handle
      const handle = document.createElementNS('http://www.w3.org/2000/svg','circle');
      handle.setAttribute('cx', 20);
      handle.setAttribute('cy', y);
      handle.setAttribute('r', 7);
      handle.classList.add('cut-handle');

      // Label on right side
      const txt = document.createElementNS('http://www.w3.org/2000/svg','text');
      txt.setAttribute('x', W - 6);
      txt.setAttribute('y', y - 4);
      txt.setAttribute('text-anchor', 'end');
      txt.setAttribute('fill', '#f97316');
      txt.setAttribute('font-size', '11');
      txt.textContent = `cut ${i + 1}`;
      svg.appendChild(line);
      svg.appendChild(handle);
      svg.appendChild(txt);

      // Events via index closure
      const idx = i;
      [line, handle].forEach(el => {
        el.addEventListener('mousedown', e => {
          e.stopPropagation();
          state.selectedCut = idx;
          App.startCutDrag(e, idx);
          App.renderCutLines();
        });
        el.style.pointerEvents = 'all';
      });
    });

    // Strip color fills
    App.renderStripFills(cuts, W, H, svg);
  },

  renderStripFills(cuts, W, H, svg) {
    const allCuts = [0, ...cuts.sort((a,b)=>a-b), 1];
    const page = state.currentPage;

    for (let i = 0; i < allCuts.length - 1; i++) {
      const y0 = allCuts[i] * H;
      const y1 = allCuts[i + 1] * H;

      // Find strip
      const strip = App.stripForSegment(page, allCuts[i], allCuts[i+1]);
      if (!strip || !strip.part) continue;

      const color = partColor(strip.part);
      const rect = document.createElementNS('http://www.w3.org/2000/svg','rect');
      rect.setAttribute('x', 0); rect.setAttribute('y', y0);
      rect.setAttribute('width', W); rect.setAttribute('height', y1 - y0);
      rect.setAttribute('fill', color);
      rect.setAttribute('opacity', '0.12');
      rect.style.pointerEvents = 'none';
      svg.insertBefore(rect, svg.firstChild);

      // Label
      const label = document.createElementNS('http://www.w3.org/2000/svg','text');
      label.setAttribute('x', W / 2);
      label.setAttribute('y', (y0 + y1) / 2 + 5);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('fill', color);
      label.setAttribute('font-size', '13');
      label.setAttribute('font-weight', 'bold');
      label.setAttribute('opacity', '0.8');
      label.style.pointerEvents = 'none';
      label.textContent = strip.part;
      svg.appendChild(label);
    }
  },

  stripForSegment(page, yStart, yEnd) {
    return state.session.strips.find(s =>
      s.page === page &&
      Math.abs(s.y_start - yStart) < 0.005 &&
      Math.abs(s.y_end   - yEnd)   < 0.005
    ) ?? null;
  },

  // ── Cut adding / dragging ────────────────────

  initCanvasEvents() {
    const container = document.getElementById('canvas-container');

    container.addEventListener('click', e => {
      if (state.mode !== 'cut') return;
      if (state.dragState) return;
      const rect = container.getBoundingClientRect();
      const y = (e.clientY - rect.top) / container.offsetHeight;
      const yFrac = Math.round(y * 10000) / 10000;
      const cuts = state.session.pages[state.currentPage].cuts;
      // don't add if too close to existing
      if (cuts.some(c => Math.abs(c - yFrac) < 0.02)) return;
      cuts.push(yFrac);
      App.rebuildStrips();
      pushSession();
      App.renderCutLines();
      App.renderStripAssignment();
    });
  },

  startCutDrag(e, idx) {
    const container = document.getElementById('canvas-container');
    const H = container.offsetHeight;
    e.preventDefault();
    state.dragState = { type: 'cut', idx };

    const onMove = mv => {
      const rect = container.getBoundingClientRect();
      let y = (mv.clientY - rect.top) / H;
      y = Math.max(0.01, Math.min(0.99, y));
      state.session.pages[state.currentPage].cuts[idx] = Math.round(y * 10000) / 10000;
      App.renderCutLines();
    };

    const onUp = () => {
      state.dragState = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      App.rebuildStrips();
      pushSession();
      App.renderStripAssignment();
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  },

  deleteSelectedCut() {
    if (state.selectedCut === null) return;
    state.session.pages[state.currentPage].cuts.splice(state.selectedCut, 1);
    state.selectedCut = null;
    App.rebuildStrips();
    pushSession();
    App.renderCutLines();
    App.renderStripAssignment();
  },

  clearCuts() {
    if (!confirm('Delete all cut lines on this page?')) return;
    state.session.pages[state.currentPage].cuts = [];
    state.selectedCut = null;
    App.rebuildStrips();
    pushSession();
    App.renderCutLines();
    App.renderStripAssignment();
  },

  copyToAll() {
    const src = state.session.pages[state.currentPage].cuts.slice();
    state.session.pages.forEach((p, i) => {
      if (i !== state.currentPage) p.cuts = src.slice();
    });
    App.rebuildAllStrips();
    pushSession();
    toast('Cut positions copied to all pages');
  },

  async autoDetect() {
    toast('Detecting staves…');
    try {
      const data = await apiJSON(`/api/detect/${state.sessionId}/${state.currentPage}`);
      state.session.pages[state.currentPage].cuts = data.cuts;
      App.rebuildStrips();
      await pushSession();
      App.renderCutLines();
      App.renderStripAssignment();
      toast(`Detected ${data.cuts.length} cut positions`);
    } catch (e) {
      toast('Detection failed: ' + e.message, 'error');
    }
  },

  // ── Strips ───────────────────────────────────

  rebuildStrips() {
    const page = state.currentPage;
    // Remove old strips for this page
    state.session.strips = state.session.strips.filter(s => s.page !== page);

    const cuts = [...state.session.pages[page].cuts].sort((a, b) => a - b);
    const boundaries = [0, ...cuts, 1];
    const defaultParts = state.session.parts;

    for (let i = 0; i < boundaries.length - 1; i++) {
      const y0 = boundaries[i];
      const y1 = boundaries[i + 1];
      const existing = state.session.strips.find(s =>
        s.page === page &&
        Math.abs(s.y_start - y0) < 0.002 &&
        Math.abs(s.y_end   - y1) < 0.002
      );
      if (!existing) {
        state.session.strips.push({
          id: uid(),
          page,
          y_start: y0,
          y_end:   y1,
          part: defaultParts[i] ?? '',
        });
      }
    }

    App.rebuildLayout();
  },

  rebuildAllStrips() {
    state.session.strips = [];
    for (let p = 0; p < state.session.page_count; p++) {
      const tmpPage = state.currentPage;
      state.currentPage = p;
      App.rebuildStrips();
      state.currentPage = tmpPage;
    }
  },

  rebuildLayout() {
    // Rebuild layout order: group strips by part, ordered by page then position
    const byPart = {};
    const sorted = [...state.session.strips].sort((a, b) =>
      a.page !== b.page ? a.page - b.page : a.y_start - b.y_start
    );
    sorted.forEach(s => {
      if (!s.part) return;
      if (!byPart[s.part]) byPart[s.part] = [];
      byPart[s.part].push(s.id);
    });
    state.session.layout = byPart;
  },

  // ── Strip assignment panel ───────────────────

  renderStripAssignment() {
    const panel = document.getElementById('strip-assignment-panel');
    const page = state.currentPage;
    const cuts = [...(state.session.pages[page].cuts ?? [])].sort((a, b) => a - b);
    const boundaries = [0, ...cuts, 1];
    panel.innerHTML = '';

    for (let i = 0; i < boundaries.length - 1; i++) {
      const y0 = boundaries[i];
      const y1 = boundaries[i + 1];

      let strip = state.session.strips.find(s =>
        s.page === page &&
        Math.abs(s.y_start - y0) < 0.005 &&
        Math.abs(s.y_end   - y1) < 0.005
      );
      if (!strip) {
        strip = { id: uid(), page, y_start: y0, y_end: y1, part: '' };
        state.session.strips.push(strip);
      }

      const color = strip.part ? partColor(strip.part) : '#555';
      const div = document.createElement('div');
      div.className = 'strip-row';
      div.innerHTML = `
        <div class="strip-color-dot" style="background:${color}"></div>
        <span style="flex:0 0 auto;color:var(--text-dim);font-size:.75rem">Strip ${i+1}</span>
        <select class="strip-part-select" data-stripid="${strip.id}">
          <option value="">— unassigned —</option>
          ${state.session.parts.map(p =>
            `<option value="${escHtml(p)}" ${p === strip.part ? 'selected' : ''}>${escHtml(p)}</option>`
          ).join('')}
        </select>
      `;
      div.querySelector('select').addEventListener('change', function() {
        const s = state.session.strips.find(x => x.id === this.dataset.stripid);
        if (s) s.part = this.value;
        App.rebuildLayout();
        pushSession();
        App.renderCutLines();
        App.renderStripAssignment();
      });
      panel.appendChild(div);
    }
  },

  // ── Rotation ─────────────────────────────────

  onRotationInput(val, source) {
    const v = parseFloat(val) || 0;
    state.session.pages[state.currentPage].rotation = v;
    if (source === 'range') document.getElementById('rot-num').value = v;
    else document.getElementById('rot-range').value = v;
    // debounce re-render
    clearTimeout(App._rotTimer);
    App._rotTimer = setTimeout(async () => {
      await pushSession();
      await App.renderEditorPage(state.currentPage);
    }, 300);
  },

  applyRotationToAll() {
    const rot = state.session.pages[state.currentPage].rotation ?? 0;
    state.session.pages.forEach(p => { p.rotation = rot; });
    pushSession();
    toast(`Rotation ${rot}° applied to all pages`);
  },

  // ── Mode ────────────────────────────────────

  setMode(m) {
    state.mode = m;
    document.getElementById('canvas-container').classList.toggle('mode-select', m === 'select');
    document.getElementById('btn-mode-cut').className    = 'btn btn-sm ' + (m === 'cut'    ? 'btn-secondary' : 'btn-ghost');
    document.getElementById('btn-mode-select').className = 'btn btn-sm ' + (m === 'select' ? 'btn-secondary' : 'btn-ghost');
  },

  // ── Layout view ──────────────────────────────

  async renderLayoutView() {
    const cols = document.getElementById('layout-columns');
    const nav  = document.getElementById('layout-parts-nav');
    cols.innerHTML = '<div class="spinner"></div>';
    nav.innerHTML  = '';

    await pullSession();

    cols.innerHTML = '';

    const parts = state.session.parts;
    if (!parts.length) {
      cols.innerHTML = '<p style="color:var(--text-dim)">No parts defined yet.</p>';
      return;
    }

    // Preload strip thumbnails
    const stripImgs = {};
    const stripMap = Object.fromEntries(state.session.strips.map(s => [s.id, s]));

    for (const part of parts) {
      const stripIds = state.session.layout[part] ?? [];
      const col = document.createElement('div');
      col.className = 'part-column';
      col.dataset.part = part;
      const color = partColor(part);

      col.innerHTML = `
        <div class="part-column-header">
          <div class="part-color-swatch" style="background:${color}"></div>
          <span>${escHtml(part)}</span>
          <span style="margin-left:auto;font-size:.72rem;color:var(--text-dim)">${stripIds.length} strips</span>
        </div>
      `;

      const dropZoneTop = document.createElement('div');
      dropZoneTop.className = 'layout-drop-indicator';
      col.appendChild(dropZoneTop);

      for (let i = 0; i < stripIds.length; i++) {
        const sid = stripIds[i];
        const s = stripMap[sid];
        if (!s) continue;

        const card = document.createElement('div');
        card.className = 'layout-strip';
        card.draggable = true;
        card.dataset.stripid = sid;
        card.dataset.part = part;
        card.dataset.idx = i;

        const thumbUrl = `/api/render/${state.sessionId}/${s.page}?dpi=60&t=${state.sessionId}`;
        const pct0 = (s.y_start * 100).toFixed(1);
        const pct1 = (s.y_end   * 100).toFixed(1);

        card.innerHTML = `
          <div style="position:relative;overflow:hidden;max-height:80px">
            <img src="${thumbUrl}" style="width:100%;display:block;
              clip-path:inset(${pct0}% 0 ${(100 - parseFloat(pct1)).toFixed(1)}% 0);
              margin-top:-${pct0}%;
            " loading="lazy">
          </div>
          <div class="layout-strip-info">
            <span>p.${s.page + 1}</span>
            <button class="btn btn-icon btn-ghost btn-sm"
              onclick="App.removeStripFromLayout('${part}',${i})" title="Remove">✕</button>
          </div>
        `;
        App.initStripDrag(card, part, i);

        const dropAfter = document.createElement('div');
        dropAfter.className = 'layout-drop-indicator';
        col.appendChild(card);
        col.appendChild(dropAfter);
      }

      App.initColDrop(col, part);
      nav.innerHTML += `<div style="margin-bottom:6px"><a href="#" style="color:${color};font-size:.82rem"
        onclick="document.querySelector('[data-part=\\'${escHtml(part)}\\']').scrollIntoView({behavior:'smooth'});return false">
        ${escHtml(part)}</a></div>`;
      cols.appendChild(col);
    }
  },

  initStripDrag(el, part, idx) {
    el.addEventListener('dragstart', e => {
      state.layoutDrag = { stripId: el.dataset.stripid, fromPart: part, fromIdx: idx };
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
  },

  initColDrop(col, part) {
    col.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    col.addEventListener('drop', e => {
      e.preventDefault();
      if (!state.layoutDrag) return;
      const { stripId, fromPart, fromIdx } = state.layoutDrag;
      state.layoutDrag = null;

      // Remove from source
      const src = state.session.layout[fromPart] ?? [];
      const srcIdx = src.indexOf(stripId);
      if (srcIdx >= 0) src.splice(srcIdx, 1);
      state.session.layout[fromPart] = src;

      // Add to target
      if (!state.session.layout[part]) state.session.layout[part] = [];
      state.session.layout[part].push(stripId);

      // Update strip part assignment
      const strip = state.session.strips.find(s => s.id === stripId);
      if (strip) strip.part = part;

      pushSession();
      App.renderLayoutView();
    });
  },

  removeStripFromLayout(part, idx) {
    const ids = state.session.layout[part] ?? [];
    const [removed] = ids.splice(idx, 1);
    const strip = state.session.strips.find(s => s.id === removed);
    if (strip) strip.part = '';
    pushSession();
    App.renderLayoutView();
  },

  // ── Export ───────────────────────────────────

  renderExportView() {
    const grid = document.getElementById('export-grid');
    if (!state.session) return;
    grid.innerHTML = '';
    state.session.parts.forEach(part => {
      const count = (state.session.layout[part] ?? []).length;
      const color = partColor(part);
      const card = document.createElement('div');
      card.className = 'export-card';
      card.innerHTML = `
        <div style="width:20px;height:20px;border-radius:50%;background:${color};margin:0 auto 10px"></div>
        <h3>${escHtml(part)}</h3>
        <p>${count} strip${count !== 1 ? 's' : ''}</p>
        <button class="btn btn-secondary btn-sm" onclick="App.exportPart('${escHtml(part)}')">⬇ PDF</button>
      `;
      grid.appendChild(card);
    });
  },

  async exportAll() {
    toast('Building ZIP…');
    try {
      const resp = await apiFetch(`/api/export/${state.sessionId}`, { method: 'POST' });
      const blob = await resp.blob();
      App.triggerDownload(blob, 'score_parts.zip');
    } catch (e) {
      toast('Export failed: ' + e.message, 'error');
    }
  },

  async exportPart(part) {
    toast(`Exporting ${part}…`);
    try {
      const resp = await apiFetch(`/api/export/${state.sessionId}/${encodeURIComponent(part)}`);
      const blob = await resp.blob();
      App.triggerDownload(blob, `${part}.pdf`);
    } catch (e) {
      toast('Export failed: ' + e.message, 'error');
    }
  },

  triggerDownload(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  },

  // ── Keyboard shortcuts ───────────────────────

  initKeyboard() {
    document.addEventListener('keydown', e => {
      // Don't fire if typing in an input
      if (['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) return;

      const step = App.currentStep();
      if (step === 'edit') {
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          App.deleteSelectedCut();
        }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          const p = Math.max(0, state.currentPage - 1);
          if (p !== state.currentPage) App.renderEditorPage(p);
        }
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          const p = Math.min(state.session.page_count - 1, state.currentPage + 1);
          if (p !== state.currentPage) App.renderEditorPage(p);
        }
        if (e.key === 'a' || e.key === 'A') App.autoDetect();
        if (e.key === 'c' || e.key === 'C') App.setMode('cut');
        if (e.key === 's' || e.key === 'S') App.setMode('select');
        if (e.key === 'Escape') { state.selectedCut = null; App.renderCutLines(); }
      }
    });
  },

  currentStep() {
    for (const [step, elId] of Object.entries(VIEW_ELS)) {
      const el = document.getElementById(elId);
      if (el && el.style.display !== 'none') return step;
    }
    return 'upload';
  },
};

// ── HTML escape ──────────────────────────────
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Init ─────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  App.initUpload();
  App.initCanvasEvents();
  App.initKeyboard();
});
