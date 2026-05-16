// ui.js — UI entry point; owns the live projectData reference for the current session

let projectData = createEmptyProjectData();
let loadedFilename = null;
// Active top-level tab. Single source of truth — set by activateTab, read by the
// dispatcher's post-mutation hook to know which panel to re-render.
let activeTab = 'data';

// ── Table renderers ────────────────────────────────────────────────────────────
function renderEntityTable(container, data, derivedKeys = []) {
  if (!data || !data.length) {
    container.innerHTML = '<p><em>No data</em></p>';
    return;
  }
  const keys = Object.keys(data[0]);
  let html = '<table><thead><tr>';
  keys.forEach(k => {
    const label = derivedKeys.includes(k) ? `${k} (derived)` : k;
    html += `<th>${label}</th>`;
  });
  html += '</tr></thead><tbody>';
  data.forEach(row => {
    html += '<tr>';
    keys.forEach(k => {
      const v = row[k];
      html += `<td>${v != null ? v : ''}</td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  container.innerHTML = html;
}

function renderConfigTable(container, config) {
  const entries = Object.entries(config);
  if (!entries.length) {
    container.innerHTML = '<p><em>No data</em></p>';
    return;
  }
  let html = '<table><thead><tr><th>Property</th><th>Value</th></tr></thead><tbody>';
  entries.forEach(([k, v]) => {
    html += `<tr><td>${k}</td><td>${v != null ? v : ''}</td></tr>`;
  });
  html += '</tbody></table>';
  container.innerHTML = html;
}

// ── Tab switching ──────────────────────────────────────────────────────────────
function activateTab(name) {
  activeTab = name;

  ['data', 'issues', 'chart', 'inspector'].forEach(n => {
    document.getElementById(n + 'Panel').style.display = n === name ? '' : 'none';
    document.getElementById('tab' + n.charAt(0).toUpperCase() + n.slice(1)).classList.toggle('active', n === name);
  });

  if (name === 'data') {
    renderDataPanel();
  }

  if (name === 'issues') {
    renderIssuesPanel(document.getElementById('issuesPanel'));
  }

  if (name === 'chart') {
    const panel = document.getElementById('chartPanel');
    panel.innerHTML = projectData.tasks.length === 0
      ? '<p>No project loaded</p>'
      : renderChart(projectData);
  }

  if (name === 'inspector') {
    renderInspector(document.getElementById('inspectorPanel'));
  }
}

// ── Data panel renderer ────────────────────────────────────────────────────────
// Populates the eight entity/config containers in the Data panel from the current
// projectData. Called on Data-tab activation (including dispatcher re-renders)
// and from the file-load handler.
function renderDataPanel() {
  const d = projectData;
  renderDataTasksTable(document.getElementById('tasksContainer'), d.tasks);
  renderEntityTable(document.getElementById('swimlanesContainer'), d.swimlanes);
  renderEntityTable(document.getElementById('linksContainer'),     d.links);
  renderEntityTable(document.getElementById('pipesContainer'),     d.pipes);
  renderEntityTable(document.getElementById('curtainsContainer'),  d.curtains);
  renderEntityTable(document.getElementById('notesContainer'),     d.notes);
  renderConfigTable(document.getElementById('configLayoutContainer'),      d.config.layout);
  renderConfigTable(document.getElementById('configBarsContainer'),        d.config.bars);
  renderConfigTable(document.getElementById('configTimelineContainer'),    d.config.timeline);
  renderConfigTable(document.getElementById('configTitlesContainer'),      d.config.titles);
  renderConfigTable(document.getElementById('configStyleContainer'),       d.config.style);
  renderConfigTable(document.getElementById('configTypographyContainer'),  d.config.typography);
  renderConfigTable(document.getElementById('configPreferencesContainer'), d.config.preferences);
  renderConfigTable(document.getElementById('configRenderingContainer'),   d.config.rendering);
}

// Variant of renderEntityTable for the Data tab's Tasks table: the Name column
// is inline-editable as the slice-1 proof case. Other columns render read-only.
function renderDataTasksTable(container, tasks) {
  if (!tasks || !tasks.length) {
    container.innerHTML = '<p><em>No data</em></p>';
    return;
  }
  const keys = Object.keys(tasks[0]);
  let html = '<table><thead><tr>';
  keys.forEach(k => { html += `<th>${k}</th>`; });
  html += '</tr></thead><tbody>';
  tasks.forEach(row => {
    html += `<tr data-id="${row.id}">`;
    keys.forEach(k => {
      const v = row[k];
      if (k === 'name') {
        html += `<td class="editable-name" title="Click to edit">${v != null ? escapeHtml(String(v)) : ''}</td>`;
      } else {
        html += `<td>${v != null ? escapeHtml(String(v)) : ''}</td>`;
      }
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  container.innerHTML = html;

  container.querySelectorAll('td.editable-name').forEach(td => {
    td.addEventListener('click', () => beginEditTaskNameCell(td));
  });
}

function beginEditTaskNameCell(td) {
  if (td.querySelector('input')) return;
  const originalText = td.textContent;
  const id = parseInt(td.parentElement.dataset.id, 10);
  if (!Number.isFinite(id)) return;

  const input = document.createElement('input');
  input.type  = 'text';
  input.value = originalText;
  td.textContent = '';
  td.appendChild(input);
  input.focus();
  input.select();

  let cancelled = false;
  function commit() {
    if (cancelled) {
      td.textContent = originalText;
      return;
    }
    const newValue = input.value;
    if (newValue === originalText) {
      td.textContent = originalText;
      return;
    }
    dispatch({ entity: 'task', action: 'update', id, field: 'name', value: newValue });
    // dispatch's post-mutation hook re-renders the Data tab; this <td> is gone.
  }
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape')      { cancelled = true; input.blur(); }
    else if (e.key === 'Enter')  { input.blur(); }
  });
  input.addEventListener('blur', commit);
}

// ── Inspector renderer ─────────────────────────────────────────────────────────
function renderInspector(panel) {
  const d = projectData;
  panel.innerHTML = '';

  function appendSection(path, sourceLabel, renderFn) {
    const h2 = document.createElement('h2');
    h2.textContent = `${path} — ${sourceLabel}`;
    panel.appendChild(h2);
    const div = document.createElement('div');
    panel.appendChild(div);
    renderFn(div);
  }

  appendSection('tasks',     'from Tasks sheet',     div => renderEntityTable(div, d.tasks,     ['isMilestone']));
  appendSection('swimlanes', 'from Swimlanes sheet',  div => renderEntityTable(div, d.swimlanes, ['order']));
  appendSection('links',     'from Links sheet',      div => renderEntityTable(div, d.links));
  appendSection('pipes',     'from Pipes sheet',      div => renderEntityTable(div, d.pipes));
  appendSection('curtains',  'from Curtains sheet',   div => renderEntityTable(div, d.curtains));
  appendSection('notes',     'from Notes sheet',      div => renderEntityTable(div, d.notes));

  appendSection('config.layout',      'from Layout sheet',     div => renderConfigTable(div, d.config.layout));
  appendSection('config.bars',        'from Bars sheet',       div => renderConfigTable(div, d.config.bars));
  appendSection('config.timeline',    'from Timeline sheet',   div => renderConfigTable(div, d.config.timeline));
  appendSection('config.titles',      'from Titles sheet',     div => renderConfigTable(div, d.config.titles));
  appendSection('config.style',       'from Style sheet',      div => renderConfigTable(div, d.config.style));
  appendSection('config.typography',  'from Typography sheet', div => renderConfigTable(div, d.config.typography));
  appendSection('config.preferences', 'from Preferences sheet',div => renderConfigTable(div, d.config.preferences));
  appendSection('config.rendering',   'not in Excel',          div => renderConfigTable(div, d.config.rendering));

  const FIXED = new Set(['tasks', 'swimlanes', 'links', 'pipes', 'curtains', 'notes', 'config']);
  Object.keys(d).forEach(key => {
    if (FIXED.has(key)) return;
    const val = d[key];
    // Plain object whose every value is an array → render one section per sub-key.
    // Generalises e.g. _validation's { errors, warnings, notices } buckets.
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      const entries = Object.entries(val);
      if (entries.length > 0 && entries.every(([, v]) => Array.isArray(v))) {
        entries.forEach(([subKey, subVal]) => {
          appendSection(`${key}.${subKey}`, 'diagnostic', div => renderEntityTable(div, subVal));
        });
        return;
      }
    }
    appendSection(key, 'diagnostic', div => {
      if (Array.isArray(val)) {
        renderEntityTable(div, val);
      } else if (val !== null && typeof val === 'object') {
        renderConfigTable(div, val);
      } else if (val === null || typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
        div.innerHTML = `<table><tbody><tr><td>${val != null ? String(val) : ''}</td></tr></tbody></table>`;
      } else {
        div.innerHTML = `<table><tbody><tr><td>${JSON.stringify(val)}</td></tr></tbody></table>`;
      }
    });
  });
}

// ── Issues tab ────────────────────────────────────────────────────────────────
const ISSUE_SEVERITIES = ['errors', 'warnings', 'notices'];
const ISSUE_SEVERITY_RANK   = { errors: 0, warnings: 1, notices: 2 };
const ISSUE_SEVERITY_PLURAL = { errors: 'Errors', warnings: 'Warnings', notices: 'Notices' };
const ISSUE_SEVERITY_PILL   = { errors: 'Error',  warnings: 'Warning',  notices: 'Notice'  };
const ISSUE_ENTITY_ORDER = ['task', 'swimlane', 'link', 'pipe', 'curtain', 'note', 'config'];
const ISSUE_ENTITY_RANK  = {};
ISSUE_ENTITY_ORDER.forEach((e, i) => { ISSUE_ENTITY_RANK[e] = i; });
const ISSUE_ENTITY_LABEL = { task:'Task', swimlane:'Swimlane', link:'Link', pipe:'Pipe', curtain:'Curtain', note:'Note', config:'Config' };
const ISSUE_COLUMNS = [
  { key: 'severity', label: 'Severity' },
  { key: 'entity',   label: 'Entity'   },
  { key: 'id',       label: 'ID'       },
  { key: 'field',    label: 'Field'    },
  { key: 'message',  label: 'Message'  },
  { key: 'value',    label: 'Value'    },
];
const ISSUE_DEFAULT_FILTER = () => ({
  search: '',
  showErrors: true, showWarnings: true, showNotices: true,
  grouped: true,
  sortColumn: null, sortDirection: null,
});
let issuesFilterState = ISSUE_DEFAULT_FILTER();

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function flattenIssues(v) {
  const out = [];
  ISSUE_SEVERITIES.forEach(sev => {
    v[sev].forEach(iss => {
      out.push({ ...iss, _severity: sev, _emissionIndex: out.length });
    });
  });
  return out;
}

// Returns { text, placeholder, raw }. text is the visible cell text (with em-dash
// for placeholder cases); raw is the search/sort key (empty for placeholders).
function formatIssueValue(value) {
  if (value === null || value === undefined) return { text: '—', placeholder: true,  raw: '' };
  if (value === '')                          return { text: '—', placeholder: true,  raw: '' };
  if (Array.isArray(value)) {
    const joined = value.join(', ');
    return { text: joined, placeholder: false, raw: joined };
  }
  const s = String(value);
  return { text: s, placeholder: false, raw: s };
}

function truncateCell(s, max) {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

function applyIssueFilters(items) {
  const q = issuesFilterState.search.trim().toLowerCase();
  return items.filter(iss => {
    if (iss._severity === 'errors'   && !issuesFilterState.showErrors)   return false;
    if (iss._severity === 'warnings' && !issuesFilterState.showWarnings) return false;
    if (iss._severity === 'notices'  && !issuesFilterState.showNotices)  return false;
    if (q) {
      const msg = String(iss.message || '').toLowerCase();
      const val = formatIssueValue(iss.value).raw.toLowerCase();
      if (!msg.includes(q) && !val.includes(q)) return false;
    }
    return true;
  });
}

// Returns a comparator value, or the sentinels +Infinity / -Infinity to mean
// "a sorts last / first regardless of asc-desc direction" (for nulls-last rules).
function compareIssues(a, b, col) {
  if (col === 'id') {
    const aNull = a.id == null, bNull = b.id == null;
    if (aNull && !bNull) return  Infinity;
    if (bNull && !aNull) return -Infinity;
  }
  if (col === 'value') {
    const aP = formatIssueValue(a.value).placeholder;
    const bP = formatIssueValue(b.value).placeholder;
    if (aP && !bP) return  Infinity;
    if (bP && !aP) return -Infinity;
  }
  switch (col) {
    case 'severity': return ISSUE_SEVERITY_RANK[a._severity] - ISSUE_SEVERITY_RANK[b._severity];
    case 'entity':   return (ISSUE_ENTITY_RANK[a.entity] ?? 99) - (ISSUE_ENTITY_RANK[b.entity] ?? 99);
    case 'id': {
      const an = typeof a.id === 'number' ? a.id : Number(a.id);
      const bn = typeof b.id === 'number' ? b.id : Number(b.id);
      if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
      return String(a.id).toLowerCase().localeCompare(String(b.id).toLowerCase());
    }
    case 'field':   return String(a.field).toLowerCase().localeCompare(String(b.field).toLowerCase());
    case 'message': return String(a.message).toLowerCase().localeCompare(String(b.message).toLowerCase());
    case 'value':   return formatIssueValue(a.value).raw.toLowerCase()
                          .localeCompare(formatIssueValue(b.value).raw.toLowerCase());
  }
  return 0;
}

function applyIssueSort(items) {
  const col = issuesFilterState.sortColumn;
  const dir = issuesFilterState.sortDirection;
  if (!col || !dir) return items.slice();
  const sign = dir === 'asc' ? 1 : -1;
  const out = items.slice();
  out.sort((a, b) => {
    const r = compareIssues(a, b, col);
    if (r ===  Infinity) return  1;
    if (r === -Infinity) return -1;
    if (r !== 0) return sign * r;
    return a._emissionIndex - b._emissionIndex;
  });
  return out;
}

function buildIssueGroups(filtered) {
  const groups = [];
  ISSUE_SEVERITIES.forEach(sev => {
    const sevItems = filtered.filter(i => i._severity === sev);
    if (!sevItems.length) return;
    const subGroups = [];
    ISSUE_ENTITY_ORDER.forEach(ent => {
      const sub = sevItems.filter(i => i.entity === ent);
      if (!sub.length) return;
      subGroups.push({ entity: ent, count: sub.length, items: applyIssueSort(sub) });
    });
    groups.push({ severity: sev, count: sevItems.length, subGroups });
  });
  return groups;
}

function renderIssueRow(iss) {
  const tr = document.createElement('tr');
  const sevPill = `<span class="issues-pill issues-pill-${iss._severity}">${ISSUE_SEVERITY_PILL[iss._severity]}</span>`;
  const idHtml  = iss.id == null
    ? '<span class="issues-placeholder">—</span>'
    : escapeHtml(String(iss.id));
  const v = formatIssueValue(iss.value);
  let valHtml;
  if (v.placeholder) {
    valHtml = '<span class="issues-placeholder">—</span>';
  } else {
    const truncated = truncateCell(v.text, 40);
    valHtml = truncated !== v.text
      ? `<span title="${escapeHtml(v.text)}">${escapeHtml(truncated)}</span>`
      : escapeHtml(v.text);
  }
  tr.innerHTML =
    `<td class="issues-col-severity">${sevPill}</td>` +
    `<td class="issues-col-entity">${escapeHtml(ISSUE_ENTITY_LABEL[iss.entity] || iss.entity)}</td>` +
    `<td class="issues-col-id">${idHtml}</td>` +
    `<td class="issues-col-field">${escapeHtml(iss.field)}</td>` +
    `<td class="issues-col-message">${escapeHtml(String(iss.message))}</td>` +
    `<td class="issues-col-value">${valHtml}</td>`;
  return tr;
}

function renderIssuesTable(items) {
  const table = document.createElement('table');
  table.className = 'issues-table';
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  ISSUE_COLUMNS.forEach(c => {
    const th = document.createElement('th');
    th.className = 'issues-col-' + c.key;
    let label = c.label;
    if (issuesFilterState.sortColumn === c.key) {
      label += issuesFilterState.sortDirection === 'asc' ? ' ▲' : ' ▼';
    }
    th.textContent = label;
    th.addEventListener('click', () => cycleIssueSort(c.key));
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  items.forEach(iss => tbody.appendChild(renderIssueRow(iss)));
  table.appendChild(tbody);
  return table;
}

function renderSeverityBand(g) {
  const wrap = document.createElement('div');
  wrap.className = 'issues-band issues-band-' + g.severity;
  const header = document.createElement('div');
  header.className = 'issues-band-header';
  header.textContent = `${ISSUE_SEVERITY_PLURAL[g.severity]} — ${g.count}`;
  wrap.appendChild(header);
  g.subGroups.forEach(sub => {
    const sh = document.createElement('div');
    sh.className = 'issues-subheader';
    sh.textContent = `${ISSUE_ENTITY_LABEL[sub.entity]} — ${sub.count}`;
    wrap.appendChild(sh);
    wrap.appendChild(renderIssuesTable(sub.items));
  });
  return wrap;
}

function cycleIssueSort(col) {
  if (issuesFilterState.sortColumn !== col) {
    issuesFilterState.sortColumn = col;
    issuesFilterState.sortDirection = 'asc';
  } else if (issuesFilterState.sortDirection === 'asc') {
    issuesFilterState.sortDirection = 'desc';
  } else {
    issuesFilterState.sortColumn = null;
    issuesFilterState.sortDirection = null;
  }
  const body = document.getElementById('issuesBody');
  if (body) refreshIssuesBody(body);
}

function buildIssuesControls() {
  const wrap = document.createElement('div');
  wrap.className = 'issues-controls';
  wrap.innerHTML =
    `<input type="text" class="issues-search" placeholder="Search issues…">` +
    `<label class="issues-check"><input type="checkbox" data-sev="errors">   Errors</label>` +
    `<label class="issues-check"><input type="checkbox" data-sev="warnings"> Warnings</label>` +
    `<label class="issues-check"><input type="checkbox" data-sev="notices">  Notices</label>` +
    `<label class="issues-check"><input type="checkbox" class="issues-group-toggle"> Group by severity and entity</label>`;
  wrap.querySelector('.issues-search').value                 = issuesFilterState.search;
  wrap.querySelector('input[data-sev="errors"]').checked     = issuesFilterState.showErrors;
  wrap.querySelector('input[data-sev="warnings"]').checked   = issuesFilterState.showWarnings;
  wrap.querySelector('input[data-sev="notices"]').checked    = issuesFilterState.showNotices;
  wrap.querySelector('.issues-group-toggle').checked         = issuesFilterState.grouped;
  return wrap;
}

function refreshIssuesBody(body) {
  body.innerHTML = '';
  const v = projectData._validation;
  const totalE = v.errors.length, totalW = v.warnings.length, totalN = v.notices.length;
  const totalAll = totalE + totalW + totalN;

  const all = flattenIssues(v);
  const filtered = applyIssueFilters(all);
  const filtersActive =
    issuesFilterState.search.trim() !== '' ||
    !issuesFilterState.showErrors ||
    !issuesFilterState.showWarnings ||
    !issuesFilterState.showNotices;

  const summary = document.createElement('div');
  summary.className = 'issues-summary';
  const line1 = `${totalE} ${totalE === 1 ? 'error' : 'errors'}, ` +
                `${totalW} ${totalW === 1 ? 'warning' : 'warnings'}, ` +
                `${totalN} ${totalN === 1 ? 'notice' : 'notices'}`;
  summary.innerHTML = `<div>${line1}</div>` +
    (filtersActive ? `<div>Showing ${filtered.length} of ${totalAll}</div>` : '');
  body.appendChild(summary);

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'issues-empty';
    empty.textContent = 'No issues match the current filters.';
    body.appendChild(empty);
    return;
  }

  if (issuesFilterState.grouped) {
    buildIssueGroups(filtered).forEach(g => body.appendChild(renderSeverityBand(g)));
  } else {
    body.appendChild(renderIssuesTable(applyIssueSort(filtered)));
  }
}

function renderIssuesPanel(panel) {
  panel.innerHTML = '';
  const v = projectData._validation;

  if (!v) {
    const empty = document.createElement('div');
    empty.className = 'issues-empty';
    empty.textContent = 'Load a project to see validation results.';
    panel.appendChild(empty);
    return;
  }
  if (v.errors.length === 0 && v.warnings.length === 0 && v.notices.length === 0) {
    panel.innerHTML = '<div class="issues-clear"><div class="issues-clear-main">No issues found.</div></div>';
    return;
  }

  const controls = buildIssuesControls();
  panel.appendChild(controls);
  const body = document.createElement('div');
  body.id = 'issuesBody';
  panel.appendChild(body);

  controls.querySelector('.issues-search').addEventListener('input', e => {
    issuesFilterState.search = e.target.value;
    refreshIssuesBody(body);
  });
  controls.querySelectorAll('input[data-sev]').forEach(cb => {
    cb.addEventListener('change', e => {
      const sev = e.target.dataset.sev;
      if (sev === 'errors')   issuesFilterState.showErrors   = e.target.checked;
      if (sev === 'warnings') issuesFilterState.showWarnings = e.target.checked;
      if (sev === 'notices')  issuesFilterState.showNotices  = e.target.checked;
      refreshIssuesBody(body);
    });
  });
  controls.querySelector('.issues-group-toggle').addEventListener('change', e => {
    issuesFilterState.grouped = e.target.checked;
    refreshIssuesBody(body);
  });

  refreshIssuesBody(body);
}

function updateIssuesTabLabel() {
  const tab = document.getElementById('tabIssues');
  if (!tab) return;
  tab.classList.remove('tab-tint-error', 'tab-tint-warning', 'tab-tint-notice');
  const v = projectData._validation;
  if (!v) { tab.textContent = 'Issues'; return; }
  const e = v.errors.length, w = v.warnings.length, n = v.notices.length;
  if (e + w + n === 0) { tab.textContent = 'Issues'; return; }
  tab.textContent = `Issues (${e}/${w}/${n})`;
  if      (e > 0) tab.classList.add('tab-tint-error');
  else if (w > 0) tab.classList.add('tab-tint-warning');
  else if (n > 0) tab.classList.add('tab-tint-notice');
}

// ── Dispatcher (single-writer entry point) ────────────────────────────────────
// All UI-driven mutations to projectData route through dispatch(). Validation
// re-run, active-tab re-render, and Issues-tab-label refresh hook here so they
// can never be bypassed. Malformed calls and rule-blocked deletions silently
// no-op (with console.warn for unknown values, missing required fields, and
// id misses — slice 2 will surface block reasons via disabled toolbar buttons).
const ENTITY_ARRAY_KEY = {
  task: 'tasks', swimlane: 'swimlanes', link: 'links',
  pipe: 'pipes', curtain: 'curtains', note: 'notes',
};
const ENTITY_FACTORY = {
  task:     createEmptyTask,
  swimlane: createEmptySwimlane,
  link:     createEmptyLink,
  pipe:     createEmptyPipe,
  curtain:  createEmptyCurtain,
  note:     createEmptyNote,
};
const VALID_ENTITIES = new Set([...Object.keys(ENTITY_ARRAY_KEY), 'config']);
const VALID_ACTIONS  = new Set(['update', 'add', 'delete', 'duplicate', 'moveUp', 'moveDown']);

function dispatch({ entity, action, id, block, field, value, index } = {}) {
  if (!VALID_ENTITIES.has(entity)) { console.warn('[dispatch] unknown entity:', entity); return; }
  if (!VALID_ACTIONS.has(action))  { console.warn('[dispatch] unknown action:', action); return; }

  // ── Config ────────────────────────────────────────────────────────────────
  if (entity === 'config') {
    if (action !== 'update')          { console.warn('[dispatch] action not supported for config:', action); return; }
    if (!block)                       { console.warn('[dispatch] config update missing block'); return; }
    if (!field)                       { console.warn('[dispatch] config update missing field'); return; }
    if (!(block in projectData.config)) { console.warn('[dispatch] unknown config block:', block); return; }
    projectData.config[block][field] = value;
    runPostMutationHook();
    return;
  }

  // ── Entity dispatch ───────────────────────────────────────────────────────
  const arr = projectData[ENTITY_ARRAY_KEY[entity]];

  if (action === 'update') {
    if (id == null) { console.warn('[dispatch] update missing id'); return; }
    if (!field)     { console.warn('[dispatch] update missing field'); return; }
    const rec = arr.find(r => r.id === id);
    if (!rec) { console.warn('[dispatch] update: no', entity, 'with id', id); return; }
    rec[field] = value;
    if (entity === 'task') recomputeTaskDerived(rec);
    runPostMutationHook();
    return;
  }

  if (action === 'add') {
    const rec = ENTITY_FACTORY[entity]();
    rec.id = nextIdFor(arr);
    const insertAt = (typeof index === 'number' && index >= 0 && index <= arr.length) ? index : arr.length;
    arr.splice(insertAt, 0, rec);
    if (entity === 'swimlane') recomputeSwimlaneOrders();
    runPostMutationHook();
    return;
  }

  if (action === 'delete') {
    if (id == null) { console.warn('[dispatch] delete missing id'); return; }
    const idx = arr.findIndex(r => r.id === id);
    if (idx === -1) { console.warn('[dispatch] delete: no', entity, 'with id', id); return; }
    if (entity === 'task'     && !canDeleteTask(id))     return;  // referential-integrity no-op
    if (entity === 'swimlane' && !canDeleteSwimlane(id)) return;  // referential-integrity no-op
    arr.splice(idx, 1);
    if (entity === 'swimlane') recomputeSwimlaneOrders();
    runPostMutationHook();
    return;
  }

  if (action === 'duplicate') {
    if (id == null) { console.warn('[dispatch] duplicate missing id'); return; }
    const rec = arr.find(r => r.id === id);
    if (!rec) { console.warn('[dispatch] duplicate: no', entity, 'with id', id); return; }
    const clone = { ...rec };
    clone.id = nextIdFor(arr);
    arr.push(clone);
    if (entity === 'swimlane') recomputeSwimlaneOrders();
    runPostMutationHook();
    return;
  }

  if (action === 'moveUp' || action === 'moveDown') {
    if (id == null) { console.warn('[dispatch]', action, 'missing id'); return; }
    const idx = arr.findIndex(r => r.id === id);
    if (idx === -1) { console.warn('[dispatch]', action, 'no', entity, 'with id', id); return; }
    if (action === 'moveUp'   && idx === 0)              return;  // edge no-op
    if (action === 'moveDown' && idx === arr.length - 1) return;  // edge no-op
    const swap = action === 'moveUp' ? idx - 1 : idx + 1;
    [arr[idx], arr[swap]] = [arr[swap], arr[idx]];
    if (entity === 'swimlane') recomputeSwimlaneOrders();
    runPostMutationHook();
    return;
  }
}

function nextIdFor(arr) {
  const ids = arr.map(r => r.id).filter(n => typeof n === 'number');
  return ids.length === 0 ? 1 : Math.max(...ids) + 1;
}

// Derived-field maintenance. Task.isMilestone and Swimlane.order are computed
// in the parser; the dispatcher keeps them consistent after mutations so
// validation and re-render see correct state.
function recomputeTaskDerived(task) {
  task.isMilestone = task.startDate !== null && task.startDate === task.finishDate;
}

function recomputeSwimlaneOrders() {
  projectData.swimlanes.forEach((s, i) => { s.order = i + 1; });
}

// Deletion blocking rules. Each returns false to signal "block" (silent no-op).
function canDeleteTask(id) {
  const task = projectData.tasks.find(t => t.id === id);
  if (!task) return true;
  // A link pointing to or from this task blocks delete.
  if (projectData.links.some(l => l.fromTaskId === id || l.toTaskId === id)) return false;
  // Deleting would leave this task's swimlane with zero tasks. Only applies
  // when the swimlane actually exists — orphan-swimlaneId tasks aren't
  // keeping anything alive.
  if (task.swimlaneId != null) {
    const swimlaneExists = projectData.swimlanes.some(s => s.id === task.swimlaneId);
    if (swimlaneExists) {
      const otherInSwimlane = projectData.tasks.some(t => t.id !== id && t.swimlaneId === task.swimlaneId);
      if (!otherInSwimlane) return false;
    }
  }
  return true;
}

function canDeleteSwimlane(id) {
  return !projectData.tasks.some(t => t.swimlaneId === id);
}

function runPostMutationHook() {
  projectData._validation = validateProject(projectData);
  activateTab(activeTab);
  updateIssuesTabLabel();
}

// ── Public entry point ─────────────────────────────────────────────────────────
function initUI() {
  document.getElementById('tabData').addEventListener('click',      () => activateTab('data'));
  document.getElementById('tabIssues').addEventListener('click',    () => activateTab('issues'));
  document.getElementById('tabChart').addEventListener('click',     () => activateTab('chart'));
  document.getElementById('tabInspector').addEventListener('click', () => activateTab('inspector'));

  document.getElementById('fileInput').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(ev) {
      const workbook = XLSX.read(new Uint8Array(ev.target.result), { type: 'array', cellDates: true });
      projectData = parseWorkbook(workbook);
      projectData._validation = validateProject(projectData);
      loadedFilename = file.name;

      issuesFilterState = ISSUE_DEFAULT_FILTER();
      updateIssuesTabLabel();
      if (document.getElementById('tabIssues').classList.contains('active')) {
        renderIssuesPanel(document.getElementById('issuesPanel'));
      }

      const d = projectData;
      const noData = d.tasks.length === 0 && d.swimlanes.length === 0;
      document.getElementById('saveBtn').disabled    = noData;
      document.getElementById('saveSvgBtn').disabled = noData;
      const cnt = (num, s) => `${num} ${num === 1 ? s : s + 's'}`;
      document.getElementById('status').textContent =
        `Loaded: ${file.name} — `                    +
        `${cnt(d.tasks.length,     'task')}, `        +
        `${cnt(d.swimlanes.length, 'swimlane')}, `    +
        `${cnt(d.links.length,     'link')}, `        +
        `${cnt(d.pipes.length,     'pipe')}, `        +
        `${cnt(d.curtains.length,  'curtain')}, `     +
        `${cnt(d.notes.length,     'note')}`;

      renderDataPanel();
    };
    reader.readAsArrayBuffer(file);
  });

  document.getElementById('saveBtn').addEventListener('click', function() {
    const filename = loadedFilename || 'compactgantt_project.xlsx';
    const data = writeWorkbook(projectData);
    const blob = new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById('saveSvgBtn').addEventListener('click', function() {
    const base = loadedFilename
      ? (loadedFilename.includes('.') ? loadedFilename.slice(0, loadedFilename.lastIndexOf('.')) : loadedFilename)
      : 'compactgantt_chart';
    const filename = base + '.svg';
    const svg  = renderChart(projectData);
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  });
}
