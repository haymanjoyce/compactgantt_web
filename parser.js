// parser.js — .xlsx parsing logic; exports parseWorkbook and createEmptyProjectData

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

function kvDate(map, key, fallback /* reserved — old-format key fallback, unused today */) {
  let v = map[key];
  if ((v == null || v === '') && fallback !== undefined) v = map[fallback];
  if (v == null || v === '') return null;
  return toISODate(v);
}

// ── Default shape ──────────────────────────────────────────────────────────────
// Single source of truth for the projectData shape and all default values.
// parseWorkbook calls this and overwrites from the workbook.
// ui.js calls this to initialise projectData before any file is loaded.
function createEmptyProjectData() {
  return {
    tasks: [], swimlanes: [], links: [], pipes: [], curtains: [], notes: [],
    config: {
      layout: {
        outerWidth: 1200, outerHeight: 700,
        paddingTop: 20, paddingRight: 20, paddingBottom: 20, paddingLeft: 20,
        showRowDividers: true,
      },
      bars: {
        taskBarHeightFactor:       0.7,
        milestoneSizeFactor:       0.7,
        taskCornerRadius:          2,
        milestoneCornerSharpness:  1.0,
      },
      timeline: {
        chartStartDate: null, chartEndDate: null,
        chartStartDateExplicit: false, chartEndDateExplicit: false,
        showYears: true, showMonths: true, showWeeks: false, showDays: false, showDates: false,
        gridlineYears: true, gridlineMonths: true, gridlineWeeks: false, gridlineDays: false, gridlineDates: false,
      },
      titles: {
        headerHeight: 20, headerText: '',
        footerHeight: 20, footerText: '',
      },
      style: {
        chartBackgroundColor:        'white',
        headerFooterBackgroundColor: 'lightgrey',
        swimlaneLabelColor:          'black',
        swimlaneDividerColor:        'grey',
        scaleBackgroundColor:        'lightgrey',
        scaleTickColor:              'grey',
        gridlineVerticalColor:       'lightgrey',
        taskStrokeColor:             'black',
        milestoneStrokeColor:        'black',
        outsideLabelTextColor:       'black',
        outsideLabelLineColor:       'black',
        insideLabelTextColor:        'black',
      },
      typography: {
        fontFamily:                   'Arial',
        taskFontSize:                 10,
        scaleFontSize:                10,
        headerFooterFontSize:         10,
        noteFontSize:                 10,
        swimlaneFontSize:             10,
        pipeFontSize:                 10,
        curtainFontSize:              10,
        scaleAlignmentFactor:         0.7,
        taskAlignmentFactor:          0.7,
        headerFooterAlignmentFactor:  0.7,
        swimlaneTopAlignmentFactor:   0.7,
        swimlaneBottomAlignmentFactor:0.7,
      },
      preferences: {
        uiDateFormat:    'dd/MM/yyyy',
        chartDateFormat: 'dd MMM',
      },
      rendering: {
        arrowheadSizeFactor:           0.3,
        originMarkerSizeFactor:        0.15,
        linkArrowheadMilestoneGap:     2,
        swimlaneLabelPadding:       4,
        minScaleBandHeight:         20,
        gridlineStrokeWidth:        0.5,
        scaleTickStrokeWidth:       0.5,
        taskStrokeWidth:            0.5,
        milestoneStrokeWidth:       0.5,
        swimlaneDividerStrokeWidth: 1,
        linkStrokeWidth:            1,
        linkCornerRadius:           3,
        insideLabelPadding:         2,
        pipeStrokeWidth:            1,
        pipeBadgePaddingX:          4,
        pipeBadgePaddingY:          2,
        curtainStrokeWidth:         1,
        curtainBadgePaddingX:       4,
        curtainBadgePaddingY:       2,
      },
    }
  };
}

