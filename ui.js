// ui.js — UI entry point; owns the live projectData reference for the current session

let projectData = createEmptyProjectData();
let loadedFilename = null;
// Active top-level tab. Single source of truth — set by activateTab, read by the
// dispatcher's post-mutation hook to know which panel to re-render.
let activeTab = 'data';

// Data-panel state — second-tier entity tab, per-entity selection, and the
// transient next-selection-intent used by toolbar actions and row clicks to
// communicate the intended post-mutation selection to renderDataPanel.
// formRenderedForId is the id the edit form was last built from; the form is
// only rebuilt when this changes, so commit-on-blur preserves user focus.
let activeEntityTab = 'tasks';
let entitySelections = { tasks: null, swimlanes: null, links: null, pipes: null, curtains: null, notes: null };
let nextSelectionIntent = null;
let formRenderedForId = null;

function resetDataPanelState() {
  activeEntityTab    = 'tasks';
  entitySelections   = { tasks: null, swimlanes: null, links: null, pipes: null, curtains: null, notes: null };
  nextSelectionIntent = null;
  formRenderedForId  = null;
}

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
// Renders the second-tier entity tab strip and the active entity tab's panel.
// Called on Data-tab activation (including dispatcher-triggered re-renders via
// runPostMutationHook) and from the file-load / New-Project handlers.
// Tasks tab is fully implemented in slice 2a; other five tabs are stubs.

const ENTITY_TABS = [
  { key: 'tasks',     label: 'Tasks'     },
  { key: 'swimlanes', label: 'Swimlanes' },
  { key: 'links',     label: 'Links'     },
  { key: 'pipes',     label: 'Pipes'     },
  { key: 'curtains',  label: 'Curtains'  },
  { key: 'notes',     label: 'Notes'     },
];

function renderDataPanel() {
  // Always clear the transient intent at the top of every render, even before
  // we read its value. Guards against silent dispatch no-ops leaving stale
  // intent that would mis-target a later mutation.
  const intent = nextSelectionIntent;
  nextSelectionIntent = null;
  if (intent && intent.entity in entitySelections) {
    entitySelections[intent.entity] = intent.id;
  }

  // Build the persistent skeleton on first render. Stable child elements let
  // us update parts of the panel without recreating the form DOM, which is
  // how commit-on-blur preserves user focus on the surviving inputs.
  const panel = document.getElementById('dataPanel');
  let strip = document.getElementById('entityTabStrip');
  let area  = document.getElementById('entityArea');
  if (!strip || !area) {
    panel.innerHTML = '<div id="entityTabStrip" class="entity-tabs"></div><div id="entityArea"></div>';
    strip = document.getElementById('entityTabStrip');
    area  = document.getElementById('entityArea');
  }

  buildEntityTabStrip(strip);

  // Rebuild the entity-area sub-tree only when switching tabs, not on every
  // mutation. Inside the Tasks tree, the form's container survives untouched
  // so renderTasksForm can decide whether to rebuild it.
  if (area.dataset.tab !== activeEntityTab) {
    area.dataset.tab = activeEntityTab;
    if (activeEntityTab === 'tasks') {
      area.innerHTML = '<div class="entity-panel"><div class="entity-left"></div><div class="entity-right"></div></div>';
      formRenderedForId = null;  // right pane is a fresh element — force form rebuild
    } else {
      const label = ENTITY_TABS.find(t => t.key === activeEntityTab).label;
      area.innerHTML = `<div class="entity-stub">${escapeHtml(label)} tab — coming in slice 2b</div>`;
    }
  }

  if (activeEntityTab === 'tasks') renderTasksPanel(area);
}

function buildEntityTabStrip(strip) {
  strip.innerHTML = '';
  ENTITY_TABS.forEach(t => {
    const btn = document.createElement('button');
    btn.className = 'entity-tab' + (t.key === activeEntityTab ? ' active' : '');
    btn.textContent = t.label;
    btn.addEventListener('click', () => {
      if (activeEntityTab === t.key) return;
      activeEntityTab = t.key;
      renderDataPanel();
    });
    strip.appendChild(btn);
  });
}

