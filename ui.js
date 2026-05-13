// ui.js — UI entry point; owns the live projectData reference for the current session

let projectData = createEmptyProjectData();
let loadedFilename = null;

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
  ['data', 'chart', 'inspector'].forEach(n => {
    document.getElementById(n + 'Panel').style.display = n === name ? '' : 'none';
    document.getElementById('tab' + n.charAt(0).toUpperCase() + n.slice(1)).classList.toggle('active', n === name);
  });

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

// ── Public entry point ─────────────────────────────────────────────────────────
function initUI() {
  document.getElementById('tabData').addEventListener('click',      () => activateTab('data'));
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

      renderEntityTable(document.getElementById('tasksContainer'),    d.tasks);
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
