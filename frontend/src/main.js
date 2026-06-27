import './style.css';
import { PickVault, Scan, PreviewNote, DryRun, ApplyOps, ListPresets, SavePreset, LoadPreset, DeletePreset } from '../wailsjs/go/main/App';

// ── State ──────────────────────────────────────────────────
let allNotes = [];   // NoteInfo[]
let selected = new Set(); // paths
let ops = [];        // {kind, key, value, conds:[]}

// ── DOM refs ───────────────────────────────────────────────
const btnPick        = document.getElementById('btn-pick');
const vaultPath      = document.getElementById('vault-path');
const noteFilter     = document.getElementById('note-filter');
const noteList       = document.getElementById('note-list');
const btnSelectAll   = document.getElementById('btn-select-all');
const btnSelectNone  = document.getElementById('btn-select-none');
const selCount       = document.getElementById('sel-count');
const btnAddOp       = document.getElementById('btn-add-op');
const opsList        = document.getElementById('ops-list');
const previewNoteSel = document.getElementById('preview-note-sel');
const btnPreview     = document.getElementById('btn-preview');
const previewBefore  = document.getElementById('preview-before');
const previewAfter   = document.getElementById('preview-after');
const presetSel      = document.getElementById('preset-sel');
const btnPresetNew   = document.getElementById('btn-preset-new');
const btnPresetLoad  = document.getElementById('btn-preset-load');
const btnPresetSave  = document.getElementById('btn-preset-save');
const btnPresetDel   = document.getElementById('btn-preset-delete');
const btnDryrun      = document.getElementById('btn-dryrun');
const btnApply       = document.getElementById('btn-apply');
const runSummary     = document.getElementById('run-summary');
const logList        = document.getElementById('log-list');

// ── Toasts ─────────────────────────────────────────────────
const TOAST_TTL = { success: 4000, info: 4000, error: 9000, busy: 0 };

function toast(text, type = 'info') {
  const wrap = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-text">${type === 'busy' ? '<span class="spin"></span>' : ''}${text}</span><button class="toast-x">×</button>`;
  el.querySelector('.toast-x').onclick = () => close();
  wrap.appendChild(el);

  let timer;
  const close = () => {
    clearTimeout(timer);
    el.classList.add('out');
    setTimeout(() => el.remove(), 210);
  };
  const arm = () => { if (TOAST_TTL[type]) timer = setTimeout(close, TOAST_TTL[type]); };
  arm();

  return {
    update(t, tp) {
      type = tp;
      el.className = `toast ${tp}`;
      el.querySelector('.toast-text').innerHTML = t;
      arm();
      return this;
    },
    close,
  };
}

// ── Vault picker ───────────────────────────────────────────
btnPick.onclick = async () => {
  const h = toast('Opening folder dialog…', 'busy');
  try {
    const dir = await PickVault();
    if (!dir) { h.close(); return; }
    vaultPath.textContent = dir;
    vaultPath.classList.remove('muted');
    h.update('Scanning vault…', 'busy');
    const notes = await Scan(dir);
    loadNotes(notes);
    h.update(`Loaded ${notes.length} notes`, 'success');
  } catch (e) {
    h.update('Error: ' + e, 'error');
  }
};

// ── Note list ──────────────────────────────────────────────
function loadNotes(notes) {
  allNotes = notes;
  selected.clear();
  noteFilter.disabled = false;
  btnSelectAll.disabled = false;
  btnSelectNone.disabled = false;
  btnAddOp.disabled = false;
  renderNotes();
  populatePreviewSel();
  updateRunButtons();
}

function renderNotes() {
  const q = noteFilter.value.toLowerCase();
  const filtered = q ? allNotes.filter(n =>
    n.title.toLowerCase().includes(q) || n.rel.toLowerCase().includes(q)
  ) : allNotes;

  if (!filtered.length) {
    noteList.innerHTML = '<p class="empty-hint">No notes match the filter.</p>';
    updateSelCount();
    return;
  }

  noteList.innerHTML = '';
  for (const n of filtered) {
    const item = document.createElement('div');
    item.className = 'note-item' + (selected.has(n.path) ? ' selected' : '');
    item.dataset.path = n.path;
    item.innerHTML = `<input type="checkbox" ${selected.has(n.path) ? 'checked' : ''}/>
      <div><div class="note-item-title">${esc(n.title)}</div><div class="note-item-rel">${esc(n.rel)}</div></div>`;
    item.onclick = (e) => {
      if (e.target.tagName === 'INPUT') return; // checkbox handles itself
      const cb = item.querySelector('input');
      cb.checked = !cb.checked;
      toggleNote(n.path, cb.checked, item);
    };
    item.querySelector('input').onchange = (e) => toggleNote(n.path, e.target.checked, item);
    noteList.appendChild(item);
  }
  updateSelCount();
}