// ── Tasks entity panel ─────────────────────────────────────────────────────────

function renderTasksPanel(area) {
  // Normalise selection: clear stale id, apply default-first-row rule.
  const tasks = projectData.tasks;
  let selectedId = entitySelections.tasks;
  if (selectedId !== null && !tasks.some(t => t.id === selectedId)) selectedId = null;
  if (selectedId === null && tasks.length > 0) selectedId = tasks[0].id;
  entitySelections.tasks = selectedId;

  const left  = area.querySelector('.entity-left');
  const right = area.querySelector('.entity-right');

  // Left pane (toolbar + nav table) is rebuilt every render — no focusable
  // controls inside, so this has no UX cost.
  left.innerHTML = '';
  left.appendChild(renderTasksToolbar(selectedId));
  left.appendChild(renderTasksNavTable(selectedId));

  // Right pane (form) is rebuilt only when selectedId changes — see policy
  // note inside renderTasksForm.
  renderTasksForm(right, selectedId);
}

function renderTasksToolbar(selectedId) {
  const toolbar = document.createElement('div');
  toolbar.className = 'entity-toolbar';

  const tasks = projectData.tasks;
  const swimlaneCount = projectData.swimlanes.length;
  const idx = selectedId == null ? -1 : tasks.findIndex(t => t.id === selectedId);

  function mkBtn(label) {
    const b = document.createElement('button');
    b.textContent = label;
    return b;
  }

  const btnAdd       = mkBtn('Add');
  const btnDelete    = mkBtn('Delete');
  const btnDuplicate = mkBtn('Duplicate');
  const btnMoveUp    = mkBtn('Move Up');
  const btnMoveDown  = mkBtn('Move Down');

  if (swimlaneCount === 0) {
    btnAdd.disabled = true;
    btnAdd.title = 'Add a swimlane first';
  }
  if (idx === -1) {
    btnDelete.disabled = btnDuplicate.disabled = btnMoveUp.disabled = btnMoveDown.disabled = true;
  } else {
    const blockReason = whyCannotDeleteTask(selectedId);
    if (blockReason !== null) {
      btnDelete.disabled = true;
      btnDelete.title = blockReason;
    }
    // Move Up / Down operate on task.row, not array order — see §2 of the
    // slice-2a patch. Enablement is row-vs-rowCount, with orphan tasks
    // (swimlaneId pointing to a missing swimlane, or null) explicitly tooltipped.
    const task = tasks[idx];
    const swimlane = task.swimlaneId == null
      ? null
      : (projectData.swimlanes.find(s => s.id === task.swimlaneId) || null);
    if (!swimlane) {
      btnMoveUp.disabled = btnMoveDown.disabled = true;
      btnMoveUp.title = btnMoveDown.title = 'Task has no swimlane';
    } else {
      if (!(typeof task.row === 'number' && task.row > 1))                 btnMoveUp.disabled   = true;
      if (!(typeof task.row === 'number' && task.row < swimlane.rowCount)) btnMoveDown.disabled = true;
    }
  }

  btnAdd.addEventListener('click', () => {
    const newId = nextIdFor(tasks);
    nextSelectionIntent = { entity: 'tasks', id: newId };
    dispatch({ entity: 'task', action: 'add' });
  });
  btnDelete.addEventListener('click', () => {
    // Post-delete selection follows the sorted display order — the array
    // order no longer matches the visible table order after sort lands.
    const sorted = buildTasksDisplayOrder();
    const i = sorted.findIndex(t => t.id === selectedId);
    let nextId = null;
    if (i !== -1) {
      if (i + 1 < sorted.length) nextId = sorted[i + 1].id;
      else if (i - 1 >= 0)       nextId = sorted[i - 1].id;
    }
    nextSelectionIntent = { entity: 'tasks', id: nextId };
    dispatch({ entity: 'task', action: 'delete', id: selectedId });
  });
  btnDuplicate.addEventListener('click', () => {
    const newId = nextIdFor(tasks);
    nextSelectionIntent = { entity: 'tasks', id: newId };
    dispatch({ entity: 'task', action: 'duplicate', id: selectedId });
  });
  // Move Up / Down on the Tasks tab dispatch row-field updates rather than
  // array reorders — see §2 of the slice-2a patch. The dispatcher's moveUp /
  // moveDown actions remain in use by other entity types (Swimlanes in 2b).
  // After dispatch returns the form's row input still shows the stale
  // pre-click value (renderTasksForm no-ops on same-id), so we sync it here.
  btnMoveUp.addEventListener('click', () => {
    const task = projectData.tasks.find(t => t.id === selectedId);
    if (!task) return;
    nextSelectionIntent = { entity: 'tasks', id: task.id };
    dispatch({ entity: 'task', action: 'update', id: task.id, field: 'row', value: task.row - 1 });
    syncTaskRowInput(task.id);
  });
  btnMoveDown.addEventListener('click', () => {
    const task = projectData.tasks.find(t => t.id === selectedId);
    if (!task) return;
    nextSelectionIntent = { entity: 'tasks', id: task.id };
    dispatch({ entity: 'task', action: 'update', id: task.id, field: 'row', value: task.row + 1 });
    syncTaskRowInput(task.id);
  });

  toolbar.appendChild(btnAdd);
  toolbar.appendChild(btnDelete);
  toolbar.appendChild(btnDuplicate);
  toolbar.appendChild(btnMoveUp);
  toolbar.appendChild(btnMoveDown);
  return toolbar;
}

