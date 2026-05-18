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

// Config-panel state — active sub-tab and a per-block form-rebuild gate parallel
// to formRenderedForId. Reset on file load / New Project alongside data-panel
// state (function name is a soft misnomer kept for low-churn consistency with
// the existing entitySelections reset).
let activeConfigBlock = 'layout';
let configBlockRenderedFor = null;

function resetDataPanelState() {
  activeEntityTab    = 'tasks';
  entitySelections   = { tasks: null, swimlanes: null, links: null, pipes: null, curtains: null, notes: null };
  nextSelectionIntent = null;
  formRenderedForId  = null;
  activeConfigBlock       = 'layout';
  configBlockRenderedFor  = null;
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

  ['data', 'issues', 'chart', 'config', 'inspector'].forEach(n => {
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

  if (name === 'config') {
    renderConfigPanel(document.getElementById('configPanel'));
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
  // mutation. The form's container survives untouched so each panel's form
  // renderer can decide whether to rebuild it.
  if (area.dataset.tab !== activeEntityTab) {
    area.dataset.tab = activeEntityTab;
    area.innerHTML = '<div class="entity-panel"><div class="entity-left"></div><div class="entity-right"></div></div>';
    formRenderedForId = null;  // right pane is a fresh element — force form rebuild
  }

  if (activeEntityTab === 'tasks')     renderTasksPanel(area);
  if (activeEntityTab === 'swimlanes') renderSwimlanesPanel(area);
  if (activeEntityTab === 'links')     renderLinksPanel(area);
  if (activeEntityTab === 'pipes')     renderPipesPanel(area);
  if (activeEntityTab === 'curtains')  renderCurtainsPanel(area);
  if (activeEntityTab === 'notes')     renderNotesPanel(area);
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
    if (val === '') { upd('row', null); return; }
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
  addColorRow(form, 'fillColor', task.fillColor, val => upd('fillColor', val));
  addSelectRow(form, 'fillPattern', task.fillPattern,
    FILL_PATTERN_OPTIONS.map(o => ({ value: o, label: o })),
    val => upd('fillPattern', val));
  addColorRow(form, 'patternColor', task.patternColor, val => upd('patternColor', val));
  addTextRow(form, 'dateFormat', task.dateFormat == null ? '' : task.dateFormat,
    val => upd('dateFormat', val === '' ? null : val));
}

function addReadonlyRow(form, fieldName, value, suffix) {
  const label = document.createElement('label');
  label.textContent = fieldName + (suffix || '');
  const div = document.createElement('div');
  div.className = 'readonly';
  div.dataset.field = fieldName;
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

// Text → "#rrggbb" mapping for syncing the native swatch with the text input.
// Hex passthrough takes a fast path; everything else (named colours, rgb(),
// rgba(), hsl(), hsla(), 8-digit hex) defers to the browser's CSS parser via
// a transient display:none probe element. Alpha is stripped — the swatch is
// RGB-only because <input type="color"> cannot represent alpha; the text
// input remains source of truth and preserves the original string verbatim.
// NOT PURE: makes a DOM round-trip on non-hex inputs. Call only from UI
// rendering paths — never from the renderer or validator.
function parseTextToHex6(text) {
  if (text == null) return null;
  const s = String(text).trim();
  if (s === '') return null;
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(s)) {
    return ('#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]).toLowerCase();
  }
  const probe = document.createElement('div');
  probe.style.display = 'none';
  probe.style.color = s;
  if (probe.style.color === '') return null;
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  document.body.removeChild(probe);
  const m = computed.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return null;
  const toHex = n => parseInt(n, 10).toString(16).padStart(2, '0');
  return '#' + toHex(m[1]) + toHex(m[2]) + toHex(m[3]);
}

// Hybrid color picker: text input (source of truth) + native <input type="color">
// swatch (convenience). The swatch sits in a fixed-width slot on the right of
// the control column; both controls share a flex wrapper. opts: { allowEmpty }
// — when true, a `.color-clear-btn` ✕ button renders in its own fixed-width
// slot to the right of the swatch (always present, regardless of current
// value). Clicking ✕ clears the text input to empty, snaps the swatch to
// #000000 (so cleared and never-set fields look identical — native swatches
// cannot represent an empty state), and commits empty.
function addColorRow(form, fieldName, value, commitFn, opts) {
  const o = opts || {};
  const allowEmpty = !!o.allowEmpty;
  const initialStr = value == null ? '' : String(value);

  const label = document.createElement('label');
  label.textContent = fieldName;

  const wrapper = document.createElement('div');
  wrapper.className = 'color-row-wrapper';

  const input = document.createElement('input');
  input.type  = 'text';
  input.value = initialStr;

  const swatch = document.createElement('input');
  swatch.type = 'color';
  swatch.className = 'color-swatch';
  swatch.value = parseTextToHex6(initialStr) || '#000000';

  wrapper.appendChild(input);
  wrapper.appendChild(swatch);

  const handle = attachCommitHandlers(input, () => input.value, val => {
    commitFn(val);
    const hex = parseTextToHex6(val);
    if (hex !== null) swatch.value = hex;
  });

  swatch.addEventListener('change', () => {
    const hex = swatch.value;
    input.value = hex;
    handle.setPreEditValue(hex);
    commitFn(hex);
  });

  if (allowEmpty) {
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'color-clear-btn';
    clearBtn.textContent = '✕';  // ✕ U+2715 MULTIPLICATION X
    clearBtn.title = 'Clear';
    clearBtn.addEventListener('click', () => {
      input.value = '';
      swatch.value = '#000000';
      handle.setPreEditValue('');
      commitFn('');
    });
    wrapper.appendChild(clearBtn);
  }

  form.appendChild(label);
  form.appendChild(wrapper);
}

// opts: { step, min, max } — all optional. Defaults to integer-stepping (step=1,
// no bounds). Parsing is the caller's responsibility (parseInt vs parseFloat
// inside commitFn); the helper only configures the input's HTML attributes.
function addNumberRow(form, fieldName, value, commitFn, opts) {
  const o = opts || {};
  const label = document.createElement('label');
  label.textContent = fieldName;
  const input = document.createElement('input');
  input.type  = 'number';
  input.step  = o.step != null ? String(o.step) : '1';
  if (o.min != null) input.min = String(o.min);
  if (o.max != null) input.max = String(o.max);
  input.value = value == null ? '' : String(value);
  // data-field marker enables targeted DOM updates without rebuilding the form
  // (e.g. syncTaskRowInput after a Move Up / Move Down dispatch).
  input.dataset.field = fieldName;
  attachCommitHandlers(input, () => input.value, commitFn);
  form.appendChild(label);
  form.appendChild(input);
}

function addTextareaRow(form, fieldName, value, commitFn, rows) {
  const label = document.createElement('label');
  label.textContent = fieldName;
  const ta = document.createElement('textarea');
  ta.rows  = rows != null ? rows : 3;
  ta.value = value == null ? '' : String(value);
  // Enter inserts a newline (attachCommitHandlers gates its Enter→blur on
  // tagName === 'INPUT'), so multi-line text commits naturally on blur.
  attachCommitHandlers(ta, () => ta.value, commitFn);
  form.appendChild(label);
  form.appendChild(ta);
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

// NOTE: unlike addTextRow / addNumberRow / addSelectRow which pass the raw
// string from the input to commitFn (caller parses), this helper passes the
// parsed boolean directly. Commit handlers in the Config tab receive `true`
// or `false`, not a string. Auto-commits on the native 'change' event — no
// blur cycle, no Escape-to-revert (toggling back is one click).
function addCheckboxRow(form, fieldName, value, commitFn) {
  const label = document.createElement('label');
  label.textContent = fieldName;
  const wrapper = document.createElement('div');
  wrapper.className = 'checkbox-wrapper';
  const input = document.createElement('input');
  input.type    = 'checkbox';
  input.checked = !!value;
  input.dataset.field = fieldName;
  input.addEventListener('change', () => commitFn(input.checked));
  wrapper.appendChild(input);
  form.appendChild(label);
  form.appendChild(wrapper);
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

// ── Swimlanes entity panel ─────────────────────────────────────────────────────

function renderSwimlanesPanel(area) {
  const swimlanes = projectData.swimlanes;
  let selectedId = entitySelections.swimlanes;
  if (selectedId !== null && !swimlanes.some(s => s.id === selectedId)) selectedId = null;
  if (selectedId === null && swimlanes.length > 0) selectedId = swimlanes[0].id;
  entitySelections.swimlanes = selectedId;

  const left  = area.querySelector('.entity-left');
  const right = area.querySelector('.entity-right');

  left.innerHTML = '';
  left.appendChild(renderSwimlanesToolbar(selectedId));
  left.appendChild(renderSwimlanesNavTable(selectedId));

  renderSwimlanesForm(right, selectedId);
}

function renderSwimlanesToolbar(selectedId) {
  const toolbar = document.createElement('div');
  toolbar.className = 'entity-toolbar';

  const swimlanes = projectData.swimlanes;
  const idx = selectedId == null ? -1 : swimlanes.findIndex(s => s.id === selectedId);

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

  if (idx === -1) {
    btnDelete.disabled = btnDuplicate.disabled = btnMoveUp.disabled = btnMoveDown.disabled = true;
  } else {
    if (idx === 0)                    btnMoveUp.disabled   = true;
    if (idx === swimlanes.length - 1) btnMoveDown.disabled = true;
  }

  btnAdd.addEventListener('click', () => {
    const newId = nextIdFor(swimlanes);
    nextSelectionIntent = { entity: 'swimlanes', id: newId };
    dispatch({ entity: 'swimlane', action: 'add' });
  });
  btnDelete.addEventListener('click', () => {
    const i = swimlanes.findIndex(s => s.id === selectedId);
    let nextId = null;
    if (i !== -1) {
      if (i + 1 < swimlanes.length) nextId = swimlanes[i + 1].id;
      else if (i - 1 >= 0)          nextId = swimlanes[i - 1].id;
    }
    nextSelectionIntent = { entity: 'swimlanes', id: nextId };
    dispatch({ entity: 'swimlane', action: 'delete', id: selectedId });
  });
  btnDuplicate.addEventListener('click', () => {
    const newId = nextIdFor(swimlanes);
    nextSelectionIntent = { entity: 'swimlanes', id: newId };
    dispatch({ entity: 'swimlane', action: 'duplicate', id: selectedId });
  });
  // Move Up / Down dispatch array reorders. swimlane.order is derived from
  // array index, so the moved row's form `order` cell would display the stale
  // pre-click value (renderSwimlanesForm no-ops on same-id) without an
  // explicit DOM sync — same pattern as syncTaskRowInput on the Tasks tab.
  btnMoveUp.addEventListener('click', () => {
    nextSelectionIntent = { entity: 'swimlanes', id: selectedId };
    dispatch({ entity: 'swimlane', action: 'moveUp', id: selectedId });
    syncSwimlaneOrderCell(selectedId);
  });
  btnMoveDown.addEventListener('click', () => {
    nextSelectionIntent = { entity: 'swimlanes', id: selectedId };
    dispatch({ entity: 'swimlane', action: 'moveDown', id: selectedId });
    syncSwimlaneOrderCell(selectedId);
  });

  toolbar.appendChild(btnAdd);
  toolbar.appendChild(btnDelete);
  toolbar.appendChild(btnDuplicate);
  toolbar.appendChild(btnMoveUp);
  toolbar.appendChild(btnMoveDown);
  return toolbar;
}

function renderSwimlanesNavTable(selectedId) {
  const swimlanes = projectData.swimlanes;
  const table = document.createElement('table');
  table.className = 'entity-nav-table';
  const COLS = [
    { key: 'id',       label: 'id'              },
    { key: 'order',    label: 'order (derived)' },
    { key: 'name',     label: 'name'            },
    { key: 'rowCount', label: 'rowCount'        },
  ];

  let html = '<thead><tr>';
  COLS.forEach(c => { html += `<th>${c.label}</th>`; });
  html += '</tr></thead><tbody>';

  if (swimlanes.length === 0) {
    html += `<tr><td colspan="${COLS.length}" class="entity-empty">No swimlanes. Click Add to create one.</td></tr>`;
  } else {
    swimlanes.forEach(s => {
      const isSelected = s.id === selectedId;
      html += `<tr data-id="${s.id}"${isSelected ? ' class="selected"' : ''}>`;
      COLS.forEach(c => {
        const v = s[c.key] == null ? '' : s[c.key];
        html += `<td>${escapeHtml(String(v))}</td>`;
      });
      html += '</tr>';
    });
  }
  html += '</tbody></table>';
  table.innerHTML = html;

  table.querySelectorAll('tbody tr[data-id]').forEach(tr => {
    tr.addEventListener('mousedown', () => {
      const swId = parseInt(tr.dataset.id, 10);
      if (!Number.isFinite(swId)) return;
      if (swId === entitySelections.swimlanes) return;
      nextSelectionIntent = { entity: 'swimlanes', id: swId };
      const active = document.activeElement;
      const inForm = active && active.closest && active.closest('.entity-form');
      if (inForm) {
        active.blur();
      } else {
        renderDataPanel();
      }
    });
  });

  return table;
}

const LABEL_POSITION_OPTIONS = ['top-right', 'top-left', 'bottom-right', 'bottom-left'];

function renderSwimlanesForm(container, selectedId) {
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

  const sw = projectData.swimlanes.find(s => s.id === selectedId);
  if (!sw) { formRenderedForId = null; return; }

  const form = document.createElement('div');
  form.className = 'entity-form';
  container.appendChild(form);

  const upd = (field, value) => dispatch({ entity: 'swimlane', action: 'update', id: sw.id, field, value });

  addReadonlyRow(form, 'id',    sw.id);
  addReadonlyRow(form, 'order', sw.order, ' (derived)');
  addTextRow(form, 'name', sw.name, val => upd('name', val));
  addNumberRow(form, 'rowCount', sw.rowCount, val => {
    const n = parseInt(val, 10);
    if (Number.isFinite(n)) upd('rowCount', n);
  });
  addSelectRow(form, 'labelPosition', sw.labelPosition,
    LABEL_POSITION_OPTIONS.map(o => ({ value: o, label: o })),
    val => upd('labelPosition', val));
  addColorRow(form, 'backgroundColor', sw.backgroundColor, val => upd('backgroundColor', val));
}

// Targeted in-place sync of the form's order readonly cell after a Move Up /
// Move Down dispatch. renderSwimlanesForm no-ops on same-id, so without this
// the cell continues to display the pre-click order value. Same pattern as
// syncTaskRowInput on the Tasks tab.
function syncSwimlaneOrderCell(swimlaneId) {
  const sw = projectData.swimlanes.find(s => s.id === swimlaneId);
  if (!sw) return;
  const cell = document.querySelector('.entity-form .readonly[data-field="order"]');
  if (!cell) return;
  cell.textContent = sw.order == null ? '' : String(sw.order);
}

// ── Shared helpers for Links / Pipes / Curtains / Notes panels ────────────────
// These four entity tabs share identical toolbar mechanics (no Add prerequisite,
// no delete-block, dispatcher-driven array reorder) and identical nav-table
// row-click behaviour. Tasks (delete-block, row-field Move Up/Down) and
// Swimlanes (predates this helper, plus order-cell sync) keep their own
// dedicated toolbars and inline row handlers.

function renderSimpleEntityToolbar(entitySingular, entityPlural, arr, selectedId) {
  const toolbar = document.createElement('div');
  toolbar.className = 'entity-toolbar';
  const idx = selectedId == null ? -1 : arr.findIndex(r => r.id === selectedId);

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

  if (idx === -1) {
    btnDelete.disabled = btnDuplicate.disabled = btnMoveUp.disabled = btnMoveDown.disabled = true;
  } else {
    if (idx === 0)              btnMoveUp.disabled   = true;
    if (idx === arr.length - 1) btnMoveDown.disabled = true;
  }

  btnAdd.addEventListener('click', () => {
    const newId = nextIdFor(arr);
    nextSelectionIntent = { entity: entityPlural, id: newId };
    dispatch({ entity: entitySingular, action: 'add' });
  });
  btnDelete.addEventListener('click', () => {
    const i = arr.findIndex(r => r.id === selectedId);
    let nextId = null;
    if (i !== -1) {
      if (i + 1 < arr.length) nextId = arr[i + 1].id;
      else if (i - 1 >= 0)    nextId = arr[i - 1].id;
    }
    nextSelectionIntent = { entity: entityPlural, id: nextId };
    dispatch({ entity: entitySingular, action: 'delete', id: selectedId });
  });
  btnDuplicate.addEventListener('click', () => {
    const newId = nextIdFor(arr);
    nextSelectionIntent = { entity: entityPlural, id: newId };
    dispatch({ entity: entitySingular, action: 'duplicate', id: selectedId });
  });
  // Selection follows the moved row. The id doesn't change, but setting the
  // intent makes the post-mutation consume step explicit and uniform.
  btnMoveUp.addEventListener('click', () => {
    nextSelectionIntent = { entity: entityPlural, id: selectedId };
    dispatch({ entity: entitySingular, action: 'moveUp', id: selectedId });
  });
  btnMoveDown.addEventListener('click', () => {
    nextSelectionIntent = { entity: entityPlural, id: selectedId };
    dispatch({ entity: entitySingular, action: 'moveDown', id: selectedId });
  });

  toolbar.appendChild(btnAdd);
  toolbar.appendChild(btnDelete);
  toolbar.appendChild(btnDuplicate);
  toolbar.appendChild(btnMoveUp);
  toolbar.appendChild(btnMoveDown);
  return toolbar;
}

// mousedown rather than click so the natural focus shift doesn't commit the
// in-progress edit through the wrong code path — same reason Tasks/Swimlanes
// use mousedown. See renderTasksNavTable for the original rationale.
function attachNavTableRowHandlers(table, entityPlural) {
  table.querySelectorAll('tbody tr[data-id]').forEach(tr => {
    tr.addEventListener('mousedown', () => {
      const id = parseInt(tr.dataset.id, 10);
      if (!Number.isFinite(id)) return;
      if (id === entitySelections[entityPlural]) return;
      nextSelectionIntent = { entity: entityPlural, id };
      const active = document.activeElement;
      const inForm = active && active.closest && active.closest('.entity-form');
      if (inForm) {
        active.blur();
      } else {
        renderDataPanel();
      }
    });
  });
}

// ── Links entity panel ─────────────────────────────────────────────────────────

function renderLinksPanel(area) {
  const links = projectData.links;
  let selectedId = entitySelections.links;
  if (selectedId !== null && !links.some(l => l.id === selectedId)) selectedId = null;
  if (selectedId === null && links.length > 0) selectedId = links[0].id;
  entitySelections.links = selectedId;

  const left  = area.querySelector('.entity-left');
  const right = area.querySelector('.entity-right');

  left.innerHTML = '';
  left.appendChild(renderSimpleEntityToolbar('link', 'links', links, selectedId));
  left.appendChild(renderLinksNavTable(selectedId));

  renderLinksForm(right, selectedId);
}

// Format an FK reference to a task for display. null → em-dash (user hasn't
// filled this in yet); orphan id (no matching task) → "{id} — (missing)".
function formatTaskRefCell(taskId) {
  if (taskId == null) return '—';
  const task = projectData.tasks.find(t => t.id === taskId);
  return taskId + ' — ' + (task ? task.name : '(missing)');
}

// Build the option list for a fromTaskId / toTaskId <select>. If currentValue
// is an orphan id (non-null, no matching task), prepend a "{id} — (missing)"
// option so the orphan state is visible and the user can re-point or save with
// the orphan persisting.
function buildTaskRefOptions(currentValue) {
  const opts = projectData.tasks.map(t => ({ value: String(t.id), label: `${t.id} — ${t.name}` }));
  if (currentValue != null && !projectData.tasks.some(t => t.id === currentValue)) {
    opts.unshift({ value: String(currentValue), label: `${currentValue} — (missing)` });
  }
  return opts;
}

function renderLinksNavTable(selectedId) {
  const links = projectData.links;
  const table = document.createElement('table');
  table.className = 'entity-nav-table';
  const COLS = ['id', 'fromTaskId', 'toTaskId', 'lineColor', 'lineStyle', 'routing'];

  let html = '<thead><tr>';
  COLS.forEach(c => { html += `<th>${c}</th>`; });
  html += '</tr></thead><tbody>';

  if (links.length === 0) {
    html += `<tr><td colspan="${COLS.length}" class="entity-empty">No links. Click Add to create one.</td></tr>`;
  } else {
    links.forEach(l => {
      const isSelected = l.id === selectedId;
      html += `<tr data-id="${l.id}"${isSelected ? ' class="selected"' : ''}>`;
      COLS.forEach(c => {
        let v;
        if (c === 'fromTaskId' || c === 'toTaskId') v = formatTaskRefCell(l[c]);
        else                                        v = l[c] == null ? '' : l[c];
        html += `<td>${escapeHtml(String(v))}</td>`;
      });
      html += '</tr>';
    });
  }
  html += '</tbody></table>';
  table.innerHTML = html;

  attachNavTableRowHandlers(table, 'links');
  return table;
}

const LINK_LINE_STYLE_OPTIONS = ['solid', 'dashed'];
const LINK_ROUTING_OPTIONS    = ['auto', 'hv', 'vh'];

function renderLinksForm(container, selectedId) {
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

  const link = projectData.links.find(l => l.id === selectedId);
  if (!link) { formRenderedForId = null; return; }

  const form = document.createElement('div');
  form.className = 'entity-form';
  container.appendChild(form);

  const upd = (field, value) => dispatch({ entity: 'link', action: 'update', id: link.id, field, value });

  addReadonlyRow(form, 'id', link.id);
  addSelectRow(form, 'fromTaskId', link.fromTaskId, buildTaskRefOptions(link.fromTaskId), val => {
    if (val === '') return;
    const n = parseInt(val, 10);
    if (Number.isFinite(n)) upd('fromTaskId', n);
  });
  addSelectRow(form, 'toTaskId', link.toTaskId, buildTaskRefOptions(link.toTaskId), val => {
    if (val === '') return;
    const n = parseInt(val, 10);
    if (Number.isFinite(n)) upd('toTaskId', n);
  });
  addColorRow(form, 'lineColor', link.lineColor, val => upd('lineColor', val));
  addSelectRow(form, 'lineStyle', link.lineStyle,
    LINK_LINE_STYLE_OPTIONS.map(o => ({ value: o, label: o })),
    val => upd('lineStyle', val));
  addSelectRow(form, 'routing', link.routing,
    LINK_ROUTING_OPTIONS.map(o => ({ value: o, label: o })),
    val => upd('routing', val));
}

// ── Pipes entity panel ─────────────────────────────────────────────────────────

function renderPipesPanel(area) {
  const pipes = projectData.pipes;
  let selectedId = entitySelections.pipes;
  if (selectedId !== null && !pipes.some(p => p.id === selectedId)) selectedId = null;
  if (selectedId === null && pipes.length > 0) selectedId = pipes[0].id;
  entitySelections.pipes = selectedId;

  const left  = area.querySelector('.entity-left');
  const right = area.querySelector('.entity-right');

  left.innerHTML = '';
  left.appendChild(renderSimpleEntityToolbar('pipe', 'pipes', pipes, selectedId));
  left.appendChild(renderPipesNavTable(selectedId));

  renderPipesForm(right, selectedId);
}

function renderPipesNavTable(selectedId) {
  const pipes = projectData.pipes;
  const table = document.createElement('table');
  table.className = 'entity-nav-table';
  const COLS = ['id', 'date', 'name', 'color', 'lineStyle', 'labelPosition'];

  let html = '<thead><tr>';
  COLS.forEach(c => { html += `<th>${c}</th>`; });
  html += '</tr></thead><tbody>';

  if (pipes.length === 0) {
    html += `<tr><td colspan="${COLS.length}" class="entity-empty">No pipes. Click Add to create one.</td></tr>`;
  } else {
    pipes.forEach(p => {
      const isSelected = p.id === selectedId;
      html += `<tr data-id="${p.id}"${isSelected ? ' class="selected"' : ''}>`;
      COLS.forEach(c => {
        const v = p[c] == null ? '' : p[c];
        html += `<td>${escapeHtml(String(v))}</td>`;
      });
      html += '</tr>';
    });
  }
  html += '</tbody></table>';
  table.innerHTML = html;

  attachNavTableRowHandlers(table, 'pipes');
  return table;
}

const PIPE_LINE_STYLE_OPTIONS = ['solid', 'dashed', 'dotted'];

function renderPipesForm(container, selectedId) {
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

  const pipe = projectData.pipes.find(p => p.id === selectedId);
  if (!pipe) { formRenderedForId = null; return; }

  const form = document.createElement('div');
  form.className = 'entity-form';
  container.appendChild(form);

  const upd = (field, value) => dispatch({ entity: 'pipe', action: 'update', id: pipe.id, field, value });

  addReadonlyRow(form, 'id', pipe.id);
  addDateRow(form, 'date', pipe.date, val => upd('date', val === '' ? null : val));
  addTextRow(form, 'name',  pipe.name,  val => upd('name',  val));
  addColorRow(form, 'color', pipe.color, val => upd('color', val));
  addSelectRow(form, 'lineStyle', pipe.lineStyle,
    PIPE_LINE_STYLE_OPTIONS.map(o => ({ value: o, label: o })),
    val => upd('lineStyle', val));
  addNumberRow(form, 'labelPosition', pipe.labelPosition, val => {
    const n = parseFloat(val);
    if (Number.isFinite(n)) upd('labelPosition', n);
  }, { step: '0.1', min: '0', max: '1' });
}

// ── Curtains entity panel ──────────────────────────────────────────────────────

function renderCurtainsPanel(area) {
  const curtains = projectData.curtains;
  let selectedId = entitySelections.curtains;
  if (selectedId !== null && !curtains.some(c => c.id === selectedId)) selectedId = null;
  if (selectedId === null && curtains.length > 0) selectedId = curtains[0].id;
  entitySelections.curtains = selectedId;

  const left  = area.querySelector('.entity-left');
  const right = area.querySelector('.entity-right');

  left.innerHTML = '';
  left.appendChild(renderSimpleEntityToolbar('curtain', 'curtains', curtains, selectedId));
  left.appendChild(renderCurtainsNavTable(selectedId));

  renderCurtainsForm(right, selectedId);
}

function renderCurtainsNavTable(selectedId) {
  const curtains = projectData.curtains;
  const table = document.createElement('table');
  table.className = 'entity-nav-table';
  const COLS = ['id', 'startDate', 'endDate', 'name', 'color', 'opacity', 'labelAnchor'];

  let html = '<thead><tr>';
  COLS.forEach(c => { html += `<th>${c}</th>`; });
  html += '</tr></thead><tbody>';

  if (curtains.length === 0) {
    html += `<tr><td colspan="${COLS.length}" class="entity-empty">No curtains. Click Add to create one.</td></tr>`;
  } else {
    curtains.forEach(cu => {
      const isSelected = cu.id === selectedId;
      html += `<tr data-id="${cu.id}"${isSelected ? ' class="selected"' : ''}>`;
      COLS.forEach(c => {
        const v = cu[c] == null ? '' : cu[c];
        html += `<td>${escapeHtml(String(v))}</td>`;
      });
      html += '</tr>';
    });
  }
  html += '</tbody></table>';
  table.innerHTML = html;

  attachNavTableRowHandlers(table, 'curtains');
  return table;
}

const CURTAIN_LABEL_ANCHOR_OPTIONS = ['start', 'end'];

function renderCurtainsForm(container, selectedId) {
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

  const cu = projectData.curtains.find(c => c.id === selectedId);
  if (!cu) { formRenderedForId = null; return; }

  const form = document.createElement('div');
  form.className = 'entity-form';
  container.appendChild(form);

  const upd = (field, value) => dispatch({ entity: 'curtain', action: 'update', id: cu.id, field, value });

  addReadonlyRow(form, 'id', cu.id);
  addDateRow(form, 'startDate', cu.startDate, val => upd('startDate', val === '' ? null : val));
  addDateRow(form, 'endDate',   cu.endDate,   val => upd('endDate',   val === '' ? null : val));
  addTextRow(form, 'name',  cu.name,  val => upd('name',  val));
  addColorRow(form, 'color', cu.color, val => upd('color', val));
  addNumberRow(form, 'opacity', cu.opacity, val => {
    const n = parseFloat(val);
    if (Number.isFinite(n)) upd('opacity', n);
  }, { step: '0.1', min: '0', max: '1' });
  addNumberRow(form, 'labelPosition', cu.labelPosition, val => {
    const n = parseFloat(val);
    if (Number.isFinite(n)) upd('labelPosition', n);
  }, { step: '0.1', min: '0', max: '1' });
  addSelectRow(form, 'labelAnchor', cu.labelAnchor,
    CURTAIN_LABEL_ANCHOR_OPTIONS.map(o => ({ value: o, label: o })),
    val => upd('labelAnchor', val));
}

// ── Notes entity panel ─────────────────────────────────────────────────────────

function renderNotesPanel(area) {
  const notes = projectData.notes;
  let selectedId = entitySelections.notes;
  if (selectedId !== null && !notes.some(n => n.id === selectedId)) selectedId = null;
  if (selectedId === null && notes.length > 0) selectedId = notes[0].id;
  entitySelections.notes = selectedId;

  const left  = area.querySelector('.entity-left');
  const right = area.querySelector('.entity-right');

  left.innerHTML = '';
  left.appendChild(renderSimpleEntityToolbar('note', 'notes', notes, selectedId));
  left.appendChild(renderNotesNavTable(selectedId));

  renderNotesForm(right, selectedId);
}

// Collapse any whitespace (newlines, tabs, runs of spaces) to single spaces so
// the nav-table preview reads as a single clean line regardless of how the
// source text is wrapped. Then 40-char truncate with ellipsis — matches the
// Issues tab's truncation convention.
function notePreviewText(text) {
  const collapsed = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (collapsed.length <= 40) return collapsed;
  return collapsed.slice(0, 39).trimEnd() + '…';
}

function renderNotesNavTable(selectedId) {
  const notes = projectData.notes;
  const table = document.createElement('table');
  table.className = 'entity-nav-table';
  const COLS = ['id', 'text'];

  let html = '<thead><tr>';
  COLS.forEach(c => { html += `<th>${c}</th>`; });
  html += '</tr></thead><tbody>';

  if (notes.length === 0) {
    html += `<tr><td colspan="${COLS.length}" class="entity-empty">No notes. Click Add to create one.</td></tr>`;
  } else {
    notes.forEach(n => {
      const isSelected = n.id === selectedId;
      const fullText   = String(n.text == null ? '' : n.text);
      const preview    = notePreviewText(n.text);
      html += `<tr data-id="${n.id}"${isSelected ? ' class="selected"' : ''}>`;
      html += `<td>${escapeHtml(String(n.id))}</td>`;
      html += `<td title="${escapeHtml(fullText)}">${escapeHtml(preview)}</td>`;
      html += '</tr>';
    });
  }
  html += '</tbody></table>';
  table.innerHTML = html;

  attachNavTableRowHandlers(table, 'notes');
  return table;
}

const NOTE_TEXT_ALIGN_OPTIONS     = ['left', 'center', 'right'];
const NOTE_VERTICAL_ALIGN_OPTIONS = ['top', 'middle', 'bottom'];

function renderNotesForm(container, selectedId) {
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

  const note = projectData.notes.find(n => n.id === selectedId);
  if (!note) { formRenderedForId = null; return; }

  const form = document.createElement('div');
  form.className = 'entity-form';
  container.appendChild(form);

  const upd = (field, value) => dispatch({ entity: 'note', action: 'update', id: note.id, field, value });
  const floatCommit = field => val => {
    const n = parseFloat(val);
    if (Number.isFinite(n)) upd(field, n);
  };

  addReadonlyRow(form, 'id', note.id);
  // xPct/yPct/widthPct/heightPct: no min/max — negative xPct/yPct legal per
  // §9.15 (partial overflow renders as-positioned); negative width/height is
  // accepted as input and surfaced by validation in the Issues tab.
  addNumberRow(form, 'xPct',      note.xPct,      floatCommit('xPct'),      { step: '1' });
  addNumberRow(form, 'yPct',      note.yPct,      floatCommit('yPct'),      { step: '1' });
  addNumberRow(form, 'widthPct',  note.widthPct,  floatCommit('widthPct'),  { step: '1' });
  addNumberRow(form, 'heightPct', note.heightPct, floatCommit('heightPct'), { step: '1' });
  addSelectRow(form, 'textAlign', note.textAlign,
    NOTE_TEXT_ALIGN_OPTIONS.map(o => ({ value: o, label: o })),
    val => upd('textAlign', val));
  addSelectRow(form, 'verticalAlign', note.verticalAlign,
    NOTE_VERTICAL_ALIGN_OPTIONS.map(o => ({ value: o, label: o })),
    val => upd('verticalAlign', val));
  // Empty string is legal and meaningful for both colors — suppresses the
  // border/fill rect in the renderer.
  addColorRow(form, 'borderColor', note.borderColor, val => upd('borderColor', val), { allowEmpty: true });
  addColorRow(form, 'fillColor',   note.fillColor,   val => upd('fillColor',   val), { allowEmpty: true });
  addTextareaRow(form, 'text', note.text, val => upd('text', val));
}

// Returns { setPreEditValue }. Only addColorRow uses it — to keep the
// Escape-to-revert target in sync after a sibling swatch commits a new value
// while the text input is focused. Other callers ignore the return value.
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
  return {
    setPreEditValue(val) { preEditValue = val; },
  };
}

// ── Config panel ───────────────────────────────────────────────────────────────
// Form-only — no nav table, no toolbar, no selection state. Seven sub-tabs
// correspond to the seven user-facing config blocks (config.rendering is
// deliberately excluded). Persistent-skeleton pattern mirrors renderDataPanel:
// the sub-tab strip and an outer area survive across same-block re-renders so
// commit-on-blur dispatches preserve focus inside the form.

const CONFIG_TABS = [
  { key: 'layout',      label: 'Layout'      },
  { key: 'bars',        label: 'Bars'        },
  { key: 'timeline',    label: 'Timeline'    },
  { key: 'titles',      label: 'Titles'      },
  { key: 'style',       label: 'Style'       },
  { key: 'typography',  label: 'Typography'  },
  { key: 'preferences', label: 'Preferences' },
];

const MILESTONE_SHAPE_OPTIONS = ['diamond', 'circle'];
const HEADER_FOOTER_TEXT_ALIGN_OPTIONS = ['left', 'center', 'right'];

function renderConfigPanel(panel) {
  let strip = document.getElementById('configTabStrip');
  let area  = document.getElementById('configArea');
  if (!strip || !area) {
    panel.innerHTML = '<div id="configTabStrip" class="entity-tabs"></div><div id="configArea"></div>';
    strip = document.getElementById('configTabStrip');
    area  = document.getElementById('configArea');
  }

  buildConfigTabStrip(strip);

  if (area.dataset.block !== activeConfigBlock) {
    area.dataset.block = activeConfigBlock;
    area.innerHTML = '<div class="config-panel"><div class="config-form-container"></div></div>';
    configBlockRenderedFor = null;
  }

  const container = area.querySelector('.config-form-container');
  if (activeConfigBlock === 'layout')      renderLayoutConfigForm(container);
  if (activeConfigBlock === 'bars')        renderBarsConfigForm(container);
  if (activeConfigBlock === 'timeline')    renderTimelineConfigForm(container);
  if (activeConfigBlock === 'titles')      renderTitlesConfigForm(container);
  if (activeConfigBlock === 'style')       renderStyleConfigForm(container);
  if (activeConfigBlock === 'typography')  renderTypographyConfigForm(container);
  if (activeConfigBlock === 'preferences') renderPreferencesConfigForm(container);
}

function buildConfigTabStrip(strip) {
  strip.innerHTML = '';
  CONFIG_TABS.forEach(t => {
    const btn = document.createElement('button');
    btn.className = 'entity-tab' + (t.key === activeConfigBlock ? ' active' : '');
    btn.textContent = t.label;
    btn.addEventListener('click', () => {
      if (activeConfigBlock === t.key) return;
      activeConfigBlock = t.key;
      renderConfigPanel(document.getElementById('configPanel'));
    });
    strip.appendChild(btn);
  });
}

// Integer commit: empty → null, NaN → no-op (input keeps user's garbage until next rebuild).
function commitInt(upd, field) {
  return val => {
    if (val === '') { upd(field, null); return; }
    const n = parseInt(val, 10);
    if (Number.isFinite(n)) upd(field, n);
  };
}

// Float commit: empty → null, NaN → no-op.
function commitFloat(upd, field) {
  return val => {
    if (val === '') { upd(field, null); return; }
    const n = parseFloat(val);
    if (Number.isFinite(n)) upd(field, n);
  };
}

function renderLayoutConfigForm(container) {
  if (configBlockRenderedFor === 'layout' && container.childElementCount > 0) return;
  configBlockRenderedFor = 'layout';
  container.innerHTML = '';

  const form = document.createElement('div');
  form.className = 'entity-form';
  container.appendChild(form);

  const layout = projectData.config.layout;
  const upd = (field, value) =>
    dispatch({ entity: 'config', action: 'update', block: 'layout', field, value });

  addNumberRow(form, 'outerWidth',      layout.outerWidth,      commitInt(upd, 'outerWidth'));
  addNumberRow(form, 'outerHeight',     layout.outerHeight,     commitInt(upd, 'outerHeight'));
  addNumberRow(form, 'paddingTop',      layout.paddingTop,      commitInt(upd, 'paddingTop'));
  addNumberRow(form, 'paddingRight',    layout.paddingRight,    commitInt(upd, 'paddingRight'));
  addNumberRow(form, 'paddingBottom',   layout.paddingBottom,   commitInt(upd, 'paddingBottom'));
  addNumberRow(form, 'paddingLeft',     layout.paddingLeft,     commitInt(upd, 'paddingLeft'));
  addCheckboxRow(form, 'showRowDividers', layout.showRowDividers, val => upd('showRowDividers', val));
}

function renderBarsConfigForm(container) {
  if (configBlockRenderedFor === 'bars' && container.childElementCount > 0) return;
  configBlockRenderedFor = 'bars';
  container.innerHTML = '';

  const form = document.createElement('div');
  form.className = 'entity-form';
  container.appendChild(form);

  const bars = projectData.config.bars;
  const upd = (field, value) =>
    dispatch({ entity: 'config', action: 'update', block: 'bars', field, value });

  addNumberRow(form, 'taskBarHeightFactor',   bars.taskBarHeightFactor,   commitFloat(upd, 'taskBarHeightFactor'),   { step: '0.1' });
  addNumberRow(form, 'milestoneSizeFactor',   bars.milestoneSizeFactor,   commitFloat(upd, 'milestoneSizeFactor'),   { step: '0.1' });
  addNumberRow(form, 'taskCornerRadius',      bars.taskCornerRadius,      commitInt  (upd, 'taskCornerRadius'));
  addSelectRow(form, 'milestoneShape',        bars.milestoneShape,
    MILESTONE_SHAPE_OPTIONS.map(o => ({ value: o, label: o })),
    val => upd('milestoneShape', val));
  addNumberRow(form, 'milestoneCornerRadius', bars.milestoneCornerRadius, commitFloat(upd, 'milestoneCornerRadius'), { step: '0.1' });
}

function renderTimelineConfigForm(container) {
  if (configBlockRenderedFor === 'timeline' && container.childElementCount > 0) return;
  configBlockRenderedFor = 'timeline';
  container.innerHTML = '';

  const form = document.createElement('div');
  form.className = 'entity-form';
  container.appendChild(form);

  const timeline = projectData.config.timeline;
  const upd = (field, value) =>
    dispatch({ entity: 'config', action: 'update', block: 'timeline', field, value });

  // Date fields commit twice: the value, then the paired *Explicit flag.
  // The writer round-trips empty (explicit=false) as "auto-derive from tasks",
  // and non-empty (explicit=true) as the user's authoritative value. The flags
  // are derived state — not user-editable, not rendered as rows.
  addDateRow(form, 'chartStartDate', timeline.chartStartDate, val => {
    if (val === '') {
      upd('chartStartDate', null);
      upd('chartStartDateExplicit', false);
    } else {
      upd('chartStartDate', val);
      upd('chartStartDateExplicit', true);
    }
  });
  addDateRow(form, 'chartEndDate', timeline.chartEndDate, val => {
    if (val === '') {
      upd('chartEndDate', null);
      upd('chartEndDateExplicit', false);
    } else {
      upd('chartEndDate', val);
      upd('chartEndDateExplicit', true);
    }
  });

  addCheckboxRow(form, 'showYears',  timeline.showYears,  val => upd('showYears',  val));
  addCheckboxRow(form, 'showMonths', timeline.showMonths, val => upd('showMonths', val));
  addCheckboxRow(form, 'showWeeks',  timeline.showWeeks,  val => upd('showWeeks',  val));
  addCheckboxRow(form, 'showDays',   timeline.showDays,   val => upd('showDays',   val));
  addCheckboxRow(form, 'showDates',  timeline.showDates,  val => upd('showDates',  val));
  addCheckboxRow(form, 'gridlineYears',  timeline.gridlineYears,  val => upd('gridlineYears',  val));
  addCheckboxRow(form, 'gridlineMonths', timeline.gridlineMonths, val => upd('gridlineMonths', val));
  addCheckboxRow(form, 'gridlineWeeks',  timeline.gridlineWeeks,  val => upd('gridlineWeeks',  val));
  addCheckboxRow(form, 'gridlineDays',   timeline.gridlineDays,   val => upd('gridlineDays',   val));
}

function renderTitlesConfigForm(container) {
  if (configBlockRenderedFor === 'titles' && container.childElementCount > 0) return;
  configBlockRenderedFor = 'titles';
  container.innerHTML = '';

  const form = document.createElement('div');
  form.className = 'entity-form';
  container.appendChild(form);

  const titles = projectData.config.titles;
  const upd = (field, value) =>
    dispatch({ entity: 'config', action: 'update', block: 'titles', field, value });

  addNumberRow(form, 'headerHeight',    titles.headerHeight,    commitInt(upd, 'headerHeight'));
  addTextRow  (form, 'headerText',      titles.headerText,      val => upd('headerText', val));
  addSelectRow(form, 'headerTextAlign', titles.headerTextAlign,
    HEADER_FOOTER_TEXT_ALIGN_OPTIONS.map(o => ({ value: o, label: o })),
    val => upd('headerTextAlign', val));
  addNumberRow(form, 'footerHeight',    titles.footerHeight,    commitInt(upd, 'footerHeight'));
  addTextRow  (form, 'footerText',      titles.footerText,      val => upd('footerText', val));
  addSelectRow(form, 'footerTextAlign', titles.footerTextAlign,
    HEADER_FOOTER_TEXT_ALIGN_OPTIONS.map(o => ({ value: o, label: o })),
    val => upd('footerTextAlign', val));
}

function renderStyleConfigForm(container) {
  if (configBlockRenderedFor === 'style' && container.childElementCount > 0) return;
  configBlockRenderedFor = 'style';
  container.innerHTML = '';

  const form = document.createElement('div');
  form.className = 'entity-form';
  container.appendChild(form);

  const style = projectData.config.style;
  const upd = (field, value) =>
    dispatch({ entity: 'config', action: 'update', block: 'style', field, value });

  const STYLE_FIELDS = [
    'chartBackgroundColor', 'headerFooterBackgroundColor', 'headerFooterBorderColor',
    'headerFooterTextColor', 'swimlaneLabelColor', 'swimlaneDividerColor',
    'scaleBackgroundColor', 'scaleTickColor', 'scaleLabelTextColor',
    'gridlineVerticalColor', 'taskStrokeColor', 'milestoneStrokeColor',
    'outsideLabelTextColor', 'leaderLineColor', 'insideLabelTextColor',
    'noteTextColor',
  ];
  STYLE_FIELDS.forEach(f => addColorRow(form, f, style[f], val => upd(f, val)));
}

function renderTypographyConfigForm(container) {
  if (configBlockRenderedFor === 'typography' && container.childElementCount > 0) return;
  configBlockRenderedFor = 'typography';
  container.innerHTML = '';

  const form = document.createElement('div');
  form.className = 'entity-form';
  container.appendChild(form);

  const typo = projectData.config.typography;
  const upd = (field, value) =>
    dispatch({ entity: 'config', action: 'update', block: 'typography', field, value });

  addTextRow(form, 'fontFamily', typo.fontFamily, val => upd('fontFamily', val));

  const FONT_SIZE_FIELDS = [
    'taskFontSize', 'scaleFontSize', 'headerFooterFontSize', 'noteFontSize',
    'swimlaneFontSize', 'pipeFontSize', 'curtainFontSize',
  ];
  FONT_SIZE_FIELDS.forEach(f => addNumberRow(form, f, typo[f], commitInt(upd, f)));

  const ALIGNMENT_FACTOR_FIELDS = [
    'scaleAlignmentFactor', 'taskAlignmentFactor', 'headerFooterAlignmentFactor',
    'pipeAlignmentFactor', 'curtainAlignmentFactor', 'noteAlignmentFactor',
    'swimlaneTopAlignmentFactor', 'swimlaneBottomAlignmentFactor',
  ];
  ALIGNMENT_FACTOR_FIELDS.forEach(f =>
    addNumberRow(form, f, typo[f], commitFloat(upd, f), { step: '0.1' }));
}

function renderPreferencesConfigForm(container) {
  if (configBlockRenderedFor === 'preferences' && container.childElementCount > 0) return;
  configBlockRenderedFor = 'preferences';
  container.innerHTML = '';

  const form = document.createElement('div');
  form.className = 'entity-form';
  container.appendChild(form);

  const prefs = projectData.config.preferences;
  const upd = (field, value) =>
    dispatch({ entity: 'config', action: 'update', block: 'preferences', field, value });

  addTextRow(form, 'uiDateFormat',    prefs.uiDateFormat,    val => upd('uiDateFormat',    val));
  addTextRow(form, 'chartDateFormat', prefs.chartDateFormat, val => upd('chartDateFormat', val));
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
  document.getElementById('tabConfig').addEventListener('click',    () => activateTab('config'));
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
      if (document.getElementById('tabConfig').classList.contains('active')) {
        renderConfigPanel(document.getElementById('configPanel'));
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
