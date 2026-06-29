// writer.js — serialises projectData back to an .xlsx file
// Exports writeWorkbook(projectData) → Uint8Array (SheetJS type:'array')

// Serialise a boolean as the string expected by the parser's kvBool helper.
function boolStr(v) { return v ? 'Yes' : 'No'; }

function writeWorkbook(projectData) {
  const { tasks, swimlanes, links, pipes, curtains, notes, baseline, counters, config } = projectData;
  const { layout, bars, timeline, titles, style, typography } = config;

  const wb = XLSX.utils.book_new();

  function addSheet(name, aoa) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  }

  // ── 1. Tasks ──────────────────────────────────────────────────────────────────
  addSheet('Tasks', [
    ['ID', 'Swimlane ID', 'Row', 'Name', 'Start Date', 'Finish Date',
     'Label Content', 'Label Placement', 'Label Offset', 'Date Format',
     'Fill Color', 'Fill Pattern', 'Pattern Color', 'Label Color'],
    ...tasks.map(t => [
      t.id, t.swimlaneId, t.row, t.name,
      toJsDate(t.startDate), toJsDate(t.finishDate),
      t.labelContent, t.labelPlacement, t.labelOffset, t.dateFormat,
      t.fillColor, t.fillPattern, t.patternColor, t.labelColor,
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
    ['ID', 'Date', 'Name', 'Color', 'Line Style', 'Label Position', 'Invert Label'],
    ...pipes.map(p => [
      p.id, toJsDate(p.date), p.name, p.color, p.lineStyle, p.labelPosition, boolStr(p.invertLabel),
    ]),
  ]);

  // ── 5. Curtains ───────────────────────────────────────────────────────────────
  addSheet('Curtains', [
    ['ID', 'Start Date', 'End Date', 'Name', 'Color', 'Opacity', 'Label Position', 'Label Anchor', 'Invert Label'],
    ...curtains.map(c => [
      c.id, toJsDate(c.startDate), toJsDate(c.endDate), c.name, c.color, c.opacity, c.labelPosition, c.labelAnchor, boolStr(c.invertLabel),
    ]),
  ]);

  // ── 6. Notes ──────────────────────────────────────────────────────────────────
  addSheet('Notes', [
    ['ID', 'X %', 'Y %', 'Width %', 'Height %', 'Text Align', 'Vertical Align', 'Border Color', 'Fill Color', 'Text'],
    ...notes.map(n => [
      n.id, n.xPct, n.yPct, n.widthPct, n.heightPct, n.textAlign, n.verticalAlign, n.borderColor, n.fillColor, n.text,
    ]),
  ]);

  // ── Baseline ──────────────────────────────────────────────────────────────────
  // Diverges from the entity-sheet convention: emitted only when non-empty, so
  // existing/non-baselined files don't gain a stray empty Baseline sheet on save.
  // The parser already tolerates a missing sheet.
  if (baseline.length > 0) {
    addSheet('Baseline', [
      ['ID', 'Start Date', 'Finish Date'],
      ...baseline.map(b => [
        b.id, toJsDate(b.startDate), toJsDate(b.finishDate),
      ]),
    ]);
  }

  // ── Counters ──────────────────────────────────────────────────────────────────
  // Monotonic per-entity next-id-to-issue, persisted so a later add can't reuse
  // the id of a deleted high-id entity. Always emitted. Key-value, mirroring the
  // config sheets (col A = singular entity name, col B = next id).
  addSheet('Counters', [
    ['Field', 'Value'],
    ['task',     counters.task],
    ['swimlane', counters.swimlane],
    ['link',     counters.link],
    ['pipe',     counters.pipe],
    ['curtain',  counters.curtain],
    ['note',     counters.note],
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

  // ── 8. Bars ───────────────────────────────────────────────────────────────────
  addSheet('Bars', [
    ['Field', 'Value'],
    ['Task Bar Height Factor',  bars.taskBarHeightFactor],
    ['Milestone Size Factor',   bars.milestoneSizeFactor],
    ['Task Bar Vertical Offset Factor',   bars.taskBarVerticalOffsetFactor],
    ['Milestone Vertical Offset Factor', bars.milestoneVerticalOffsetFactor],
    ['Baseline Bar Height Factor',           bars.baselineBarHeightFactor],
    ['Baseline Bar Vertical Offset Factor',   bars.baselineBarVerticalOffsetFactor],
    ['Baseline Milestone Size Factor',         bars.baselineMilestoneSizeFactor],
    ['Baseline Milestone Vertical Offset Factor', bars.baselineMilestoneVerticalOffsetFactor],
    ['Baseline Fill Opacity',                 bars.baselineFillOpacity],
    ['Milestone Shape',         bars.milestoneShape],
    ['Milestone Corner Radius', bars.milestoneCornerRadius],
    ['Task Corner Radius',      bars.taskCornerRadius],
    ['Arrowhead Size Factor',    bars.arrowheadSizeFactor],
    ['Origin Marker Size Factor', bars.originMarkerSizeFactor],
  ]);

  // ── 9. Timeline ───────────────────────────────────────────────────────────────
  // Dates are only written when they were explicitly set in the source file.
  // If derived from task dates, the cell is left empty so auto-derivation
  // continues to work after a save/reload cycle.
  addSheet('Timeline', [
    ['Field', 'Value'],
    ['Chart Start Date', timeline.chartStartDateExplicit ? toJsDate(timeline.chartStartDate) : null],
    ['Chart End Date',   timeline.chartEndDateExplicit   ? toJsDate(timeline.chartEndDate)   : null],
    ['Chart Date Format', timeline.chartDateFormat],
    ['Show Years',    boolStr(timeline.showYears)],
    ['Show Months',   boolStr(timeline.showMonths)],
    ['Show Weeks',    boolStr(timeline.showWeeks)],
    ['Show Days',     boolStr(timeline.showDays)],
    ['Show Dates',    boolStr(timeline.showDates)],
    ['Gridline Years',  boolStr(timeline.gridlineYears)],
    ['Gridline Months', boolStr(timeline.gridlineMonths)],
    ['Gridline Weeks',  boolStr(timeline.gridlineWeeks)],
    ['Gridline Days',   boolStr(timeline.gridlineDays)],
  ]);

  // ── 10. Titles ────────────────────────────────────────────────────────────────
  addSheet('Titles', [
    ['Field', 'Value'],
    ['Header Height',     titles.headerHeight],
    ['Header Text',       titles.headerText],
    ['Header Text Align', titles.headerTextAlign],
    ['Footer Height',     titles.footerHeight],
    ['Footer Text',       titles.footerText],
    ['Footer Text Align', titles.footerTextAlign],
  ]);

  // ── 11. Style ─────────────────────────────────────────────────────────────────
  addSheet('Style', [
    ['Field', 'Value'],
    ['Chart Background Color',         style.chartBackgroundColor],
    ['Header Footer Background Color', style.headerFooterBackgroundColor],
    ['Header Footer Border Color',     style.headerFooterBorderColor],
    ['Header Footer Text Color',       style.headerFooterTextColor],
    ['Swimlane Label Color',           style.swimlaneLabelColor],
    ['Swimlane Divider Color',         style.swimlaneDividerColor],
    ['Scale Background Color',         style.scaleBackgroundColor],
    ['Scale Tick Color',               style.scaleTickColor],
    ['Scale Label Text Color',         style.scaleLabelTextColor],
    ['Gridline Vertical Color',        style.gridlineVerticalColor],
    ['Task Stroke Color',              style.taskStrokeColor],
    ['Milestone Stroke Color',         style.milestoneStrokeColor],
    ['Outside Label Text Color',       style.outsideLabelTextColor],
    ['Leader Line Color',              style.leaderLineColor],
    ['Inside Label Text Color',        style.insideLabelTextColor],
    ['Note Text Color',                style.noteTextColor],
  ]);

  // ── 12. Typography ────────────────────────────────────────────────────────────
  addSheet('Typography', [
    ['Field', 'Value'],
    ['Font Family',                      typography.fontFamily],
    ['Task Font Size',                   typography.taskFontSize],
    ['Scale Font Size',                  typography.scaleFontSize],
    ['Header Footer Font Size',          typography.headerFooterFontSize],
    ['Note Font Size',                   typography.noteFontSize],
    ['Swimlane Font Size',               typography.swimlaneFontSize],
    ['Pipe Font Size',                   typography.pipeFontSize],
    ['Curtain Font Size',                typography.curtainFontSize],
    ['Scale Alignment Factor',           typography.scaleAlignmentFactor],
    ['Task Alignment Factor',            typography.taskAlignmentFactor],
    ['Header Footer Alignment Factor',   typography.headerFooterAlignmentFactor],
    ['Pipe Alignment Factor',            typography.pipeAlignmentFactor],
    ['Curtain Alignment Factor',         typography.curtainAlignmentFactor],
    ['Note Alignment Factor',            typography.noteAlignmentFactor],
    ['Swimlane Top Alignment Factor',    typography.swimlaneTopAlignmentFactor],
    ['Swimlane Bottom Alignment Factor', typography.swimlaneBottomAlignmentFactor],
  ]);

  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
}
