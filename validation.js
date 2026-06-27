// validation.js — exports validateProject(projectData) → ValidationReport.
// Pure function; no DOM, no side effects; never mutates projectData; never throws.

// ── CSS Color recognition ──────────────────────────────────────────────────────
const CSS_COLOR_NAMES = new Set([
  'aliceblue','antiquewhite','aqua','aquamarine','azure','beige','bisque','black',
  'blanchedalmond','blue','blueviolet','brown','burlywood','cadetblue','chartreuse',
  'chocolate','coral','cornflowerblue','cornsilk','crimson','cyan','darkblue',
  'darkcyan','darkgoldenrod','darkgray','darkgreen','darkgrey','darkkhaki',
  'darkmagenta','darkolivegreen','darkorange','darkorchid','darkred','darksalmon',
  'darkseagreen','darkslateblue','darkslategray','darkslategrey','darkturquoise',
  'darkviolet','deeppink','deepskyblue','dimgray','dimgrey','dodgerblue','firebrick',
  'floralwhite','forestgreen','fuchsia','gainsboro','ghostwhite','gold','goldenrod',
  'gray','green','greenyellow','grey','honeydew','hotpink','indianred','indigo','ivory',
  'khaki','lavender','lavenderblush','lawngreen','lemonchiffon','lightblue',
  'lightcoral','lightcyan','lightgoldenrodyellow','lightgray','lightgreen',
  'lightgrey','lightpink','lightsalmon','lightseagreen','lightskyblue',
  'lightslategray','lightslategrey','lightsteelblue','lightyellow','lime',
  'limegreen','linen','magenta','maroon','mediumaquamarine','mediumblue',
  'mediumorchid','mediumpurple','mediumseagreen','mediumslateblue',
  'mediumspringgreen','mediumturquoise','mediumvioletred','midnightblue',
  'mintcream','mistyrose','moccasin','navajowhite','navy','oldlace','olive','olivedrab',
  'orange','orangered','orchid','palegoldenrod','palegreen','paleturquoise',
  'palevioletred','papayawhip','peachpuff','peru','pink','plum','powderblue','purple',
  'rebeccapurple','red','rosybrown','royalblue','saddlebrown','salmon','sandybrown',
  'seagreen','seashell','sienna','silver','skyblue','slateblue','slategray','slategrey',
  'snow','springgreen','steelblue','tan','teal','thistle','tomato','turquoise','violet',
  'wheat','white','whitesmoke','yellow','yellowgreen','transparent','currentcolor',
]);

const HEX_RE  = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNC_RE = /^(rgb|rgba|hsl|hsla)\(\s*[^)]+\)$/i;

function isValidCssColor(str) {
  if (str == null) return false;
  const s = String(str).trim().toLowerCase();
  if (s === '') return false;
  if (CSS_COLOR_NAMES.has(s)) return true;
  if (HEX_RE.test(s)) return true;
  if (FUNC_RE.test(s)) return true;
  return false;
}

function isInteger(val)       { return Number.isInteger(val); }
function isFiniteNumber(val)  { return typeof val === 'number' && Number.isFinite(val); }

function findDuplicateIds(rows) {
  const counts = new Map();
  for (const r of rows) {
    if (r.id == null) continue;
    counts.set(r.id, (counts.get(r.id) || 0) + 1);
  }
  const dupes = new Set();
  for (const [id, n] of counts) if (n > 1) dupes.add(id);
  return dupes;
}

// ── Issue helpers ──────────────────────────────────────────────────────────────
function mkIssue(entity, id, field, message, value) {
  return { entity, id, field, message, value };
}

function noticeMessage(reason) {
  switch (reason) {
    case 'unparseable_date':     return 'Unparseable date';
    case 'unparseable_number':   return 'Unparseable number';
    case 'unrecognised_boolean': return 'Unrecognised boolean value';
    case 'unrecognised_enum':    return 'Unrecognised value';
    case 'id_assigned':          return 'ID assigned by parser (source cell was blank or unparseable)';
    default:                     return 'Parse notice';
  }
}

// Guard: "Missing X" fires only when value is null AND no parser notice exists
// for (entity, id, field) with an unparseable reason. Looks at all notices
// (consumed or not) — the guard is shape-based, not consumption-based.
function isMissingField(value, parseNotices, entity, id, field) {
  if (value !== null) return false;
  for (const n of parseNotices) {
    if (n.entity !== entity || n.id !== id || n.field !== field) continue;
    if (n.reason === 'unparseable_number' || n.reason === 'unparseable_date') return false;
  }
  return true;
}

// Find and mark-consumed the first unconsumed notice matching this signature.
// Returns the notice or null. The "consumed" set ensures that when multiple
// rows share id=null (because their id cells were missing/unparseable), each
// notice is attributed to exactly one row.
function consumeNotice(parseNotices, consumed, entity, id, field, reason) {
  for (const n of parseNotices) {
    if (consumed.has(n)) continue;
    if (n.entity !== entity || n.id !== id || n.field !== field || n.reason !== reason) continue;
    consumed.add(n);
    return n;
  }
  return null;
}