// UI-only message for the disabled Delete button. canDeleteTask is the pure
// boolean the dispatcher consults; this returns the human-readable reason (or
// null when delete is allowed).
function whyCannotDeleteTask(id) {
  const task = projectData.tasks.find(t => t.id === id);
  if (!task) return null;
  if (projectData.links.some(l => l.fromTaskId === id || l.toTaskId === id)) {
    return 'Cannot delete: task has links pointing to or from it';
  }
  return null;
}

// Sorted display order for the Tasks navigation table. Returns a shallow copy
// of projectData.tasks; the array itself is never mutated (array order remains
// under user control via the Excel sheet / writer round-trip).
// Key: (swimlane.order, task.row, originalIndex). Orphan tasks (no matching
// swimlane) sort to the end; within any group, null/undefined task.row sorts
// after numeric rows. Infinity sentinels make the comparator straightforward
// without tripping JS's null/undefined-vs-number quirks.
function buildTasksDisplayOrder() {
  const tasks = projectData.tasks;
  const swimlaneOrderById = new Map();
  projectData.swimlanes.forEach(s => swimlaneOrderById.set(s.id, s.order));
  const decorated = tasks.map((t, i) => ({
    task:    t,
    swOrder: swimlaneOrderById.has(t.swimlaneId) ? swimlaneOrderById.get(t.swimlaneId) : Infinity,
    rowKey:  (typeof t.row === 'number' && Number.isFinite(t.row)) ? t.row : Infinity,
    index:   i,
  }));
  decorated.sort((a, b) => {
    if (a.swOrder !== b.swOrder) return a.swOrder - b.swOrder;
    if (a.rowKey  !== b.rowKey)  return a.rowKey  - b.rowKey;
    return a.index - b.index;
  });
  return decorated.map(d => d.task);
}

function formatSwimlaneIdCell(swimlaneId) {
  if (swimlaneId == null) return '—';
  const sw = projectData.swimlanes.find(s => s.id === swimlaneId);
  return swimlaneId + ' — ' + (sw ? sw.name : '<unknown>');
}

