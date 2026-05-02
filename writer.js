// writer.js — serialises projectData back to an .xlsx file
// Exports writeWorkbook(projectData) → Uint8Array (SheetJS type:'array')

// Serialise a boolean as the string expected by the parser's kvBool helper.
function boolStr(v) { return v ? 'Yes' : 'No'; }

function writeWorkbook(projectData) {
  const { tasks, swimlanes, links, pipes, curtains, notes, config } = projectData;
  const { layout, timeline, titles, style, typography, preferences } = config;

  const wb = XLSX.utils.book_new();

  function addSheet(name, aoa) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  }

  // ── 1. Tasks ──────────────────────────────────────────────────────────────────
  addSheet('Tasks', [
    ['ID', 'Swimlane ID', 'Row', 'Name', 'Start Date', 'Finish Date',
     'Label Content', 'Label Placement', 'Label Offset', 'Date Format',
     'Fill Color', 'Fill Pattern', 'Pattern Color'],
    ...tasks.map(t => [
      t.id, t.swimlaneId, t.row, t.name,
      toJsDate(t.startDate), toJsDate(t.finishDate),
      t.labelContent, t.labelPlacement, t.labelOffset, t.dateFormat,
      t.fillColor, t.fillPattern, t.patternColor,
    ]),
  ]);

  // ── 2. Swimlanes ──────────────────────────────────────────────────────────────
  addSheet('Swimlanes', [
    ['ID', 'Name', 'Row Count', 'Label Position', 'Background Color'],
    ...swimlanes.map(s => [
      s.id, s.name, s.rowCount, s.labelPosition, s.backgroundColor,
    ]),
  ]);

  // ── 3. Links ──────────────────────────────────────────────────────────────────
  addSheet('Links', [
    ['ID', 'From Task ID', 'To Task ID', 'Line Color', 'Line Style', 'Routing'],
    ...links.map(l => [
      l.id, l.fromTaskId, l.toTaskId, l.lineColor, l.lineStyle, l.routing,
    ]),
  ]);

  // ── 4. Pipes ──────────────────────────────────────────────────────────────────
  addSheet('Pipes', [
    ['ID', 'Date', 'Name', 'Color', 'Line Style'],
    ...pipes.map(p => [
      p.id, toJsDate(p.date), p.name, p.color, p.lineStyle,
    ]),
  ]);

  // ── 5. Curtains ───────────────────────────────────────────────────────────────
  addSheet('Curtains', [
    ['ID', 'Start Date', 'End Date', 'Name', 'Color', 'Opacity'],
    ...curtains.map(c => [
      c.id, toJsDate(c.startDate), toJsDate(c.endDate), c.name, c.color, c.opacity,
    ]),
  ]);

  // ── 6. Notes ──────────────────────────────────────────────────────────────────
  addSheet('Notes', [
    ['ID', 'X %', 'Y %', 'Width %', 'Height %', 'Text Align', 'Vertical Align', 'Text'],
    ...notes.map(n => [
      n.id, n.xPct, n.yPct, n.widthPct, n.heightPct, n.textAlign, n.verticalAlign, n.text,
    ]),
  ]);

  // ── 7. Layout ─────────────────────────────────────────────────────────────────
  addSheet('Layout', [
    ['Field', 'Value'],
    ['Outer Width',    layout.outerWidth],
    ['Outer Height',   layout.outerHeight],
    ['Padding Top',    layout.paddingTop],
    ['Padding Right',  layout.paddingRight],
    ['Padding Bottom', layout.paddingBottom],
    ['Padding Left',   layout.paddingLeft],
    ['Row Dividers',   boolStr(layout.showRowDividers)],
  ]);

  // ── 8. Timeline ───────────────────────────────────────────────────────────────
  // Dates are only written when they were explicitly set in the source file.
  // If derived from task dates, the cell is left empty so auto-derivation
  // continues to work after a save/reload cycle.
  addSheet('Timeline', [
    ['Field', 'Value'],
    ['Chart Start Date', timeline.chartStartDateExplicit ? toJsDate(timeline.chartStartDate) : null],
    ['Chart End Date',   timeline.chartEndDateExplicit   ? toJsDate(timeline.chartEndDate)   : null],
    ['Show Years',    boolStr(timeline.showYears)],
    ['Show Months',   boolStr(timeline.showMonths)],
    ['Show Weeks',    boolStr(timeline.showWeeks)],
    ['Show Days',     boolStr(timeline.showDays)],
    ['Gridline Years',  boolStr(timeline.gridlineYears)],
    ['Gridline Months', boolStr(timeline.gridlineMonths)],
    ['Gridline Weeks',  boolStr(timeline.gridlineWeeks)],
    ['Gridline Days',   boolStr(timeline.gridlineDays)],
  ]);

  // ── 9. Titles ─────────────────────────────────────────────────────────────────
  addSheet('Titles', [
    ['Field', 'Value'],
    ['Header Height', titles.headerHeight],
    ['Header Text',   titles.headerText],
    ['Footer Height', titles.footerHeight],
    ['Footer Text',   titles.footerText],
  ]);

  // ── 10. Style ─────────────────────────────────────────────────────────────────
  addSheet('Style', [
    ['Field', 'Value'],
    ['Chart Background Color',         style.chartBackgroundColor],
    ['Header Footer Background Color', style.headerFooterBackgroundColor],
    ['Swimlane Label Color',           style.swimlaneLabelColor],
    ['Swimlane Divider Color',         style.swimlaneDividerColor],
    ['Scale Background Color',         style.scaleBackgroundColor],
    ['Scale Tick Color',               style.scaleTickColor],
    ['Gridline Vertical Color',        style.gridlineVerticalColor],
    ['Task Stroke Color',              style.taskStrokeColor],
    ['Milestone Stroke Color',         style.milestoneStrokeColor],
    ['Outside Label Text Color',       style.outsideLabelTextColor],
    ['Outside Label Line Color',       style.outsideLabelLineColor],
    ['Inside Label Text Color',        style.insideLabelTextColor],
  ]);

  // ── 11. Typography ────────────────────────────────────────────────────────────
  addSheet('Typography', [
    ['Field', 'Value'],
    ['Font Family',                      typography.fontFamily],
    ['Task Font Size',                   typography.taskFontSize],
    ['Scale Font Size',                  typography.scaleFontSize],
    ['Header Footer Font Size',          typography.headerFooterFontSize],
    ['Note Font Size',                   typography.noteFontSize],
    ['Swimlane Font Size',               typography.swimlaneFontSize],
    ['Scale Alignment Factor',           typography.scaleAlignmentFactor],
    ['Task Alignment Factor',            typography.taskAlignmentFactor],
    ['Header Footer Alignment Factor',   typography.headerFooterAlignmentFactor],
    ['Swimlane Top Alignment Factor',    typography.swimlaneTopAlignmentFactor],
    ['Swimlane Bottom Alignment Factor', typography.swimlaneBottomAlignmentFactor],
  ]);

  // ── 12. Preferences ───────────────────────────────────────────────────────────
  addSheet('Preferences', [
    ['Field', 'Value'],
    ['UI Date Format',    preferences.uiDateFormat],
    ['Chart Date Format', preferences.chartDateFormat],
  ]);

  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
}