// ── Tasks ──────────────────────────────────────────────────────────────────────
function validateTasks(projectData) {
  const errors = [], warnings = [], notices = [];
  const pN = projectData._parseNotices || [];
  const consumed = new Set();
  const tasks = projectData.tasks;

  const dupIds = findDuplicateIds(tasks);
  const swimlaneIds = new Set(projectData.swimlanes.filter(s => s.id != null).map(s => s.id));
  const swimlaneById = new Map(projectData.swimlanes.filter(s => s.id != null).map(s => [s.id, s]));
  const cs = projectData.config.timeline.chartStartDate;
  const ce = projectData.config.timeline.chartEndDate;

  for (const t of tasks) {
    const id = t.id;

    // Errors
    if (id !== null && dupIds.has(id)) {
      errors.push(mkIssue('task', id, 'id', `Duplicate id ${id}`, id));
    }
    for (const f of ['swimlaneId', 'row', 'labelOffset']) {
      const n = consumeNotice(pN, consumed, 'task', id, f, 'unparseable_number');
      if (n) errors.push(mkIssue('task', id, f, noticeMessage(n.reason), n.rawValue));
    }
    if (isMissingField(t.swimlaneId, pN, 'task', id, 'swimlaneId')) {
      errors.push(mkIssue('task', id, 'swimlaneId', 'Missing swimlaneId', null));
    }
    if (t.swimlaneId !== null && !swimlaneIds.has(t.swimlaneId)) {
      errors.push(mkIssue('task', id, 'swimlaneId', `Orphan swimlaneId ${t.swimlaneId}`, t.swimlaneId));
    }
    if (isMissingField(t.startDate, pN, 'task', id, 'startDate')) {
      errors.push(mkIssue('task', id, 'startDate', 'Missing startDate', null));
    }
    if (isMissingField(t.finishDate, pN, 'task', id, 'finishDate')) {
      errors.push(mkIssue('task', id, 'finishDate', 'Missing finishDate', null));
    }
    for (const f of ['startDate', 'finishDate']) {
      const n = consumeNotice(pN, consumed, 'task', id, f, 'unparseable_date');
      if (n) errors.push(mkIssue('task', id, f, noticeMessage(n.reason), n.rawValue));
    }
    if (t.startDate !== null && t.finishDate !== null && t.finishDate < t.startDate) {
      errors.push(mkIssue('task', id, 'finishDate', 'finishDate earlier than startDate', t.finishDate));
    }
    if (isInteger(t.row) && t.row < 1) {
      errors.push(mkIssue('task', id, 'row', 'row less than 1', t.row));
    }
    if (isInteger(t.labelOffset) && t.labelOffset < 0) {
      errors.push(mkIssue('task', id, 'labelOffset', 'labelOffset less than 0', t.labelOffset));
    }
    if (t.fillColor === '') {
      errors.push(mkIssue('task', id, 'fillColor', 'Empty fillColor', ''));
    }

    // Warnings
    const sl = swimlaneById.get(t.swimlaneId);
    if (sl && isInteger(t.row) && isInteger(sl.rowCount) && t.row > sl.rowCount) {
      warnings.push(mkIssue('task', id, 'row', `row ${t.row} exceeds swimlane rowCount ${sl.rowCount}`, t.row));
    }
    if (t.fillColor !== '' && t.fillColor != null && !isValidCssColor(t.fillColor)) {
      warnings.push(mkIssue('task', id, 'fillColor', 'Invalid CSS color', t.fillColor));
    }
    if (t.patternColor !== '' && t.patternColor != null && !isValidCssColor(t.patternColor)) {
      warnings.push(mkIssue('task', id, 'patternColor', 'Invalid CSS color', t.patternColor));
    }
    {
      const n = consumeNotice(pN, consumed, 'task', id, 'fillPattern', 'unrecognised_enum');
      if (n) warnings.push(mkIssue('task', id, 'fillPattern', noticeMessage(n.reason), n.rawValue));
    }
    if (cs !== null && ce !== null && t.startDate !== null && t.finishDate !== null) {
      if (t.finishDate < cs || t.startDate > ce) {
        warnings.push(mkIssue('task', id, 'startDate', 'Task fully outside chart date range', t.startDate));
      }
    }

    // Notices
    {
      const n = consumeNotice(pN, consumed, 'task', id, 'id', 'id_assigned');
      if (n) notices.push(mkIssue('task', id, 'id', noticeMessage(n.reason), n.rawValue));
    }
    {
      const n = consumeNotice(pN, consumed, 'task', id, 'labelContent', 'unrecognised_enum');
      if (n) notices.push(mkIssue('task', id, 'labelContent', noticeMessage(n.reason), n.rawValue));
    }
    {
      const n = consumeNotice(pN, consumed, 'task', id, 'labelPlacement', 'unrecognised_enum');
      if (n) notices.push(mkIssue('task', id, 'labelPlacement', noticeMessage(n.reason), n.rawValue));
    }
    if (isInteger(t.labelOffset) && t.labelOffset > 0 && t.labelPlacement === 'inside' && t.isMilestone === false) {
      notices.push(mkIssue('task', id, 'labelOffset', 'labelOffset > 0 with labelPlacement "inside" (inert for non-milestone)', t.labelOffset));
    }
    if (t.fillPattern === 'solid' && t.patternColor !== 'white') {
      notices.push(mkIssue('task', id, 'patternColor', 'patternColor non-default with fillPattern "solid" (inert)', t.patternColor));
    }
    if (t.dateFormat === '') {
      notices.push(mkIssue('task', id, 'dateFormat', 'dateFormat is empty string (treated as null at render)', ''));
    }
  }

  return { errors, warnings, notices };
}

// ── Swimlanes ──────────────────────────────────────────────────────────────────
function validateSwimlanes(projectData) {
  const errors = [], warnings = [], notices = [];
  const pN = projectData._parseNotices || [];
  const consumed = new Set();
  const swimlanes = projectData.swimlanes;

  const dupIds = findDuplicateIds(swimlanes);

  // Count tasks per swimlane id (for "zero tasks" warning).
  const taskCount = new Map();
  for (const t of projectData.tasks) {
    if (t.swimlaneId !== null) {
      taskCount.set(t.swimlaneId, (taskCount.get(t.swimlaneId) || 0) + 1);
    }
  }

  for (const s of swimlanes) {
    const id = s.id;

    // Errors
    if (id !== null && dupIds.has(id)) {
      errors.push(mkIssue('swimlane', id, 'id', `Duplicate id ${id}`, id));
    }
    for (const f of ['rowCount']) {
      const n = consumeNotice(pN, consumed, 'swimlane', id, f, 'unparseable_number');
      if (n) errors.push(mkIssue('swimlane', id, f, noticeMessage(n.reason), n.rawValue));
    }
    if (isInteger(s.rowCount) && s.rowCount < 1) {
      errors.push(mkIssue('swimlane', id, 'rowCount', 'rowCount less than 1', s.rowCount));
    }
    if (s.backgroundColor === '') {
      errors.push(mkIssue('swimlane', id, 'backgroundColor', 'Empty backgroundColor', ''));
    }

    // Warnings
    if (s.backgroundColor !== '' && s.backgroundColor != null && !isValidCssColor(s.backgroundColor)) {
      warnings.push(mkIssue('swimlane', id, 'backgroundColor', 'Invalid CSS color', s.backgroundColor));
    }
    if (id !== null && (taskCount.get(id) || 0) === 0) {
      warnings.push(mkIssue('swimlane', id, 'id', 'Swimlane has zero tasks', id));
    }

    // Notices
    {
      const n = consumeNotice(pN, consumed, 'swimlane', id, 'id', 'id_assigned');
      if (n) notices.push(mkIssue('swimlane', id, 'id', noticeMessage(n.reason), n.rawValue));
    }
    {
      const n = consumeNotice(pN, consumed, 'swimlane', id, 'labelPosition', 'unrecognised_enum');
      if (n) notices.push(mkIssue('swimlane', id, 'labelPosition', noticeMessage(n.reason), n.rawValue));
    }
  }

  return { errors, warnings, notices };
}

