// ui.js — UI entry point; owns the live projectData reference for the current session

let projectData = createEmptyProjectData();
let loadedFilename = null;
// Last status-line prefix ("Loaded: <name>" / "New project"), remembered so the
// status bar can be recomposed (e.g. after baseline load/clear) without the
// caller re-supplying it. null until the first file-load / New Project.
let lastStatusPrefix = null;
// Active top-level tab. Single source of truth — set by activateTab, read by the
// dispatcher's post-mutation hook to know which panel to re-render.
let activeTab = 'data';

// Chart-tab baseline overlay visibility. Transient (never written to the workbook):
// a non-destructive view toggle over the baseline overlay, distinct from Clear
// Baseline. Reset to true on file-load / New Project (via resetDataPanelState)
// and on baseline load, so a toggled-off state never carries into a new project.
let showBaseline = true;

// Chart-tab "only moved" baseline filter. Transient (never written to the
// workbook): an opt-in view filter that hides baselines whose dates match the
// live task's (zero delta). Reset to false on file-load / New Project (via
// resetDataPanelState).
let showOnlyMoved = false;

// Data-panel state — second-tier entity tab, per-entity selection, and the
// transient next-selection-intent used by toolbar actions and row clicks to
// communicate the intended post-mutation selection to renderDataPanel.
// formRenderedForId is the id the edit form was last built from; the form is
// only rebuilt when this changes, so commit-on-blur preserves user focus.
let activeEntityTab = 'tasks';
let entitySelections = { tasks: null, swimlanes: null, links: null, pipes: null, curtains: null, notes: null };
let nextSelectionIntent = null;
let formRenderedForId = null;
// The nav-table cell currently being inline-edited, or null. Drives the editor
// vs text rendering in renderTasksNavTable; cleared on commit/cancel.
let editingCell = null;

// Registry for the four shared-handler entities (Links / Pipes / Curtains /
// Notes), keyed by plural. Each entry maps to its singular name, a getter for
// its live array (a getter — not a captured reference — because projectData is
// replaced wholesale on file load / New Project), and its form renderer. Drives
// selectSimpleEntity's parameterised fast path. (Inline cell editing is no
// longer driven from here — see INLINE_EDIT_REGISTRY / attachInlineEditor.)
const SIMPLE_ENTITY_REGISTRY = {
  links:    { singular: 'link',    arr: () => projectData.links,    renderForm: renderLinksForm },
  pipes:    { singular: 'pipe',    arr: () => projectData.pipes,    renderForm: renderPipesForm },
  curtains: { singular: 'curtain', arr: () => projectData.curtains, renderForm: renderCurtainsForm },
  notes:    { singular: 'note',    arr: () => projectData.notes,    renderForm: renderNotesForm },
};

// Registry for inline nav-cell editing, keyed by SINGULAR entity (matching
// editingCell.entity and the dispatch entity, so the mount code needs no
// plural↔singular translation). `arr` is a getter — not a captured reference —
// because projectData is replaced wholesale on file load / New Project. `fields`
// maps each inline-editable field to its editor type ('text' | 'date' | 'select').
// A 'select' field also needs an `options` getter `(field, obj) => [{value,label}]`
// supplying the dropdown contents (so attachInlineEditor stays generic and a
// future select field — e.g. an inline Tasks swimlaneId — can reuse the type);
// Links' FKs use buildTaskRefOptions. Tasks and Swimlanes have bespoke
// (non-shared) row handlers, so they live here rather than in
// SIMPLE_ENTITY_REGISTRY; Notes is deliberately absent (multi-line text needs a
// textarea) — attachInlineEditor is inert for any entity not listed.
const INLINE_EDIT_REGISTRY = {
  task:     { arr: () => projectData.tasks,     fields: { name: 'text', startDate: 'date', finishDate: 'date' } },
  swimlane: { arr: () => projectData.swimlanes, fields: { name: 'text' } },
  link:     { arr: () => projectData.links,     fields: { fromTaskId: 'select', toTaskId: 'select' },
              options: (field, obj) => buildTaskRefOptions(obj[field]) },
  pipe:     { arr: () => projectData.pipes,     fields: { name: 'text', date: 'date' } },
  curtain:  { arr: () => projectData.curtains,  fields: { name: 'text', startDate: 'date', endDate: 'date' } },
};

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
  editingCell        = null;
  activeConfigBlock       = 'layout';
  configBlockRenderedFor  = null;
  showBaseline            = true;
  showOnlyMoved           = false;
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

  ['data', 'chart', 'issues', 'config', 'inspector'].forEach(n => {
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
    renderChartPanel();
  }

  if (name === 'config') {
    renderConfigPanel(document.getElementById('configPanel'));
  }

  if (name === 'inspector') {
    renderInspector(document.getElementById('inspectorPanel'));
  }
}

// ── Chart panel renderer ───────────────────────────────────────────────────────
// "No project loaded" when there are no tasks; otherwise a fixed control strip
// ("Show baseline" and "Only moved" checkboxes, present only when a baseline
// exists) above the chart SVG, which lives in an inner .chart-scroll container
// so the control strip stays put as the chart scrolls. Called on chart-tab
// activation and re-entrantly by the checkbox listeners; the showBaseline and
// showOnlyMoved flags flow into renderChart and the Save SVG export so screen
// and file stay WYSIWYG.
function renderChartPanel() {
  const panel = document.getElementById('chartPanel');
  if (projectData.tasks.length === 0) {
    panel.innerHTML = '<p>No project loaded</p>';
    return;
  }

  const hasBaseline = projectData.baseline.length > 0;
  const controlRow = hasBaseline
    ? `<div class="chart-controls">`
      + `<label><input type="checkbox" id="showBaselineToggle"${showBaseline ? ' checked' : ''}> Show baseline</label>`
      + `<label><input type="checkbox" id="showOnlyMovedToggle"${showOnlyMoved ? ' checked' : ''}> Only moved</label>`
      + `</div>`
    : '';
  panel.innerHTML = `${controlRow}<div class="chart-scroll">${renderChart(projectData, { showBaseline, showOnlyMoved })}</div>`;

  const toggle = document.getElementById('showBaselineToggle');
  if (toggle) {
    toggle.addEventListener('change', function(e) {
      showBaseline = e.target.checked;
      renderChartPanel();
    });
  }

  const onlyMovedToggle = document.getElementById('showOnlyMovedToggle');
  if (onlyMovedToggle) {
    onlyMovedToggle.addEventListener('change', function(e) {
      showOnlyMoved = e.target.checked;
      renderChartPanel();
    });
  }
}

// ── Data panel renderer ────────────────────────────────────────────────────────
// Renders the second-tier entity tab strip and the active entity tab's panel.
// Called on Data-tab activation (including dispatcher-triggered re-renders via
// runPostMutationHook) and from the file-load / New-Project handlers.
// Tasks tab is fully implemented in slice 2a; other five tabs are stubs.