function toggleNote(path, checked, item) {
  checked ? selected.add(path) : selected.delete(path);
  item.classList.toggle('selected', checked);
  updateSelCount();
  updateRunButtons();
  populatePreviewSel();
}

function updateSelCount() {
  selCount.textContent = selected.size ? `${selected.size} selected` : '';
}

noteFilter.oninput = renderNotes;

btnSelectAll.onclick = () => {
  const q = noteFilter.value.toLowerCase();
  const filtered = q ? allNotes.filter(n =>
    n.title.toLowerCase().includes(q) || n.rel.toLowerCase().includes(q)
  ) : allNotes;
  filtered.forEach(n => selected.add(n.path));
  renderNotes();
  populatePreviewSel();
  updateRunButtons();
};

btnSelectNone.onclick = () => {
  selected.clear();
  renderNotes();
  populatePreviewSel();
  updateRunButtons();
};

// ── Op builder ─────────────────────────────────────────────
const OP_KINDS = ['add', 'set', 'delete', 'rename'];
const COND_KINDS = ['key_exists', 'key_missing', 'value_equals', 'value_contains'];

btnAddOp.onclick = () => addOp({ kind: 'set', key: '', value: '', conds: [] });

function addOp(op) {
  ops.push(op);
  renderOps();
}

function renderOps() {
  opsList.innerHTML = '';
  if (!ops.length) {
    opsList.innerHTML = '<p class="empty-hint" style="padding:10px">No operations yet. Click + Add op.</p>';
    return;
  }
  ops.forEach((op, i) => {
    const row = document.createElement('div');
    row.className = 'op-row';

    const needsValue = op.kind !== 'delete';
    const valueLabel = op.kind === 'rename' ? 'New key name' : 'Value';

    row.innerHTML = `
      <select class="op-kind" title="Operation type">
        ${OP_KINDS.map(k => `<option ${op.kind===k?'selected':''}>${k}</option>`).join('')}
      </select>
      <input class="input op-key" placeholder="Key" value="${esc(op.key)}"/>
      <input class="input op-val" placeholder="${valueLabel}" value="${esc(op.value)}" ${needsValue?'':'disabled style="opacity:.3"'}/>
      <button class="btn btn-danger op-del" title="Remove">✕</button>
      <div class="op-conds">
        ${op.conds.map((c, ci) => condRowHTML(c, i, ci)).join('')}
        <button class="btn btn-xs btn-add-cond">+ condition</button>
      </div>`;

    row.querySelector('.op-kind').onchange = e => { op.kind = e.target.value; renderOps(); };
    row.querySelector('.op-key').oninput = e => { op.key = e.target.value; };
    row.querySelector('.op-val').oninput = e => { op.value = e.target.value; };
    row.querySelector('.op-del').onclick = () => { ops.splice(i, 1); renderOps(); };
    row.querySelector('.btn-add-cond').onclick = () => {
      op.conds.push({ kind: 'key_exists', key: '', value: '' });
      renderOps();
    };
    row.querySelectorAll('.cond-kind').forEach((sel, ci) => {
      sel.onchange = e => { op.conds[ci].kind = e.target.value; renderOps(); };
    });
    row.querySelectorAll('.cond-key').forEach((inp, ci) => {
      inp.oninput = e => { op.conds[ci].key = e.target.value; };
    });
    row.querySelectorAll('.cond-val').forEach((inp, ci) => {
      inp.oninput = e => { op.conds[ci].value = e.target.value; };
    });
    row.querySelectorAll('.cond-del').forEach((btn, ci) => {
      btn.onclick = () => { op.conds.splice(ci, 1); renderOps(); };
    });

    opsList.appendChild(row);
  });
}