// ── Links ──────────────────────────────────────────────────────────────────────
function validateLinks(projectData) {
  const errors = [], warnings = [], notices = [];
  const pN = projectData._parseNotices || [];
  const consumed = new Set();
  const links = projectData.links;

  const dupIds = findDuplicateIds(links);
  const taskIds = new Set(projectData.tasks.filter(t => t.id != null).map(t => t.id));
  const taskById = new Map(projectData.tasks.filter(t => t.id != null).map(t => [t.id, t]));

  // Build absRow lookup — duplicates renderer logic (see CLAUDE.md "Link rendering").
  const swimlanesByOrder = projectData.swimlanes
    .filter(s => s.id != null)
    .slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  const startRowOf = new Map();
  let cum = 0;
  for (const s of swimlanesByOrder) {
    startRowOf.set(s.id, cum + 1);
    cum += (isInteger(s.rowCount) && s.rowCount > 0 ? s.rowCount : 1);
  }
  const absRowOf = new Map();
  for (const t of projectData.tasks) {
    if (t.id == null || t.swimlaneId == null) continue;
    const start = startRowOf.get(t.swimlaneId);
    if (start == null) continue;
    const row = isInteger(t.row) && t.row >= 1 ? t.row : 1;
    absRowOf.set(t.id, start + row - 1);
  }

  // Duplicate (fromTaskId, toTaskId) pairs.
  const pairCount = new Map();
  for (const l of links) {
    if (l.fromTaskId != null && l.toTaskId != null) {
      const key = `${l.fromTaskId}|${l.toTaskId}`;
      pairCount.set(key, (pairCount.get(key) || 0) + 1);
    }
  }
  const dupPairs = new Set();
  for (const [k, c] of pairCount) if (c > 1) dupPairs.add(k);

  for (const l of links) {
    const id = l.id;

    // Errors
    if (id !== null && dupIds.has(id)) {
      errors.push(mkIssue('link', id, 'id', `Duplicate id ${id}`, id));
    }
    for (const f of ['fromTaskId', 'toTaskId']) {
      const n = consumeNotice(pN, consumed, 'link', id, f, 'unparseable_number');
      if (n) errors.push(mkIssue('link', id, f, noticeMessage(n.reason), n.rawValue));
    }
    if (isMissingField(l.fromTaskId, pN, 'link', id, 'fromTaskId')) {
      errors.push(mkIssue('link', id, 'fromTaskId', 'Missing fromTaskId', null));
    }
    if (isMissingField(l.toTaskId, pN, 'link', id, 'toTaskId')) {
      errors.push(mkIssue('link', id, 'toTaskId', 'Missing toTaskId', null));
    }
    if (l.fromTaskId !== null && !taskIds.has(l.fromTaskId)) {
      errors.push(mkIssue('link', id, 'fromTaskId', `Orphan fromTaskId ${l.fromTaskId}`, l.fromTaskId));
    }
    if (l.toTaskId !== null && !taskIds.has(l.toTaskId)) {
      errors.push(mkIssue('link', id, 'toTaskId', `Orphan toTaskId ${l.toTaskId}`, l.toTaskId));
    }
    if (l.fromTaskId !== null && l.toTaskId !== null && l.fromTaskId === l.toTaskId) {
      errors.push(mkIssue('link', id, 'fromTaskId', 'Self-link (fromTaskId === toTaskId)', l.fromTaskId));
    }
    if (l.lineColor === '') {
      errors.push(mkIssue('link', id, 'lineColor', 'Empty lineColor', ''));
    }

    // Warnings
    if (l.lineColor !== '' && l.lineColor != null && !isValidCssColor(l.lineColor)) {
      warnings.push(mkIssue('link', id, 'lineColor', 'Invalid CSS color', l.lineColor));
    }
    {
      const n = consumeNotice(pN, consumed, 'link', id, 'lineStyle', 'unrecognised_enum');
      if (n) warnings.push(mkIssue('link', id, 'lineStyle', noticeMessage(n.reason), n.rawValue));
    }
    {
      const n = consumeNotice(pN, consumed, 'link', id, 'routing', 'unrecognised_enum');
      if (n) warnings.push(mkIssue('link', id, 'routing', noticeMessage(n.reason), n.rawValue));
    }

    // Classification — skip if either end is orphan, has missing/unparseable
    // dates, or is a self-link (already flagged as its own error above).
    const pred = l.fromTaskId !== null ? taskById.get(l.fromTaskId) : null;
    const succ = l.toTaskId   !== null ? taskById.get(l.toTaskId)   : null;
    if (pred && succ
        && l.fromTaskId !== l.toTaskId
        && pred.startDate !== null && pred.finishDate !== null
        && succ.startDate !== null && succ.finishDate !== null
        && pred.finishDate > succ.startDate) {
      // R1 — pred runs at or past succ's finish
      if (pred.finishDate >= succ.finishDate) {
        warnings.push(mkIssue('link', id, 'fromTaskId',
          'Invalid link: predecessor finish ≥ successor finish', l.fromTaskId));
      }
      // R2 — late-recoverable but same absolute row
      const isLate = pred.finishDate < succ.finishDate;
      if (isLate) {
        const aP = absRowOf.get(pred.id);
        const aS = absRowOf.get(succ.id);
        if (aP !== undefined && aS !== undefined && aP === aS) {
          warnings.push(mkIssue('link', id, 'fromTaskId',
            'Invalid link: late-recoverable on same row', l.fromTaskId));
        }
      }
    }

    // Notices
    {
      const n = consumeNotice(pN, consumed, 'link', id, 'id', 'id_assigned');
      if (n) notices.push(mkIssue('link', id, 'id', noticeMessage(n.reason), n.rawValue));
    }
    if (l.fromTaskId !== null && l.toTaskId !== null
        && dupPairs.has(`${l.fromTaskId}|${l.toTaskId}`)) {
      notices.push(mkIssue('link', id, 'fromTaskId',
        `Duplicate (fromTaskId, toTaskId) pair (${l.fromTaskId}, ${l.toTaskId})`,
        [l.fromTaskId, l.toTaskId]));
    }
  }

  return { errors, warnings, notices };
}