const ENTITY_TABS = [
  { key: 'swimlanes', label: 'Swimlanes' },
  { key: 'tasks',     label: 'Tasks'     },
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

  // Drop a stale inline-edit marker if its task no longer exists (e.g. deleted
  // out from under an open editor) so the mount block below never targets it.
  // Entity-scoped: a swimlane marker is left alone here.
  if (editingCell && editingCell.entity === 'task' &&
      !tasks.some(t => t.id === editingCell.id)) editingCell = null;

  const left  = area.querySelector('.entity-left');
  const right = area.querySelector('.entity-right');

  // Left pane (toolbar + nav table) is rebuilt every render. It now hosts a
  // focusable inline-edit input, so preserve the scroll container's position
  // across the rebuild (no-op on a freshly created pane where scrollTop is 0).
  const prevScroll = left.scrollTop;
  left.innerHTML = '';
  left.appendChild(renderTasksToolbar(selectedId));
  left.appendChild(renderTasksNavTable(selectedId));
  left.scrollTop = prevScroll;

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
    btnDelete.title = btnDuplicate.title = btnMoveUp.title = btnMoveDown.title = 'No row selected';
  } else {
    // Delete is always allowed for a selected task (referential integrity for
    // link FKs is advisory, not enforced — a deleted task's links orphan and
    // are flagged by validation, the renderer skips them, and the user
    // re-points / clears / deletes the link). "No row selected" above is the
    // only Delete disable, matching the simple-entity tabs.
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
      // Tooltip text splits on whether row is numeric: a null/non-numeric row
      // isn't "at an edge", it's missing — parallels the 'Task has no swimlane' case.
      if (!(typeof task.row === 'number' && task.row > 1)) {
        btnMoveUp.disabled = true;
        btnMoveUp.title = typeof task.row === 'number' ? 'Already at top of swimlane' : 'Task has no row';
      }
      if (!(typeof task.row === 'number' && task.row < swimlane.rowCount)) {
        btnMoveDown.disabled = true;
        btnMoveDown.title = typeof task.row === 'number' ? 'Already at bottom of swimlane' : 'Task has no row';
      }
    }
  }

  btnAdd.addEventListener('click', () => {
    const newId = predictId('task');
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
    const newId = predictId('task');
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

// Sorted display order for the Tasks navigation table. Returns a shallow copy
// of projectData.tasks; the array itself is never mutated (array order remains
// under user control via the Excel sheet / writer round-trip).
// Key: (swimlane.order, task.row, finishDate, startDate, originalIndex), all
// ascending. Orphan tasks (no matching swimlane) sort to the end; within any
// group, null/undefined task.row and null/empty dates sort after their
// well-typed counterparts. Sentinels (Infinity for numbers, '￿' for
// dates — sorts after any YYYY-MM-DD string) make the comparator
// straightforward without tripping JS's null/undefined-vs-number quirks.
function buildTasksDisplayOrder() {
  const tasks = projectData.tasks;
  const swimlaneOrderById = new Map();
  projectData.swimlanes.forEach(s => swimlaneOrderById.set(s.id, s.order));
  const decorated = tasks.map((t, i) => ({
    task:       t,
    swOrder:    swimlaneOrderById.has(t.swimlaneId) ? swimlaneOrderById.get(t.swimlaneId) : Infinity,
    rowKey:     (typeof t.row === 'number' && Number.isFinite(t.row)) ? t.row : Infinity,
    finishKey:  (typeof t.finishDate === 'string' && t.finishDate !== '') ? t.finishDate : '￿',
    startKey:   (typeof t.startDate  === 'string' && t.startDate  !== '') ? t.startDate  : '￿',
    index:      i,
  }));
  decorated.sort((a, b) => {
    if (a.swOrder    !== b.swOrder)    return a.swOrder - b.swOrder;
    if (a.rowKey     !== b.rowKey)     return a.rowKey  - b.rowKey;
    if (a.finishKey  !== b.finishKey)  return a.finishKey < b.finishKey ? -1 : 1;
    if (a.startKey   !== b.startKey)   return a.startKey  < b.startKey  ? -1 : 1;
    return a.index - b.index;
  });
  return decorated.map(d => d.task);
}

function formatNavTableDateCell(iso) {
  return toLocaleDateDisplay(iso);
}

// Integer calendar-day span (finishDate − startDate), or null when either date is
// missing/empty or the pair is non-finite (malformed but non-empty). Negative spans
// pass through literally; milestones yield 0.
function taskDays(t) {
  if (t.startDate == null || t.startDate === '' || t.finishDate == null || t.finishDate === '') return null;
  const d = daysBetween(t.startDate, t.finishDate);
  return Number.isFinite(d) ? d : null;
}

// Symbol-column bar geometry. SYMBOL_COL_WIDTH_PX must match the .task-symbol-col
// CSS width in index.html; the usable bar range is that minus end padding on each side.
const SYMBOL_COL_WIDTH_PX = 64;
const SYMBOL_END_PADDING_PX = 5;
const BAR_MIN_WIDTH_PX = 10;
const BAR_MAX_WIDTH_PX = SYMBOL_COL_WIDTH_PX - 2 * SYMBOL_END_PADDING_PX; // 54

// Bar width proportional to positive duration, scaled linearly against maxDays (the
// largest positive span among bar tasks in the table). Unified minWidth guard collapses
// every degenerate case — missing/non-finite span, span ≤ 0 (incl. negative), or no
// positive-duration bars anywhere (maxDays ≤ 0) — to BAR_MIN_WIDTH_PX.
function computeBarWidth(t, maxDays) {
  const d = taskDays(t);
  if (d == null || d <= 0 || maxDays <= 0) return BAR_MIN_WIDTH_PX;
  return Math.round(BAR_MIN_WIDTH_PX + (d / maxDays) * (BAR_MAX_WIDTH_PX - BAR_MIN_WIDTH_PX));
}

// Small CSS-drawn marker for the symbol column: a rotated square (diamond) for
// milestones, a duration-proportional rectangle for bars. Fill = task.fillColor;
// task.fillPattern is intentionally ignored (solid only — patterns are chart-only).
function taskSymbolMarkup(t, barWidth) {
  const bg = escapeHtml(String(t.fillColor));
  if (t.isMilestone) {
    return `<span class="task-symbol task-symbol-milestone" style="background:${bg}"></span>`;
  }
  return `<span class="task-symbol task-symbol-bar" style="width:${barWidth}px;background:${bg}"></span>`;
}

function renderTasksNavTable(selectedId) {
  const sortedTasks = buildTasksDisplayOrder();
  const table = document.createElement('table');
  table.className = 'entity-nav-table';
  const COLS = ['id', 'symbol', 'name', 'startDate', 'finishDate'];

  // Bucket the cascade-sorted tasks by swimlane, preserving order. Defined
  // swimlanes get their own bucket; tasks with a null/empty swimlaneId go to
  // Unassigned; a non-empty swimlaneId with no matching swimlane goes to
  // Misassigned.
  const definedIds = new Set(projectData.swimlanes.map(s => s.id));
  const bySwimlane = new Map();
  const unassigned = [];
  const misassigned = [];
  sortedTasks.forEach(t => {
    if (t.swimlaneId == null || t.swimlaneId === '') {
      unassigned.push(t);
    } else if (definedIds.has(t.swimlaneId)) {
      if (!bySwimlane.has(t.swimlaneId)) bySwimlane.set(t.swimlaneId, []);
      bySwimlane.get(t.swimlaneId).push(t);
    } else {
      misassigned.push(t);
    }
  });

  // Pre-pass: largest positive span among bar (non-milestone) tasks — the proportional
  // scaling basis. Milestones are excluded; non-finite/non-positive spans don't raise it.
  let maxDays = 0;
  sortedTasks.forEach(t => {
    if (t.isMilestone) return;
    const d = taskDays(t);
    if (d != null && d > maxDays) maxDays = d;
  });

  let html = '<thead><tr>';
  COLS.forEach(c => {
    if (c === 'symbol') html += '<th class="task-symbol-col">symbol</th>';
    else                html += `<th>${c}</th>`;
  });
  html += '</tr></thead><tbody>';

  if (sortedTasks.length === 0) {
    html += `<tr><td colspan="${COLS.length}" class="entity-empty">No tasks. Click Add to create one.</td></tr>`;
  } else {
    const groupHeader = label =>
      `<tr class="entity-nav-table-group-header"><td colspan="${COLS.length}">${escapeHtml(String(label))}</td></tr>`;

    const dataRow = (t, isChartRowStart) => {
      const isSelected = t.id === selectedId;
      const sw = projectData.swimlanes.find(s => s.id === t.swimlaneId);
      const symbolBg = sw ? ` style="background:${escapeHtml(String(sw.backgroundColor))}"` : '';
      const cls = [isSelected ? 'selected' : '', isChartRowStart ? 'chart-row-start' : ''].filter(Boolean).join(' ');
      let row = `<tr data-id="${t.id}"${cls ? ` class="${cls}"` : ''}>`;
      COLS.forEach(c => {
        if (c === 'symbol')                          row += `<td class="task-symbol-col"${symbolBg}>${taskSymbolMarkup(t, computeBarWidth(t, maxDays))}</td>`;
        else if (c === 'startDate' || c === 'finishDate') row += `<td data-field="${c}">${escapeHtml(formatNavTableDateCell(t[c]))}</td>`;
        else if (c === 'name')                       row += `<td data-field="name">${escapeHtml(String(t.name == null ? '' : t.name))}</td>`;
        else                                         row += `<td>${escapeHtml(String(t[c] == null ? '' : t[c]))}</td>`;
      });
      return row + '</tr>';
    };

    // Emit a bucket's tasks, marking each chart-row boundary: a task is the start
    // of a new chart-row group when it is NOT the first in the bucket AND its row
    // differs from the previous task's row (null === null, so null-row tasks
    // cluster together with a single divider above them).
    const emitBucket = tasks => {
      let prevRow;
      tasks.forEach((t, i) => {
        const isChartRowStart = i > 0 && t.row !== prevRow;
        html += dataRow(t, isChartRowStart);
        prevRow = t.row;
      });
    };

    // Defined swimlanes first, in swimlane.order sequence (array order).
    // Headers render even when the bucket is empty.
    projectData.swimlanes.forEach(s => {
      html += groupHeader(s.name);
      emitBucket(bySwimlane.get(s.id) || []);
    });
    // Synthetic groups, only when populated.
    if (unassigned.length)  { html += groupHeader('Unassigned');  emitBucket(unassigned); }
    if (misassigned.length) { html += groupHeader('Misassigned'); emitBucket(misassigned); }
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
      // An active editor counts as mid-edit whether it's a right-pane form input
      // or our inline nav-cell editor — the only focusable thing inside
      // .entity-nav-table is .nav-cell-input, so this cleanly detects either.
      const active = document.activeElement;
      const inEdit = active && active.closest &&
                     (active.closest('.entity-form') || active.closest('.entity-nav-table'));
      if (inEdit) {
        // Commit-on-blur path: a focused form OR inline editor must commit before
        // selection moves; the dispatch's post-hook render consumes this intent.
        nextSelectionIntent = { entity: 'tasks', id: taskId };
        active.blur();
      } else {
        // Pure selection: non-destructive, preserves nav-table scroll + DOM.
        selectTask(taskId);
      }
    });
  });

  attachInlineEditor(table, 'task');

  return table;
}

