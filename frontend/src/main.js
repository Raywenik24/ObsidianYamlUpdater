import './style.css';
import { PickVault, Scan, PreviewNote, DryRun, ApplyOps, ListPresets, SavePreset, LoadPreset, DeletePreset, GetUndoable, UndoLastRun } from '../wailsjs/go/main/App';
import { WindowMinimise, WindowToggleMaximise, Quit } from '../wailsjs/runtime/runtime';

// ── State ──────────────────────────────────────────────────
let allNotes = [];        // NoteInfo[]
let selected = new Set(); // paths
let ops = [];             // {kind, key, value, conds:[]}
let knownKeys = [];       // unique YAML keys across all notes
let yamlFilters = [];     // {connector:'AND'|'OR', key:'', op:'=', value:''}

// ── DOM refs ───────────────────────────────────────────────
const btnPick        = document.getElementById('btn-pick');
const vaultPath      = document.getElementById('vault-path');
const noteFilter     = document.getElementById('note-filter');
const noteList       = document.getElementById('note-list');
const btnSelectAll   = document.getElementById('btn-select-all');
const btnSelectNone  = document.getElementById('btn-select-none');
const btnCheck       = document.getElementById('btn-check');
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
const btnUndo        = document.getElementById('btn-undo');
const runSummary     = document.getElementById('run-summary');
const logList        = document.getElementById('log-list');

// ── Window controls ────────────────────────────────────────
document.getElementById('btn-win-min').onclick   = () => WindowMinimise();
document.getElementById('btn-win-max').onclick   = () => WindowToggleMaximise();
document.getElementById('btn-win-close').onclick = () => Quit();

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
    localStorage.setItem('vaultPath', dir);
    loadNotes(notes);
    h.update(`Loaded ${notes.length} notes`, 'success');
  } catch (e) {
    h.update('Error: ' + e, 'error');
  }
};

// ── Note list ──────────────────────────────────────────────
let collapsedFolders = new Set();
let lastClickedPath = null;
let noteStatuses = new Map(); // path → 'changed' | 'skipped' | 'error'
let checkTimer   = null;
let dryRunDone   = false;
let acceptMode   = false;

function scheduleCheck() {
  clearTimeout(checkTimer);
  if (!selected.size || !ops.length) {
    noteStatuses.clear();
    renderNotes();
    return;
  }
  checkTimer = setTimeout(runCheck, 600);
}

async function runCheck() {
  const paths = [...selected];
  if (!paths.length || !ops.length) return;
  try {
    const verdicts = await DryRun(paths, collectOps());
    noteStatuses.clear();
    for (const v of verdicts) noteStatuses.set(v.path, v.status);
    renderNotes();
  } catch { /* silent */ }
}

function loadNotes(notes) {
  allNotes = notes;
  selected.clear();
  lastClickedPath = null;
  noteStatuses.clear();
  knownKeys = [...new Set(notes.flatMap(n => Object.keys(n.fields || {})))].sort();
  noteFilter.disabled = false;
  btnSelectAll.disabled = false;
  btnSelectNone.disabled = false;
  btnAddOp.disabled = false;
  document.getElementById('btn-add-yaml-filter').disabled = false;
  renderYamlFilters();
  renderNotes();
  populatePreviewSel();
  invalidateDryRun();
}

async function refreshNotesInPlace() {
  try {
    const notes = await Scan('');
    allNotes = notes;
    knownKeys = [...new Set(notes.flatMap(n => Object.keys(n.fields || {})))].sort();
    selected = new Set([...selected].filter(p => notes.some(n => n.path === p)));
    noteStatuses.clear();
    renderYamlFilters();
    renderNotes();
    populatePreviewSel();
    scheduleCheck();
    if (previewNoteSel.value) runPreview();
  } catch { /* silent — stale data is better than crashing */ }
}

function buildTree(notes) {
  const root = { children: {}, notes: [] };
  for (const n of notes) {
    const parts = n.rel.replace(/\\/g, '/').split('/');
    parts.pop();
    let node = root;
    for (const part of parts) {
      if (!node.children[part]) node.children[part] = { children: {}, notes: [] };
      node = node.children[part];
    }
    node.notes.push(n);
  }
  return root;
}