// ── Pipes ──────────────────────────────────────────────────────────────────────
function validatePipes(projectData) {
  const errors = [], warnings = [], notices = [];
  const pN = projectData._parseNotices || [];
  const consumed = new Set();
  const pipes = projectData.pipes;

  const dupIds = findDuplicateIds(pipes);
  const cs = projectData.config.timeline.chartStartDate;
  const ce = projectData.config.timeline.chartEndDate;

  for (const p of pipes) {
    const id = p.id;

    // Errors
    if (id !== null && dupIds.has(id)) {
      errors.push(mkIssue('pipe', id, 'id', `Duplicate id ${id}`, id));
    }
    if (isMissingField(p.date, pN, 'pipe', id, 'date')) {
      errors.push(mkIssue('pipe', id, 'date', 'Missing date', null));
    }
    {
      const n = consumeNotice(pN, consumed, 'pipe', id, 'date', 'unparseable_date');
      if (n) errors.push(mkIssue('pipe', id, 'date', noticeMessage(n.reason), n.rawValue));
    }
    {
      const n = consumeNotice(pN, consumed, 'pipe', id, 'labelPosition', 'unparseable_number');
      if (n) errors.push(mkIssue('pipe', id, 'labelPosition', noticeMessage(n.reason), n.rawValue));
    }
    if (p.color === '') {
      errors.push(mkIssue('pipe', id, 'color', 'Empty color', ''));
    }

    // Warnings
    if (p.color !== '' && p.color != null && !isValidCssColor(p.color)) {
      warnings.push(mkIssue('pipe', id, 'color', 'Invalid CSS color', p.color));
    }
    {
      const n = consumeNotice(pN, consumed, 'pipe', id, 'lineStyle', 'unrecognised_enum');
      if (n) warnings.push(mkIssue('pipe', id, 'lineStyle', noticeMessage(n.reason), n.rawValue));
    }
    {
      const n = consumeNotice(pN, consumed, 'pipe', id, 'invertLabel', 'unrecognised_boolean');
      if (n) warnings.push(mkIssue('pipe', id, 'invertLabel', noticeMessage(n.reason), n.rawValue));
    }
    if (isFiniteNumber(p.labelPosition) && (p.labelPosition < 0 || p.labelPosition > 1)) {
      warnings.push(mkIssue('pipe', id, 'labelPosition', 'labelPosition out of [0, 1]', p.labelPosition));
    }
    if (p.date !== null && cs !== null && ce !== null && (p.date < cs || p.date > ce)) {
      warnings.push(mkIssue('pipe', id, 'date', 'date outside chart range', p.date));
    }

    // Notices
    {
      const n = consumeNotice(pN, consumed, 'pipe', id, 'id', 'id_assigned');
      if (n) notices.push(mkIssue('pipe', id, 'id', noticeMessage(n.reason), n.rawValue));
    }
  }

  return { errors, warnings, notices };
}

// ── Curtains ───────────────────────────────────────────────────────────────────
function validateCurtains(projectData) {
  const errors = [], warnings = [], notices = [];
  const pN = projectData._parseNotices || [];
  const consumed = new Set();
  const curtains = projectData.curtains;

  const dupIds = findDuplicateIds(curtains);
  const cs = projectData.config.timeline.chartStartDate;
  const ce = projectData.config.timeline.chartEndDate;

  for (const c of curtains) {
    const id = c.id;

    // Errors
    if (id !== null && dupIds.has(id)) {
      errors.push(mkIssue('curtain', id, 'id', `Duplicate id ${id}`, id));
    }
    if (isMissingField(c.startDate, pN, 'curtain', id, 'startDate')) {
      errors.push(mkIssue('curtain', id, 'startDate', 'Missing startDate', null));
    }
    if (isMissingField(c.endDate, pN, 'curtain', id, 'endDate')) {
      errors.push(mkIssue('curtain', id, 'endDate', 'Missing endDate', null));
    }
    for (const f of ['startDate', 'endDate']) {
      const n = consumeNotice(pN, consumed, 'curtain', id, f, 'unparseable_date');
      if (n) errors.push(mkIssue('curtain', id, f, noticeMessage(n.reason), n.rawValue));
    }
    if (c.startDate !== null && c.endDate !== null && c.endDate <= c.startDate) {
      errors.push(mkIssue('curtain', id, 'endDate', 'endDate ≤ startDate (zero-width or inverted)', c.endDate));
    }
    for (const f of ['opacity', 'labelPosition']) {
      const n = consumeNotice(pN, consumed, 'curtain', id, f, 'unparseable_number');
      if (n) errors.push(mkIssue('curtain', id, f, noticeMessage(n.reason), n.rawValue));
    }
    if (c.color === '') {
      errors.push(mkIssue('curtain', id, 'color', 'Empty color', ''));
    }

    // Warnings
    if (c.color !== '' && c.color != null && !isValidCssColor(c.color)) {
      warnings.push(mkIssue('curtain', id, 'color', 'Invalid CSS color', c.color));
    }
    if (isFiniteNumber(c.opacity) && (c.opacity < 0 || c.opacity > 1)) {
      warnings.push(mkIssue('curtain', id, 'opacity', 'opacity out of [0, 1]', c.opacity));
    }
    if (isFiniteNumber(c.opacity) && c.opacity > 0 && c.opacity < 0.15) {
      warnings.push(mkIssue('curtain', id, 'opacity', 'opacity below 0.15 (may not render visibly)', c.opacity));
    }
    if (isFiniteNumber(c.labelPosition) && (c.labelPosition < 0 || c.labelPosition > 1)) {
      warnings.push(mkIssue('curtain', id, 'labelPosition', 'labelPosition out of [0, 1]', c.labelPosition));
    }
    {
      const n = consumeNotice(pN, consumed, 'curtain', id, 'labelAnchor', 'unrecognised_enum');
      if (n) warnings.push(mkIssue('curtain', id, 'labelAnchor', noticeMessage(n.reason), n.rawValue));
    }
    {
      const n = consumeNotice(pN, consumed, 'curtain', id, 'invertLabel', 'unrecognised_boolean');
      if (n) warnings.push(mkIssue('curtain', id, 'invertLabel', noticeMessage(n.reason), n.rawValue));
    }
    if (cs !== null && ce !== null && c.startDate !== null && c.endDate !== null) {
      if (c.endDate < cs || c.startDate > ce) {
        warnings.push(mkIssue('curtain', id, 'startDate', 'Curtain fully outside chart date range', c.startDate));
      }
    }

    // Notices
    {
      const n = consumeNotice(pN, consumed, 'curtain', id, 'id', 'id_assigned');
      if (n) notices.push(mkIssue('curtain', id, 'id', noticeMessage(n.reason), n.rawValue));
    }
  }

  return { errors, warnings, notices };
}