// Non-destructive Tasks selection: updates selection state, highlight, toolbar,
// and form in place WITHOUT rebuilding the nav table, so the scroll container's
// scrollTop and the row DOM survive. Called only for a pure row-click when no
// form input is mid-edit (the commit-on-blur path is handled in the listener).
function selectTask(taskId) {
  if (taskId === entitySelections.tasks) return;
  const area = document.getElementById('entityArea');
  if (!area) return;
  const left  = area.querySelector('.entity-left');
  const right = area.querySelector('.entity-right');
  if (!left || !right) return;

  // selectTask is authoritative for selection, so any pending intent left by a
  // silent dispatch no-op is now obsolete — clear it so the next full render
  // can't override the row the user just clicked.
  nextSelectionIntent = null;
  entitySelections.tasks = taskId;

  // Highlight: move .selected from the old row to the clicked row.
  const prev = left.querySelector('tbody tr.selected');
  if (prev) prev.classList.remove('selected');
  const next = left.querySelector('tbody tr[data-id="' + String(taskId) + '"]');
  if (next) next.classList.add('selected');

  // Toolbar rebuilt in place — button enablement is selection-dependent.
  // Replacing the toolbar element leaves the nav-table sibling untouched, so
  // scrollTop is preserved.
  const oldToolbar = left.querySelector('.entity-toolbar');
  if (oldToolbar) left.replaceChild(renderTasksToolbar(taskId), oldToolbar);

  // Form rebuilds because the id changed (renderTasksForm's same-id guard).
  renderTasksForm(right, taskId);
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
  addReadonlyRow(form, 'calendarDays', taskDays(task), ' (derived)');
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
  addColorRow(form, 'labelColor', task.labelColor, val => upd('labelColor', val), { allowEmpty: true });
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

  // A native <input type="color"> always paints a filled well (#000000 when
  // "empty"), which misreads as a deliberate black choice. On the allowEmpty
  // path only, mark the genuinely-empty state (null or '' — a typed-but-invalid
  // value still counts as set) so the stylesheet can give the well a neutral
  // "no color set" look. Non-allowEmpty rows never get the class.
  const applyUnsetState = (val) => {
    if (!allowEmpty) return;
    swatch.classList.toggle('is-unset', val == null || val === '');
  };
  applyUnsetState(initialStr);

  const handle = attachCommitHandlers(input, () => input.value, val => {
    commitFn(val);
    const hex = parseTextToHex6(val);
    if (hex !== null) swatch.value = hex;
    applyUnsetState(val);
  });

  swatch.addEventListener('change', () => {
    const hex = swatch.value;
    input.value = hex;
    handle.setPreEditValue(hex);
    commitFn(hex);
    applyUnsetState(hex);
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
      applyUnsetState('');
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
  // opts.decimals (opt-in): format the DISPLAYED value to a fixed number of
  // decimals so finer precision is discoverable. Display-only — never alters
  // the stored value or commit/parse behaviour. Non-finite/null → blank input.
  if (o.decimals != null) {
    const n = Number(value);
    input.value = (value == null || value === '' || !Number.isFinite(n))
      ? ''
      : n.toFixed(o.decimals);
  } else {
    input.value = value == null ? '' : String(value);
  }
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
  // Suppressed when the options already supply a '' option (e.g. the FK builder's
  // clear option doubles as the placeholder), so there's never a duplicate.
  if ((value === null || value === undefined) && !options.some(o => o.value === '')) {
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

  // Drop a stale inline-edit marker if its swimlane no longer exists (e.g.
  // deleted out from under an open editor) so the mount block never targets it.
  // Entity-scoped: a task marker is left alone here.
  if (editingCell && editingCell.entity === 'swimlane' &&
      !swimlanes.some(s => s.id === editingCell.id)) editingCell = null;

  const left  = area.querySelector('.entity-left');
  const right = area.querySelector('.entity-right');

  // Left pane now hosts a focusable inline-edit input, so preserve the scroll
  // container's position across the rebuild (no-op on a freshly created pane).
  const prevScroll = left.scrollTop;
  left.innerHTML = '';
  left.appendChild(renderSwimlanesToolbar(selectedId));
  left.appendChild(renderSwimlanesNavTable(selectedId));
  left.scrollTop = prevScroll;

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
    btnDelete.title = btnDuplicate.title = btnMoveUp.title = btnMoveDown.title = 'No row selected';
  } else {
    if (idx === 0)                    { btnMoveUp.disabled   = true; btnMoveUp.title   = 'Already at top';    }
    if (idx === swimlanes.length - 1) { btnMoveDown.disabled = true; btnMoveDown.title = 'Already at bottom'; }
  }

  btnAdd.addEventListener('click', () => {
    const newId = predictId('swimlane');
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
    const newId = predictId('swimlane');
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
  // Per-column emission (not a generic loop): the color column is text-free and
  // style-bearing, and rowCount carries alignment classes on header + data cells.
  const COLS = ['id', 'color', 'name', 'rowCount'];
  const COL_COUNT = COLS.length;

  const headerCell = c => {
    if (c === 'rowCount') return '<th class="swimlane-rowcount-col">rowCount</th>';
    if (c === 'color')    return '<th>color</th>';
    return `<th>${c}</th>`;
  };

  let html = '<thead><tr>';
  COLS.forEach(c => { html += headerCell(c); });
  html += '</tr></thead><tbody>';

  if (swimlanes.length === 0) {
    html += `<tr><td colspan="${COL_COUNT}" class="entity-empty">No swimlanes. Click Add to create one.</td></tr>`;
  } else {
    swimlanes.forEach(s => {
      const isSelected = s.id === selectedId;
      // Raw stored backgroundColor as the cell background; browser judges validity.
      // Always emitted (the field is always present); empty/invalid/null → no-op.
      const colorBg = ` style="background:${escapeHtml(String(s.backgroundColor))}"`;
      html += `<tr data-id="${s.id}"${isSelected ? ' class="selected"' : ''}>`;
      COLS.forEach(c => {
        if (c === 'color')         html += `<td${colorBg}></td>`;
        else if (c === 'rowCount') html += `<td class="swimlane-rowcount-col">${escapeHtml(String(s.rowCount == null ? '' : s.rowCount))}</td>`;
        else if (c === 'name')     html += `<td data-field="name">${escapeHtml(String(s.name == null ? '' : s.name))}</td>`;
        else                       html += `<td>${escapeHtml(String(s[c] == null ? '' : s[c]))}</td>`;
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
      // An active editor counts as mid-edit whether it's a right-pane form input
      // or our inline nav-cell editor — the only focusable thing inside
      // .entity-nav-table is .nav-cell-input, so this cleanly detects either.
      const active = document.activeElement;
      const inEdit = active && active.closest &&
                     (active.closest('.entity-form') || active.closest('.entity-nav-table'));
      if (inEdit) {
        // Commit-on-blur path: a focused form OR inline editor must commit before
        // selection moves; the dispatch's post-hook render consumes this intent.
        nextSelectionIntent = { entity: 'swimlanes', id: swId };
        active.blur();
      } else {
        // Pure selection: non-destructive, preserves nav-table scroll + DOM.
        selectSwimlane(swId);
      }
    });
  });

  attachInlineEditor(table, 'swimlane');

  return table;
}

// Non-destructive Swimlanes selection: updates selection state, highlight,
// toolbar, and form in place WITHOUT rebuilding the nav table, so the scroll
// container's scrollTop and the row DOM survive. Mirrors selectTask; called
// only for a pure row-click when no form input is mid-edit (the commit-on-blur
// path is handled in the listener).
function selectSwimlane(swimlaneId) {
  if (swimlaneId === entitySelections.swimlanes) return;
  const area = document.getElementById('entityArea');
  if (!area) return;
  const left  = area.querySelector('.entity-left');
  const right = area.querySelector('.entity-right');
  if (!left || !right) return;

  // selectSwimlane is authoritative for selection, so any pending intent left
  // by a silent dispatch no-op is now obsolete — clear it so the next full
  // render can't override the row the user just clicked.
  nextSelectionIntent = null;
  entitySelections.swimlanes = swimlaneId;

  // Highlight: move .selected from the old row to the clicked row.
  const prev = left.querySelector('tbody tr.selected');
  if (prev) prev.classList.remove('selected');
  const next = left.querySelector('tbody tr[data-id="' + String(swimlaneId) + '"]');
  if (next) next.classList.add('selected');

  // Toolbar rebuilt in place — button enablement is selection-dependent.
  // Replacing the toolbar element leaves the nav-table sibling untouched, so
  // scrollTop is preserved.
  const oldToolbar = left.querySelector('.entity-toolbar');
  if (oldToolbar) left.replaceChild(renderSwimlanesToolbar(swimlaneId), oldToolbar);

  // Form rebuilds because the id changed (renderSwimlanesForm's same-id guard).
  renderSwimlanesForm(right, swimlaneId);
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
    btnDelete.title = btnDuplicate.title = btnMoveUp.title = btnMoveDown.title = 'No row selected';
  } else {
    if (idx === 0)              { btnMoveUp.disabled   = true; btnMoveUp.title   = 'Already at top';    }
    if (idx === arr.length - 1) { btnMoveDown.disabled = true; btnMoveDown.title = 'Already at bottom'; }
  }

  btnAdd.addEventListener('click', () => {
    const newId = predictId(entitySingular);
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
    const newId = predictId(entitySingular);
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

// Non-destructive selection for the four shared-handler entities: updates
// selection state, highlight, toolbar, and form in place WITHOUT rebuilding the
// nav table, so the scroll container's scrollTop and the row DOM survive. A
// parameterised mirror of selectSwimlane; called only for a pure row-click when
// no form input is mid-edit (the commit-on-blur path is handled in the listener).
function selectSimpleEntity(entityPlural, id) {
  if (id === entitySelections[entityPlural]) return;
  const reg = SIMPLE_ENTITY_REGISTRY[entityPlural];
  if (!reg) return;
  const area = document.getElementById('entityArea');
  if (!area) return;
  const left  = area.querySelector('.entity-left');
  const right = area.querySelector('.entity-right');
  if (!left || !right) return;

  // This helper is authoritative for selection, so any pending intent left by a
  // silent dispatch no-op is now obsolete — clear it so the next full render
  // can't override the row the user just clicked.
  nextSelectionIntent = null;
  entitySelections[entityPlural] = id;

  // Highlight: move .selected from the old row to the clicked row.
  const prev = left.querySelector('tbody tr.selected');
  if (prev) prev.classList.remove('selected');
  const next = left.querySelector('tbody tr[data-id="' + String(id) + '"]');
  if (next) next.classList.add('selected');

  // Toolbar rebuilt in place — button enablement is selection-dependent.
  // Replacing the toolbar element leaves the nav-table sibling untouched, so
  // scrollTop is preserved.
  const oldToolbar = left.querySelector('.entity-toolbar');
  if (oldToolbar) left.replaceChild(renderSimpleEntityToolbar(reg.singular, entityPlural, reg.arr(), id), oldToolbar);

  // Form rebuilds because the id changed (the form's same-id guard).
  reg.renderForm(right, id);
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
      // An active editor counts as mid-edit whether it's a right-pane form input
      // or our inline nav-cell editor (.nav-cell-input — an <input> for text/date
      // fields, a <select> for Links' FK cells), so this closest() check cleanly
      // detects either. Harmless for Notes — nothing focusable lives in its nav
      // table yet.
      const active = document.activeElement;
      const inEdit = active && active.closest &&
                     (active.closest('.entity-form') || active.closest('.entity-nav-table'));
      if (inEdit) {
        nextSelectionIntent = { entity: entityPlural, id };
        active.blur();
      } else {
        selectSimpleEntity(entityPlural, id);
      }
    });
  });
}

// Canonical inline nav-cell editor, shared by all four inline-edit tabs (Tasks,
// Swimlanes, Pipes, Curtains) and driven by INLINE_EDIT_REGISTRY. Inert for any
// entity not in the registry (Links/Notes). Wires double-click entry on
// td[data-field] cells and, on every render, mounts the editor when editingCell
// points at a row in this table (so the editor survives the rebuild that
// edit-entry triggers). Per-field 'text'/'date' type comes from the registry.
function attachInlineEditor(table, entitySingular) {
  const reg = INLINE_EDIT_REGISTRY[entitySingular];
  if (!reg) return;

  // Inline-edit entry: double-click an editable cell (those carrying data-field)
  // to edit in place. Re-renders through renderDataPanel so editor creation
  // lives in one place (the mount block below); scroll is preserved.
  table.querySelectorAll('tbody tr[data-id] td[data-field]').forEach(td => {
    td.addEventListener('dblclick', () => {
      const id = parseInt(td.closest('tr').dataset.id, 10);
      const field = td.dataset.field;
      if (!Number.isFinite(id)) return;
      if (editingCell && editingCell.entity === entitySingular &&
          editingCell.id === id && editingCell.field === field) return;
      if (!reg.arr().some(o => o.id === id)) return;
      editingCell = { entity: entitySingular, id, field };
      renderDataPanel();
    });
  });

  // Mount the editor when editingCell points at a row in this table. Runs on
  // every render so the editor survives the rebuild that edit-entry triggers.
  if (editingCell && editingCell.entity === entitySingular) {
    const tr = table.querySelector('tbody tr[data-id="' + String(editingCell.id) + '"]');
    const obj = reg.arr().find(o => o.id === editingCell.id);
    const td = tr && tr.querySelector('td[data-field="' + editingCell.field + '"]');
    if (td && obj) {
      const field = editingCell.field;
      const type = reg.fields[field];   // 'text' | 'date' | 'select'
      td.textContent = '';

      // attachCommitHandlers reverts the value on Escape but has no teardown hook;
      // an inline cell (unlike a persistent form input) must revert to a text
      // cell. Also reused by select's no-commit paths (empty / non-finite).
      const revert = () => { editingCell = null; renderDataPanel(); };

      if (type === 'select') {
        // Build the dropdown exactly as addSelectRow does, so inline ≡ form:
        // options from the registry's getter (buildTaskRefOptions supplies a
        // leading '' clear option and a "{id} — (missing)" option for an orphan
        // current value), a when-null '—' placeholder only if the options don't
        // already carry a '' option, seeded from the canonical id (not the
        // formatted display cell).
        const select = document.createElement('select');
        select.className = 'nav-cell-input';
        const options = reg.options(field, obj);
        if (options.length === 0) select.disabled = true;
        if (obj[field] == null && !options.some(o => o.value === '')) {
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
        select.value = obj[field] == null ? '' : String(obj[field]);
        td.appendChild(select);
        attachCommitHandlers(select, () => select.value, val => {
          editingCell = null;          // clear BEFORE dispatch so the rebuild renders text
          formRenderedForId = null;    // force form rebuild so the right-pane reflects the edit
          // Mirror the form's FK commit: '' clears to null, a finite id
          // re-points, anything else reverts. Both null and id dispatch (the
          // post-mutation hook re-renders); only the revert path needs an
          // explicit re-render to restore the text cell.
          if (val === '') { dispatch({ entity: entitySingular, action: 'update', id: obj.id, field, value: null }); return; }
          const n = parseInt(val, 10);
          if (Number.isFinite(n)) dispatch({ entity: entitySingular, action: 'update', id: obj.id, field, value: n });
          else renderDataPanel();
        });
        select.addEventListener('keydown', ev => {
          if (ev.key === 'Escape') revert();
        });
        queueMicrotask(() => {
          select.focus({ preventScroll: true });
          // Best-effort auto-open of the dropdown; not implemented for <select>
          // in every browser and may throw — harmless either way.
          try { select.showPicker(); } catch (e) { /* unsupported */ }
        });
      } else {
        const isDate = type === 'date';
        const input = document.createElement('input');
        input.type = isDate ? 'date' : 'text';
        input.className = 'nav-cell-input';
        input.value = obj[field] == null ? '' : String(obj[field]);   // canonical ISO for dates, raw for text
        td.appendChild(input);
        attachCommitHandlers(input, () => input.value, val => {
          editingCell = null;          // clear BEFORE dispatch so the rebuild renders text
          formRenderedForId = null;    // force form rebuild so the right-pane reflects the edit
          const value = isDate ? (val === '' ? null : val) : val;   // empty date → null; text as-is
          dispatch({ entity: entitySingular, action: 'update', id: obj.id, field, value });
        });
        input.addEventListener('keydown', ev => {
          if (ev.key === 'Escape') revert();
        });
        // The table is detached when this runs (the caller appends it afterward),
        // so a synchronous focus() would no-op. Defer to a microtask, by which
        // point renderDataPanel's appendChild + scrollTop restore have completed.
        queueMicrotask(() => {
          input.focus({ preventScroll: true });
          if (!isDate) input.select();   // select-all on text only; not meaningful on a date input
        });
      }
    }
  }
}

// ── Links entity panel ─────────────────────────────────────────────────────────

function renderLinksPanel(area) {
  const links = projectData.links;
  let selectedId = entitySelections.links;
  if (selectedId !== null && !links.some(l => l.id === selectedId)) selectedId = null;
  if (selectedId === null && links.length > 0) selectedId = links[0].id;
  entitySelections.links = selectedId;

  // Drop a stale inline-edit marker if its link no longer exists (e.g. deleted
  // out from under an open editor) so the mount block never targets it.
  // Entity-scoped: other entities' markers are left alone here.
  if (editingCell && editingCell.entity === 'link' &&
      !links.some(l => l.id === editingCell.id)) editingCell = null;

  const left  = area.querySelector('.entity-left');
  const right = area.querySelector('.entity-right');

  // Left pane now hosts a focusable inline-edit select, so preserve the scroll
  // container's position across the rebuild (no-op on a freshly created pane).
  const prevScroll = left.scrollTop;
  left.innerHTML = '';
  left.appendChild(renderSimpleEntityToolbar('link', 'links', links, selectedId));
  left.appendChild(renderLinksNavTable(selectedId));
  left.scrollTop = prevScroll;

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
// the orphan persisting. A leading, always-present, selectable clear option
// (value '', label "— (none)") lets a non-null FK be set back to null — null is
// the initial state of every link and a tolerated/flagged state validation
// already errors on, so the editor must be able to return to it (referential
// integrity for FKs is advisory, not enforced). Its '' value also serves as the
// unset placeholder, so addSelectRow / the inline editor suppress their own
// when-null placeholder once a '' option is present (no duplicate).
function buildTaskRefOptions(currentValue) {
  const opts = projectData.tasks.map(t => ({ value: String(t.id), label: `${t.id} — ${t.name}` }));
  if (currentValue != null && !projectData.tasks.some(t => t.id === currentValue)) {
    opts.unshift({ value: String(currentValue), label: `${currentValue} — (missing)` });
  }
  opts.unshift({ value: '', label: '— (none)' });
  return opts;
}

// Compact link-preview glyph for the Links nav table — mirrors the renderer's
// same-row link (origin dot → styled line → arrowhead), surfacing lineColor /
// lineStyle without a text column. lineColor is interpolated raw (browser judges
// validity, matching the renderer + the swimlane color cell) but escaped into the
// attribute. Returned markup is emitted RAW (it is SVG, not a text value).
function buildLinkGlyph(lineColor, lineStyle) {
  const stroke = escapeHtml(String(lineColor));
  const dash = lineStyle === 'dashed' ? ' stroke-dasharray="4 3"' : '';
  return `<svg class="link-glyph" viewBox="0 0 44 16" width="48" height="16" aria-hidden="true">` +
         `<line x1="4" y1="8" x2="36" y2="8" stroke="${stroke}" stroke-width="1.5"${dash} />` +
         `<circle cx="4" cy="8" r="2.5" fill="${stroke}" />` +
         `<polygon points="36,4 44,8 36,12" fill="${stroke}" />` +
         `</svg>`;
}

function renderLinksNavTable(selectedId) {
  const links = projectData.links;
  const table = document.createElement('table');
  table.className = 'entity-nav-table';
  const COLS = ['id', 'fromTaskId', 'line', 'toTaskId'];

  let html = '<thead><tr>';
  COLS.forEach(c => {
    if (c === 'line')                                 html += '<th class="link-glyph-col">line</th>';
    else if (c === 'fromTaskId' || c === 'toTaskId')  html += `<th class="link-fk-col">${c}</th>`;
    else                                              html += `<th>${c}</th>`;
  });
  html += '</tr></thead><tbody>';

  if (links.length === 0) {
    html += `<tr><td colspan="${COLS.length}" class="entity-empty">No links. Click Add to create one.</td></tr>`;
  } else {
    links.forEach(l => {
      const isSelected = l.id === selectedId;
      html += `<tr data-id="${l.id}"${isSelected ? ' class="selected"' : ''}>`;
      COLS.forEach(c => {
        // The glyph column is non-editable (styling stays in the form) and emits
        // raw SVG, so it bypasses the data-field / escapeHtml text path entirely.
        if (c === 'line') {
          html += `<td class="link-glyph-col">${buildLinkGlyph(l.lineColor, l.lineStyle)}</td>`;
          return;
        }
        let v;
        // FK cells carry data-field so attachInlineEditor's dblclick + mount
        // targeting works; they still DISPLAY via formatTaskRefCell.
        const isFk = (c === 'fromTaskId' || c === 'toTaskId');
        if (isFk) v = formatTaskRefCell(l[c]);
        else      v = l[c] == null ? '' : l[c];
        html += `<td${isFk ? ` class="link-fk-col" data-field="${c}"` : ''}>${escapeHtml(String(v))}</td>`;
      });
      html += '</tr>';
    });
  }
  html += '</tbody></table>';
  table.innerHTML = html;

  attachNavTableRowHandlers(table, 'links');
  attachInlineEditor(table, 'link');
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
    if (val === '') { upd('fromTaskId', null); return; }
    const n = parseInt(val, 10);
    if (Number.isFinite(n)) upd('fromTaskId', n);
  });
  addSelectRow(form, 'toTaskId', link.toTaskId, buildTaskRefOptions(link.toTaskId), val => {
    if (val === '') { upd('toTaskId', null); return; }
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

  // Drop a stale inline-edit marker if its pipe no longer exists (e.g. deleted
  // out from under an open editor) so the mount block never targets it.
  // Entity-scoped: other entities' markers are left alone here.
  if (editingCell && editingCell.entity === 'pipe' &&
      !pipes.some(p => p.id === editingCell.id)) editingCell = null;

  const left  = area.querySelector('.entity-left');
  const right = area.querySelector('.entity-right');

  // Left pane now hosts a focusable inline-edit input, so preserve the scroll
  // container's position across the rebuild (no-op on a freshly created pane).
  const prevScroll = left.scrollTop;
  left.innerHTML = '';
  left.appendChild(renderSimpleEntityToolbar('pipe', 'pipes', pipes, selectedId));
  left.appendChild(renderPipesNavTable(selectedId));
  left.scrollTop = prevScroll;

  renderPipesForm(right, selectedId);
}

function renderPipesNavTable(selectedId) {
  const pipes = projectData.pipes;
  const table = document.createElement('table');
  table.className = 'entity-nav-table';
  const COLS = ['id', 'date', 'name'];

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
        let v;
        if (c === 'date') v = formatNavTableDateCell(p.date);
        else              v = p[c] == null ? '' : p[c];
        if (c === 'name')      html += `<td data-field="name">${escapeHtml(String(v))}</td>`;
        else if (c === 'date') html += `<td data-field="date">${escapeHtml(String(v))}</td>`;
        else                   html += `<td>${escapeHtml(String(v))}</td>`;
      });
      html += '</tr>';
    });
  }
  html += '</tbody></table>';
  table.innerHTML = html;

  attachNavTableRowHandlers(table, 'pipes');
  attachInlineEditor(table, 'pipe');
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
  }, { step: '0.1', min: '0', max: '1', decimals: 2 });
  addCheckboxRow(form, 'invertLabel', pipe.invertLabel, val => upd('invertLabel', val));
}