function condRowHTML(c, oi, ci) {
  const needsVal = c.kind === 'value_equals' || c.kind === 'value_contains';
  return `<div class="cond-row">
    <select class="input input-sm cond-kind">
      ${COND_KINDS.map(k => `<option ${c.kind===k?'selected':''}>${k}</option>`).join('')}
    </select>
    <input class="input input-sm cond-key" placeholder="Key" value="${esc(c.key)}"/>
    <input class="input input-sm cond-val" placeholder="Value" value="${esc(c.value)}" ${needsVal?'':'disabled style="opacity:.3"'}/>
    <button class="btn btn-danger cond-del">✕</button>
  </div>`;
}

// ── Preview ────────────────────────────────────────────────
function populatePreviewSel() {
  const prev = previewNoteSel.value;
  previewNoteSel.innerHTML = '<option value="">— pick a note —</option>';
  [...selected].forEach(path => {
    const n = allNotes.find(x => x.path === path);
    if (!n) return;
    const opt = document.createElement('option');
    opt.value = path;
    opt.textContent = n.title;
    previewNoteSel.appendChild(opt);
  });
  if (prev && selected.has(prev)) previewNoteSel.value = prev;
  previewNoteSel.disabled = selected.size === 0;
  btnPreview.disabled = selected.size === 0;
}

btnPreview.onclick = runPreview;
previewNoteSel.onchange = runPreview;

async function runPreview() {
  const path = previewNoteSel.value;
  if (!path) return;
  const currentOps = collectOps();
  try {
    const result = await PreviewNote(path, currentOps);
    previewBefore.textContent = result.before || '(no frontmatter)';
    previewAfter.textContent  = result.after  || '(no frontmatter)';
  } catch (e) {
    toast('Preview error: ' + e, 'error');
  }
}

// ── Dry-run ────────────────────────────────────────────────
btnDryrun.onclick = async () => {
  const paths = [...selected];
  if (!paths.length) return;
  const currentOps = collectOps();
  const h = toast(`Dry-running ${paths.length} notes…`, 'busy');
  try {
    const verdicts = await DryRun(paths, currentOps);
    renderLog(verdicts, true);
    h.update('Dry-run complete', 'success');
  } catch (e) {
    h.update('Error: ' + e, 'error');
  }
};

// ── Apply ──────────────────────────────────────────────────
btnApply.onclick = async () => {
  const paths = [...selected];
  if (!paths.length) return;
  const currentOps = collectOps();
  const h = toast(`Applying to ${paths.length} notes…`, 'busy');
  try {
    const verdicts = await ApplyOps(paths, currentOps);
    renderLog(verdicts, false);
    const changed = verdicts.filter(v => v.status === 'changed').length;
    const errors  = verdicts.filter(v => v.status === 'error').length;
    h.update(errors ? `Done — ${changed} changed, ${errors} errors` : `Done — ${changed} changed`, errors ? 'error' : 'success');
  } catch (e) {
    h.update('Error: ' + e, 'error');
  }
};

function renderLog(verdicts, isDryRun) {
  logList.innerHTML = '';
  let changed = 0, skipped = 0, errored = 0;
  for (const v of verdicts) {
    if (v.status === 'changed') changed++;
    else if (v.status === 'skipped') skipped++;
    else errored++;

    const item = document.createElement('div');
    item.className = 'log-item';
    const detail = v.status === 'changed'
      ? (v.changes || []).join(', ')
      : (v.reason || '');
    item.innerHTML = `<span class="log-status ${v.status}">${v.status.toUpperCase()}</span>
      <span class="log-detail"><strong>${esc(v.path)}</strong>${detail ? ' — ' + esc(detail) : ''}</span>`;
    logList.appendChild(item);
  }
  runSummary.textContent = `${isDryRun ? 'Dry-run: ' : ''}${changed} would change, ${skipped} skip, ${errored} error${errored !== 1 ? 's' : ''}`.replace('would change', isDryRun ? 'would change' : 'changed');
}

function updateRunButtons() {
  const ready = selected.size > 0;
  btnDryrun.disabled = !ready;
  btnApply.disabled = !ready;
}