// ── Notes ──────────────────────────────────────────────────────────────────────
function validateNotes(projectData) {
  const errors = [], warnings = [], notices = [];
  const pN = projectData._parseNotices || [];
  const consumed = new Set();
  const notesArr = projectData.notes;

  const dupIds = findDuplicateIds(notesArr);

  for (const note of notesArr) {
    const id = note.id;

    // Errors
    if (id !== null && dupIds.has(id)) {
      errors.push(mkIssue('note', id, 'id', `Duplicate id ${id}`, id));
    }
    for (const f of ['xPct', 'yPct', 'widthPct', 'heightPct']) {
      const n = consumeNotice(pN, consumed, 'note', id, f, 'unparseable_number');
      if (n) errors.push(mkIssue('note', id, f, noticeMessage(n.reason), n.rawValue));
    }

    // Warnings
    if (isFiniteNumber(note.widthPct) && note.widthPct <= 0) {
      warnings.push(mkIssue('note', id, 'widthPct', 'widthPct ≤ 0 (render skips)', note.widthPct));
    }
    if (isFiniteNumber(note.heightPct) && note.heightPct <= 0) {
      warnings.push(mkIssue('note', id, 'heightPct', 'heightPct ≤ 0 (render skips)', note.heightPct));
    }
    if (isFiniteNumber(note.xPct) && note.xPct >= 100) {
      warnings.push(mkIssue('note', id, 'xPct', 'xPct ≥ 100 (fully off-chart)', note.xPct));
    }
    if (isFiniteNumber(note.yPct) && note.yPct >= 100) {
      warnings.push(mkIssue('note', id, 'yPct', 'yPct ≥ 100 (fully off-chart)', note.yPct));
    }
    if (isFiniteNumber(note.xPct) && isFiniteNumber(note.widthPct) && note.xPct + note.widthPct <= 0) {
      warnings.push(mkIssue('note', id, 'xPct', 'xPct + widthPct ≤ 0 (fully off-chart)', note.xPct));
    }
    if (isFiniteNumber(note.yPct) && isFiniteNumber(note.heightPct) && note.yPct + note.heightPct <= 0) {
      warnings.push(mkIssue('note', id, 'yPct', 'yPct + heightPct ≤ 0 (fully off-chart)', note.yPct));
    }
    {
      const n = consumeNotice(pN, consumed, 'note', id, 'textAlign', 'unrecognised_enum');
      if (n) warnings.push(mkIssue('note', id, 'textAlign', noticeMessage(n.reason), n.rawValue));
    }
    {
      const n = consumeNotice(pN, consumed, 'note', id, 'verticalAlign', 'unrecognised_enum');
      if (n) warnings.push(mkIssue('note', id, 'verticalAlign', noticeMessage(n.reason), n.rawValue));
    }
    if (note.borderColor !== '' && note.borderColor != null && !isValidCssColor(note.borderColor)) {
      warnings.push(mkIssue('note', id, 'borderColor', 'Invalid CSS color', note.borderColor));
    }
    if (note.fillColor !== '' && note.fillColor != null && !isValidCssColor(note.fillColor)) {
      warnings.push(mkIssue('note', id, 'fillColor', 'Invalid CSS color', note.fillColor));
    }

    // Notices
    {
      const n = consumeNotice(pN, consumed, 'note', id, 'id', 'id_assigned');
      if (n) notices.push(mkIssue('note', id, 'id', noticeMessage(n.reason), n.rawValue));
    }
  }

  return { errors, warnings, notices };
}

// ── Baseline ───────────────────────────────────────────────────────────────────
function validateBaseline(projectData) {
  const errors = [], warnings = [], notices = [];
  const taskIds = new Set(projectData.tasks.filter(t => t.id != null).map(t => t.id));

  for (const b of projectData.baseline) {
    if (b.id !== null && !taskIds.has(b.id)) {
      notices.push(mkIssue('baseline', b.id, 'id', 'No current task matches this baseline id', b.id));
    }
  }

  return { errors, warnings, notices };
}