function getAllDescendantNotes(node) {
  const notes = [...node.notes];
  for (const child of Object.values(node.children)) notes.push(...getAllDescendantNotes(child));
  return notes;
}

function collectTreeNotes(node, folderPath) {
  const result = [];
  for (const [name, child] of Object.entries(node.children).sort(([a], [b]) => a.localeCompare(b))) {
    const childPath = folderPath ? `${folderPath}/${name}` : name;
    if (!collapsedFolders.has(childPath)) result.push(...collectTreeNotes(child, childPath));
  }
  for (const n of [...node.notes].sort((a, b) => a.title.localeCompare(b.title))) result.push(n);
  return result;
}

function getFilteredNotes() {
  const q = noteFilter.value.toLowerCase();
  let notes = q ? allNotes.filter(n =>
    n.title.toLowerCase().includes(q) || n.rel.toLowerCase().includes(q)
  ) : allNotes;
  const activeFilters = yamlFilters.filter(f => f.key || f.op === 'exists' || f.op === 'not exists');
  if (activeFilters.length) notes = notes.filter(n => matchYamlFilters(n, activeFilters));
  return notes;
}

function getVisibleNotesList() {
  const filtered = getFilteredNotes();
  const q = noteFilter.value.toLowerCase();
  return q ? filtered : collectTreeNotes(buildTree(filtered), '');
}

function renderNotes() {
  const filtered = getFilteredNotes();
  const q = noteFilter.value.toLowerCase();

  if (!filtered.length) {
    noteList.innerHTML = '<p class="empty-hint">No notes match the filter.</p>';
    updateSelCount();
    return;
  }

  noteList.innerHTML = '';
  if (q) {
    for (const n of filtered) noteList.appendChild(makeNoteRow(n, 0));
  } else {
    renderTreeNode(buildTree(filtered), noteList, 0, '');
  }
  updateSelCount();
}

function renderTreeNode(node, container, depth, folderPath) {
  for (const [name, child] of Object.entries(node.children).sort(([a], [b]) => a.localeCompare(b))) {
    const childPath = folderPath ? `${folderPath}/${name}` : name;
    const isCollapsed = collapsedFolders.has(childPath);
    const allDesc = getAllDescendantNotes(child);
    const allSel = allDesc.length > 0 && allDesc.every(n => selected.has(n.path));
    const someSel = allDesc.some(n => selected.has(n.path));

    const folderRow = document.createElement('div');
    folderRow.className = 'tree-folder' + (allSel ? ' selected' : someSel ? ' partial' : '');
    folderRow.style.paddingLeft = `${8 + depth * 16}px`;

    const chevron = document.createElement('span');
    chevron.className = 'tree-chevron';
    chevron.textContent = isCollapsed ? '▶' : '▼';
    chevron.onclick = (e) => {
      e.stopPropagation();
      collapsedFolders.has(childPath) ? collapsedFolders.delete(childPath) : collapsedFolders.add(childPath);
      renderNotes();
    };

    const label = document.createElement('span');
    label.className = 'tree-folder-name';
    label.textContent = name;

    folderRow.appendChild(chevron);
    folderRow.appendChild(label);
    folderRow.onclick = (e) => {
      if (e.target === chevron) return;
      allSel ? allDesc.forEach(n => selected.delete(n.path)) : allDesc.forEach(n => selected.add(n.path));
      renderNotes();
      populatePreviewSel();
      invalidateDryRun();
      scheduleCheck();
    };

    container.appendChild(folderRow);
    if (!isCollapsed) renderTreeNode(child, container, depth + 1, childPath);
  }

  for (const n of [...node.notes].sort((a, b) => a.title.localeCompare(b.title))) {
    container.appendChild(makeNoteRow(n, depth));
  }
}