// ── Modal prompt ───────────────────────────────────────────
const modalOverlay = document.getElementById('modal-overlay');
const modalTitle   = document.getElementById('modal-title');
const modalInput   = document.getElementById('modal-input');
const modalOk      = document.getElementById('modal-ok');
const modalCancel  = document.getElementById('modal-cancel');

function openModal({ title, withInput, defaultVal = '' }) {
  return new Promise(resolve => {
    modalTitle.textContent = title;
    modalInput.style.display = withInput ? '' : 'none';
    if (withInput) { modalInput.value = defaultVal; modalInput.focus(); }
    else modalOk.focus();
    modalOverlay.classList.remove('hidden');

    const cleanup = result => {
      modalOverlay.classList.add('hidden');
      modalOk.removeEventListener('click', onOk);
      modalCancel.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onOk     = () => cleanup(withInput ? (modalInput.value.trim() || null) : true);
    const onCancel = () => cleanup(null);
    const onKey    = e => { if (e.key === 'Enter') onOk(); if (e.key === 'Escape') onCancel(); };

    modalOk.addEventListener('click', onOk);
    modalCancel.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
  });
}

const showPrompt  = (title, defaultVal = '') => openModal({ title, withInput: true, defaultVal });
const showConfirm = (title) => openModal({ title, withInput: false });

// ── Presets ────────────────────────────────────────────────
async function refreshPresets() {
  try {
    const names = await ListPresets();
    const prev = presetSel.value;
    presetSel.innerHTML = '<option value="">— presets —</option>';
    names.forEach(n => {
      const opt = document.createElement('option');
      opt.value = n;
      opt.textContent = n;
      presetSel.appendChild(opt);
    });
    if (prev && names.includes(prev)) presetSel.value = prev;
    presetSel.disabled = names.length === 0;
    updatePresetButtons();
  } catch (e) {
    toast('Could not list presets: ' + e, 'error');
  }
}

function updatePresetButtons() {
  const sel = presetSel.value;
  btnPresetLoad.disabled = !sel;
  btnPresetDel.disabled = !sel;
  btnPresetSave.disabled = false;
}

function clearOps() {
  ops = [];
  renderOps();
}

presetSel.onchange = async () => {
  if (!presetSel.value) {
    if (ops.length > 0 && !await showConfirm('Clear current operations?')) return;
    clearOps();
  }
  updatePresetButtons();
};

btnPresetNew.onclick = async () => {
  if (ops.length > 0 && !await showConfirm('Clear current operations?')) return;
  clearOps();
  presetSel.value = '';
  updatePresetButtons();
};

btnPresetLoad.onclick = async () => {
  const name = presetSel.value;
  if (!name) return;
  if (ops.length > 0 && !await showConfirm('Loading a preset will replace the current operations. Continue?')) return;
  try {
    const loaded = await LoadPreset(name);
    ops = loaded.map(o => ({ kind: o.kind, key: o.key, value: o.value, conds: (o.conds || []).map(c => ({ kind: c.kind, key: c.key, value: c.value })) }));
    renderOps();
    toast(`Preset "${name}" loaded`, 'success');
  } catch (e) {
    toast('Load failed: ' + e, 'error');
  }
};

btnPresetSave.onclick = async () => {
  const name = await showPrompt('Preset name:');
  if (!name) return;
  const existing = [...presetSel.options].map(o => o.value).filter(Boolean);
  if (existing.includes(name) && !await showConfirm(`Overwrite preset "${name}"?`)) return;
  try {
    await SavePreset(name, collectOps());
    await refreshPresets();
    presetSel.value = name;
    updatePresetButtons();
    toast(`Preset "${name}" saved`, 'success');
  } catch (e) {
    toast('Save failed: ' + e, 'error');
  }
};

btnPresetDel.onclick = async () => {
  const name = presetSel.value;
  if (!name || !await showConfirm(`Delete preset "${name}"?`)) return;
  try {
    await DeletePreset(name);
    await refreshPresets();
    toast(`Preset "${name}" deleted`, 'info');
  } catch (e) {
    toast('Delete failed: ' + e, 'error');
  }
};

refreshPresets();

// ── Helpers ─────────────────────────────────────────────────
function collectOps() {
  return ops.map(op => ({
    kind:  op.kind,
    key:   op.key,
    value: op.value,
    conds: op.conds.map(c => ({ kind: c.kind, key: c.key, value: c.value })),
  }));
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