// ── Config: Layout ─────────────────────────────────────────────────────────────
function validateLayout(projectData) {
  const errors = [], warnings = [], notices = [];
  const OWNED = new Set(['outerWidth','outerHeight','paddingTop','paddingRight','paddingBottom','paddingLeft','showRowDividers']);
  const pN = (projectData._parseNotices || []).filter(n => n.entity === 'config' && OWNED.has(n.field));
  const consumed = new Set();
  const layout = projectData.config.layout;

  // Errors — unparseable_number for integer fields
  for (const f of ['outerWidth','outerHeight','paddingTop','paddingRight','paddingBottom','paddingLeft']) {
    const n = consumeNotice(pN, consumed, 'config', null, f, 'unparseable_number');
    if (n) errors.push(mkIssue('config', null, f, noticeMessage(n.reason), n.rawValue));
  }
  if (isInteger(layout.outerWidth) && layout.outerWidth <= 0) {
    errors.push(mkIssue('config', null, 'outerWidth', 'outerWidth ≤ 0', layout.outerWidth));
  }
  if (isInteger(layout.outerHeight) && layout.outerHeight <= 0) {
    errors.push(mkIssue('config', null, 'outerHeight', 'outerHeight ≤ 0', layout.outerHeight));
  }
  for (const f of ['paddingTop','paddingRight','paddingBottom','paddingLeft']) {
    if (isInteger(layout[f]) && layout[f] < 0) {
      errors.push(mkIssue('config', null, f, `${f} < 0`, layout[f]));
    }
  }
  if (isInteger(layout.paddingLeft) && isInteger(layout.paddingRight) && isInteger(layout.outerWidth)
      && layout.paddingLeft + layout.paddingRight >= layout.outerWidth) {
    errors.push(mkIssue('config', null, 'paddingLeft',
      'paddingLeft + paddingRight ≥ outerWidth',
      layout.paddingLeft + layout.paddingRight));
  }
  if (isInteger(layout.paddingTop) && isInteger(layout.paddingBottom) && isInteger(layout.outerHeight)
      && layout.paddingTop + layout.paddingBottom >= layout.outerHeight) {
    errors.push(mkIssue('config', null, 'paddingTop',
      'paddingTop + paddingBottom ≥ outerHeight',
      layout.paddingTop + layout.paddingBottom));
  }

  // Task-row-area collapse check (mirrors renderer's scaleTotalHeight formula)
  const tl = projectData.config.timeline;
  const ty = projectData.config.typography;
  const ti = projectData.config.titles;
  const rd = projectData.config.rendering;
  const visibleScales =
    [tl.showYears, tl.showMonths, tl.showWeeks, tl.showDates, tl.showDays].filter(Boolean).length;
  const bandHeight = Math.max(rd.minScaleBandHeight, ty.scaleFontSize * rd.scaleFontToBandHeightFactor);
  const scaleTotalHeight = visibleScales * bandHeight;
  const total = layout.paddingTop + ti.headerHeight + scaleTotalHeight + ti.footerHeight + layout.paddingBottom;
  if (isFiniteNumber(total) && isInteger(layout.outerHeight) && total >= layout.outerHeight) {
    errors.push(mkIssue('config', null, 'outerHeight',
      'task row area collapses (paddingTop + headerHeight + scales + footerHeight + paddingBottom ≥ outerHeight)',
      total));
  }

  // Warnings — boolean
  const bn = consumeNotice(pN, consumed, 'config', null, 'showRowDividers', 'unrecognised_boolean');
  if (bn) warnings.push(mkIssue('config', null, 'showRowDividers', noticeMessage(bn.reason), bn.rawValue));

  return { errors, warnings, notices };
}

// ── Config: Bars ───────────────────────────────────────────────────────────────
function validateBars(projectData) {
  const errors = [], warnings = [], notices = [];
  const OWNED = new Set(['taskBarHeightFactor','milestoneSizeFactor','taskBarVerticalOffsetFactor','milestoneVerticalOffsetFactor','baselineBarHeightFactor','baselineBarVerticalOffsetFactor','baselineMilestoneSizeFactor','baselineMilestoneVerticalOffsetFactor','baselineFillOpacity','milestoneShape','milestoneCornerRadius','taskCornerRadius','arrowheadSizeFactor','originMarkerSizeFactor']);
  const pN = (projectData._parseNotices || []).filter(n => n.entity === 'config' && OWNED.has(n.field));
  const consumed = new Set();
  const bars = projectData.config.bars;

  // Errors
  for (const f of ['taskBarHeightFactor','milestoneSizeFactor','taskBarVerticalOffsetFactor','milestoneVerticalOffsetFactor','baselineBarHeightFactor','baselineBarVerticalOffsetFactor','baselineMilestoneSizeFactor','baselineMilestoneVerticalOffsetFactor','baselineFillOpacity','milestoneCornerRadius','taskCornerRadius','arrowheadSizeFactor','originMarkerSizeFactor']) {
    const n = consumeNotice(pN, consumed, 'config', null, f, 'unparseable_number');
    if (n) errors.push(mkIssue('config', null, f, noticeMessage(n.reason), n.rawValue));
  }
  if (isFiniteNumber(bars.taskBarHeightFactor) && bars.taskBarHeightFactor <= 0) {
    errors.push(mkIssue('config', null, 'taskBarHeightFactor', 'taskBarHeightFactor ≤ 0', bars.taskBarHeightFactor));
  }
  if (isFiniteNumber(bars.milestoneSizeFactor) && bars.milestoneSizeFactor <= 0) {
    errors.push(mkIssue('config', null, 'milestoneSizeFactor', 'milestoneSizeFactor ≤ 0', bars.milestoneSizeFactor));
  }
  if (isFiniteNumber(bars.baselineBarHeightFactor) && bars.baselineBarHeightFactor <= 0) {
    errors.push(mkIssue('config', null, 'baselineBarHeightFactor', 'baselineBarHeightFactor ≤ 0', bars.baselineBarHeightFactor));
  }
  if (isFiniteNumber(bars.baselineMilestoneSizeFactor) && bars.baselineMilestoneSizeFactor <= 0) {
    errors.push(mkIssue('config', null, 'baselineMilestoneSizeFactor', 'baselineMilestoneSizeFactor ≤ 0', bars.baselineMilestoneSizeFactor));
  }
  if (isInteger(bars.taskCornerRadius) && bars.taskCornerRadius < 0) {
    errors.push(mkIssue('config', null, 'taskCornerRadius', 'taskCornerRadius < 0', bars.taskCornerRadius));
  }
  if (isFiniteNumber(bars.arrowheadSizeFactor) && bars.arrowheadSizeFactor <= 0) {
    errors.push(mkIssue('config', null, 'arrowheadSizeFactor', 'arrowheadSizeFactor ≤ 0', bars.arrowheadSizeFactor));
  }
  if (isFiniteNumber(bars.originMarkerSizeFactor) && bars.originMarkerSizeFactor <= 0) {
    errors.push(mkIssue('config', null, 'originMarkerSizeFactor', 'originMarkerSizeFactor ≤ 0', bars.originMarkerSizeFactor));
  }

  // Warnings
  if (isFiniteNumber(bars.taskBarHeightFactor) && bars.taskBarHeightFactor > 1) {
    warnings.push(mkIssue('config', null, 'taskBarHeightFactor', 'taskBarHeightFactor > 1', bars.taskBarHeightFactor));
  }
  if (isFiniteNumber(bars.milestoneSizeFactor) && bars.milestoneSizeFactor > 1) {
    warnings.push(mkIssue('config', null, 'milestoneSizeFactor', 'milestoneSizeFactor > 1', bars.milestoneSizeFactor));
  }
  if (isFiniteNumber(bars.baselineBarHeightFactor) && bars.baselineBarHeightFactor > 1) {
    warnings.push(mkIssue('config', null, 'baselineBarHeightFactor', 'baselineBarHeightFactor > 1', bars.baselineBarHeightFactor));
  }
  if (isFiniteNumber(bars.baselineMilestoneSizeFactor) && bars.baselineMilestoneSizeFactor > 1) {
    warnings.push(mkIssue('config', null, 'baselineMilestoneSizeFactor', 'baselineMilestoneSizeFactor > 1', bars.baselineMilestoneSizeFactor));
  }
  if (isFiniteNumber(bars.baselineFillOpacity) && (bars.baselineFillOpacity < 0 || bars.baselineFillOpacity > 1)) {
    warnings.push(mkIssue('config', null, 'baselineFillOpacity', 'baselineFillOpacity out of [0, 1]', bars.baselineFillOpacity));
  }
  {
    const n = consumeNotice(pN, consumed, 'config', null, 'milestoneShape', 'unrecognised_enum');
    if (n) warnings.push(mkIssue('config', null, 'milestoneShape', noticeMessage(n.reason), n.rawValue));
  }
  if (isFiniteNumber(bars.milestoneCornerRadius) && (bars.milestoneCornerRadius < 0 || bars.milestoneCornerRadius > 1)) {
    warnings.push(mkIssue('config', null, 'milestoneCornerRadius', 'milestoneCornerRadius out of [0, 1]', bars.milestoneCornerRadius));
  }
  if (isFiniteNumber(bars.arrowheadSizeFactor) && bars.arrowheadSizeFactor > 1) {
    warnings.push(mkIssue('config', null, 'arrowheadSizeFactor', 'arrowheadSizeFactor > 1', bars.arrowheadSizeFactor));
  }
  if (isFiniteNumber(bars.originMarkerSizeFactor) && bars.originMarkerSizeFactor > 1) {
    warnings.push(mkIssue('config', null, 'originMarkerSizeFactor', 'originMarkerSizeFactor > 1', bars.originMarkerSizeFactor));
  }

  return { errors, warnings, notices };
}