function renderTasksNavTable(selectedId) {
  const sortedTasks = buildTasksDisplayOrder();
  const table = document.createElement('table');
  table.className = 'entity-nav-table';
  const COLS = ['id', 'name', 'swimlaneId', 'row', 'startDate', 'finishDate'];

  let html = '<thead><tr>';
  COLS.forEach(c => { html += `<th>${c}</th>`; });
  html += '</tr></thead><tbody>';

  if (sortedTasks.length === 0) {
    html += `<tr><td colspan="${COLS.length}" class="entity-empty">No tasks. Click Add to create one.</td></tr>`;
  } else {
    sortedTasks.forEach(t => {
      const isSelected = t.id === selectedId;
      html += `<tr data-id="${t.id}"${isSelected ? ' class="selected"' : ''}>`;
      COLS.forEach(c => {
        let v;
        if (c === 'swimlaneId') v = formatSwimlaneIdCell(t.swimlaneId);
        else                    v = t[c] == null ? '' : t[c];
        html += `<td>${escapeHtml(String(v))}</td>`;
      });
      html += '</tr>';
    });
  }
  html += '</tbody></table>';
  table.innerHTML = html;

  // mousedown (not click) so selection updates BEFORE the natural focus shift
  // tears down the current focused form input via blur — the active.blur()
  // call below dispatches the in-progress edit and triggers the consume-intent
  // re-render that lands selection on the new row.
  table.querySelectorAll('tbody tr[data-id]').forEach(tr => {
    tr.addEventListener('mousedown', () => {
      const taskId = parseInt(tr.dataset.id, 10);
      if (!Number.isFinite(taskId)) return;
      if (taskId === entitySelections.tasks) return;
      nextSelectionIntent = { entity: 'tasks', id: taskId };
      const active = document.activeElement;
      const inForm = active && active.closest && active.closest('.entity-form');
      if (inForm) {
        active.blur();   // commit-on-blur → dispatch → renderDataPanel consumes intent
      } else {
        renderDataPanel();
      }
    });
  });

  return table;
}

// ── Tasks edit form ────────────────────────────────────────────────────────────

const LABEL_CONTENT_OPTIONS   = ['name', 'date', 'name_and_date', 'none'];
const LABEL_PLACEMENT_OPTIONS = ['inside', 'outside'];
const FILL_PATTERN_OPTIONS    = ['solid', 'hatch', 'cross-hatch', 'horizontal', 'vertical', 'dots'];

function renderTasksForm(container, selectedId) {
  // Re-render policy: only rebuild form when selected id changes. Same-id
  // commits (the common auto-commit-on-blur case) leave the form DOM intact
  // so the user's tab destination keeps focus.
  if (selectedId === formRenderedForId && container.childElementCount > 0) return;
  formRenderedForId = selectedId;
  container.innerHTML = '';

  if (selectedId === null) {
    const empty = document.createElement('div');
    empty.className = 'entity-form-empty';
    empty.textContent = 'Select a row to edit.';
    container.appendChild(empty);
    return;
  }

  const task = projectData.tasks.find(t => t.id === selectedId);
  if (!task) { formRenderedForId = null; return; }

  const form = document.createElement('div');
  form.className = 'entity-form';
  container.appendChild(form);

  const upd = (field, value) => dispatch({ entity: 'task', action: 'update', id: task.id, field, value });

  addReadonlyRow(form, 'id', task.id);

  const swimlaneOptions = projectData.swimlanes.map(s => ({ value: String(s.id), label: `${s.id} — ${s.name}` }));
  addSelectRow(form, 'swimlaneId', task.swimlaneId, swimlaneOptions, val => {
    if (val === '') return;
    const n = parseInt(val, 10);
    if (Number.isFinite(n)) upd('swimlaneId', n);
  });

  addNumberRow(form, 'row', task.row, val => {
    const n = parseInt(val, 10);
    if (Number.isFinite(n)) upd('row', n);
  });
  addTextRow(form, 'name', task.name, val => upd('name', val));
  addDateRow(form, 'startDate',  task.startDate,  val => upd('startDate',  val === '' ? null : val));
  addDateRow(form, 'finishDate', task.finishDate, val => upd('finishDate', val === '' ? null : val));
  addReadonlyRow(form, 'isMilestone', task.isMilestone, ' (derived)');

  addSelectRow(form, 'labelContent', task.labelContent,
    LABEL_CONTENT_OPTIONS.map(o => ({ value: o, label: o })),
    val => upd('labelContent', val));
  addSelectRow(form, 'labelPlacement', task.labelPlacement,
    LABEL_PLACEMENT_OPTIONS.map(o => ({ value: o, label: o })),
    val => upd('labelPlacement', val));
  addNumberRow(form, 'labelOffset', task.labelOffset, val => {
    const n = parseInt(val, 10);
    if (Number.isFinite(n)) upd('labelOffset', n);
  });
  addTextRow(form, 'fillColor', task.fillColor, val => upd('fillColor', val));
  addSelectRow(form, 'fillPattern', task.fillPattern,
    FILL_PATTERN_OPTIONS.map(o => ({ value: o, label: o })),
    val => upd('fillPattern', val));
  addTextRow(form, 'patternColor', task.patternColor, val => upd('patternColor', val));
  addTextRow(form, 'dateFormat', task.dateFormat == null ? '' : task.dateFormat,
    val => upd('dateFormat', val === '' ? null : val));
}