// ── Curtains entity panel ──────────────────────────────────────────────────────

function renderCurtainsPanel(area) {
  const curtains = projectData.curtains;
  let selectedId = entitySelections.curtains;
  if (selectedId !== null && !curtains.some(c => c.id === selectedId)) selectedId = null;
  if (selectedId === null && curtains.length > 0) selectedId = curtains[0].id;
  entitySelections.curtains = selectedId;

  // Drop a stale inline-edit marker if its curtain no longer exists (e.g.
  // deleted out from under an open editor) so the mount block never targets it.
  // Entity-scoped: other entities' markers are left alone here.
  if (editingCell && editingCell.entity === 'curtain' &&
      !curtains.some(c => c.id === editingCell.id)) editingCell = null;

  const left  = area.querySelector('.entity-left');
  const right = area.querySelector('.entity-right');

  // Left pane now hosts a focusable inline-edit input, so preserve the scroll
  // container's position across the rebuild (no-op on a freshly created pane).
  const prevScroll = left.scrollTop;
  left.innerHTML = '';
  left.appendChild(renderSimpleEntityToolbar('curtain', 'curtains', curtains, selectedId));
  left.appendChild(renderCurtainsNavTable(selectedId));
  left.scrollTop = prevScroll;

  renderCurtainsForm(right, selectedId);
}