// ── Config: Timeline ───────────────────────────────────────────────────────────
function validateTimeline(projectData) {
  const errors = [], warnings = [], notices = [];
  const OWNED = new Set([
    'chartStartDate','chartEndDate',
    'showYears','showMonths','showWeeks','showDays','showDates',
    'gridlineYears','gridlineMonths','gridlineWeeks','gridlineDays',
  ]);
  const pN = (projectData._parseNotices || []).filter(n => n.entity === 'config' && OWNED.has(n.field));
  const consumed = new Set();
  const tl = projectData.config.timeline;

  // Errors — unparseable dates
  for (const f of ['chartStartDate','chartEndDate']) {
    const n = consumeNotice(pN, consumed, 'config', null, f, 'unparseable_date');
    if (n) errors.push(mkIssue('config', null, f, noticeMessage(n.reason), n.rawValue));
  }
  if (tl.chartStartDate !== null && tl.chartEndDate !== null && tl.chartEndDate <= tl.chartStartDate) {
    errors.push(mkIssue('config', null, 'chartEndDate', 'chartEndDate ≤ chartStartDate', tl.chartEndDate));
  }
  if (tl.chartDateFormat === '') {
    errors.push(mkIssue('config', null, 'chartDateFormat', 'Empty chartDateFormat', ''));
  }

  // Warnings — all show* off
  if (!tl.showYears && !tl.showMonths && !tl.showWeeks && !tl.showDays && !tl.showDates) {
    warnings.push(mkIssue('config', null, 'showYears', 'All five show* flags are false', false));
  }
  // Warnings — explicit range excludes every task
  if (tl.chartStartDateExplicit === true && tl.chartEndDateExplicit === true
      && projectData.tasks.length > 0
      && tl.chartStartDate !== null && tl.chartEndDate !== null) {
    const anyInRange = projectData.tasks.some(t => {
      if (t.startDate === null || t.finishDate === null) return false;
      return !(t.finishDate < tl.chartStartDate || t.startDate > tl.chartEndDate);
    });
    if (!anyInRange) {
      warnings.push(mkIssue('config', null, 'chartStartDate',
        'Explicit chart range excludes every task', tl.chartStartDate));
    }
  }
  // Warnings — unrecognised_boolean on any show*/gridline* field
  for (const f of ['showYears','showMonths','showWeeks','showDays','showDates',
                   'gridlineYears','gridlineMonths','gridlineWeeks','gridlineDays']) {
    const n = consumeNotice(pN, consumed, 'config', null, f, 'unrecognised_boolean');
    if (n) warnings.push(mkIssue('config', null, f, noticeMessage(n.reason), n.rawValue));
  }

  return { errors, warnings, notices };
}

// ── Config: Titles ─────────────────────────────────────────────────────────────
function validateTitles(projectData) {
  const errors = [], warnings = [], notices = [];
  const OWNED = new Set(['headerHeight','headerText','headerTextAlign','footerHeight','footerText','footerTextAlign']);
  const pN = (projectData._parseNotices || []).filter(n => n.entity === 'config' && OWNED.has(n.field));
  const consumed = new Set();
  const t = projectData.config.titles;

  // Errors
  for (const f of ['headerHeight','footerHeight']) {
    const n = consumeNotice(pN, consumed, 'config', null, f, 'unparseable_number');
    if (n) errors.push(mkIssue('config', null, f, noticeMessage(n.reason), n.rawValue));
  }
  if (isInteger(t.headerHeight) && t.headerHeight < 0) {
    errors.push(mkIssue('config', null, 'headerHeight', 'headerHeight < 0', t.headerHeight));
  }
  if (isInteger(t.footerHeight) && t.footerHeight < 0) {
    errors.push(mkIssue('config', null, 'footerHeight', 'footerHeight < 0', t.footerHeight));
  }

  // Warnings
  for (const f of ['headerTextAlign','footerTextAlign']) {
    const n = consumeNotice(pN, consumed, 'config', null, f, 'unrecognised_enum');
    if (n) warnings.push(mkIssue('config', null, f, noticeMessage(n.reason), n.rawValue));
  }

  return { errors, warnings, notices };
}