function addReadonlyRow(form, fieldName, value, suffix) {
  const label = document.createElement('label');
  label.textContent = fieldName + (suffix || '');
  const div = document.createElement('div');
  div.className = 'readonly';
  div.textContent = (value === null || value === undefined) ? '' : String(value);
  form.appendChild(label);
  form.appendChild(div);
}

function addTextRow(form, fieldName, value, commitFn) {
  const label = document.createElement('label');
  label.textContent = fieldName;
  const input = document.createElement('input');
  input.type  = 'text';
  input.value = value == null ? '' : String(value);
  attachCommitHandlers(input, () => input.value, commitFn);
  form.appendChild(label);
  form.appendChild(input);
}

function addNumberRow(form, fieldName, value, commitFn) {
  const label = document.createElement('label');
  label.textContent = fieldName;
  const input = document.createElement('input');
  input.type  = 'number';
  input.step  = '1';
  input.value = value == null ? '' : String(value);
  // data-field marker enables targeted DOM updates without rebuilding the form
  // (e.g. syncTaskRowInput after a Move Up / Move Down dispatch).
  input.dataset.field = fieldName;
  attachCommitHandlers(input, () => input.value, commitFn);
  form.appendChild(label);
  form.appendChild(input);
}

function addDateRow(form, fieldName, value, commitFn) {
  const label = document.createElement('label');
  label.textContent = fieldName;
  const input = document.createElement('input');
  input.type  = 'date';
  input.value = value == null ? '' : String(value);
  attachCommitHandlers(input, () => input.value, commitFn);
  form.appendChild(label);
  form.appendChild(input);
}

function addSelectRow(form, fieldName, value, options, commitFn) {
  const label = document.createElement('label');
  label.textContent = fieldName;
  const select = document.createElement('select');
  if (options.length === 0) select.disabled = true;
  // Placeholder for null values — gives the user a visible "no selection"
  // state instead of the browser silently displaying the first real option.
  if (value === null || value === undefined) {
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '—';
    select.appendChild(placeholder);
  }
  options.forEach(o => {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    select.appendChild(opt);
  });
  select.value = (value === null || value === undefined) ? '' : String(value);
  attachCommitHandlers(select, () => select.value, commitFn);
  form.appendChild(label);
  form.appendChild(select);
}

// Targeted in-place sync of the form's row input after a Move Up / Move Down
// dispatch. renderTasksForm no-ops on same-id, so without this the form
// continues to display the pre-click row value. Only used for the row field;
// the slice-2a known-limitation for stale isMilestone display is preserved.
function syncTaskRowInput(taskId) {
  const task = projectData.tasks.find(t => t.id === taskId);
  if (!task) return;
  const input = document.querySelector('.entity-form input[data-field="row"]');
  if (!input) return;
  input.value = task.row == null ? '' : String(task.row);
}