function renderCurtainsNavTable(selectedId) {
  const curtains = projectData.curtains;
  const table = document.createElement('table');
  table.className = 'entity-nav-table';
  const COLS = ['id', 'startDate', 'endDate', 'name'];

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
        let v;
        if (c === 'startDate' || c === 'endDate') v = formatNavTableDateCell(cu[c]);
        else                                      v = cu[c] == null ? '' : cu[c];
        if (c === 'name')                              html += `<td data-field="name">${escapeHtml(String(v))}</td>`;
        else if (c === 'startDate' || c === 'endDate') html += `<td data-field="${c}">${escapeHtml(String(v))}</td>`;
        else                                           html += `<td>${escapeHtml(String(v))}</td>`;
      });
      html += '</tr>';
    });
  }
  html += '</tbody></table>';
  table.innerHTML = html;

  attachNavTableRowHandlers(table, 'curtains');
  attachInlineEditor(table, 'curtain');
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
  }, { step: '0.1', min: '0', max: '1', decimals: 2 });
  addNumberRow(form, 'labelPosition', cu.labelPosition, val => {
    const n = parseFloat(val);
    if (Number.isFinite(n)) upd('labelPosition', n);
  }, { step: '0.1', min: '0', max: '1', decimals: 2 });
  addSelectRow(form, 'labelAnchor', cu.labelAnchor,
    CURTAIN_LABEL_ANCHOR_OPTIONS.map(o => ({ value: o, label: o })),
    val => upd('labelAnchor', val));
  addCheckboxRow(form, 'invertLabel', cu.invertLabel, val => upd('invertLabel', val));
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
// Form-only — no nav table, no toolbar, no selection state. Six sub-tabs
// correspond to the six user-facing config blocks (config.rendering is
// deliberately excluded). Persistent-skeleton pattern mirrors renderDataPanel:
// the sub-tab strip and an outer area survive across same-block re-renders so
// commit-on-blur dispatches preserve focus inside the form.