function makeNoteRow(n, depth) {
  const item = document.createElement('div');
  const status = noteStatuses.get(n.rel);
  item.className = 'tree-note' + (selected.has(n.path) ? ' selected' : '') + (status ? ` status-${status}` : '');
  item.style.paddingLeft = `${8 + depth * 16}px`;
  item.dataset.path = n.path;
  const dot = status === 'skipped' ? `<span class="status-dot skipped" title="skipped">—</span>`
            : status === 'error'   ? `<span class="status-dot error" title="error">⚠</span>`
            : '';
  item.innerHTML = `${dot}<span class="note-item-title">${esc(n.title)}</span>`;

  item.onclick = (e) => {
    if (e.shiftKey && lastClickedPath) {
      const visible = getVisibleNotesList();
      const lastIdx = visible.findIndex(x => x.path === lastClickedPath);
      const currIdx = visible.findIndex(x => x.path === n.path);
      if (lastIdx !== -1 && currIdx !== -1) {
        const [lo, hi] = [Math.min(lastIdx, currIdx), Math.max(lastIdx, currIdx)];
        visible.slice(lo, hi + 1).forEach(x => selected.add(x.path));
      } else {
        selected.add(n.path);
      }
    } else if (e.ctrlKey || e.metaKey) {
      selected.has(n.path) ? selected.delete(n.path) : selected.add(n.path);
      lastClickedPath = n.path;
    } else {
      const onlyThis = selected.size === 1 && selected.has(n.path);
      selected.clear();
      if (!onlyThis) selected.add(n.path);
      lastClickedPath = n.path;
    }
    renderNotes();
    updateSelCount();
    invalidateDryRun();
    populatePreviewSel();
    scheduleCheck();
  };

  return item;
}

function updateSelCount() {
  selCount.textContent = selected.size ? `${selected.size} selected` : '';
}

// ── YAML filter ────────────────────────────────────────────
const YAML_OPS = ['=', '!=', '<', '>', 'contains', 'exists', 'not exists'];

function renderYamlFilters() {
  const container = document.getElementById('yaml-filter-rows');
  container.innerHTML = '';
  yamlFilters.forEach((f, i) => {
    const row = document.createElement('div');
    row.className = 'yaml-filter-row';
    const needsVal = f.op !== 'exists' && f.op !== 'not exists';
    const connectorHTML = i === 0
      ? '<span class="yaml-filter-where">WHERE</span>'
      : `<select class="input yaml-fc">${['AND','OR'].map(c => `<option ${f.connector===c?'selected':''}>${c}</option>`).join('')}</select>`;
    row.innerHTML = `
      <div class="yaml-filter-top">
        ${connectorHTML}
        <select class="input input-sm yaml-fk">
          <option value="" ${!f.key?'selected':''}>— key —</option>
          ${knownKeys.map(k => `<option value="${esc(k)}" ${f.key===k?'selected':''}>${esc(k)}</option>`).join('')}
        </select>
        <button class="btn btn-danger yaml-fdel" title="Remove">×</button>
      </div>
      <div class="yaml-filter-bottom">
        <select class="input input-sm yaml-fop">
          ${YAML_OPS.map(o => `<option ${f.op===o?'selected':''}>${o}</option>`).join('')}
        </select>
        <input class="input input-sm yaml-fv" placeholder="value" value="${esc(f.value)}" ${needsVal?'':'disabled style="opacity:.3"'}/>
      </div>`;
    const connSel = row.querySelector('.yaml-fc');
    if (connSel) connSel.onchange = e => { f.connector = e.target.value; renderNotes(); };
    row.querySelector('.yaml-fk').onchange = e => { f.key = e.target.value; renderNotes(); };
    row.querySelector('.yaml-fop').onchange = e => { f.op = e.target.value; renderYamlFilters(); renderNotes(); };
    row.querySelector('.yaml-fv').oninput = e => { f.value = e.target.value; renderNotes(); };
    row.querySelector('.yaml-fdel').onclick = () => { yamlFilters.splice(i, 1); renderYamlFilters(); renderNotes(); };
    container.appendChild(row);
  });
}

document.getElementById('btn-add-yaml-filter').onclick = () => {
  yamlFilters.push({ connector: 'AND', key: '', op: '=', value: '' });
  renderYamlFilters();
  renderNotes();
};