// ── Main parse function ────────────────────────────────────────────────────────
function parseWorkbook(workbook) {
  const projectData = createEmptyProjectData();

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
      const startDate      = toISODate(t.startDate);
      const finishDate     = toISODate(t.finishDate);
      const isMilestone    = startDate !== null && startDate === finishDate;
      const labelPlacement = normalizeLabelPlacement(t.labelPlacement);
      return {
        id:             toInt(t.id),
        swimlaneId:     toInt(t.swimlaneId),
        row:            toInt(t.row, 1),
        name:           t.name,
        startDate,
        finishDate,
        isMilestone,
        labelContent:   normalizeLabelContent(t.labelContent),
        labelPlacement,
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
      'ID':             { key: 'id',            def: null    },
      'Date':           { key: 'date',          def: null    },
      'Name':           { key: 'name',          def: ''      },
      'Color':          { key: 'color',         def: 'black' },
      'Line Style':     { key: 'lineStyle',     def: 'solid' },
      'Label Position': { key: 'labelPosition', def: 1       },
    });
    projectData.pipes = raw.map(p => ({
      id:            toInt(p.id),
      date:          toISODate(p.date),
      name:          p.name,
      color:         p.color,
      lineStyle:     p.lineStyle,
      labelPosition: toFloat(p.labelPosition, 1),
    }));
  }

  // ── Curtains ───────────────────────────────────────────────────────────────
  const curtainsSheet = workbook.Sheets['Curtains'];
  if (curtainsSheet) {
    const raw = parseEntitySheet(curtainsSheet, {
      'ID':             { key: 'id',            def: null    },
      'Start Date':     { key: 'startDate',     def: null    },
      'End Date':       { key: 'endDate',       def: null    },
      'Name':           { key: 'name',          def: ''      },
      'Color':          { key: 'color',         def: 'grey'  },
      'Opacity':        { key: 'opacity',       def: 0.2     },
      'Label Position': { key: 'labelPosition', def: 1       },
      'Label Anchor':   { key: 'labelAnchor',   def: 'start' },
    });
    projectData.curtains = raw.map(c => ({
      id:            toInt(c.id),
      startDate:     toISODate(c.startDate),
      endDate:       toISODate(c.endDate),
      name:          c.name,
      color:         c.color,
      opacity:       toFloat(c.opacity, 0.2),
      labelPosition: toFloat(c.labelPosition, 1),
      labelAnchor:   c.labelAnchor,
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
    showRowDividers: kvBool(layoutKV, 'Row Dividers',   true),
  };

  // ── Config: Bars ───────────────────────────────────────────────────────────
  const barsKV = parseConfigSheet(workbook.Sheets['Bars']);
  projectData.config.bars = {
    taskBarHeightFactor:       kvFloat(barsKV, 'Task Bar Height Factor',      0.7),
    milestoneSizeFactor:       kvFloat(barsKV, 'Milestone Size Factor',       0.7),
    taskCornerRadius:          kvInt(barsKV,   'Task Corner Radius',           2),
    milestoneCornerSharpness:  kvFloat(barsKV, 'Milestone Corner Sharpness',  1.0),
  };

  // ── Config: Timeline ───────────────────────────────────────────────────────
  const timelineKV = parseConfigSheet(workbook.Sheets['Timeline']);
  let chartStartDate = kvDate(timelineKV, 'Chart Start Date');
  let chartEndDate   = kvDate(timelineKV, 'Chart End Date');
  const chartStartDateExplicit = chartStartDate !== null;
  const chartEndDateExplicit   = chartEndDate !== null;
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
    chartStartDateExplicit,
    chartEndDateExplicit,
    showYears:      kvBool(timelineKV, 'Show Years',      true),
    showMonths:     kvBool(timelineKV, 'Show Months',     true),
    showWeeks:      kvBool(timelineKV, 'Show Weeks',      false),
    showDays:       kvBool(timelineKV, 'Show Days',       false),
    showDates:      kvBool(timelineKV, 'Show Dates',      false),
    gridlineYears:  kvBool(timelineKV, 'Gridline Years',  true,  'Vertical Gridline Years'),
    gridlineMonths: kvBool(timelineKV, 'Gridline Months', true,  'Vertical Gridline Months'),
    gridlineWeeks:  kvBool(timelineKV, 'Gridline Weeks',  false, 'Vertical Gridline Weeks'),
    gridlineDays:   kvBool(timelineKV, 'Gridline Days',   false),
    gridlineDates:  kvBool(timelineKV, 'Gridline Dates',  false),
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
    gridlineVerticalColor:       kvStr(styleKV, 'Gridline Vertical Color',        'lightgrey',  'Gridline Vertical Colour'),
    taskStrokeColor:             kvStr(styleKV, 'Task Stroke Color',              'black',      'Task Stroke Colour'),
    milestoneStrokeColor:        kvStr(styleKV, 'Milestone Stroke Color',         'black',      'Milestone Stroke Colour'),
    outsideLabelTextColor:       kvStr(styleKV, 'Outside Label Text Color',       'black',      'Outside Label Text Colour'),
    outsideLabelLineColor:       kvStr(styleKV, 'Outside Label Line Color',       'black',      'Outside Label Line Colour'),
    insideLabelTextColor:        kvStr(styleKV, 'Inside Label Text Color',        'black'),
  };

  // ── Config: Typography ─────────────────────────────────────────────────────
  const typographyKV = parseConfigSheet(workbook.Sheets['Typography']);
  projectData.config.typography = {
    fontFamily:                   kvStr(typographyKV,   'Font Family',                     'Arial'),
    taskFontSize:                 kvInt(typographyKV,   'Task Font Size',                  10),
    scaleFontSize:                kvInt(typographyKV,   'Scale Font Size',                 10),
    headerFooterFontSize:         kvInt(typographyKV,   'Header Footer Font Size',          10,  'Header & Footer Font Size'),
    noteFontSize:                 kvInt(typographyKV,   'Note Font Size',                  10),
    swimlaneFontSize:             kvInt(typographyKV,   'Swimlane Font Size',               10),
    pipeFontSize:                 kvInt(typographyKV,   'Pipe Font Size',                   10),
    curtainFontSize:              kvInt(typographyKV,   'Curtain Font Size',                10),
    scaleAlignmentFactor:         kvFloat(typographyKV, 'Scale Alignment Factor',           0.7, 'Scale Vertical Alignment Factor'),
    taskAlignmentFactor:          kvFloat(typographyKV, 'Task Alignment Factor',            0.7, 'Task Vertical Alignment Factor'),
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

  return projectData;
}