function attachCommitHandlers(control, getValue, commitFn) {
  let preEditValue = getValue();
  let cancelled = false;
  control.addEventListener('focus', () => {
    preEditValue = getValue();
    cancelled = false;
  });
  control.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') {
      cancelled = true;
      control.value = preEditValue;
      control.blur();
    } else if (ev.key === 'Enter' && control.tagName === 'INPUT' && control.type !== 'date') {
      control.blur();
    }
  });
  control.addEventListener('blur', () => {
    if (cancelled) { cancelled = false; return; }
    commitFn(getValue());
  });
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
    if (entity === 'task' && !canDeleteTask(id)) return;  // referential-integrity no-op
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

// Deletion blocking rule. Returns false to signal "block" (silent no-op): a
// task with a link pointing to or from it cannot be deleted.
function canDeleteTask(id) {
  const task = projectData.tasks.find(t => t.id === id);
  if (!task) return true;
  if (projectData.links.some(l => l.fromTaskId === id || l.toTaskId === id)) return false;
  return true;
}

function runPostMutationHook() {
  projectData._validation = validateProject(projectData);
  activateTab(activeTab);
  updateIssuesTabLabel();
}

// Updates the Save-button disabled state and the status-text line. Shared
// between the file-load handler and New Project so the formatting stays in
// sync; only the prefix varies.
function refreshStatusAndButtons(prefix) {
  const d = projectData;
  const noData = d.tasks.length === 0 && d.swimlanes.length === 0;
  document.getElementById('saveBtn').disabled    = noData;
  document.getElementById('saveSvgBtn').disabled = noData;
  const cnt = (num, s) => `${num} ${num === 1 ? s : s + 's'}`;
  document.getElementById('status').textContent =
    `${prefix} — `                                  +
    `${cnt(d.tasks.length,     'task')}, `           +
    `${cnt(d.swimlanes.length, 'swimlane')}, `       +
    `${cnt(d.links.length,     'link')}, `           +
    `${cnt(d.pipes.length,     'pipe')}, `           +
    `${cnt(d.curtains.length,  'curtain')}, `        +
    `${cnt(d.notes.length,     'note')}`;
}

// ── Public entry point ─────────────────────────────────────────────────────────
function initUI() {
  document.getElementById('tabData').addEventListener('click',      () => activateTab('data'));
  document.getElementById('tabIssues').addEventListener('click',    () => activateTab('issues'));
  document.getElementById('tabChart').addEventListener('click',     () => activateTab('chart'));
  document.getElementById('tabInspector').addEventListener('click', () => activateTab('inspector'));

  document.getElementById('newProjectBtn').addEventListener('click', function() {
    projectData    = createEmptyProjectData();
    loadedFilename = null;
    resetDataPanelState();
    issuesFilterState = ISSUE_DEFAULT_FILTER();

    // Activate the Data + Tasks tabs BEFORE the dispatches so their post-mutation
    // re-renders land on the Data panel rather than re-rendering whichever
    // top-level tab the user was previously on.
    activateTab('data');

    dispatch({ entity: 'swimlane', action: 'add' });
    dispatch({ entity: 'swimlane', action: 'update', id: 1, field: 'name', value: 'Swimlane 1' });

    refreshStatusAndButtons('New project');
    updateIssuesTabLabel();
  });

  document.getElementById('fileInput').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(ev) {
      const workbook = XLSX.read(new Uint8Array(ev.target.result), { type: 'array', cellDates: true });
      projectData = parseWorkbook(workbook);
      projectData._validation = validateProject(projectData);
      loadedFilename = file.name;

      resetDataPanelState();
      issuesFilterState = ISSUE_DEFAULT_FILTER();
      updateIssuesTabLabel();
      if (document.getElementById('tabIssues').classList.contains('active')) {
        renderIssuesPanel(document.getElementById('issuesPanel'));
      }

      refreshStatusAndButtons(`Loaded: ${file.name}`);

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

  // Bootstrap the empty Data panel so the entity tab strip and empty Tasks
  // panel appear on page load, not just after the first file load / mutation.
  renderDataPanel();
}