// ── YAML filter collapse ────────────────────────────────────
let filtersCollapsed = false;
document.getElementById('btn-toggle-filters').onclick = () => {
  filtersCollapsed = !filtersCollapsed;
  document.getElementById('yaml-filter-rows').style.display = filtersCollapsed ? 'none' : '';
  document.getElementById('btn-add-yaml-filter').style.display = filtersCollapsed ? 'none' : '';
  document.getElementById('btn-toggle-filters').textContent = filtersCollapsed ? '▶ YAML filters' : '▼';
};

function matchYamlFilters(note, filters) {
  let result = matchOneYamlFilter(note, filters[0]);
  for (let i = 1; i < filters.length; i++) {
    const m = matchOneYamlFilter(note, filters[i]);
    result = filters[i].connector === 'OR' ? result || m : result && m;
  }
  return result;
}

function matchOneYamlFilter(note, f) {
  const { key, op, value } = f;
  const listItems = key && note.listFields && note.listFields[key];
  if (listItems) {
    if (op === 'exists') return listItems.length > 0;
    if (op === 'not exists') return listItems.length === 0;
    return listItems.some(item => compareYamlValues(String(item), op, value));
  }
  const raw = key ? note.fields[key] : undefined;
  if (op === 'exists') return raw !== undefined && raw !== null && raw !== '';
  if (op === 'not exists') return raw === undefined || raw === null || raw === '';
  if (!key || raw === undefined || raw === null) return true;
  // inline list like "[a, b, c]"
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const items = raw.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
    return items.some(item => compareYamlValues(item, op, value));
  }
  return compareYamlValues(String(raw), op, value);
}

function compareYamlValues(rawStr, op, value) {
  switch (op) {
    case '=':        return rawStr === value;
    case '!=':       return rawStr !== value;
    case 'contains': return rawStr.toLowerCase().includes(value.toLowerCase());
    case '<': { const n = parseFloat(rawStr), v = parseFloat(value); return !isNaN(n)&&!isNaN(v) ? n<v : rawStr<value; }
    case '>': { const n = parseFloat(rawStr), v = parseFloat(value); return !isNaN(n)&&!isNaN(v) ? n>v : rawStr>value; }
    default: return false;
  }
}

noteFilter.oninput = renderNotes;

btnSelectAll.onclick = () => {
  getVisibleNotesList().forEach(n => selected.add(n.path));
  renderNotes();
  populatePreviewSel();
  invalidateDryRun();
  scheduleCheck();
};

btnSelectNone.onclick = () => {
  selected.clear();
  renderNotes();
  populatePreviewSel();
  invalidateDryRun();
  scheduleCheck();
};

btnCheck.onclick = () => {
  clearTimeout(checkTimer);
  runCheck();
};

// ── Op builder ─────────────────────────────────────────────
const OP_KINDS = ['add', 'set', 'delete', 'rename', 'list-add', 'list-remove'];
const COND_KINDS = [
  'key_exists', 'key_missing', 'value_equals', 'value_contains',
  'value_gt', 'value_lt', 'value_gte', 'value_lte',
  'date_before', 'date_after',
  'in_folder', 'in_folder_recursive', 'not_in_folder', 'not_in_folder_recursive',
];

btnAddOp.onclick = () => addOp({ kind: 'set', key: '', value: '', conds: [] });

function addOp(op) {
  ops.push(op);
  renderOps();
}

