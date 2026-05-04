// ui.js — UI entry point; owns the live projectData reference for the current session

let projectData = createEmptyProjectData();
let loadedFilename = null;

// ── Table renderers ────────────────────────────────────────────────────────────
function renderEntityTable(container, data) {
  if (!data || !data.length) {
    container.innerHTML = '<p><em>No data</em></p>';
    return;
  }
  const keys = Object.keys(data[0]);
  let html = '<table><thead><tr>';
  keys.forEach(k => { html += `<th>${k}</th>`; });
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
  const showData = name === 'data';
  document.getElementById('dataPanel').style.display  = showData ? '' : 'none';
  document.getElementById('chartPanel').style.display = showData ? 'none' : '';
  document.getElementById('tabData').classList.toggle('active',  showData);
  document.getElementById('tabChart').classList.toggle('active', !showData);

  if (!showData) {
    const panel = document.getElementById('chartPanel');
    if (projectData.tasks.length === 0) {
      panel.innerHTML = '<p>No project loaded</p>';
    } else {
      panel.innerHTML = renderChart(projectData);
    }
  }
}

// ── Public entry point ─────────────────────────────────────────────────────────
function initUI() {
  document.getElementById('tabData').addEventListener('click',  () => activateTab('data'));
  document.getElementById('tabChart').addEventListener('click', () => activateTab('chart'));

  document.getElementById('fileInput').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(ev) {
      const workbook = XLSX.read(new Uint8Array(ev.target.result), { type: 'array', cellDates: true });
      projectData = parseWorkbook(workbook);
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
