// renderer.js — SVG chart generation
// Exports renderChart(projectData) → SVG string. Does not modify projectData.

// ── Helpers ────────────────────────────────────────────────────────────────────

// Escape characters that are unsafe in SVG text content and attribute values.
function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Build display text for a task label; returns null when labelContent is 'none'.
function buildLabelText(task, defaultFmt) {
  if (task.labelContent === 'none') return null;
  const fmt = task.dateFormat || defaultFmt;
  if (task.labelContent === 'name') return task.name;
  const sd = task.startDate ? formatDate(task.startDate, fmt) : '';
  const fd = task.finishDate ? formatDate(task.finishDate, fmt) : '';
  if (task.labelContent === 'date') return task.isMilestone ? sd : `${sd} - ${fd}`;
  return task.isMilestone ? `${task.name} (${sd})` : `${task.name} (${sd} - ${fd})`;
}

// Truncate label to fit availWidth using fontSize * charWidthFactor per character (sans-serif estimate).
// Prefers a word-boundary break; falls back to character truncation.
function truncateLabel(text, availWidth, fontSize, charWidthFactor) {
  const charW = fontSize * charWidthFactor;
  if (text.length * charW <= availWidth) return text;
  const ellipsisW = charW;
  if (ellipsisW > availWidth) return '';
  const maxChars = Math.floor((availWidth - ellipsisW) / charW);
  if (maxChars <= 0) return '';
  const sub = text.slice(0, maxChars);
  const lastSpace = sub.lastIndexOf(' ');
  return (lastSpace > 0 ? text.slice(0, lastSpace) : sub) + '…';
}

// Format a number to at most 2 decimal places, dropping trailing zeros.
function n(v) { return parseFloat(v.toFixed(2)); }

const PATTERN_TYPES = new Set(['hatch', 'cross-hatch', 'horizontal', 'vertical', 'dots']);

function makePatternId(fillPattern, fillColor, patternColor) {
  return `pattern-${fillPattern}-${fillColor}-${patternColor}`.replace(/[^A-Za-z0-9-]/g, '-');
}