function buildKeyCombo(value, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'key-combo';

  const inp = document.createElement('input');
  inp.className = 'input op-key';
  inp.placeholder = 'Key';
  inp.value = value;
  wrap.appendChild(inp);

  const list = document.createElement('div');
  list.className = 'key-combo-list';
  list.style.display = 'none';
  document.body.appendChild(list);

  let activeIdx = -1;

  function positionList() {
    const r = inp.getBoundingClientRect();
    list.style.left = r.left + 'px';
    list.style.top = (r.bottom + 2) + 'px';
    list.style.width = r.width + 'px';
  }

  function showList(filter) {
    const q = filter.toLowerCase();
    const matches = q ? knownKeys.filter(k => k.toLowerCase().includes(q)) : knownKeys;
    list.innerHTML = '';
    activeIdx = -1;
    if (!matches.length) { list.style.display = 'none'; return; }
    matches.forEach((k, i) => {
      const d = document.createElement('div');
      d.textContent = k;
      d.addEventListener('mousedown', e => {
        e.preventDefault();
        inp.value = k;
        onChange(k);
        list.style.display = 'none';
      });
      list.appendChild(d);
    });
    positionList();
    list.style.display = 'block';
  }

  inp.addEventListener('focus', () => showList(inp.value));
  inp.addEventListener('input', () => { onChange(inp.value); showList(inp.value); });
  inp.addEventListener('blur', () => { setTimeout(() => { list.style.display = 'none'; }, 150); });
  inp.addEventListener('keydown', e => {
    const items = list.querySelectorAll('div');
    if (!items.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = Math.min(activeIdx + 1, items.length - 1);
      items.forEach((d, i) => d.classList.toggle('active', i === activeIdx));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = Math.max(activeIdx - 1, 0);
      items.forEach((d, i) => d.classList.toggle('active', i === activeIdx));
    } else if (e.key === 'Enter' && activeIdx >= 0) {
      e.preventDefault();
      const chosen = items[activeIdx].textContent;
      inp.value = chosen;
      onChange(chosen);
      list.style.display = 'none';
    } else if (e.key === 'Escape') {
      list.style.display = 'none';
    }
  });

  new MutationObserver(() => {
    if (!document.body.contains(wrap)) { list.remove(); }
  }).observe(document.body, { childList: true, subtree: true });

  return wrap;
}

function buildKeySelect(value, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'key-combo';

  const btn = document.createElement('input');
  btn.type = 'text';
  btn.readOnly = true;
  btn.className = 'input op-key key-select-btn';
  btn.value = value || '';
  btn.placeholder = '— key —';
  wrap.appendChild(btn);

  const list = document.createElement('div');
  list.className = 'key-combo-list';
  list.style.display = 'none';
  document.body.appendChild(list);

  let open = false;

  function positionList() {
    const r = btn.getBoundingClientRect();
    list.style.left = r.left + 'px';
    list.style.top = (r.bottom + 2) + 'px';
    list.style.width = r.width + 'px';
  }

  function showList() {
    list.innerHTML = '';
    knownKeys.forEach(k => {
      const d = document.createElement('div');
      d.textContent = k;
      if (k === value) d.classList.add('active');
      d.addEventListener('mousedown', e => {
        e.preventDefault();
        btn.value = k;
        value = k;
        onChange(k);
        list.style.display = 'none';
        open = false;
      });
      list.appendChild(d);
    });
    positionList();
    list.style.display = 'block';
    open = true;
  }

  btn.addEventListener('click', () => {
    if (open) { list.style.display = 'none'; open = false; }
    else showList();
  });

  document.addEventListener('mousedown', e => {
    if (!wrap.contains(e.target) && !list.contains(e.target)) {
      list.style.display = 'none';
      open = false;
    }
  });

  new MutationObserver(() => {
    if (!document.body.contains(wrap)) { list.remove(); }
  }).observe(document.body, { childList: true, subtree: true });

  return wrap;
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
    const valueLabel = op.kind === 'rename' ? 'New key name'
      : op.kind === 'list-add' || op.kind === 'list-remove' ? 'Item'
      : 'Value';

    const isAddOp = op.kind === 'add';

    row.innerHTML = `
      <select class="op-kind" title="Operation type">
        ${OP_KINDS.map(k => `<option ${op.kind===k?'selected':''}>${k}</option>`).join('')}
      </select>
      <input class="input op-val" placeholder="${valueLabel}" value="${esc(op.value)}" ${needsValue?'':'disabled style="opacity:.3"'}/>
      <button class="btn btn-danger op-del" title="Remove">✕</button>
      <div class="op-conds">
        ${op.conds.map((c, ci) => condRowHTML(c, i, ci)).join('')}
        <button class="btn btn-xs btn-add-cond">+ condition</button>
      </div>`;

    const keyWidget = isAddOp
      ? buildKeyCombo(op.key, v => { op.key = v; if (previewNoteSel.value) runPreview(); })
      : buildKeySelect(op.key, v => { op.key = v; if (previewNoteSel.value) runPreview(); });
    row.querySelector('.op-kind').insertAdjacentElement('afterend', keyWidget);

    row.querySelector('.op-kind').onchange = e => { op.kind = e.target.value; renderOps(); if (previewNoteSel.value) runPreview(); };
    row.querySelector('.op-val').oninput = e => { op.value = e.target.value; };
    row.querySelector('.op-del').onclick = () => { ops.splice(i, 1); renderOps(); if (previewNoteSel.value) runPreview(); };
    row.querySelector('.btn-add-cond').onclick = () => {
      op.conds.push({ kind: 'key_exists', key: '', value: '' });
      renderOps();
    };
    row.querySelectorAll('.cond-kind').forEach((sel, ci) => {
      sel.onchange = e => { op.conds[ci].kind = e.target.value; renderOps(); };
    });
    row.querySelectorAll('.cond-key').forEach((sel, ci) => {
      sel.oninput = e => { op.conds[ci].key = e.target.value; };
      sel.onchange = e => { op.conds[ci].key = e.target.value; };
    });
    row.querySelectorAll('.cond-val').forEach((inp, ci) => {
      inp.oninput = e => { op.conds[ci].value = e.target.value; };
    });
    row.querySelectorAll('.cond-del').forEach((btn, ci) => {
      btn.onclick = () => { op.conds.splice(ci, 1); renderOps(); };
    });

    opsList.appendChild(row);
  });
  scheduleCheck();
  invalidateDryRun();
}

