// parser.js — .xlsx parsing logic; exports parseWorkbook and createEmptyProjectData

// ── Parse-notice side-channel ──────────────────────────────────────────────────
// Collects records of non-empty source cells that the parser could not
// interpret. Reset at the start of each parseWorkbook call. Helpers below
// push to this buffer when they fall back to a default after a non-empty
// input. Empty/whitespace cells produce no notice.
let _notices = [];

function recordNotice(notice) {
  _notices.push(notice);
}

// True when val is a meaningful user-written input (not null/undefined/''
// and not whitespace-only). Decides whether a parser-defaulting case
// warrants a notice.
function isNoticeableInput(val) {
  if (val == null || val === '') return false;
  if (typeof val === 'string' && val.trim() === '') return false;
  if (val instanceof Date && isNaN(val.getTime())) return false;
  return true;
}

// ── Numeric helpers ────────────────────────────────────────────────────────────
function toInt(val, def = null, ctx) {
  if (val == null || val === '') return def;
  const n = parseInt(val, 10);
  if (Number.isFinite(n)) return n;
  if (ctx && isNoticeableInput(val)) {
    recordNotice({ ...ctx, rawValue: val, reason: 'unparseable_number' });
  }
  return def;
}

function toFloat(val, def = null, ctx) {
  if (val == null || val === '') return def;
  const n = parseFloat(val);
  if (Number.isFinite(n)) return n;
  if (ctx && isNoticeableInput(val)) {
    recordNotice({ ...ctx, rawValue: val, reason: 'unparseable_number' });
  }
  return def;
}

// ── Date helper ────────────────────────────────────────────────────────────────
// Wraps toISODate (dates.js) and emits 'unparseable_date' when a non-empty
// meaningful input does not produce a valid YYYY-MM-DD result. toISODate
// itself is unchanged — its current contract returns the raw string for
// non-slash inputs, so we validate the shape here and coerce to null
// otherwise.
function parseDate(val, ctx) {
  const raw = toISODate(val);
  const iso = (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) ? raw : null;
  if (iso === null && ctx && isNoticeableInput(val)) {
    recordNotice({ ...ctx, rawValue: val, reason: 'unparseable_date' });
  }
  return iso;
}

// ── Normalizers ────────────────────────────────────────────────────────────────
function normalizeLabelContent(val, ctx) {
  if (!val) return 'name';
  const v = String(val).trim().toLowerCase();
  if (v === '') return 'name';
  if (v === 'name only' || v === 'name') return 'name';
  if (v === 'date only' || v === 'date') return 'date';
  if (v.includes('name') && v.includes('date')) return 'name_and_date';
  if (v === 'none') return 'none';
  if (ctx) recordNotice({ ...ctx, rawValue: val, reason: 'unrecognised_enum' });
  return 'name';
}

function normalizeLabelPlacement(val, ctx) {
  if (!val) return 'inside';
  const v = String(val).trim().toLowerCase();
  if (v === '') return 'inside';
  if (v === 'outside' || v === 'inside') return v;
  if (ctx) recordNotice({ ...ctx, rawValue: val, reason: 'unrecognised_enum' });
  return 'inside';
}

function normalizeLabelPosition(val, ctx) {
  if (!val) return 'top-right';
  const v = String(val).trim().toLowerCase().replace(/\s+/g, '-');
  if (v === '' || v === '-') return 'top-right';
  if (['top-right', 'top-left', 'bottom-right', 'bottom-left'].includes(v)) return v;
  if (ctx) recordNotice({ ...ctx, rawValue: val, reason: 'unrecognised_enum' });
  return 'top-right';
}

function normalizeTextAlign(val, ctx) {
  if (!val) return 'center';
  const v = String(val).trim().toLowerCase();
  if (v === '') return 'center';
  if (v === 'left' || v === 'center' || v === 'right') return v;
  if (ctx) recordNotice({ ...ctx, rawValue: val, reason: 'unrecognised_enum' });
  return 'center';
}

function normalizeMilestoneShape(val, ctx) {
  if (!val) return 'diamond';
  const v = String(val).trim().toLowerCase();
  if (v === '') return 'diamond';
  if (v === 'circle' || v === 'diamond') return v;
  if (ctx) recordNotice({ ...ctx, rawValue: val, reason: 'unrecognised_enum' });
  return 'diamond';
}