const CONFIG_TABS = [
  { key: 'layout',      label: 'Layout'      },
  { key: 'bars',        label: 'Elements'    },
  { key: 'timeline',    label: 'Timeline'    },
  { key: 'titles',      label: 'Titles'      },
  { key: 'style',       label: 'Colors'      },
  { key: 'typography',  label: 'Typography'  },
];

const MILESTONE_SHAPE_OPTIONS = ['diamond', 'circle'];
const HEADER_FOOTER_TEXT_ALIGN_OPTIONS = ['left', 'center', 'right'];
// Suggested font families for the Typography Font Family picklist — most-common
// first, order preserved (NOT alphabetized). Pure UI list: option value === label
// === bare family name (no quotes / fallback chains), so the stored fontFamily
// string is unchanged. Never enters projectData.config / Excel / the Inspector.
const FONT_FAMILY_OPTIONS = [
  'Arial', 'Calibri', 'Segoe UI', 'Tahoma', 'Trebuchet MS', 'Verdana',
  'Times New Roman', 'Georgia', 'Cambria', 'Garamond', 'Courier New',
  'Consolas', 'sans-serif', 'serif', 'monospace',
];

// Pangrams rotated through the font-preview specimen swatch — pure UI sample text,
// never stored or written. pickPangram() returns a random one that differs from the
// one shown immediately before (tracked in module-scope lastPangram), so each preview
// update on a non-empty font visibly changes the line.
const FONT_PREVIEW_PANGRAMS = [
  'The quick brown fox jumps over the lazy dog',
  'Pack my box with five dozen liquor jugs',
  'How vexingly quick daft zebras jump',
  'The five boxing wizards jump quickly',
  'Sphinx of black quartz, judge my vow',
  'Jackdaws love my big sphinx of quartz',
];
let lastPangram = null;
function pickPangram() {
  const pool = FONT_PREVIEW_PANGRAMS.filter(p => p !== lastPangram);
  const choice = pool[Math.floor(Math.random() * pool.length)];
  lastPangram = choice;
  return choice;
}

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

// Section heading for a config form: a full-width, label-only row (no input,
// not focusable, no part in commit handling). CSS gives it a top hairline rule
// and spacing, suppressed on the first heading via :first-child.
function addConfigSection(form, title) {
  const heading = document.createElement('div');
  heading.className = 'config-section-heading';
  heading.textContent = title;
  form.appendChild(heading);
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

  addConfigSection(form, 'Size');
  addNumberRow(form, 'outerWidth',      layout.outerWidth,      commitInt(upd, 'outerWidth'));
  addNumberRow(form, 'outerHeight',     layout.outerHeight,     commitInt(upd, 'outerHeight'));

  addConfigSection(form, 'Padding');
  addNumberRow(form, 'paddingTop',      layout.paddingTop,      commitInt(upd, 'paddingTop'));
  addNumberRow(form, 'paddingRight',    layout.paddingRight,    commitInt(upd, 'paddingRight'));
  addNumberRow(form, 'paddingBottom',   layout.paddingBottom,   commitInt(upd, 'paddingBottom'));
  addNumberRow(form, 'paddingLeft',     layout.paddingLeft,     commitInt(upd, 'paddingLeft'));

  addConfigSection(form, 'Dividers');
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

  addConfigSection(form, 'Tasks');
  addNumberRow(form, 'taskBarHeightFactor',   bars.taskBarHeightFactor,   commitFloat(upd, 'taskBarHeightFactor'),   { step: '0.1', decimals: 2 });
  addNumberRow(form, 'taskBarVerticalOffsetFactor',   bars.taskBarVerticalOffsetFactor,   commitFloat(upd, 'taskBarVerticalOffsetFactor'),   { step: '0.01', decimals: 2 });
  addNumberRow(form, 'taskCornerRadius',      bars.taskCornerRadius,      commitInt  (upd, 'taskCornerRadius'));

  addConfigSection(form, 'Milestones');
  addNumberRow(form, 'milestoneSizeFactor',   bars.milestoneSizeFactor,   commitFloat(upd, 'milestoneSizeFactor'),   { step: '0.1', decimals: 2 });
  addNumberRow(form, 'milestoneVerticalOffsetFactor', bars.milestoneVerticalOffsetFactor, commitFloat(upd, 'milestoneVerticalOffsetFactor'), { step: '0.01', decimals: 2 });
  addSelectRow(form, 'milestoneShape',        bars.milestoneShape,
    MILESTONE_SHAPE_OPTIONS.map(o => ({ value: o, label: o })),
    val => upd('milestoneShape', val));
  addNumberRow(form, 'milestoneCornerRadius', bars.milestoneCornerRadius, commitFloat(upd, 'milestoneCornerRadius'), { step: '0.1', decimals: 2 });

  addConfigSection(form, 'Baseline');
  addNumberRow(form, 'baselineBarHeightFactor',           bars.baselineBarHeightFactor,           commitFloat(upd, 'baselineBarHeightFactor'),           { step: '0.01', decimals: 2 });
  addNumberRow(form, 'baselineBarVerticalOffsetFactor',   bars.baselineBarVerticalOffsetFactor,   commitFloat(upd, 'baselineBarVerticalOffsetFactor'),   { step: '0.01', decimals: 2 });
  addNumberRow(form, 'baselineMilestoneSizeFactor',       bars.baselineMilestoneSizeFactor,       commitFloat(upd, 'baselineMilestoneSizeFactor'),       { step: '0.01', decimals: 2 });
  addNumberRow(form, 'baselineMilestoneVerticalOffsetFactor', bars.baselineMilestoneVerticalOffsetFactor, commitFloat(upd, 'baselineMilestoneVerticalOffsetFactor'), { step: '0.01', decimals: 2 });
  addNumberRow(form, 'baselineFillOpacity',               bars.baselineFillOpacity,               commitFloat(upd, 'baselineFillOpacity'),               { step: '0.1', min: '0', max: '1', decimals: 2 });

  addConfigSection(form, 'Links');
  addNumberRow(form, 'arrowheadSizeFactor',    bars.arrowheadSizeFactor,    commitFloat(upd, 'arrowheadSizeFactor'),    { step: '0.1', decimals: 2 });
  addNumberRow(form, 'originMarkerSizeFactor', bars.originMarkerSizeFactor, commitFloat(upd, 'originMarkerSizeFactor'), { step: '0.1', decimals: 2 });
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
  // Clearing reverts to auto-derived: drop the explicit flag AND set the value
  // to the current task extent immediately. The task-gated post-mutation hook
  // never fires on these config dispatches, so without seeding the value here a
  // cleared field would leave the chart blank until the next task edit.
  addConfigSection(form, 'Date range');
  addDateRow(form, 'chartStartDate', timeline.chartStartDate, val => {
    if (val === '') {
      upd('chartStartDateExplicit', false);
      upd('chartStartDate', taskDateExtents(projectData.tasks).earliestStart);
    } else {
      upd('chartStartDate', val);
      upd('chartStartDateExplicit', true);
    }
  });
  addDateRow(form, 'chartEndDate', timeline.chartEndDate, val => {
    if (val === '') {
      upd('chartEndDateExplicit', false);
      upd('chartEndDate', taskDateExtents(projectData.tasks).latestFinish);
    } else {
      upd('chartEndDate', val);
      upd('chartEndDateExplicit', true);
    }
  });
  addTextRow(form, 'chartDateFormat', timeline.chartDateFormat, val => upd('chartDateFormat', val));

  addConfigSection(form, 'Scales');
  addCheckboxRow(form, 'showYears',  timeline.showYears,  val => upd('showYears',  val));
  addCheckboxRow(form, 'showMonths', timeline.showMonths, val => upd('showMonths', val));
  addCheckboxRow(form, 'showWeeks',  timeline.showWeeks,  val => upd('showWeeks',  val));
  addCheckboxRow(form, 'showDays',   timeline.showDays,   val => upd('showDays',   val));
  addCheckboxRow(form, 'showDates',  timeline.showDates,  val => upd('showDates',  val));

  addConfigSection(form, 'Gridlines');
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

  addConfigSection(form, 'Header');
  addNumberRow(form, 'headerHeight',    titles.headerHeight,    commitInt(upd, 'headerHeight'));
  addTextRow  (form, 'headerText',      titles.headerText,      val => upd('headerText', val));
  addSelectRow(form, 'headerTextAlign', titles.headerTextAlign,
    HEADER_FOOTER_TEXT_ALIGN_OPTIONS.map(o => ({ value: o, label: o })),
    val => upd('headerTextAlign', val));

  addConfigSection(form, 'Footer');
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

  const STYLE_SECTIONS = [
    ['Chart', ['chartBackgroundColor']],
    ['Header & footer', ['headerFooterBackgroundColor', 'headerFooterBorderColor', 'headerFooterTextColor']],
    ['Swimlanes', ['swimlaneLabelColor', 'swimlaneDividerColor']],
    ['Scale & gridlines', ['scaleBackgroundColor', 'scaleTickColor', 'scaleLabelTextColor', 'gridlineVerticalColor']],
    ['Tasks & milestones', ['taskStrokeColor', 'milestoneStrokeColor']],
    ['Labels & notes', ['outsideLabelTextColor', 'insideLabelTextColor', 'leaderLineColor', 'noteTextColor']],
  ];
  STYLE_SECTIONS.forEach(([title, fields]) => {
    addConfigSection(form, title);
    fields.forEach(f => addColorRow(form, f, style[f], val => upd(f, val)));
  });
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

  addConfigSection(form, 'Font');

  // Live font preview — display-only specimen swatch BELOW the Font Family select.
  // applyFontPreview sets its font-family imperatively so the empty case shows the
  // muted placeholder in the form's normal font (rather than a fallback that would
  // read as a working selection); a non-empty font shows a pangram chosen via
  // pickPangram (random, never the one shown immediately before, so a change always
  // visibly changes the line). It is driven on (re)entry by the stored value below
  // and live by the select's own change handler — the form isn't rebuilt on
  // same-block config changes, so we update it imperatively.
  const fontPreview = document.createElement('div');
  fontPreview.className = 'font-preview';
  const applyFontPreview = value => {
    const empty = value === null || value === undefined || value === '';
    if (empty) {
      fontPreview.classList.add('is-empty');
      fontPreview.style.fontFamily = '';
      fontPreview.textContent = '(no font selected)';
    } else {
      fontPreview.classList.remove('is-empty');
      fontPreview.style.fontFamily = value;
      fontPreview.textContent = pickPangram();
    }
  };

  // Closed picklist via addSelectRow (same as other enum config fields). Empty/null
  // stored value → pass null so the placeholder shows WITHOUT coercing the stored
  // value (empty-fontFamily validation still fires; save still writes empty). A
  // non-empty value not in the list (e.g. a font from a loaded file) is prepended
  // as its own selectable option so it displays and round-trips unchanged.
  const storedFont = typo.fontFamily;
  const fontEmpty = storedFont === null || storedFont === undefined || storedFont === '';
  const fontOptions = FONT_FAMILY_OPTIONS.map(o => ({ value: o, label: o }));
  if (!fontEmpty && !FONT_FAMILY_OPTIONS.includes(storedFont)) {
    fontOptions.unshift({ value: storedFont, label: storedFont });
  }
  addSelectRow(form, 'fontFamily', fontEmpty ? null : storedFont, fontOptions,
    val => upd('fontFamily', val));
  // Live update: the select is the form's last appended child (addSelectRow
  // appends label then select). Additive listener — addSelectRow's own commit
  // wiring is untouched. Grab the select BEFORE appending the preview below it.
  form.lastElementChild.addEventListener('change', e => applyFontPreview(e.target.value));

  // Preview sits directly below the Font Family select; seed it from the stored value.
  form.appendChild(fontPreview);
  applyFontPreview(storedFont);

  addConfigSection(form, 'Sizes');
  const FONT_SIZE_FIELDS = [
    'taskFontSize', 'scaleFontSize', 'headerFooterFontSize', 'noteFontSize',
    'swimlaneFontSize', 'pipeFontSize', 'curtainFontSize',
  ];
  FONT_SIZE_FIELDS.forEach(f => addNumberRow(form, f, typo[f], commitInt(upd, f)));

  addConfigSection(form, 'Alignment');
  const ALIGNMENT_FACTOR_FIELDS = [
    'scaleAlignmentFactor', 'taskAlignmentFactor', 'headerFooterAlignmentFactor',
    'pipeAlignmentFactor', 'curtainAlignmentFactor', 'noteAlignmentFactor',
    'swimlaneTopAlignmentFactor', 'swimlaneBottomAlignmentFactor',
  ];
  ALIGNMENT_FACTOR_FIELDS.forEach(f =>
    addNumberRow(form, f, typo[f], commitFloat(upd, f), { step: '0.1', decimals: 2 }));
}