// ── Config: Style ──────────────────────────────────────────────────────────────
const STYLE_FIELDS = [
  'chartBackgroundColor','headerFooterBackgroundColor','headerFooterBorderColor',
  'headerFooterTextColor','swimlaneLabelColor','swimlaneDividerColor',
  'scaleBackgroundColor','scaleTickColor','scaleLabelTextColor','gridlineVerticalColor',
  'taskStrokeColor','milestoneStrokeColor','outsideLabelTextColor','leaderLineColor',
  'insideLabelTextColor','noteTextColor',
];

function validateStyle(projectData) {
  const errors = [], warnings = [], notices = [];
  const style = projectData.config.style;
  for (const f of STYLE_FIELDS) {
    const v = style[f];
    if (v === '') {
      errors.push(mkIssue('config', null, f, `Empty ${f}`, ''));
    } else if (v != null && !isValidCssColor(v)) {
      warnings.push(mkIssue('config', null, f, 'Invalid CSS color', v));
    }
  }
  return { errors, warnings, notices };
}

// ── Config: Typography ─────────────────────────────────────────────────────────
const TYPOGRAPHY_FONT_SIZE_FIELDS = [
  'taskFontSize','scaleFontSize','headerFooterFontSize','noteFontSize',
  'swimlaneFontSize','pipeFontSize','curtainFontSize',
];
const TYPOGRAPHY_FACTOR_FIELDS = [
  'scaleAlignmentFactor','taskAlignmentFactor','headerFooterAlignmentFactor',
  'pipeAlignmentFactor','curtainAlignmentFactor','noteAlignmentFactor',
  'swimlaneTopAlignmentFactor','swimlaneBottomAlignmentFactor',
];

function validateTypography(projectData) {
  const errors = [], warnings = [], notices = [];
  const OWNED = new Set(['fontFamily', ...TYPOGRAPHY_FONT_SIZE_FIELDS, ...TYPOGRAPHY_FACTOR_FIELDS]);
  const pN = (projectData._parseNotices || []).filter(n => n.entity === 'config' && OWNED.has(n.field));
  const consumed = new Set();
  const ty = projectData.config.typography;

  if (ty.fontFamily === '') {
    errors.push(mkIssue('config', null, 'fontFamily', 'Empty fontFamily', ''));
  }
  for (const f of TYPOGRAPHY_FONT_SIZE_FIELDS) {
    const n = consumeNotice(pN, consumed, 'config', null, f, 'unparseable_number');
    if (n) errors.push(mkIssue('config', null, f, noticeMessage(n.reason), n.rawValue));
    if (isInteger(ty[f]) && ty[f] <= 0) {
      errors.push(mkIssue('config', null, f, `${f} ≤ 0`, ty[f]));
    }
  }
  for (const f of TYPOGRAPHY_FACTOR_FIELDS) {
    const n = consumeNotice(pN, consumed, 'config', null, f, 'unparseable_number');
    if (n) errors.push(mkIssue('config', null, f, noticeMessage(n.reason), n.rawValue));
    if (isFiniteNumber(ty[f]) && (ty[f] < 0 || ty[f] > 1)) {
      warnings.push(mkIssue('config', null, f, `${f} out of [0, 1]`, ty[f]));
    }
  }

  return { errors, warnings, notices };
}

// ── Config: Rendering ──────────────────────────────────────────────────────────
const RENDERING_STROKE_WIDTH_FIELDS = [
  'gridlineStrokeWidth','scaleTickStrokeWidth','headerFooterBorderStrokeWidth',
  'taskStrokeWidth','milestoneStrokeWidth','swimlaneDividerStrokeWidth',
  'linkStrokeWidth','leaderLineStrokeWidth','pipeStrokeWidth','curtainStrokeWidth',
  'patternStrokeWidth','noteBorderStrokeWidth',
];
const RENDERING_PADDING_GAP_FIELDS = [
  'linkArrowheadMilestoneGap','swimlaneLabelPadding','insideLabelPadding',
  'outsideLabelKissingGap','headerFooterTextPadding','pipeBadgePaddingX',
  'pipeBadgePaddingY','curtainBadgePaddingX','curtainBadgePaddingY','notePadding',
];

function validateRendering(projectData) {
  const errors = [], warnings = [], notices = [];
  const r = projectData.config.rendering;

  if (!Array.isArray(r.monthLetters) || r.monthLetters.length !== 12) {
    errors.push(mkIssue('config', null, 'monthLetters', 'monthLetters length ≠ 12',
      Array.isArray(r.monthLetters) ? r.monthLetters.length : r.monthLetters));
  }
  for (const f of RENDERING_STROKE_WIDTH_FIELDS) {
    if (isFiniteNumber(r[f]) && r[f] < 0) {
      errors.push(mkIssue('config', null, f, `${f} < 0`, r[f]));
    }
  }
  for (const f of RENDERING_PADDING_GAP_FIELDS) {
    if (isInteger(r[f]) && r[f] < 0) {
      errors.push(mkIssue('config', null, f, `${f} < 0`, r[f]));
    }
  }
  if (isFiniteNumber(r.minScaleBandHeight) && r.minScaleBandHeight <= 0) {
    errors.push(mkIssue('config', null, 'minScaleBandHeight', 'minScaleBandHeight ≤ 0', r.minScaleBandHeight));
  }
  if (isFiniteNumber(r.patternTileSize) && r.patternTileSize <= 0) {
    errors.push(mkIssue('config', null, 'patternTileSize', 'patternTileSize ≤ 0', r.patternTileSize));
  }

  if (Array.isArray(r.monthLetters) && r.monthLetters.some(x => typeof x !== 'string')) {
    warnings.push(mkIssue('config', null, 'monthLetters', 'monthLetters contains non-string elements', r.monthLetters));
  }

  return { errors, warnings, notices };
}

// ── Coordinator ────────────────────────────────────────────────────────────────
function validateProject(projectData) {
  const all = { errors: [], warnings: [], notices: [] };
  const fns = [
    validateTasks, validateSwimlanes, validateLinks, validatePipes, validateCurtains, validateNotes,
    validateBaseline,
    validateLayout, validateBars, validateTimeline, validateTitles, validateStyle, validateTypography,
    validateRendering,
  ];
  for (const fn of fns) {
    const r = fn(projectData);
    all.errors.push(...r.errors);
    all.warnings.push(...r.warnings);
    all.notices.push(...r.notices);
  }
  return all;
}