function normalizeLineStyleLink(val, ctx) {
  if (!val) return 'solid';
  const v = String(val).trim().toLowerCase();
  if (v === '') return 'solid';
  if (v === 'solid' || v === 'dashed') return v;
  if (ctx) recordNotice({ ...ctx, rawValue: val, reason: 'unrecognised_enum' });
  return 'solid';
}

function normalizeLineStylePipe(val, ctx) {
  if (!val) return 'solid';
  const v = String(val).trim().toLowerCase();
  if (v === '') return 'solid';
  if (v === 'solid' || v === 'dashed' || v === 'dotted') return v;
  if (ctx) recordNotice({ ...ctx, rawValue: val, reason: 'unrecognised_enum' });
  return 'solid';
}

function normalizeFillPattern(val, ctx) {
  if (!val) return 'solid';
  const v = String(val).trim().toLowerCase();
  if (v === '') return 'solid';
  if (['solid', 'hatch', 'cross-hatch', 'horizontal', 'vertical', 'dots'].includes(v)) return v;
  if (ctx) recordNotice({ ...ctx, rawValue: val, reason: 'unrecognised_enum' });
  return 'solid';
}

function normalizeLabelAnchor(val, ctx) {
  if (!val) return 'start';
  const v = String(val).trim().toLowerCase();
  if (v === '') return 'start';
  if (v === 'start' || v === 'end') return v;
  if (ctx) recordNotice({ ...ctx, rawValue: val, reason: 'unrecognised_enum' });
  return 'start';
}

function normalizeNoteTextAlign(val, ctx) {
  if (!val) return 'left';
  const v = String(val).trim().toLowerCase();
  if (v === '') return 'left';
  if (v === 'left' || v === 'center' || v === 'right') return v;
  if (ctx) recordNotice({ ...ctx, rawValue: val, reason: 'unrecognised_enum' });
  return 'left';
}

function normalizeNoteVerticalAlign(val, ctx) {
  if (!val) return 'top';
  const v = String(val).trim().toLowerCase();
  if (v === '') return 'top';
  if (v === 'top' || v === 'middle' || v === 'bottom') return v;
  if (ctx) recordNotice({ ...ctx, rawValue: val, reason: 'unrecognised_enum' });
  return 'top';
}