function condRowHTML(c, oi, ci) {
  const folderKinds = ['in_folder', 'in_folder_recursive', 'not_in_folder', 'not_in_folder_recursive'];
  const numericKinds = ['value_gt', 'value_lt', 'value_gte', 'value_lte'];
  const dateKinds = ['date_before', 'date_after'];
  const isFolder = folderKinds.includes(c.kind);
  const needsKey = !isFolder;
  const needsVal = !['key_exists', 'key_missing'].includes(c.kind);
  let valPlaceholder = 'Value';
  if (dateKinds.includes(c.kind)) valPlaceholder = 'YYYY-MM-DD';
  else if (numericKinds.includes(c.kind)) valPlaceholder = 'Number';
  else if (isFolder) valPlaceholder = 'folder/path';
  const keyFieldHTML = needsKey
    ? `<select class="input input-sm cond-key">
         <option value="" ${!c.key ? 'selected' : ''}>— key —</option>
         ${knownKeys.map(k => `<option value="${esc(k)}" ${c.key === k ? 'selected' : ''}>${esc(k)}</option>`).join('')}
       </select>`
    : `<select class="input input-sm cond-key" disabled style="opacity:.3"><option>Key</option></select>`;
  return `<div class="cond-row">
    <select class="input input-sm cond-kind">
      ${COND_KINDS.map(k => `<option ${c.kind===k?'selected':''}>${k}</option>`).join('')}
    </select>
    ${keyFieldHTML}
    <input class="input input-sm cond-val" placeholder="${valPlaceholder}" value="${esc(c.value)}" ${needsVal?'':'disabled style="opacity:.3"'}/>
    <button class="btn btn-danger cond-del">✕</button>
  </div>`;
}

// ── Preview ────────────────────────────────────────────────
function populatePreviewSel() {
  const prev = previewNoteSel.value;
  previewNoteSel.innerHTML = '';
  [...selected].forEach(path => {
    const n = allNotes.find(x => x.path === path);
    if (!n) return;
    const opt = document.createElement('option');
    opt.value = path;
    opt.textContent = n.title;
    previewNoteSel.appendChild(opt);
  });
  if (prev && selected.has(prev)) {
    previewNoteSel.value = prev;
  } else if (previewNoteSel.options.length > 0) {
    previewNoteSel.value = previewNoteSel.options[0].value;
    if (previewNoteSel.value !== prev) runPreview();
  }
  previewNoteSel.disabled = selected.size === 0;
  btnPreview.disabled = selected.size === 0;
}

