// parser.js — owns projectData and all .xlsx parsing logic

// ── Top-level state ────────────────────────────────────────────────────────────
const projectData = {
  tasks:     [],
  swimlanes: [],
  links:     [],
  pipes:     [],
  curtains:  [],
  notes:     [],
  config: {
    layout:      {},
    timeline:    {},
    titles:      {},
    style:       {},
    typography:  {},
    preferences: {}
  }
};

// ── Date helper ────────────────────────────────────────────────────────────────
// Accepts a JS Date object (from SheetJS with cellDates:true) or a DD/MM/YYYY
// string (text-stored cells). Returns YYYY-MM-DD, or null if absent/unparseable.
// Never uses Date.toString() or toISOString() — timezone offsets can shift the date.
function toISODate(val) {
  if (val == null || val === '') return null;
  if (val instanceof Date) {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof val === 'string') {
    const parts = val.split('/');
    if (parts.length === 3) {
      // Interpret as DD/MM/YYYY — do not pass to new Date() (treats as MM/DD/YYYY)
      const [dd, mm, yyyy] = parts;
      return `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    }
    return val; // assume already YYYY-MM-DD
  }
  return null;
}

// ── Numeric helpers ────────────────────────────────────────────────────────────
function toInt(val, def = null) {
  if (val == null || val === '') return def;
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? n : def;
}

function toFloat(val, def = null) {
  if (val == null || val === '') return def;
  const n = parseFloat(val);
  return Number.isFinite(n) ? n : def;
}

// ── Normalizers ────────────────────────────────────────────────────────────────
function normalizeLabelContent(val) {
  if (!val) return 'name';
  const v = String(val).trim().toLowerCase();
  if (v === 'name only' || v === 'name') return 'name';
  if (v === 'date only' || v === 'date') return 'date';
  if (v.includes('name') && v.includes('date')) return 'name_and_date';
  if (v === 'none') return 'none';
  return 'name';
}

function normalizeLabelPlacement(val) {
  if (!val) return 'inside';
  return String(val).trim().toLowerCase() === 'outside' ? 'outside' : 'inside';
}

function normalizeLabelPosition(val) {
  if (!val) return 'top-right';
  const v = String(val).trim().toLowerCase().replace(/\s+/g, '-');
  return ['top-right', 'top-left', 'bottom-right', 'bottom-left'].includes(v) ? v : 'top-right';
}

// ── Entity sheet parser ────────────────────────────────────────────────────────
// colDefs: { 'Excel Column': { key, def, fallback? }, ... }
// Tries the primary column name first; falls back to the old name if absent.
// Missing columns silently receive their default — no throw.
function parseEntitySheet(worksheet, colDefs) {
  const rows = XLSX.utils.sheet_to_json(worksheet, { defval: undefined });
  return rows.map(row => {
    const obj = {};
    for (const [header, { key, def, fallback }] of Object.entries(colDefs)) {
      let raw = row[header];
      if ((raw == null || raw === '') && fallback !== undefined) {
        raw = row[fallback];
      }
      obj[key] = (raw != null && raw !== '') ? raw : def;
    }
    return obj;
  });
}

// ── Config sheet parser ────────────────────────────────────────────────────────
// Config sheets are key-value pairs: col A = field name, col B = value.
// Returns a plain { key: value } map for use with the kv* extractors below.
function parseConfigSheet(worksheet) {
  if (!worksheet) return {};
  const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
  const map = {};
  for (const row of rows) {
    const k = row[0];
    if (k != null && k !== '') {
      map[String(k).trim()] = (row[1] !== undefined) ? row[1] : '';
    }
  }
  return map;
}

function kvStr(map, key, def, fallback) {
  let v = map[key];
  if ((v == null || v === '') && fallback !== undefined) v = map[fallback];
  if (v == null || v === '') return def;
  return String(v);
}

function kvInt(map, key, def, fallback) {
  let v = map[key];
  if ((v == null || v === '') && fallback !== undefined) v = map[fallback];
  if (v == null || v === '') return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function kvFloat(map, key, def, fallback) {
  let v = map[key];
  if ((v == null || v === '') && fallback !== undefined) v = map[fallback];
  if (v == null || v === '') return def;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : def;
}

function kvBool(map, key, def, fallback) {
  let v = map[key];
  if ((v == null || v === '') && fallback !== undefined) v = map[fallback];
  if (v == null || v === '') return def;
  if (typeof v === 'boolean') return v;
  return String(v).toLowerCase() === 'yes';
}

function kvDate(map, key, fallback) {
  let v = map[key];
  if ((v == null || v === '') && fallback !== undefined) v = map[fallback];
  if (v == null || v === '') return null;
  return toISODate(v);
}

// ── Main parse function ────────────────────────────────────────────────────────
function parseWorkbook(workbook) {

  // Reset to empty state
  projectData.tasks     = [];
  projectData.swimlanes = [];
  projectData.links     = [];
  projectData.pipes     = [];
  projectData.curtains  = [];
  projectData.notes     = [];
  projectData.config    = {
    layout: {}, timeline: {}, titles: {}, style: {}, typography: {}, preferences: {}
  };

  // ── Tasks ──────────────────────────────────────────────────────────────────
  const tasksSheet = workbook.Sheets['Tasks'];
  if (tasksSheet) {
    const raw = parseEntitySheet(tasksSheet, {
      'ID':              { key: 'id',             def: null                   },
      'Swimlane ID':     { key: 'swimlaneId',      def: null                   },
      'Row':             { key: 'row',             def: 1,  fallback: 'Swimlane Row' },
      'Name':            { key: 'name',            def: ''                     },
      'Start Date':      { key: 'startDate',       def: null                   },
      'Finish Date':     { key: 'finishDate',      def: null                   },
      'Label Content':   { key: 'labelContent',    def: 'name'                 },
      'Label Placement': { key: 'labelPlacement',  def: 'inside'               },
      'Label Offset':    { key: 'labelOffset',     def: 0                      },
      'Fill Color':      { key: 'fillColor',       def: 'blue'                 },
      'Fill Pattern':    { key: 'fillPattern',     def: 'solid'                },
      'Pattern Color':   { key: 'patternColor',    def: 'white'                },
      'Date Format':     { key: 'dateFormat',      def: null                   },
    });
    projectData.tasks = raw.map(t => {
      const startDate  = toISODate(t.startDate);
      const finishDate = toISODate(t.finishDate);
      return {
        id:             toInt(t.id),
        swimlaneId:     toInt(t.swimlaneId),
        row:            toInt(t.row, 1),
        name:           t.name,
        startDate,
        finishDate,
        isMilestone:    startDate !== null && startDate === finishDate,
        labelContent:   normalizeLabelContent(t.labelContent),
        labelPlacement: normalizeLabelPlacement(t.labelPlacement),
        labelOffset:    toInt(t.labelOffset, 0),
        fillColor:      t.fillColor,
        fillPattern:    t.fillPattern,
        patternColor:   t.patternColor,
        dateFormat:     t.dateFormat,
      };
    });
  }

  // ── Swimlanes ──────────────────────────────────────────────────────────────
  const swimlanesSheet = workbook.Sheets['Swimlanes'];
  if (swimlanesSheet) {
    const raw = parseEntitySheet(swimlanesSheet, {
      'ID':               { key: 'id',              def: null,       },
      'Name':             { key: 'name',             def: '', fallback: 'Title' },
      'Row Count':        { key: 'rowCount',         def: 1           },
      'Label Position':   { key: 'labelPosition',    def: 'top-right' },
      'Background Color': { key: 'backgroundColor',  def: 'white'     },
    });
    projectData.swimlanes = raw.map((s, i) => ({
      id:              toInt(s.id),
      name:            s.name,
      rowCount:        toInt(s.rowCount, 1),
      labelPosition:   normalizeLabelPosition(s.labelPosition),
      backgroundColor: s.backgroundColor,
      order:           i + 1,
    }));
  }

  // ── Links ──────────────────────────────────────────────────────────────────
  const linksSheet = workbook.Sheets['Links'];
  if (linksSheet) {
    const raw = parseEntitySheet(linksSheet, {
      'ID':           { key: 'id',         def: null              },
      'From Task ID': { key: 'fromTaskId', def: null              },
      'To Task ID':   { key: 'toTaskId',   def: null              },
      'Line Color':   { key: 'lineColor',  def: 'black'           },
      'Line Style':   { key: 'lineStyle',  def: 'solid'           },
      'Routing':      { key: 'routing',    def: 'auto', fallback: 'Link Routing' },
    });
    projectData.links = raw.map(l => ({
      id:         toInt(l.id),
      fromTaskId: toInt(l.fromTaskId),
      toTaskId:   toInt(l.toTaskId),
      lineColor:  l.lineColor,
      lineStyle:  l.lineStyle,
      routing:    l.routing,
    }));
  }

  // ── Pipes ──────────────────────────────────────────────────────────────────
  const pipesSheet = workbook.Sheets['Pipes'];
  if (pipesSheet) {
    const raw = parseEntitySheet(pipesSheet, {
      'ID':         { key: 'id',        def: null    },
      'Date':       { key: 'date',      def: null    },
      'Name':       { key: 'name',      def: ''      },
      'Color':      { key: 'color',     def: 'black' },
      'Line Style': { key: 'lineStyle', def: 'solid' },
    });
    projectData.pipes = raw.map(p => ({
      id:        toInt(p.id),
      date:      toISODate(p.date),
      name:      p.name,
      color:     p.color,
      lineStyle: p.lineStyle,
    }));
  }

  // ── Curtains ───────────────────────────────────────────────────────────────
  const curtainsSheet = workbook.Sheets['Curtains'];
  if (curtainsSheet) {
    const raw = parseEntitySheet(curtainsSheet, {
      'ID':         { key: 'id',        def: null   },
      'Start Date': { key: 'startDate', def: null   },
      'End Date':   { key: 'endDate',   def: null   },
      'Name':       { key: 'name',      def: ''     },
      'Color':      { key: 'color',     def: 'grey' },
      'Opacity':    { key: 'opacity',   def: 0.2    },
    });
    projectData.curtains = raw.map(c => ({
      id:        toInt(c.id),
      startDate: toISODate(c.startDate),
      endDate:   toISODate(c.endDate),
      name:      c.name,
      color:     c.color,
      opacity:   toFloat(c.opacity, 0.2),
    }));
  }

  // ── Notes ──────────────────────────────────────────────────────────────────
  const notesSheet = workbook.Sheets['Notes'];
  if (notesSheet) {
    const raw = parseEntitySheet(notesSheet, {
      'ID':             { key: 'id',            def: null   },
      'X %':            { key: 'xPct',          def: 0      },
      'Y %':            { key: 'yPct',          def: 0      },
      'Width %':        { key: 'widthPct',      def: 0      },
      'Height %':       { key: 'heightPct',     def: 0      },
      'Text Align':     { key: 'textAlign',     def: 'left' },
      'Vertical Align': { key: 'verticalAlign', def: 'top'  },
      'Text':           { key: 'text',          def: ''     },
    });
    projectData.notes = raw.map(n => ({
      id:            toInt(n.id),
      xPct:          toFloat(n.xPct, 0),
      yPct:          toFloat(n.yPct, 0),
      widthPct:      toFloat(n.widthPct, 0),
      heightPct:     toFloat(n.heightPct, 0),
      textAlign:     n.textAlign,
      verticalAlign: n.verticalAlign,
      text:          n.text,
    }));
  }

  // ── Config: Layout ─────────────────────────────────────────────────────────
  const layoutKV = parseConfigSheet(workbook.Sheets['Layout']);
  projectData.config.layout = {
    outerWidth:      kvInt(layoutKV,  'Outer Width',    1200),
    outerHeight:     kvInt(layoutKV,  'Outer Height',   700),
    paddingTop:      kvInt(layoutKV,  'Padding Top',    20, 'Margin Top'),
    paddingRight:    kvInt(layoutKV,  'Padding Right',  20, 'Margin Right'),
    paddingBottom:   kvInt(layoutKV,  'Padding Bottom', 20, 'Margin Bottom'),
    paddingLeft:     kvInt(layoutKV,  'Padding Left',   20, 'Margin Left'),
    showRowNumbers:  kvBool(layoutKV, 'Row Numbers',    false),
    showRowDividers: kvBool(layoutKV, 'Row Dividers',   true),
  };

  // ── Config: Timeline ───────────────────────────────────────────────────────
  const timelineKV = parseConfigSheet(workbook.Sheets['Timeline']);
  let chartStartDate = kvDate(timelineKV, 'Chart Start Date');
  let chartEndDate   = kvDate(timelineKV, 'Chart End Date');
  // Derive from task dates if absent or unparseable
  if (!chartStartDate) {
    const dates = projectData.tasks.map(t => t.startDate).filter(Boolean).sort();
    chartStartDate = dates[0] || null;
  }
  if (!chartEndDate) {
    const dates = projectData.tasks.map(t => t.finishDate).filter(Boolean).sort();
    chartEndDate = dates[dates.length - 1] || null;
  }
  projectData.config.timeline = {
    chartStartDate,
    chartEndDate,
    showYears:      kvBool(timelineKV, 'Show Years',      true),
    showMonths:     kvBool(timelineKV, 'Show Months',     true),
    showWeeks:      kvBool(timelineKV, 'Show Weeks',      false),
    showDays:       kvBool(timelineKV, 'Show Days',       false),
    gridlineYears:  kvBool(timelineKV, 'Gridline Years',  true,  'Vertical Gridline Years'),
    gridlineMonths: kvBool(timelineKV, 'Gridline Months', true,  'Vertical Gridline Months'),
    gridlineWeeks:  kvBool(timelineKV, 'Gridline Weeks',  false, 'Vertical Gridline Weeks'),
    gridlineDays:   kvBool(timelineKV, 'Gridline Days',   false, 'Vertical Gridline Days'),
  };

  // ── Config: Titles ─────────────────────────────────────────────────────────
  const titlesKV = parseConfigSheet(workbook.Sheets['Titles']);
  projectData.config.titles = {
    headerHeight: kvInt(titlesKV, 'Header Height', 20),
    headerText:   kvStr(titlesKV, 'Header Text',   ''),
    footerHeight: kvInt(titlesKV, 'Footer Height', 20),
    footerText:   kvStr(titlesKV, 'Footer Text',   ''),
  };

  // ── Config: Style ──────────────────────────────────────────────────────────
  const styleKV = parseConfigSheet(workbook.Sheets['Style']);
  projectData.config.style = {
    chartBackgroundColor:        kvStr(styleKV, 'Chart Background Color',         'white',      'Chart Background Colour'),
    headerFooterBackgroundColor: kvStr(styleKV, 'Header Footer Background Color', 'lightgrey',  'Header Footer Background Colour'),
    swimlaneLabelColor:          kvStr(styleKV, 'Swimlane Label Color',           'black',      'Swimlane Label Colour'),
    swimlaneDividerColor:        kvStr(styleKV, 'Swimlane Divider Color',         'grey',       'Swimlane Divider Colour'),
    scaleBackgroundColor:        kvStr(styleKV, 'Scale Background Color',         'lightgrey',  'Scale Background Colour'),
    scaleTickColor:              kvStr(styleKV, 'Scale Tick Color',               'grey',       'Scale Tick Colour'),
    gridlineHorizontalColor:     kvStr(styleKV, 'Gridline Horizontal Color',      'lightgrey',  'Gridline Horizontal Colour'),
    gridlineVerticalColor:       kvStr(styleKV, 'Gridline Vertical Color',        'lightgrey',  'Gridline Vertical Colour'),
    taskStrokeColor:             kvStr(styleKV, 'Task Stroke Color',              'black',      'Task Stroke Colour'),
    milestoneStrokeColor:        kvStr(styleKV, 'Milestone Stroke Color',         'black',      'Milestone Stroke Colour'),
    outsideLabelTextColor:       kvStr(styleKV, 'Outside Label Text Color',       'black',      'Outside Label Text Colour'),
    outsideLabelLineColor:       kvStr(styleKV, 'Outside Label Line Color',       'black',      'Outside Label Line Colour'),
  };

  // ── Config: Typography ─────────────────────────────────────────────────────
  const typographyKV = parseConfigSheet(workbook.Sheets['Typography']);
  projectData.config.typography = {
    fontFamily:                   kvStr(typographyKV,   'Font Family',                     'Arial'),
    taskFontSize:                 kvInt(typographyKV,   'Task Font Size',                  10),
    scaleFontSize:                kvInt(typographyKV,   'Scale Font Size',                 10),
    headerFooterFontSize:         kvInt(typographyKV,   'Header Footer Font Size',          10,  'Header & Footer Font Size'),
    rowNumberFontSize:            kvInt(typographyKV,   'Row Number Font Size',             10),
    noteFontSize:                 kvInt(typographyKV,   'Note Font Size',                  10),
    swimlaneFontSize:             kvInt(typographyKV,   'Swimlane Font Size',               10),
    scaleAlignmentFactor:         kvFloat(typographyKV, 'Scale Alignment Factor',           0.7, 'Scale Vertical Alignment Factor'),
    taskAlignmentFactor:          kvFloat(typographyKV, 'Task Alignment Factor',            0.7, 'Task Vertical Alignment Factor'),
    rowNumberAlignmentFactor:     kvFloat(typographyKV, 'Row Number Alignment Factor',      0.7, 'Row Number Vertical Alignment Factor'),
    headerFooterAlignmentFactor:  kvFloat(typographyKV, 'Header Footer Alignment Factor',   0.7, 'Header & Footer Vertical Alignment Factor'),
    swimlaneTopAlignmentFactor:   kvFloat(typographyKV, 'Swimlane Top Alignment Factor',    0.7, 'Swimlane Top Vertical Alignment Factor'),
    swimlaneBottomAlignmentFactor:kvFloat(typographyKV, 'Swimlane Bottom Alignment Factor', 0.7, 'Swimlane Bottom Vertical Alignment Factor'),
  };

  // ── Config: Preferences ────────────────────────────────────────────────────
  const prefsSheet = workbook.Sheets['Preferences'];
  const prefsKV    = parseConfigSheet(prefsSheet);
  projectData.config.preferences = {
    uiDateFormat:    kvStr(prefsKV, 'UI Date Format',    'dd/MM/yyyy'),
    chartDateFormat: kvStr(prefsKV, 'Chart Date Format', 'dd MMM'),
  };
}