// ── Main render function ───────────────────────────────────────────────────────
function renderChart(projectData) {
  const { tasks, swimlanes, links, pipes, curtains, notes, config } = projectData;
  const { layout, bars, timeline, titles, style, typography, rendering } = config;

  const { outerWidth, outerHeight, paddingLeft, paddingRight, paddingTop, paddingBottom } = layout;
  const { chartStartDate, chartEndDate } = timeline;

  // Guard: need valid date range to render anything
  if (!chartStartDate || !chartEndDate) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${outerWidth}" height="${outerHeight}"></svg>`;
  }
  const totalDays = daysBetween(chartStartDate, chartEndDate);
  if (totalDays <= 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${outerWidth}" height="${outerHeight}"></svg>`;
  }

  // ── Scale geometry ───────────────────────────────────────────────────────────
  const visibleScales = [
    { key: 'years',  show: timeline.showYears,  gridline: timeline.gridlineYears  },
    { key: 'months', show: timeline.showMonths, gridline: timeline.gridlineMonths },
    { key: 'weeks',  show: timeline.showWeeks,  gridline: timeline.gridlineWeeks  },
    { key: 'dates',  show: timeline.showDates                                     },
    { key: 'days',   show: timeline.showDays,   gridline: timeline.gridlineDays   },
  ].filter(s => s.show);

  const bandH       = Math.max(rendering.minScaleBandHeight, typography.scaleFontSize * rendering.scaleFontToBandHeightFactor);
  const scaleTotalH = visibleScales.length * bandH;

  // ── Coordinate areas ─────────────────────────────────────────────────────────
  const innerX1    = paddingLeft;
  const innerX2    = outerWidth - paddingRight;
  const innerWidth = innerX2 - innerX1;

  const scaleY    = paddingTop + titles.headerHeight;
  const taskRowY1 = paddingTop + titles.headerHeight + scaleTotalH;
  const taskRowY2 = outerHeight - paddingBottom - titles.footerHeight;
  const taskRowH  = taskRowY2 - taskRowY1;

  // ── Time scale ───────────────────────────────────────────────────────────────
  const timeScale = innerWidth / totalDays;
  function xFor(dateStr) {
    return innerX1 + daysBetween(chartStartDate, dateStr) * timeScale;
  }

  // ── Swimlane geometry ────────────────────────────────────────────────────────
  const sorted    = [...swimlanes].sort((a, b) => a.order - b.order);
  const totalRows = sorted.reduce((sum, s) => sum + s.rowCount, 0);
  const rowH      = totalRows > 0 ? taskRowH / totalRows : 0;

  const startRowOf = {};
  let runRow = 0;
  for (const s of sorted) { startRowOf[s.id] = runRow; runRow += s.rowCount; }

  const byId = {};
  for (const s of sorted) byId[s.id] = s;

  // ── Date helpers ─────────────────────────────────────────────────────────────
  const [csY, csM] = chartStartDate.split('-').map(Number);
  const [ceY, ceM] = chartEndDate.split('-').map(Number);

  // Advance yr/mo by one month, returning new values
  function nextMo(yr, mo) {
    return mo === 12 ? { yr: yr + 1, mo: 1 } : { yr, mo: mo + 1 };
  }

  function moStr(yr, mo) {
    return `${yr}-${String(mo).padStart(2, '0')}-01`;
  }

  // JS Date → YYYY-MM-DD string, timezone-safe
  function dtIso(dt) {
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  }

  // ── SVG layer accumulators ────────────────────────────────────────────────────
  // Slot numbers follow the painter's algorithm z-order defined in CLAUDE.md.
  let bg = '',             // 1  chart background
      bandsSvg = '',       // 2  swimlane backgrounds
      curtainRectSvg = '', // 3  curtain tinted rectangles
      gridlines = '',      // 4  vertical gridlines
      scaleSvg = '',       // 5  scale bands
      dividersSvg = '',    // 6  swimlane dividers
      pipesSvg = '',       // 7  pipes
      curtainEdgesSvg = '', //    curtain boundary lines and badges
      linkBodySvg = '',   // 8  link bodies (path segments, no heads)
      barsSvg = '',       // 9  task bars
      milestonesSvg = '', // 10 milestones
      linkHeadSvg = '',   // 11 link arrowheads and origin markers
      taskLabelsSvg = '', // 12 task labels
      labelsSvg = '',     // 13 swimlane label overlays
      notesSvg = '',      // 14 notes
      headerSvg = '',     // 15 header band  \
      footerSvg = '';     // 15 footer band  /  emitted together, last

  // ── 1. Chart background ──────────────────────────────────────────────────────
  bg = `<rect x="0" y="0" width="${outerWidth}" height="${outerHeight}" fill="${style.chartBackgroundColor}"/>`;

  // ── 2. Swimlane backgrounds ──────────────────────────────────────────────────
  for (const s of sorted) {
    const sy = n(taskRowY1 + startRowOf[s.id] * rowH);
    const sh = n(s.rowCount * rowH);
    bandsSvg += `<rect x="${innerX1}" y="${sy}" width="${innerWidth}" height="${sh}" fill="${s.backgroundColor}"/>`;
  }

  // ── 3. Curtain tinted rectangles ─────────────────────────────────────────────
  for (const curtain of curtains) {
    if (!curtain.startDate || !curtain.endDate) continue;
    if (curtain.endDate <= curtain.startDate) continue;
    if (curtain.endDate < chartStartDate || curtain.startDate > chartEndDate) continue;
    const cx1 = Math.max(xFor(curtain.startDate), innerX1);
    const cx2 = Math.min(xFor(curtain.endDate), innerX2);
    if (cx2 <= cx1) continue;
    curtainRectSvg += `<rect x="${n(cx1)}" y="${n(taskRowY1)}" width="${n(cx2 - cx1)}" height="${n(taskRowY2 - taskRowY1)}" fill="${curtain.color}" fill-opacity="${curtain.opacity}"/>`;
  }

  // ── 4. Vertical gridlines ────────────────────────────────────────────────────
  function vLine(x) {
    const xr = n(x);
    return `<line x1="${xr}" y1="${n(taskRowY1)}" x2="${xr}" y2="${n(taskRowY2)}" stroke="${style.gridlineVerticalColor}" stroke-width="${rendering.gridlineStrokeWidth}"/>`;
  }

  // Year gridlines: at Jan 1 of each year after chartStartDate
  if (timeline.gridlineYears) {
    for (let yr = csY + 1; yr <= ceY; yr++) {
      const ds = `${yr}-01-01`;
      if (ds <= chartEndDate) gridlines += vLine(xFor(ds));
    }
  }

  // Month gridlines: at the 1st of each month after the chart's opening month
  if (timeline.gridlineMonths) {
    let { yr: myr, mo: mmo } = nextMo(csY, csM);
    while (true) {
      const ds = moStr(myr, mmo);
      if (ds >= chartEndDate) break;
      gridlines += vLine(xFor(ds));
      ({ yr: myr, mo: mmo } = nextMo(myr, mmo));
    }
  }

  // Week gridlines: at each Monday strictly after chartStartDate, up to (not including) chartEndDate
  if (timeline.gridlineWeeks) {
    const [gwy, gwm, gwd] = chartStartDate.split('-').map(Number);
    const gwdt = new Date(gwy, gwm - 1, gwd);
    gwdt.setDate(gwdt.getDate() + (1 - gwdt.getDay() + 7) % 7);
    while (true) {
      const ds = dtIso(gwdt);
      if (ds >= chartEndDate) break;
      if (ds > chartStartDate) gridlines += vLine(xFor(ds));
      gwdt.setDate(gwdt.getDate() + 7);
    }
  }

  // Day gridlines: at each calendar day strictly between chartStartDate and chartEndDate
  if (timeline.gridlineDays) {
    const [gdy, gdm, gdd] = chartStartDate.split('-').map(Number);
    const gddt = new Date(gdy, gdm - 1, gdd);
    while (true) {
      gddt.setDate(gddt.getDate() + 1);
      const ds = dtIso(gddt);
      if (ds >= chartEndDate) break;
      gridlines += vLine(xFor(ds));
    }
  }

  // ── 5. Scale bands ───────────────────────────────────────────────────────────
  visibleScales.forEach((scale, idx) => {
    const bY  = n(scaleY + idx * bandH);
    const bY2 = n(bY + bandH);

    scaleSvg += `<rect x="${innerX1}" y="${bY}" width="${innerWidth}" height="${n(bandH)}" fill="${style.scaleBackgroundColor}"/>`;

    function tick(x) {
      const xr = n(x);
      return `<line x1="${xr}" y1="${bY}" x2="${xr}" y2="${bY2}" stroke="${style.scaleTickColor}" stroke-width="${rendering.scaleTickStrokeWidth}"/>`;
    }

    function label(cx, text) {
      const ly = n(bY + bandH * typography.scaleAlignmentFactor);
      return `<text x="${n(cx)}" y="${ly}" text-anchor="middle" font-family="'${escapeXml(typography.fontFamily)}'" font-size="${typography.scaleFontSize}" fill="${style.scaleLabelTextColor}">${escapeXml(String(text))}</text>`;
    }

    if (scale.key === 'years') {
      for (let yr = csY; yr <= ceY; yr++) {
        const cx1 = yr === csY ? innerX1 : Math.max(innerX1, xFor(`${yr}-01-01`));
        const cx2 = yr < ceY  ? Math.min(innerX2, xFor(`${yr + 1}-01-01`)) : innerX2;
        if (yr > csY) scaleSvg += tick(Math.max(innerX1, xFor(`${yr}-01-01`)));
        if (cx2 - cx1 >= rendering.scaleMinLabelWidth) scaleSvg += label(cx1 + (cx2 - cx1) / 2, yr);
      }

    } else if (scale.key === 'months') {
      let myr = csY, mmo = csM;
      while (true) {
        const thisStr = moStr(myr, mmo);
        if (thisStr > chartEndDate) break;
        const { yr: nyr, mo: nmo } = nextMo(myr, mmo);
        const nextStr = moStr(nyr, nmo);
        const cx1 = Math.max(innerX1, xFor(thisStr));
        const cx2 = Math.min(innerX2, xFor(nextStr));
        if (cx1 >= innerX2) break;
        if (thisStr > chartStartDate) scaleSvg += tick(Math.max(innerX1, xFor(thisStr)));
        if (cx2 - cx1 >= rendering.scaleMinLabelWidth) scaleSvg += label(cx1 + (cx2 - cx1) / 2, rendering.monthLetters[mmo - 1]);
        myr = nyr; mmo = nmo;
      }

    } else if (scale.key === 'weeks') {
      // Build ordered list of Monday boundaries within the chart range
      const [wy0, wm0, wd0] = chartStartDate.split('-').map(Number);
      const wdt = new Date(wy0, wm0 - 1, wd0);
      wdt.setDate(wdt.getDate() + (1 - wdt.getDay() + 7) % 7);
      const wBounds = [chartStartDate];
      while (true) {
        const ds = dtIso(wdt);
        if (ds >= chartEndDate) break;
        wBounds.push(ds);
        wdt.setDate(wdt.getDate() + 7);
      }
      wBounds.push(chartEndDate);
      for (let i = 0; i < wBounds.length - 1; i++) {
        const wStart = wBounds[i];
        const wEnd   = wBounds[i + 1];
        if (wStart >= wEnd) continue;
        const cx1 = Math.max(innerX1, xFor(wStart));
        const cx2 = Math.min(innerX2, xFor(wEnd));
        if (cx1 >= innerX2) break;
        if (wStart > chartStartDate) scaleSvg += tick(Math.max(innerX1, xFor(wStart)));
        if (cx2 - cx1 >= rendering.scaleMinLabelWidth) scaleSvg += label(cx1 + (cx2 - cx1) / 2, isoWeekLabel(wStart));
      }

    } else if (scale.key === 'days') {
      // Named-day band: Monday/Mon/M/"" — width-adaptive, no fixed width gate
      const [dy0, dm0, dd0] = chartStartDate.split('-').map(Number);
      const ddt = new Date(dy0, dm0 - 1, dd0);
      const charW = typography.scaleFontSize * rendering.charWidthFactor;
      while (true) {
        const dayIso = dtIso(ddt);
        if (dayIso >= chartEndDate) break;
        ddt.setDate(ddt.getDate() + 1);
        const nextIso = dtIso(ddt);
        const cx1 = Math.max(innerX1, xFor(dayIso));
        const cx2 = Math.min(innerX2, xFor(nextIso));
        if (cx1 >= innerX2) break;
        if (dayIso > chartStartDate) scaleSvg += tick(Math.max(innerX1, xFor(dayIso)));
        const cellW = cx2 - cx1;
        let chosen = '';
        for (const v of [weekdayName(dayIso, 'full'), weekdayName(dayIso, 'short'), weekdayName(dayIso, 'letter')]) {
          if (v.length * charW <= cellW) { chosen = v; break; }
        }
        if (chosen) scaleSvg += label(cx1 + cellW / 2, chosen);
      }

    } else if (scale.key === 'dates') {
      // Numeric day-of-month band: "1" through "31"
      const [ny0, nm0, nd0] = chartStartDate.split('-').map(Number);
      const ndt = new Date(ny0, nm0 - 1, nd0);
      while (true) {
        const dayIso = dtIso(ndt);
        if (dayIso >= chartEndDate) break;
        ndt.setDate(ndt.getDate() + 1);
        const nextIso = dtIso(ndt);
        const cx1 = Math.max(innerX1, xFor(dayIso));
        const cx2 = Math.min(innerX2, xFor(nextIso));
        if (cx1 >= innerX2) break;
        if (dayIso > chartStartDate) scaleSvg += tick(Math.max(innerX1, xFor(dayIso)));
        const [, , dd] = dayIso.split('-').map(Number);
        if (cx2 - cx1 >= rendering.scaleMinLabelWidth) scaleSvg += label(cx1 + (cx2 - cx1) / 2, dd);
      }
    }

    // Bottom border for each scale band
    scaleSvg += `<line x1="${innerX1}" y1="${bY2}" x2="${innerX2}" y2="${bY2}" stroke="${style.scaleTickColor}" stroke-width="${rendering.scaleTickStrokeWidth}"/>`;
  });

  // ── 6. Swimlane dividers ─────────────────────────────────────────────────────
  sorted.forEach((s, i) => {
    if (layout.showRowDividers && i < sorted.length - 1) {
      const sy = taskRowY1 + startRowOf[s.id] * rowH;
      const sh = s.rowCount * rowH;
      const ly = n(sy + sh);
      dividersSvg += `<line x1="${innerX1}" y1="${ly}" x2="${innerX2}" y2="${ly}" stroke="${style.swimlaneDividerColor}" stroke-width="${rendering.swimlaneDividerStrokeWidth}"/>`;
    }
  });

  // ── 7. Pipes ─────────────────────────────────────────────────────────────────
  for (const pipe of pipes) {
    if (!pipe.date) continue;
    if (pipe.date < chartStartDate || pipe.date > chartEndDate) continue;

    const px = xFor(pipe.date);
    const dashAttr = pipe.lineStyle === 'dashed' ? ` stroke-dasharray="${rendering.pipeStrokeDasharrayDashed}"`
                   : pipe.lineStyle === 'dotted'  ? ` stroke-dasharray="${rendering.pipeStrokeDasharrayDotted}"`
                   : '';
    pipesSvg += `<line x1="${n(px)}" y1="${n(taskRowY1)}" x2="${n(px)}" y2="${n(taskRowY2)}" stroke="${pipe.color}" stroke-width="${rendering.pipeStrokeWidth}"${dashAttr}/>`;

    if (pipe.name) {
      const fontSize   = typography.pipeFontSize;
      const textW      = fontSize * rendering.charWidthFactor * pipe.name.length;
      const badgeW     = textW + 2 * rendering.pipeBadgePaddingX;
      const badgeH     = fontSize + 2 * rendering.pipeBadgePaddingY;
      const areaH      = taskRowY2 - taskRowY1;
      const badgeTopY  = taskRowY1 + (1 - pipe.labelPosition) * (areaH - badgeH);
      const textCX     = px + badgeW / 2;
      const textY      = n(badgeTopY + badgeH * typography.pipeAlignmentFactor);
      pipesSvg += `<rect x="${n(px)}" y="${n(badgeTopY)}" width="${n(badgeW)}" height="${n(badgeH)}" fill="${style.chartBackgroundColor}" stroke="${pipe.color}" stroke-width="${rendering.pipeStrokeWidth}"/>`;
      pipesSvg += `<text x="${n(textCX)}" y="${textY}" text-anchor="middle" font-family="'${escapeXml(typography.fontFamily)}'" font-size="${fontSize}" fill="${pipe.color}">${escapeXml(pipe.name)}</text>`;
    }
  }

  // ── 7. Curtain boundary lines and badges ─────────────────────────────────────
  for (const curtain of curtains) {
    if (!curtain.startDate || !curtain.endDate) continue;
    if (curtain.endDate <= curtain.startDate) continue;
    if (curtain.endDate < chartStartDate || curtain.startDate > chartEndDate) continue;

    const xStart = xFor(curtain.startDate);
    const xEnd   = xFor(curtain.endDate);

    if (xStart >= innerX1 && xStart <= innerX2) {
      curtainEdgesSvg += `<line x1="${n(xStart)}" y1="${n(taskRowY1)}" x2="${n(xStart)}" y2="${n(taskRowY2)}" stroke="${curtain.color}" stroke-width="${rendering.curtainStrokeWidth}"/>`;
    }
    if (xEnd >= innerX1 && xEnd <= innerX2) {
      curtainEdgesSvg += `<line x1="${n(xEnd)}" y1="${n(taskRowY1)}" x2="${n(xEnd)}" y2="${n(taskRowY2)}" stroke="${curtain.color}" stroke-width="${rendering.curtainStrokeWidth}"/>`;
    }

    if (curtain.name) {
      const anchorX = curtain.labelAnchor === 'end' ? xEnd : xStart;
      if (anchorX >= innerX1 && anchorX <= innerX2) {
        const fontSize  = typography.curtainFontSize;
        const textW     = fontSize * rendering.charWidthFactor * curtain.name.length;
        const badgeW    = textW + 2 * rendering.curtainBadgePaddingX;
        const badgeH    = fontSize + 2 * rendering.curtainBadgePaddingY;
        const areaH     = taskRowY2 - taskRowY1;
        const badgeTopY = taskRowY1 + (1 - curtain.labelPosition) * (areaH - badgeH);
        const textCX    = anchorX + badgeW / 2;
        const textY     = n(badgeTopY + badgeH * typography.curtainAlignmentFactor);
        curtainEdgesSvg += `<rect x="${n(anchorX)}" y="${n(badgeTopY)}" width="${n(badgeW)}" height="${n(badgeH)}" fill="${style.chartBackgroundColor}" stroke="${curtain.color}" stroke-width="${rendering.curtainStrokeWidth}"/>`;
        curtainEdgesSvg += `<text x="${n(textCX)}" y="${textY}" text-anchor="middle" font-family="'${escapeXml(typography.fontFamily)}'" font-size="${fontSize}" fill="${curtain.color}">${escapeXml(curtain.name)}</text>`;
      }
    }
  }

  // ── 15. Header band ──────────────────────────────────────────────────────────
  if (titles.headerHeight > 0) {
    const hY = paddingTop;
    const hW = outerWidth - paddingLeft - paddingRight;
    headerSvg += `<rect x="${paddingLeft}" y="${hY}" width="${hW}" height="${titles.headerHeight}" fill="${style.headerFooterBackgroundColor}"/>`;
    if (titles.headerText) {
      const ty = n(hY + titles.headerHeight * typography.headerFooterAlignmentFactor);
      let tx, anchor;
      if (titles.headerTextAlign === 'left') {
        tx = paddingLeft + rendering.headerFooterTextPadding;            anchor = 'start';
      } else if (titles.headerTextAlign === 'right') {
        tx = paddingLeft + hW - rendering.headerFooterTextPadding;       anchor = 'end';
      } else {
        tx = paddingLeft + hW / 2;                                       anchor = 'middle';
      }
      headerSvg += `<text x="${n(tx)}" y="${ty}" text-anchor="${anchor}" font-family="'${escapeXml(typography.fontFamily)}'" font-size="${typography.headerFooterFontSize}" fill="${style.headerFooterTextColor}">${escapeXml(titles.headerText)}</text>`;
    }
    const hBy = hY + titles.headerHeight;
    headerSvg += `<line x1="${paddingLeft}" y1="${n(hBy)}" x2="${paddingLeft + hW}" y2="${n(hBy)}" stroke="${style.headerFooterBorderColor}" stroke-width="${rendering.headerFooterBorderStrokeWidth}"/>`;
  }

  // ── 15. Footer band ──────────────────────────────────────────────────────────
  if (titles.footerHeight > 0) {
    const fy = outerHeight - paddingBottom - titles.footerHeight;
    const fW = outerWidth - paddingLeft - paddingRight;
    footerSvg += `<rect x="${paddingLeft}" y="${fy}" width="${fW}" height="${titles.footerHeight}" fill="${style.headerFooterBackgroundColor}"/>`;
    if (titles.footerText) {
      const ty = n(fy + titles.footerHeight * typography.headerFooterAlignmentFactor);
      let tx, anchor;
      if (titles.footerTextAlign === 'left') {
        tx = paddingLeft + rendering.headerFooterTextPadding;            anchor = 'start';
      } else if (titles.footerTextAlign === 'right') {
        tx = paddingLeft + fW - rendering.headerFooterTextPadding;       anchor = 'end';
      } else {
        tx = paddingLeft + fW / 2;                                       anchor = 'middle';
      }
      footerSvg += `<text x="${n(tx)}" y="${ty}" text-anchor="${anchor}" font-family="'${escapeXml(typography.fontFamily)}'" font-size="${typography.headerFooterFontSize}" fill="${style.headerFooterTextColor}">${escapeXml(titles.footerText)}</text>`;
    }
    footerSvg += `<line x1="${paddingLeft}" y1="${n(fy)}" x2="${paddingLeft + fW}" y2="${n(fy)}" stroke="${style.headerFooterBorderColor}" stroke-width="${rendering.headerFooterBorderStrokeWidth}"/>`;
  }

  // ── <defs>: collect SVG fill patterns (final assembly deferred until after notes pass) ──
  let patternDefsContent = '';
  {
    const patternDefs = new Map();
    for (const task of tasks) {
      if (task.isMilestone || !PATTERN_TYPES.has(task.fillPattern)) continue;
      const id = makePatternId(task.fillPattern, task.fillColor, task.patternColor);
      if (!patternDefs.has(id)) {
        patternDefs.set(id, { fillPattern: task.fillPattern, fillColor: task.fillColor, patternColor: task.patternColor });
      }
    }
    if (patternDefs.size > 0) {
      const ts = rendering.patternTileSize;
      const sw = rendering.patternStrokeWidth;
      const dr = rendering.patternDotRadius;
      for (const [id, { fillPattern, fillColor, patternColor }] of patternDefs) {
        let overlay = '';
        if (fillPattern === 'hatch') {
          overlay = `<line x1="0" y1="${ts}" x2="${ts}" y2="0" stroke="${patternColor}" stroke-width="${sw}"/>`;
        } else if (fillPattern === 'cross-hatch') {
          overlay  = `<line x1="0" y1="${ts}" x2="${ts}" y2="0" stroke="${patternColor}" stroke-width="${sw}"/>`;
          overlay += `<line x1="0" y1="0" x2="${ts}" y2="${ts}" stroke="${patternColor}" stroke-width="${sw}"/>`;
        } else if (fillPattern === 'horizontal') {
          overlay = `<line x1="0" y1="${n(ts / 2)}" x2="${ts}" y2="${n(ts / 2)}" stroke="${patternColor}" stroke-width="${sw}"/>`;
        } else if (fillPattern === 'vertical') {
          overlay = `<line x1="${n(ts / 2)}" y1="0" x2="${n(ts / 2)}" y2="${ts}" stroke="${patternColor}" stroke-width="${sw}"/>`;
        } else { // dots
          overlay = `<circle cx="${n(ts / 2)}" cy="${n(ts / 2)}" r="${dr}" fill="${patternColor}"/>`;
        }
        patternDefsContent += `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${ts}" height="${ts}"><rect width="${ts}" height="${ts}" fill="${fillColor}"/>${overlay}</pattern>`;
      }
    }
  }

  // ── 9 / 10. Task bars, milestones, and task geometry lookup ──────────────────
  // taskGeom is also consumed by the link renderer (slots 8 and 11).
  const barH          = rowH * bars.taskBarHeightFactor;
  const milestoneHalf = (rowH * bars.milestoneSizeFactor) / 2;
  const taskGeom      = new Map(); // task.id → geometry used by link renderer

  for (const task of tasks) {
    const swimlane = byId[task.swimlaneId];
    if (!swimlane) continue;                            // orphaned
    if (!task.startDate || !task.finishDate) continue;
    if (task.finishDate < task.startDate) continue;
    if (task.startDate > chartEndDate) continue;
    if (task.finishDate < chartStartDate) continue;

    const row        = (task.row > swimlane.rowCount) ? 1 : task.row;
    const absRow     = startRowOf[task.swimlaneId] + row - 1;
    const rowY       = taskRowY1 + absRow * rowH;
    const rowCenterY = rowY + rowH / 2;
    const color      = task.fillColor;

    if (task.isMilestone) {
      const cx   = xFor(task.startDate);
      const cy   = rowCenterY;
      const half = milestoneHalf;

      if (bars.milestoneShape === 'circle') {
        milestonesSvg += `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(half)}" fill="${color}" stroke="${style.milestoneStrokeColor}" stroke-width="${rendering.milestoneStrokeWidth}"/>`;
      } else {
        // Diamond with optional rounded corners. d = corner-shortening distance along each
        // edge; r = arc radius (= d, since the diamond's interior angles are 90°).
        const cr = bars.milestoneCornerRadius;
        const r  = cr * half / Math.SQRT2;
        const dh = cr * half / 2;             // d / sqrt(2) — projection of d onto x or y axis
        const a1x = cx + dh,        a1y = cy - half + dh;  // top, shortened toward right
        const a2x = cx + half - dh, a2y = cy - dh;         // right, shortened toward top
        const b2x = cx + half - dh, b2y = cy + dh;         // right, shortened toward bottom
        const a3x = cx + dh,        a3y = cy + half - dh;  // bottom, shortened toward right
        const b3x = cx - dh,        b3y = cy + half - dh;  // bottom, shortened toward left
        const a4x = cx - half + dh, a4y = cy + dh;         // left, shortened toward bottom
        const b4x = cx - half + dh, b4y = cy - dh;         // left, shortened toward top
        const c1x = cx - dh,        c1y = cy - half + dh;  // top, shortened toward left
        const pathD = `M ${n(a1x)},${n(a1y)} L ${n(a2x)},${n(a2y)} A ${n(r)} ${n(r)} 0 0 1 ${n(b2x)},${n(b2y)} L ${n(a3x)},${n(a3y)} A ${n(r)} ${n(r)} 0 0 1 ${n(b3x)},${n(b3y)} L ${n(a4x)},${n(a4y)} A ${n(r)} ${n(r)} 0 0 1 ${n(b4x)},${n(b4y)} L ${n(c1x)},${n(c1y)} A ${n(r)} ${n(r)} 0 0 1 ${n(a1x)},${n(a1y)} Z`;
        milestonesSvg += `<path d="${pathD}" fill="${color}" stroke="${style.milestoneStrokeColor}" stroke-width="${rendering.milestoneStrokeWidth}"/>`;
      }

      taskGeom.set(task.id, {
        absRow,
        rowCenterY:  cy,
        barTopY:     cy - half,
        barBottomY:  cy + half,
        originX:     cx,
        termX:       cx,
        startDate:   task.startDate,
        finishDate:  task.finishDate,
        isMilestone: true,
      });

      const milestoneLabel = buildLabelText(task, config.preferences.chartDateFormat);
      if (milestoneLabel) {
        const rightEdge = cx + half;
        const lx = n(rightEdge + rendering.outsideLabelKissingGap + task.labelOffset);
        const ly = n(rowY + rowH * typography.taskAlignmentFactor);
        if (task.labelOffset > 0) {
          taskLabelsSvg += `<line x1="${n(rightEdge)}" y1="${n(cy)}" x2="${n(rightEdge + task.labelOffset)}" y2="${n(cy)}" stroke="${style.leaderLineColor}" stroke-width="${rendering.leaderLineStrokeWidth}"/>`;
        }
        taskLabelsSvg += `<text x="${lx}" y="${ly}" text-anchor="start" font-family="'${escapeXml(typography.fontFamily)}'" font-size="${typography.taskFontSize}" fill="${style.outsideLabelTextColor}">${escapeXml(milestoneLabel)}</text>`;
      }
    } else {
      const x1   = Math.max(innerX1, xFor(task.startDate));
      const x2   = Math.min(innerX2, xFor(task.finishDate));
      const bw   = x2 - x1;
      if (bw <= 0) continue;
      const barY = rowY + (rowH - barH) / 2;
      const barFill = PATTERN_TYPES.has(task.fillPattern)
        ? `url(#${makePatternId(task.fillPattern, task.fillColor, task.patternColor)})`
        : color;
      barsSvg += `<rect x="${n(x1)}" y="${n(barY)}" width="${n(bw)}" height="${n(barH)}" rx="${bars.taskCornerRadius}" fill="${barFill}" stroke="${style.taskStrokeColor}" stroke-width="${rendering.taskStrokeWidth}"/>`;

      taskGeom.set(task.id, {
        absRow,
        rowCenterY,
        barTopY:     barY,
        barBottomY:  barY + barH,
        originX:     xFor(task.finishDate),
        termX:       xFor(task.startDate),
        startDate:   task.startDate,
        finishDate:  task.finishDate,
        isMilestone: false,
      });

      const barLabel = buildLabelText(task, config.preferences.chartDateFormat);
      if (barLabel) {
        if (task.labelPlacement === 'inside') {
          const availW    = bw - 2 * rendering.insideLabelPadding;
          const truncated = truncateLabel(barLabel, availW, typography.taskFontSize, rendering.charWidthFactor);
          if (truncated) {
            const lx = n(x1 + rendering.insideLabelPadding);
            const ly = n(rowY + rowH * typography.taskAlignmentFactor);
            taskLabelsSvg += `<text x="${lx}" y="${ly}" text-anchor="start" font-family="'${escapeXml(typography.fontFamily)}'" font-size="${typography.taskFontSize}" fill="${style.insideLabelTextColor}">${escapeXml(truncated)}</text>`;
          }
        } else {
          const rightEdge = xFor(task.finishDate);
          const lx = n(rightEdge + rendering.outsideLabelKissingGap + task.labelOffset);
          const ly = n(rowY + rowH * typography.taskAlignmentFactor);
          if (task.labelOffset > 0) {
            taskLabelsSvg += `<line x1="${n(rightEdge)}" y1="${n(rowCenterY)}" x2="${n(rightEdge + task.labelOffset)}" y2="${n(rowCenterY)}" stroke="${style.leaderLineColor}" stroke-width="${rendering.leaderLineStrokeWidth}"/>`;
          }
          taskLabelsSvg += `<text x="${lx}" y="${ly}" text-anchor="start" font-family="'${escapeXml(typography.fontFamily)}'" font-size="${typography.taskFontSize}" fill="${style.outsideLabelTextColor}">${escapeXml(barLabel)}</text>`;
        }
      }
    }
  }

  // ── 8 / 11. Links ────────────────────────────────────────────────────────────
  // Pre-compute all valid link geometry into renderedLinks, then emit bodies
  // (slot 8) and heads (slot 11) as separate passes to maintain z-order.
  const aH            = rendering.arrowheadSizeFactor * rowH;
  const oR            = rendering.originMarkerSizeFactor * rowH;
  const renderedLinks = [];

  for (const link of links) {
    const pred = taskGeom.get(link.fromTaskId);
    const succ = taskGeom.get(link.toTaskId);
    if (!pred || !succ) continue; // orphaned — one or both tasks not rendered

    const color = link.lineColor;
    const dashAttr = link.lineStyle === 'dashed' ? ` stroke-dasharray="${rendering.linkStrokeDasharrayDashed}"` : '';

    const origX = pred.originX;
    const origY = pred.rowCenterY;
    let termX, termY, isLate;

    if (pred.finishDate <= succ.startDate) {
      // Forward link
      termX = succ.termX;
      termY = succ.rowCenterY;
      if (origX >= termX) continue; // backwards geometry — skip silently
    } else if (pred.finishDate < succ.finishDate && pred.absRow !== succ.absRow) {
      // Late-recoverable: different rows, succ still in progress when pred finishes
      isLate = true;
      termX  = origX; // path is exactly vertical: termination x equals origin x
      termY  = succ.absRow > pred.absRow ? succ.barTopY : succ.barBottomY;
    } else {
      continue; // invalid (pred.finishDate >= succ.finishDate, or same-row late)
    }

    let pathD, arrowDir;

    if (isLate) {
      pathD    = `M ${n(origX)},${n(origY)} L ${n(termX)},${n(termY)}`;
      arrowDir = succ.absRow > pred.absRow ? 'down' : 'up';
    } else {
      const sameRow = pred.absRow === succ.absRow;

      if (link.routing === 'auto' && sameRow) {
        // Direct horizontal line — no bends, unchanged
        pathD    = `M ${n(origX)},${n(origY)} L ${n(termX)},${n(termY)}`;
        arrowDir = 'right';
      } else if (link.routing === 'hv') {
        const segA  = termX - origX;
        const segB  = Math.abs(termY - origY);
        const r     = Math.min(rendering.linkCornerRadius, segA / 2, segB / 2);
        const sweep = termY >= origY ? 1 : 0;
        const arcEndY = termY >= origY ? origY + r : origY - r;
        pathD    = `M ${n(origX)},${n(origY)} L ${n(termX - r)},${n(origY)} A ${n(r)} ${n(r)} 0 0 ${sweep} ${n(termX)},${n(arcEndY)} L ${n(termX)},${n(termY)}`;
        arrowDir = (origY === termY) ? 'right' : (termY > origY ? 'down' : 'up');
      } else if (link.routing === 'vh') {
        const segA      = Math.abs(termY - origY);
        const segB      = termX - origX;
        const r         = Math.min(rendering.linkCornerRadius, segA / 2, segB / 2);
        const sweep     = termY >= origY ? 0 : 1;
        const arcStartY = termY >= origY ? termY - r : termY + r;
        pathD    = `M ${n(origX)},${n(origY)} L ${n(origX)},${n(arcStartY)} A ${n(r)} ${n(r)} 0 0 ${sweep} ${n(origX + r)},${n(termY)} L ${n(termX)},${n(termY)}`;
        arrowDir = 'right';
      } else {
        // AUTO V-H-V: midpoint y is the mean of origin y and termination y
        const midY  = (origY + termY) / 2;
        const A1    = Math.abs(midY - origY);
        const H     = termX - origX;
        const A2    = Math.abs(termY - midY);
        const r1    = Math.min(rendering.linkCornerRadius, A1 / 2, H / 2);
        const r2    = Math.min(rendering.linkCornerRadius, A2 / 2, H / 2);
        const sweep1   = termY >= origY ? 0 : 1; // down→right: 0, up→right: 1
        const sweep2   = termY >= origY ? 1 : 0; // right→down: 1, right→up: 0
        const b1StartY = termY >= origY ? midY - r1 : midY + r1;
        const b2EndY   = termY >= origY ? midY + r2 : midY - r2;
        pathD    = `M ${n(origX)},${n(origY)} L ${n(origX)},${n(b1StartY)} A ${n(r1)} ${n(r1)} 0 0 ${sweep1} ${n(origX + r1)},${n(midY)} L ${n(termX - r2)},${n(midY)} A ${n(r2)} ${n(r2)} 0 0 ${sweep2} ${n(termX)},${n(b2EndY)} L ${n(termX)},${n(termY)}`;
        arrowDir = termY > origY ? 'down' : 'up';
      }
    }

    renderedLinks.push({ pathD, arrowDir, termX, termY, origX, origY, color, dashAttr, predIsMilestone: pred.isMilestone, succIsMilestone: succ.isMilestone });
  }

  // Slot 8: link bodies
  for (const rl of renderedLinks) {
    linkBodySvg += `<path d="${rl.pathD}" stroke="${rl.color}" stroke-width="${rendering.linkStrokeWidth}" fill="none"${rl.dashAttr}/>`;
  }

  // Slot 11: link arrowheads and origin markers
  for (const rl of renderedLinks) {
    if (!rl.predIsMilestone) {
      linkHeadSvg += `<circle cx="${n(rl.origX)}" cy="${n(rl.origY)}" r="${n(oR)}" fill="${rl.color}"/>`;
    }

    let tx = rl.termX, ty = rl.termY;
    if (rl.succIsMilestone) {
      const backoff = milestoneHalf + rendering.linkArrowheadMilestoneGap;
      if      (rl.arrowDir === 'right') tx -= backoff;
      else if (rl.arrowDir === 'down')  ty -= backoff;
      else                              ty += backoff; // up
    }
    const dir = rl.arrowDir;
    let pts;
    if (dir === 'right') {
      pts = `${n(tx)},${n(ty)} ${n(tx - aH)},${n(ty - aH / 2)} ${n(tx - aH)},${n(ty + aH / 2)}`;
    } else if (dir === 'down') {
      pts = `${n(tx)},${n(ty)} ${n(tx - aH / 2)},${n(ty - aH)} ${n(tx + aH / 2)},${n(ty - aH)}`;
    } else { // up
      pts = `${n(tx)},${n(ty)} ${n(tx - aH / 2)},${n(ty + aH)} ${n(tx + aH / 2)},${n(ty + aH)}`;
    }
    linkHeadSvg += `<polygon points="${pts}" fill="${rl.color}"/>`;
  }

  // ── 13. Swimlane labels ──────────────────────────────────────────────────────
  const pad = rendering.swimlaneLabelPadding;
  for (const s of sorted) {
    const sy  = taskRowY1 + startRowOf[s.id] * rowH;
    const sh  = s.rowCount * rowH;
    const pos = s.labelPosition;

    let tx, anchor, ty;
    if (pos === 'top-right') {
      tx = innerX2 - pad;  anchor = 'end';
      ty = n(sy + rowH * typography.swimlaneTopAlignmentFactor);
    } else if (pos === 'top-left') {
      tx = innerX1 + pad;  anchor = 'start';
      ty = n(sy + rowH * typography.swimlaneTopAlignmentFactor);
    } else if (pos === 'bottom-right') {
      tx = innerX2 - pad;  anchor = 'end';
      ty = n(sy + sh - rowH * (1 - typography.swimlaneBottomAlignmentFactor));
    } else {  // bottom-left
      tx = innerX1 + pad;  anchor = 'start';
      ty = n(sy + sh - rowH * (1 - typography.swimlaneBottomAlignmentFactor));
    }

    labelsSvg += `<text x="${n(tx)}" y="${ty}" text-anchor="${anchor}" font-family="'${escapeXml(typography.fontFamily)}'" font-size="${typography.swimlaneFontSize}" fill="${style.swimlaneLabelColor}">${escapeXml(s.name)}</text>`;
  }

  // ── 14. Notes ─────────────────────────────────────────────────────────────────
  let noteClipDefs = '';
  for (const note of notes) {
    if (note.text === '') continue;
    if (note.widthPct <= 0 || note.heightPct <= 0) continue;
    if (note.xPct >= 100 || note.yPct >= 100) continue;
    if (note.xPct + note.widthPct <= 0 || note.yPct + note.heightPct <= 0) continue;

    const noteX = innerX1 + (note.xPct / 100) * innerWidth;
    const noteY = taskRowY1 + (note.yPct / 100) * taskRowH;
    const noteW = (note.widthPct / 100) * innerWidth;
    const noteH = (note.heightPct / 100) * taskRowH;

    if (note.fillColor || note.borderColor) {
      const fill   = note.fillColor   || 'none';
      const stroke = note.borderColor || 'none';
      notesSvg += `<rect x="${n(noteX)}" y="${n(noteY)}" width="${n(noteW)}" height="${n(noteH)}" rx="${rendering.noteCornerRadius}" fill="${fill}" stroke="${stroke}" stroke-width="${rendering.noteBorderStrokeWidth}"/>`;
    }

    const availW = noteW - 2 * rendering.notePadding;
    if (availW <= 0) continue;

    const fontSize   = typography.noteFontSize;
    const charW      = fontSize * rendering.charWidthFactor;
    const lineHeight = n(fontSize * rendering.noteLineHeightFactor);

    const lines = [];
    for (const segment of note.text.split('\n')) {
      if (!segment) { lines.push(''); continue; }
      const tokens = segment.split(/\s+/).filter(t => t.length > 0);
      let cur = '';
      for (const token of tokens) {
        if (token.length * charW > availW) {
          if (cur) { lines.push(cur); cur = ''; }
          const maxChars = Math.floor((availW - charW) / charW);
          lines.push(maxChars > 0 ? token.slice(0, maxChars) + '…' : '…');
          continue;
        }
        const candidate = cur ? cur + ' ' + token : token;
        if (candidate.length * charW <= availW) {
          cur = candidate;
        } else {
          if (cur) lines.push(cur);
          cur = token;
        }
      }
      if (cur) lines.push(cur);
    }

    if (lines.length === 0) continue;

    const blockHeight = lines.length * lineHeight;
    const alignFactor = typography.noteAlignmentFactor;
    const vAlign      = note.verticalAlign;
    let firstLineY;
    if (vAlign === 'middle') {
      firstLineY = noteY + (noteH - blockHeight) / 2 + fontSize * alignFactor;
    } else if (vAlign === 'bottom') {
      firstLineY = noteY + noteH - rendering.notePadding - blockHeight + fontSize * alignFactor;
    } else {
      firstLineY = noteY + rendering.notePadding + fontSize * alignFactor;
    }

    const hAlign = note.textAlign;
    let textX, textAnchor;
    if (hAlign === 'center') {
      textX = noteX + noteW / 2;  textAnchor = 'middle';
    } else if (hAlign === 'right') {
      textX = noteX + noteW - rendering.notePadding;  textAnchor = 'end';
    } else {
      textX = noteX + rendering.notePadding;  textAnchor = 'start';
    }

    const clipId = `note-clip-${note.id}`;
    noteClipDefs += `<clipPath id="${clipId}"><rect x="${n(noteX)}" y="${n(noteY)}" width="${n(noteW)}" height="${n(noteH)}"/></clipPath>`;

    // Empty wrapped lines (from consecutive \n in the source) need a
    // non-breaking space so the <tspan> reserves glyph height; an empty tspan
    // is zero-height and collapses the intended blank line.
    const renderTspanContent = line => line === '' ? '&#160;' : escapeXml(line);
    const firstTspan = `<tspan x="${n(textX)}">${renderTspanContent(lines[0])}</tspan>`;
    const restTspans  = lines.slice(1).map(line => `<tspan x="${n(textX)}" dy="${lineHeight}">${renderTspanContent(line)}</tspan>`).join('');
    notesSvg += `<text x="${n(textX)}" y="${n(firstLineY)}" text-anchor="${textAnchor}" font-family="'${escapeXml(typography.fontFamily)}'" font-size="${fontSize}" fill="${style.noteTextColor}" clip-path="url(#${clipId})">${firstTspan}${restTspans}</text>`;
  }

  // ── <defs>: final assembly (patterns + note clip paths) ──────────────────────
  const defsSvg = (patternDefsContent || noteClipDefs)
    ? `<defs>${patternDefsContent}${noteClipDefs}</defs>`
    : '';

  // ── Assemble SVG (painter's algorithm, back to front) ────────────────────────
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${outerWidth}" height="${outerHeight}">`,
    defsSvg,
    `<g id="bg">${bg}</g>`,
    `<g id="swimlane-bands">${bandsSvg}</g>`,
    `<g id="curtains">${curtainRectSvg}</g>`,
    `<g id="gridlines">${gridlines}</g>`,
    `<g id="scale-bands">${scaleSvg}</g>`,
    `<g id="swimlane-dividers">${dividersSvg}</g>`,
    `<g id="pipes">${pipesSvg}</g>`,
    `<g id="curtain-edges">${curtainEdgesSvg}</g>`,
    `<g id="link-bodies">${linkBodySvg}</g>`,
    `<g id="task-bars">${barsSvg}</g>`,
    `<g id="milestones">${milestonesSvg}</g>`,
    `<g id="link-heads">${linkHeadSvg}</g>`,
    `<g id="task-labels">${taskLabelsSvg}</g>`,
    `<g id="swimlane-labels">${labelsSvg}</g>`,
    `<g id="notes">${notesSvg}</g>`,
    `<g id="header-footer">${headerSvg}${footerSvg}</g>`,
    `</svg>`,
  ].join('');
}