btnPreview.onclick = runPreview;
previewNoteSel.onchange = runPreview;

async function runPreview() {
  const path = previewNoteSel.value;
  if (!path) return;
  const currentOps = collectOps();
  const skipsEl = document.getElementById('preview-skips');
  try {
    const result = await PreviewNote(path, currentOps);
    previewBefore.textContent = result.before || '(no frontmatter)';
    previewAfter.textContent  = result.after  || '(no frontmatter)';
    if (!currentOps.length) {
      skipsEl.style.display = 'none';
    } else if (result.skipped) {
      skipsEl.style.display = '';
      skipsEl.textContent = 'Skipped: ' + result.skipped;
      skipsEl.className = 'preview-skips is-warn';
    } else {
      skipsEl.style.display = '';
      skipsEl.textContent = 'All ops will apply';
      skipsEl.className = 'preview-skips is-ok';
    }
  } catch (e) {
    toast('Preview error: ' + e, 'error');
  }
}

// ── Dry-run ────────────────────────────────────────────────
btnDryrun.onclick = async () => {
  const paths = [...selected];
  if (!paths.length) return;
  const currentOps = collectOps();
  acceptMode = false;
  btnApply.textContent = 'Apply';
  btnUndo.classList.add('hidden');
  const h = toast(`Dry-running ${paths.length} notes…`, 'busy');
  try {
    const verdicts = await DryRun(paths, currentOps);
    renderLog(verdicts, true);
    dryRunDone = true;
    updateRunButtons();
    h.update('Dry-run complete', 'success');
  } catch (e) {
    h.update('Error: ' + e, 'error');
  }
};

// ── Apply ──────────────────────────────────────────────────
btnApply.onclick = async () => {
  if (acceptMode) {
    acceptMode = false;
    btnUndo.classList.add('hidden');
    btnApply.textContent = 'Apply';
    updateRunButtons();
    return;
  }
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
    await refreshUndoButton();
    await refreshNotesInPlace();
    dryRunDone = false;
    acceptMode  = true;
    btnApply.textContent = 'Accept';
    btnApply.disabled    = false;
  } catch (e) {
    h.update('Error: ' + e, 'error');
  }
};

// ── Undo ───────────────────────────────────────────────────
async function refreshUndoButton() {
  try {
    const path = await GetUndoable();
    btnUndo.classList.toggle('hidden', !path);
  } catch {
    btnUndo.classList.add('hidden');
  }
}

btnUndo.onclick = async () => {
  const h = toast('Undoing last run…', 'busy');
  try {
    const verdicts = await UndoLastRun();
    renderLog(verdicts, false);
    const restored = verdicts.filter(v => v.status === 'changed').length;
    const errors   = verdicts.filter(v => v.status === 'error').length;
    h.update(errors ? `Undone — ${restored} restored, ${errors} errors` : `Undone — ${restored} restored`, errors ? 'error' : 'success');
    btnUndo.classList.add('hidden');
    await refreshNotesInPlace();
  } catch (e) {
    h.update('Undo failed: ' + e, 'error');
  }
};

refreshUndoButton();

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

function invalidateDryRun() {
  dryRunDone = false;
  acceptMode  = false;
  btnApply.textContent = 'Apply';
  updateRunButtons();
}

function updateRunButtons() {
  const ready = selected.size > 0;
  btnCheck.disabled  = !ready;
  btnDryrun.disabled = !ready;
  btnApply.disabled  = !ready || !dryRunDone;
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
    if (previewNoteSel.value) runPreview();
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

// ── Startup: restore saved vault ───────────────────────────
(async () => {
  const saved = localStorage.getItem('vaultPath');
  if (!saved) return;
  try {
    const notes = await Scan(saved);
    vaultPath.textContent = saved;
    vaultPath.classList.remove('muted');
    loadNotes(notes);
  } catch {
    // path gone or invalid — silently skip
  }
})();