function normalizeLinkRouting(val, ctx) {
  if (!val) return 'auto';
  const v = String(val).trim().toLowerCase();
  if (v === '') return 'auto';
  if (v === 'auto' || v === 'hv' || v === 'vh') return v;
  if (ctx) recordNotice({ ...ctx, rawValue: val, reason: 'unrecognised_enum' });
  return 'auto';
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

function kvInt(map, key, def, fallback, ctx) {
  let v = map[key];
  if ((v == null || v === '') && fallback !== undefined) v = map[fallback];
  if (v == null || v === '') return def;
  const n = parseInt(v, 10);
  if (Number.isFinite(n)) return n;
  if (ctx && isNoticeableInput(v)) {
    recordNotice({ ...ctx, rawValue: v, reason: 'unparseable_number' });
  }
  return def;
}

function kvFloat(map, key, def, fallback, ctx) {
  let v = map[key];
  if ((v == null || v === '') && fallback !== undefined) v = map[fallback];
  if (v == null || v === '') return def;
  const n = parseFloat(v);
  if (Number.isFinite(n)) return n;
  if (ctx && isNoticeableInput(v)) {
    recordNotice({ ...ctx, rawValue: v, reason: 'unparseable_number' });
  }
  return def;
}

function kvBool(map, key, def, fallback, ctx) {
  let v = map[key];
  if ((v == null || v === '') && fallback !== undefined) v = map[fallback];
  if (v == null || v === '') return def;
  if (typeof v === 'boolean') return v;
  const coerced = String(v).toLowerCase() === 'yes';
  if (ctx) {
    const trimmed = String(v).trim().toLowerCase();
    if (trimmed !== '' && trimmed !== 'yes' && trimmed !== 'no') {
      recordNotice({ ...ctx, rawValue: v, reason: 'unrecognised_boolean' });
    }
  }
  return coerced;
}

function kvDate(map, key, fallback, ctx) {
  let v = map[key];
  if ((v == null || v === '') && fallback !== undefined) v = map[fallback];
  if (v == null || v === '') return null;
  const raw = toISODate(v);
  const iso = (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) ? raw : null;
  if (iso === null && ctx && isNoticeableInput(v)) {
    recordNotice({ ...ctx, rawValue: v, reason: 'unparseable_date' });
  }
  return iso;
}

// ── Default shape ──────────────────────────────────────────────────────────────
// Single source of truth for the projectData shape and all default values.
// parseWorkbook calls this and overwrites from the workbook.
// ui.js calls this to initialise projectData before any file is loaded.
function createEmptyProjectData() {
  return {
    tasks: [], swimlanes: [], links: [], pipes: [], curtains: [], notes: [],
    _parseNotices: [],
    config: {
      layout: {
        outerWidth: 1200, outerHeight: 700,
        paddingTop: 20, paddingRight: 20, paddingBottom: 20, paddingLeft: 20,
        showRowDividers: true,
      },
      bars: {
        taskBarHeightFactor:       0.7,
        milestoneSizeFactor:       0.7,
        milestoneShape:            'diamond',
        milestoneCornerRadius:     0,
        taskCornerRadius:          2,
      },
      timeline: {
        chartStartDate: null, chartEndDate: null,
        chartStartDateExplicit: false, chartEndDateExplicit: false,
        showYears: true, showMonths: true, showWeeks: false, showDays: false, showDates: false,
        gridlineYears: true, gridlineMonths: true, gridlineWeeks: false, gridlineDays: false,
      },
      titles: {
        headerHeight: 20, headerText: '', headerTextAlign: 'center',
        footerHeight: 20, footerText: '', footerTextAlign: 'center',
      },
      style: {
        chartBackgroundColor:        'white',
        headerFooterBackgroundColor: 'lightgrey',
        headerFooterBorderColor:     'grey',
        headerFooterTextColor:       'black',
        swimlaneLabelColor:          'black',
        swimlaneDividerColor:        'grey',
        scaleBackgroundColor:        'lightgrey',
        scaleTickColor:              'grey',
        scaleLabelTextColor:         'black',
        gridlineVerticalColor:       'lightgrey',
        taskStrokeColor:             'black',
        milestoneStrokeColor:        'black',
        outsideLabelTextColor:       'black',
        leaderLineColor:             'black',
        insideLabelTextColor:        'black',
        noteTextColor:               'black',
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
        scaleMinLabelWidth:         20,
        scaleFontToBandHeightFactor: 2.5,
        charWidthFactor:            0.6,
        monthLetters:               ['J','F','M','A','M','J','J','A','S','O','N','D'],
        headerFooterTextPadding:    4,
        headerFooterBorderStrokeWidth: 0.5,
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
        patternTileSize:            8,
        patternStrokeWidth:         1,
        patternDotRadius:           1.5,
        leaderLineStrokeWidth:      0.5,
        outsideLabelKissingGap:     2,
        noteBorderStrokeWidth:      1,
        notePadding:                4,
        noteLineHeightFactor:       1.2,
        noteCornerRadius:           2,
      },
    }
  };
}

// ── Main parse function ────────────────────────────────────────────────────────
function parseWorkbook(workbook) {
  _notices = [];
  const projectData = createEmptyProjectData();
  const cfg = (field) => ({ entity: 'config', id: null, field });

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
      const id             = toInt(t.id, null, { entity: 'task', id: null, field: 'id' });
      const c              = (field) => ({ entity: 'task', id, field });
      const swimlaneId     = toInt(t.swimlaneId, null, c('swimlaneId'));
      const row            = toInt(t.row, 1, c('row'));
      const startDate      = parseDate(t.startDate, c('startDate'));
      const finishDate     = parseDate(t.finishDate, c('finishDate'));
      const labelContent   = normalizeLabelContent(t.labelContent, c('labelContent'));
      const labelPlacement = normalizeLabelPlacement(t.labelPlacement, c('labelPlacement'));
      const labelOffset    = toInt(t.labelOffset, 0, c('labelOffset'));
      const fillPattern    = normalizeFillPattern(t.fillPattern, c('fillPattern'));
      const isMilestone    = startDate !== null && startDate === finishDate;
      return {
        id, swimlaneId, row,
        name:           t.name,
        startDate, finishDate, isMilestone,
        labelContent, labelPlacement, labelOffset,
        fillColor:      t.fillColor,
        fillPattern,
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
    projectData.swimlanes = raw.map((s, i) => {
      const id            = toInt(s.id, null, { entity: 'swimlane', id: null, field: 'id' });
      const c             = (field) => ({ entity: 'swimlane', id, field });
      const rowCount      = toInt(s.rowCount, 1, c('rowCount'));
      const labelPosition = normalizeLabelPosition(s.labelPosition, c('labelPosition'));
      return {
        id,
        name:            s.name,
        rowCount,
        labelPosition,
        backgroundColor: s.backgroundColor,
        order:           i + 1,
      };
    });
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
    projectData.links = raw.map(l => {
      const id         = toInt(l.id, null, { entity: 'link', id: null, field: 'id' });
      const c          = (field) => ({ entity: 'link', id, field });
      const fromTaskId = toInt(l.fromTaskId, null, c('fromTaskId'));
      const toTaskId   = toInt(l.toTaskId, null, c('toTaskId'));
      const lineStyle  = normalizeLineStyleLink(l.lineStyle, c('lineStyle'));
      const routing    = normalizeLinkRouting(l.routing, c('routing'));
      return {
        id, fromTaskId, toTaskId,
        lineColor:  l.lineColor,
        lineStyle,
        routing,
      };
    });
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
    projectData.pipes = raw.map(p => {
      const id            = toInt(p.id, null, { entity: 'pipe', id: null, field: 'id' });
      const c             = (field) => ({ entity: 'pipe', id, field });
      const date          = parseDate(p.date, c('date'));
      const lineStyle     = normalizeLineStylePipe(p.lineStyle, c('lineStyle'));
      const labelPosition = toFloat(p.labelPosition, 1, c('labelPosition'));
      return {
        id,
        date,
        name:          p.name,
        color:         p.color,
        lineStyle,
        labelPosition,
      };
    });
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
    projectData.curtains = raw.map(cu => {
      const id            = toInt(cu.id, null, { entity: 'curtain', id: null, field: 'id' });
      const c             = (field) => ({ entity: 'curtain', id, field });
      const startDate     = parseDate(cu.startDate, c('startDate'));
      const endDate       = parseDate(cu.endDate, c('endDate'));
      const opacity       = toFloat(cu.opacity, 0.2, c('opacity'));
      const labelPosition = toFloat(cu.labelPosition, 1, c('labelPosition'));
      const labelAnchor   = normalizeLabelAnchor(cu.labelAnchor, c('labelAnchor'));
      return {
        id,
        startDate, endDate,
        name:          cu.name,
        color:         cu.color,
        opacity,
        labelPosition,
        labelAnchor,
      };
    });
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
      'Border Color':   { key: 'borderColor',   def: ''     },
      'Fill Color':     { key: 'fillColor',      def: ''     },
      'Text':           { key: 'text',           def: ''     },
    });
    projectData.notes = raw.map(n => {
      const id            = toInt(n.id, null, { entity: 'note', id: null, field: 'id' });
      const c             = (field) => ({ entity: 'note', id, field });
      const xPct          = toFloat(n.xPct, 0, c('xPct'));
      const yPct          = toFloat(n.yPct, 0, c('yPct'));
      const widthPct      = toFloat(n.widthPct, 0, c('widthPct'));
      const heightPct     = toFloat(n.heightPct, 0, c('heightPct'));
      const textAlign     = normalizeNoteTextAlign(n.textAlign, c('textAlign'));
      const verticalAlign = normalizeNoteVerticalAlign(n.verticalAlign, c('verticalAlign'));
      return {
        id,
        xPct, yPct, widthPct, heightPct,
        textAlign, verticalAlign,
        borderColor:   n.borderColor,
        fillColor:     n.fillColor,
        text:          n.text,
      };
    });
  }

  // ── Config: Layout ─────────────────────────────────────────────────────────
  const layoutKV = parseConfigSheet(workbook.Sheets['Layout']);
  projectData.config.layout = {
    outerWidth:      kvInt(layoutKV,  'Outer Width',    1200, undefined,       cfg('outerWidth')),
    outerHeight:     kvInt(layoutKV,  'Outer Height',   700,  undefined,       cfg('outerHeight')),
    paddingTop:      kvInt(layoutKV,  'Padding Top',    20,   'Margin Top',    cfg('paddingTop')),
    paddingRight:    kvInt(layoutKV,  'Padding Right',  20,   'Margin Right',  cfg('paddingRight')),
    paddingBottom:   kvInt(layoutKV,  'Padding Bottom', 20,   'Margin Bottom', cfg('paddingBottom')),
    paddingLeft:     kvInt(layoutKV,  'Padding Left',   20,   'Margin Left',   cfg('paddingLeft')),
    showRowDividers: kvBool(layoutKV, 'Row Dividers',   true, undefined,       cfg('showRowDividers')),
  };

  // ── Config: Bars ───────────────────────────────────────────────────────────
  const barsKV = parseConfigSheet(workbook.Sheets['Bars']);
  projectData.config.bars = {
    taskBarHeightFactor:       kvFloat(barsKV, 'Task Bar Height Factor',     0.7, undefined, cfg('taskBarHeightFactor')),
    milestoneSizeFactor:       kvFloat(barsKV, 'Milestone Size Factor',      0.7, undefined, cfg('milestoneSizeFactor')),
    milestoneShape:            normalizeMilestoneShape(barsKV['Milestone Shape'], cfg('milestoneShape')),
    milestoneCornerRadius:     kvFloat(barsKV, 'Milestone Corner Radius',    0,   undefined, cfg('milestoneCornerRadius')),
    taskCornerRadius:          kvInt(barsKV,   'Task Corner Radius',          2,  undefined, cfg('taskCornerRadius')),
  };

  // ── Config: Timeline ───────────────────────────────────────────────────────
  const timelineKV = parseConfigSheet(workbook.Sheets['Timeline']);
  let chartStartDate = kvDate(timelineKV, 'Chart Start Date', undefined, cfg('chartStartDate'));
  let chartEndDate   = kvDate(timelineKV, 'Chart End Date',   undefined, cfg('chartEndDate'));
  // Explicit = user wrote something non-empty in the cell, even if it
  // failed to parse (a 'garbage' Chart Start Date still expresses intent
  // and should round-trip through save as a now-valid derived value).
  const chartStartDateExplicit = isNoticeableInput(timelineKV['Chart Start Date']);
  const chartEndDateExplicit   = isNoticeableInput(timelineKV['Chart End Date']);
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
    showYears:      kvBool(timelineKV, 'Show Years',      true,  undefined,                  cfg('showYears')),
    showMonths:     kvBool(timelineKV, 'Show Months',     true,  undefined,                  cfg('showMonths')),
    showWeeks:      kvBool(timelineKV, 'Show Weeks',      false, undefined,                  cfg('showWeeks')),
    showDays:       kvBool(timelineKV, 'Show Days',       false, undefined,                  cfg('showDays')),
    showDates:      kvBool(timelineKV, 'Show Dates',      false, undefined,                  cfg('showDates')),
    gridlineYears:  kvBool(timelineKV, 'Gridline Years',  true,  'Vertical Gridline Years',  cfg('gridlineYears')),
    gridlineMonths: kvBool(timelineKV, 'Gridline Months', true,  'Vertical Gridline Months', cfg('gridlineMonths')),
    gridlineWeeks:  kvBool(timelineKV, 'Gridline Weeks',  false, 'Vertical Gridline Weeks',  cfg('gridlineWeeks')),
    gridlineDays:   kvBool(timelineKV, 'Gridline Days',   false, undefined,                  cfg('gridlineDays')),
  };

  // ── Config: Titles ─────────────────────────────────────────────────────────
  const titlesKV = parseConfigSheet(workbook.Sheets['Titles']);
  projectData.config.titles = {
    headerHeight:    kvInt(titlesKV, 'Header Height',     20, undefined, cfg('headerHeight')),
    headerText:      kvStr(titlesKV, 'Header Text',       ''),
    headerTextAlign: normalizeTextAlign(titlesKV['Header Text Align'], cfg('headerTextAlign')),
    footerHeight:    kvInt(titlesKV, 'Footer Height',     20, undefined, cfg('footerHeight')),
    footerText:      kvStr(titlesKV, 'Footer Text',       ''),
    footerTextAlign: normalizeTextAlign(titlesKV['Footer Text Align'], cfg('footerTextAlign')),
  };

  // ── Config: Style ──────────────────────────────────────────────────────────
  const styleKV = parseConfigSheet(workbook.Sheets['Style']);
  projectData.config.style = {
    chartBackgroundColor:        kvStr(styleKV, 'Chart Background Color',         'white',      'Chart Background Colour'),
    headerFooterBackgroundColor: kvStr(styleKV, 'Header Footer Background Color', 'lightgrey',  'Header Footer Background Colour'),
    headerFooterBorderColor:     kvStr(styleKV, 'Header Footer Border Color',     'grey'),
    headerFooterTextColor:       kvStr(styleKV, 'Header Footer Text Color',       'black'),
    swimlaneLabelColor:          kvStr(styleKV, 'Swimlane Label Color',           'black',      'Swimlane Label Colour'),
    swimlaneDividerColor:        kvStr(styleKV, 'Swimlane Divider Color',         'grey',       'Swimlane Divider Colour'),
    scaleBackgroundColor:        kvStr(styleKV, 'Scale Background Color',         'lightgrey',  'Scale Background Colour'),
    scaleTickColor:              kvStr(styleKV, 'Scale Tick Color',               'grey',       'Scale Tick Colour'),
    scaleLabelTextColor:         kvStr(styleKV, 'Scale Label Text Color',         'black'),
    gridlineVerticalColor:       kvStr(styleKV, 'Gridline Vertical Color',        'lightgrey',  'Gridline Vertical Colour'),
    taskStrokeColor:             kvStr(styleKV, 'Task Stroke Color',              'black',      'Task Stroke Colour'),
    milestoneStrokeColor:        kvStr(styleKV, 'Milestone Stroke Color',         'black',      'Milestone Stroke Colour'),
    outsideLabelTextColor:       kvStr(styleKV, 'Outside Label Text Color',       'black',      'Outside Label Text Colour'),
    leaderLineColor:             kvStr(styleKV, 'Leader Line Color',              'black',      'Outside Label Line Color'),
    insideLabelTextColor:        kvStr(styleKV, 'Inside Label Text Color',        'black'),
    noteTextColor:               kvStr(styleKV, 'Note Text Color',                'black'),
  };

  // ── Config: Typography ─────────────────────────────────────────────────────
  const typographyKV = parseConfigSheet(workbook.Sheets['Typography']);
  projectData.config.typography = {
    fontFamily:                   kvStr(typographyKV,   'Font Family',                     'Arial'),
    taskFontSize:                 kvInt(typographyKV,   'Task Font Size',                  10,  undefined,                                   cfg('taskFontSize')),
    scaleFontSize:                kvInt(typographyKV,   'Scale Font Size',                 10,  undefined,                                   cfg('scaleFontSize')),
    headerFooterFontSize:         kvInt(typographyKV,   'Header Footer Font Size',          10, 'Header & Footer Font Size',                 cfg('headerFooterFontSize')),
    noteFontSize:                 kvInt(typographyKV,   'Note Font Size',                  10,  undefined,                                   cfg('noteFontSize')),
    swimlaneFontSize:             kvInt(typographyKV,   'Swimlane Font Size',               10, undefined,                                   cfg('swimlaneFontSize')),
    pipeFontSize:                 kvInt(typographyKV,   'Pipe Font Size',                   10, undefined,                                   cfg('pipeFontSize')),
    curtainFontSize:              kvInt(typographyKV,   'Curtain Font Size',                10, undefined,                                   cfg('curtainFontSize')),
    scaleAlignmentFactor:         kvFloat(typographyKV, 'Scale Alignment Factor',           0.7, 'Scale Vertical Alignment Factor',           cfg('scaleAlignmentFactor')),
    taskAlignmentFactor:          kvFloat(typographyKV, 'Task Alignment Factor',            0.7, 'Task Vertical Alignment Factor',            cfg('taskAlignmentFactor')),
    headerFooterAlignmentFactor:  kvFloat(typographyKV, 'Header Footer Alignment Factor',   0.7, 'Header & Footer Vertical Alignment Factor', cfg('headerFooterAlignmentFactor')),
    swimlaneTopAlignmentFactor:   kvFloat(typographyKV, 'Swimlane Top Alignment Factor',    0.7, 'Swimlane Top Vertical Alignment Factor',    cfg('swimlaneTopAlignmentFactor')),
    swimlaneBottomAlignmentFactor:kvFloat(typographyKV, 'Swimlane Bottom Alignment Factor', 0.7, 'Swimlane Bottom Vertical Alignment Factor', cfg('swimlaneBottomAlignmentFactor')),
  };

  // ── Config: Preferences ────────────────────────────────────────────────────
  const prefsSheet = workbook.Sheets['Preferences'];
  const prefsKV    = parseConfigSheet(prefsSheet);
  projectData.config.preferences = {
    uiDateFormat:    kvStr(prefsKV, 'UI Date Format',    'dd/MM/yyyy'),
    chartDateFormat: kvStr(prefsKV, 'Chart Date Format', 'dd MMM'),
  };

  projectData._parseNotices = _notices;
  return projectData;
}