// ── Inspector renderer ─────────────────────────────────────────────────────────
function renderInspector(panel) {
  const d = projectData;
  panel.innerHTML = '';

  function appendSection(path, sourceLabel, renderFn) {
    const h2 = document.createElement('h2');
    const pathSpan = document.createElement('span');
    pathSpan.textContent = path;
    const sourceSpan = document.createElement('span');
    sourceSpan.className = 'inspector-section-source';
    sourceSpan.textContent = ` — ${sourceLabel}`;
    h2.appendChild(pathSpan);
    h2.appendChild(sourceSpan);
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
  appendSection('baseline',  'from Baseline sheet',   div => renderEntityTable(div, d.baseline));

  appendSection('config.layout',      'from Layout sheet',     div => renderConfigTable(div, d.config.layout));
  appendSection('config.bars',        'from Bars sheet',       div => renderConfigTable(div, d.config.bars));
  appendSection('config.timeline',    'from Timeline sheet',   div => renderConfigTable(div, d.config.timeline));
  appendSection('config.titles',      'from Titles sheet',     div => renderConfigTable(div, d.config.titles));
  appendSection('config.style',       'from Style sheet',      div => renderConfigTable(div, d.config.style));
  appendSection('config.typography',  'from Typography sheet', div => renderConfigTable(div, d.config.typography));
  appendSection('config.rendering',   'not in Excel',          div => renderConfigTable(div, d.config.rendering));

  const FIXED = new Set(['tasks', 'swimlanes', 'links', 'pipes', 'curtains', 'notes', 'baseline', 'config']);
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
const ISSUE_ENTITY_ORDER = ['task', 'swimlane', 'link', 'pipe', 'curtain', 'note', 'baseline', 'config'];
const ISSUE_ENTITY_RANK  = {};
ISSUE_ENTITY_ORDER.forEach((e, i) => { ISSUE_ENTITY_RANK[e] = i; });
const ISSUE_ENTITY_LABEL = { task:'Task', swimlane:'Swimlane', link:'Link', pipe:'Pipe', curtain:'Curtain', note:'Note', baseline:'Baseline', config:'Config' };
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
  // Label is always the word "Issues"; a coloured dot (worst severity present)
  // and a count tooltip carry the signal. Reset to text-only each refresh.
  tab.textContent = 'Issues';
  tab.removeAttribute('title');
  const v = projectData._validation;
  if (!v) return;
  const e = v.errors.length, w = v.warnings.length, n = v.notices.length;
  if (e + w + n === 0) return;

  const severity = e > 0 ? 'error' : w > 0 ? 'warning' : 'notice';
  const dot = document.createElement('span');
  dot.className = `tab-dot tab-dot-${severity}`;
  tab.appendChild(dot);

  const cnt = (num, s) => `${num} ${num === 1 ? s : s + 's'}`;
  const parts = [];
  if (e > 0) parts.push(cnt(e, 'error'));
  if (w > 0) parts.push(cnt(w, 'warning'));
  if (n > 0) parts.push(cnt(n, 'notice'));
  tab.title = parts.join(', ');
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
const VALID_ENTITIES = new Set([...Object.keys(ENTITY_ARRAY_KEY), 'config', 'baseline']);
const VALID_ACTIONS  = new Set(['update', 'add', 'delete', 'duplicate', 'moveUp', 'moveDown']);

function dispatch({ entity, action, id, block, field, value, index } = {}) {
  if (!VALID_ENTITIES.has(entity)) { console.warn('[dispatch] unknown entity:', entity); return; }

  // ── Baseline ──────────────────────────────────────────────────────────────
  // Not a per-row entity: a whole-array snapshot replaced wholesale (set) or
  // emptied (clear). Handled before the VALID_ACTIONS gate because its actions
  // ('set'/'clear') are deliberately outside the shared per-row action set, so
  // it self-validates here — mirroring the config branch's own action check.
  if (entity === 'baseline') {
    if (action === 'set')   { projectData.baseline = Array.isArray(value) ? value : []; runPostMutationHook(); return; }
    if (action === 'clear') { projectData.baseline = []; runPostMutationHook(); return; }
    console.warn('[dispatch] action not supported for baseline:', action);
    return;
  }

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
    if (entity === 'task') { recomputeTaskDerived(rec); recomputeTaskDateRange(); }
    runPostMutationHook();
    return;
  }

  if (action === 'add') {
    const rec = ENTITY_FACTORY[entity]();
    rec.id = issueId(entity);
    const insertAt = (typeof index === 'number' && index >= 0 && index <= arr.length) ? index : arr.length;
    arr.splice(insertAt, 0, rec);
    if (entity === 'swimlane') recomputeSwimlaneOrders();
    if (entity === 'task') recomputeTaskDateRange();
    runPostMutationHook();
    return;
  }

  if (action === 'delete') {
    if (id == null) { console.warn('[dispatch] delete missing id'); return; }
    const idx = arr.findIndex(r => r.id === id);
    if (idx === -1) { console.warn('[dispatch] delete: no', entity, 'with id', id); return; }
    arr.splice(idx, 1);
    if (entity === 'swimlane') recomputeSwimlaneOrders();
    if (entity === 'task') recomputeTaskDateRange();
    runPostMutationHook();
    return;
  }

  if (action === 'duplicate') {
    if (id == null) { console.warn('[dispatch] duplicate missing id'); return; }
    const rec = arr.find(r => r.id === id);
    if (!rec) { console.warn('[dispatch] duplicate: no', entity, 'with id', id); return; }
    const clone = { ...rec };
    clone.id = issueId(entity);
    arr.push(clone);
    if (entity === 'swimlane') recomputeSwimlaneOrders();
    if (entity === 'task') recomputeTaskDateRange();
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
    if (entity === 'task') recomputeTaskDateRange();
    runPostMutationHook();
    return;
  }
}

// ── Id issuance (monotonic, counter-backed) ─────────────────────────────────
// New ids come from projectData.counters[entity] (singular key — matches the
// dispatch entity and editingCell.entity, no plural↔singular translation). The
// counter is the NEXT id to issue and only ever advances, so deleting the
// highest-id entity can't let a later add reuse that id (which would silently
// re-point a baseline overlay record onto the wrong task). The counters are
// seeded to 1 by createEmptyProjectData and healed to max(persisted, max+1) on
// load, so both helpers' fallback paths are unreachable in normal flow.
//
// issueId reads-then-advances; predictId reads WITHOUT advancing. The toolbars
// predictId to pre-set nextSelectionIntent, then synchronously dispatch an add
// that issueIds — nothing mints between, so the two always agree.
//
// maxExistingId is the salvaged old-nextIdFor body (max numeric id + 1, or 1):
// the fallback when a counter is somehow absent/non-numeric. Degrades to the
// pre-counter behaviour; never throws, never reuses.
function maxExistingId(arr) {
  const ids = arr.map(r => r.id).filter(n => typeof n === 'number');
  return ids.length === 0 ? 1 : Math.max(...ids) + 1;
}

function issueId(entity) {
  const arr = projectData[ENTITY_ARRAY_KEY[entity]];
  const next = projectData.counters && projectData.counters[entity];
  if (Number.isInteger(next) && next >= 1) {
    projectData.counters[entity] = next + 1;
    return next;
  }
  // Should be unreachable (empty default + load-heal). Degrade to max+1 and
  // self-heal the counter so the broken state can't recur or cause reuse.
  console.warn('[issueId] counter missing/invalid for', entity, '— falling back to max+1');
  const fallback = maxExistingId(arr);
  if (projectData.counters) projectData.counters[entity] = fallback + 1;
  return fallback;
}

function predictId(entity) {
  const next = projectData.counters && projectData.counters[entity];
  if (Number.isInteger(next) && next >= 1) return next;
  return maxExistingId(projectData[ENTITY_ARRAY_KEY[entity]]);
}

// Derived-field maintenance. Task.isMilestone and Swimlane.order are computed
// in the parser; the dispatcher keeps them consistent after mutations so
// validation and re-render see correct state.
function recomputeTaskDerived(task) {
  task.isMilestone = task.startDate !== null && task.startDate === task.finishDate;
}

// The chart date range is a derived field like task.isMilestone: min task
// startDate / max finishDate, recomputed after any task-array mutation so an
// in-app task edit fixes the range without a save+reload. Gated per-field on the
// explicit flag — a user-set (explicit=true) date is authoritative and untouched.
// Only ever called from task-entity dispatch branches; a config/Timeline
// dispatch must NOT re-derive (it would clobber an explicit date in the gap
// between its value and flag dispatches).
function recomputeTaskDateRange() {
  const ext = taskDateExtents(projectData.tasks);
  const tl = projectData.config.timeline;
  if (!tl.chartStartDateExplicit) tl.chartStartDate = ext.earliestStart;
  if (!tl.chartEndDateExplicit)   tl.chartEndDate   = ext.latestFinish;
}

function recomputeSwimlaneOrders() {
  projectData.swimlanes.forEach((s, i) => { s.order = i + 1; });
}

function runPostMutationHook() {
  projectData._validation = validateProject(projectData);
  activateTab(activeTab);
  updateIssuesTabLabel();
}

// Updates the Save-button disabled state and the status bar. Shared between the
// file-load handler, New Project, and the baseline load/clear handlers. A prefix
// arg ("Loaded: <name>" / "New project") is remembered in lastStatusPrefix so a
// later prefix-less call (baseline load/clear) recomposes the same line. The
// status bar holds two parts: a left text element ("<prefix> — <counts>", set as
// textContent so a filename can't inject markup) and a right-aligned baseline
// chip reflecting projectData.baseline.length.
function refreshStatusAndButtons(prefix) {
  const d = projectData;
  const noData = d.tasks.length === 0 && d.swimlanes.length === 0;
  document.getElementById('saveBtn').disabled    = noData;
  document.getElementById('saveSvgBtn').disabled = noData;
  refreshBaselineButtons();
  if (prefix != null) lastStatusPrefix = prefix;
  const cnt = (num, s) => `${num} ${num === 1 ? s : s + 's'}`;
  const status = document.getElementById('status');
  status.textContent = '';

  const textEl = document.createElement('span');
  textEl.className = 'status-text';
  textEl.textContent =
    `${lastStatusPrefix} — `                         +
    `${cnt(d.tasks.length,     'task')}, `           +
    `${cnt(d.swimlanes.length, 'swimlane')}, `       +
    `${cnt(d.links.length,     'link')}, `           +
    `${cnt(d.pipes.length,     'pipe')}, `           +
    `${cnt(d.curtains.length,  'curtain')}, `        +
    `${cnt(d.notes.length,     'note')}`;
  status.appendChild(textEl);

  const hasBaseline = d.baseline.length > 0;
  const chip = document.createElement('span');
  chip.className = 'status-chip ' + (hasBaseline ? 'status-chip-present' : 'status-chip-absent');
  chip.textContent = hasBaseline ? '✓ baseline' : 'no baseline';
  status.appendChild(chip);
}

// Baseline buttons have a different enable logic from the Save buttons, and
// baseline set/clear flows through dispatch (whose hook doesn't call
// refreshStatusAndButtons). Centralised here so file-load, New Project, and the
// post-Load/Clear calls all stay consistent. Load enabled once a project is
// loaded (same noData gate as Save); Clear enabled only with a baseline present.
function refreshBaselineButtons() {
  const d = projectData;
  const noData = d.tasks.length === 0 && d.swimlanes.length === 0;
  document.getElementById('loadBaselineBtn').disabled  = noData;
  document.getElementById('clearBaselineBtn').disabled = d.baseline.length === 0;
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

  document.getElementById('chooseFileBtn').addEventListener('click', function() {
    document.getElementById('fileInput').click();
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

    // Reset so re-selecting the same file re-fires change.
    e.target.value = '';
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
    const svg  = renderChart(projectData, { showBaseline, showOnlyMoved });
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  });

  // ── Baseline capture ──────────────────────────────────────────────────────
  // Load Baseline opens a hidden picker; on change we parse the chosen prior
  // POAP with the same path as the main loader, then capture ONLY its tasks as
  // { id, startDate, finishDate } records. Everything else the parse produced
  // (the prior file's own Baseline sheet, its parse notices / validation) is
  // discarded — parseWorkbook returns a fresh object and never touches the live
  // projectData, so nothing merges into the current project.
  document.getElementById('loadBaselineBtn').addEventListener('click', function() {
    document.getElementById('baselineInput').click();
  });

  document.getElementById('baselineInput').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(ev) {
      let parsed;
      try {
        const workbook = XLSX.read(new Uint8Array(ev.target.result), { type: 'array', cellDates: true });
        parsed = parseWorkbook(workbook);
      } catch (err) {
        // Read/parse failure: leave any existing baseline intact.
        console.warn('[baseline] failed to read/parse file:', err);
        return;
      }
      if (parsed.tasks.length === 0) {
        // No tasks to capture: don't wipe an existing baseline with an empty one.
        console.warn('[baseline] file has no tasks; baseline unchanged');
        return;
      }
      const records = parsed.tasks.map(t => ({
        id: t.id, startDate: t.startDate, finishDate: t.finishDate,
      }));
      // Set BEFORE the dispatch: the post-mutation hook re-renders the chart
      // (if active), and we want it to pick up the now-visible default rather
      // than a stale toggled-off state from a previous baseline.
      showBaseline = true;
      dispatch({ entity: 'baseline', action: 'set', value: records });
      refreshStatusAndButtons();
    };
    reader.readAsArrayBuffer(file);

    // Reset so re-selecting the same file re-fires change.
    e.target.value = '';
  });

  document.getElementById('clearBaselineBtn').addEventListener('click', function() {
    dispatch({ entity: 'baseline', action: 'clear' });
    refreshStatusAndButtons();
  });

  // Bootstrap the empty Data panel so the entity tab strip and empty Tasks
  // panel appear on page load, not just after the first file load / mutation.
  renderDataPanel();
}
