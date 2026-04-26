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

// Truncate label to fit availWidth using fontSize * 0.6 per character (sans-serif estimate).
// Prefers a word-boundary break; falls back to character truncation.
function truncateLabel(text, availWidth, fontSize) {
  const charW = fontSize * 0.6;
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

// ── Main render function ───────────────────────────────────────────────────────
function renderChart(projectData) {
  const { tasks, swimlanes, links, config } = projectData;
  const { layout, timeline, titles, style, typography, rendering } = config;

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
    { key: 'days',   show: timeline.showDays,   gridline: timeline.gridlineDays   },
  ].filter(s => s.show);

  const bandH       = Math.max(rendering.minScaleBandHeight, typography.scaleFontSize * 2.5);
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

  // ── SVG layer accumulators ────────────────────────────────────────────────────
  // Slot numbers follow the painter's algorithm z-order defined in CLAUDE.md.
  let bg = '',            // 1  chart background
      bandsSvg = '',      // 2  swimlane backgrounds
                          // 3  curtains — not yet implemented
      gridlines = '',     // 4  vertical gridlines
      scaleSvg = '',      // 5  scale bands
      dividersSvg = '',   // 6  swimlane dividers
                          // 7  pipes — not yet implemented
      linkBodySvg = '',   // 8  link bodies (path segments, no heads)
      barsSvg = '',       // 9  task bars
      milestonesSvg = '', // 10 milestones
      linkHeadSvg = '',   // 11 link arrowheads and origin markers
      taskLabelsSvg = '', // 12 task labels
      labelsSvg = '',     // 13 swimlane label overlays
                          // 14 notes — not yet implemented
      headerSvg = '',     // 15 header band  \
      footerSvg = '';     // 15 footer band  /  emitted together, last

  // ── 1. Chart background ──────────────────────────────────────────────────────
  bg = `<rect x="0" y="0" width="${outerWidth}" height="${outerHeight}" fill="${style.chartBackgroundColor}"/>`;

  // ── 2. Swimlane backgrounds ──────────────────────────────────────────────────
  for (const s of sorted) {
    const sy = n(taskRowY1 + startRowOf[s.id] * rowH);
    const sh = n(s.rowCount * rowH);
    bandsSvg += `<rect x="${innerX1}" y="${sy}" width="${innerWidth}" height="${sh}" fill="${s.backgroundColor || 'white'}"/>`;
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

  // ── 5. Scale bands ───────────────────────────────────────────────────────────
  const MONTH_LETTERS = ['J','F','M','A','M','J','J','A','S','O','N','D'];

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
      return `<text x="${n(cx)}" y="${ly}" text-anchor="middle" font-family="'${escapeXml(typography.fontFamily)}'" font-size="${typography.scaleFontSize}" fill="black">${escapeXml(String(text))}</text>`;
    }

    if (scale.key === 'years') {
      for (let yr = csY; yr <= ceY; yr++) {
        const cx1 = yr === csY ? innerX1 : Math.max(innerX1, xFor(`${yr}-01-01`));
        const cx2 = yr < ceY  ? Math.min(innerX2, xFor(`${yr + 1}-01-01`)) : innerX2;
        if (yr > csY) scaleSvg += tick(Math.max(innerX1, xFor(`${yr}-01-01`)));
        if (cx2 - cx1 >= 20) scaleSvg += label(cx1 + (cx2 - cx1) / 2, yr);
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
        if (cx2 - cx1 >= 20) scaleSvg += label(cx1 + (cx2 - cx1) / 2, MONTH_LETTERS[mmo - 1]);
        myr = nyr; mmo = nmo;
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

  // ── 15. Header band ──────────────────────────────────────────────────────────
  if (titles.headerHeight > 0) {
    const hY = paddingTop;
    const hW = outerWidth - paddingLeft - paddingRight;
    headerSvg += `<rect x="${paddingLeft}" y="${hY}" width="${hW}" height="${titles.headerHeight}" fill="${style.headerFooterBackgroundColor}"/>`;
    if (titles.headerText) {
      const ty = n(hY + titles.headerHeight * typography.headerFooterAlignmentFactor);
      headerSvg += `<text x="${n(paddingLeft + hW / 2)}" y="${ty}" text-anchor="middle" font-family="'${escapeXml(typography.fontFamily)}'" font-size="${typography.headerFooterFontSize}" fill="black">${escapeXml(titles.headerText)}</text>`;
    }
  }

  // ── 15. Footer band ──────────────────────────────────────────────────────────
  if (titles.footerHeight > 0) {
    const fy = outerHeight - paddingBottom - titles.footerHeight;
    const fW = outerWidth - paddingLeft - paddingRight;
    footerSvg += `<rect x="${paddingLeft}" y="${fy}" width="${fW}" height="${titles.footerHeight}" fill="${style.headerFooterBackgroundColor}"/>`;
    if (titles.footerText) {
      const ty = n(fy + titles.footerHeight * typography.headerFooterAlignmentFactor);
      footerSvg += `<text x="${n(paddingLeft + fW / 2)}" y="${ty}" text-anchor="middle" font-family="'${escapeXml(typography.fontFamily)}'" font-size="${typography.headerFooterFontSize}" fill="black">${escapeXml(titles.footerText)}</text>`;
    }
  }

  // ── 9 / 10. Task bars, milestones, and task geometry lookup ──────────────────
  // taskGeom is also consumed by the link renderer (slots 8 and 11).
  const barH          = rowH * rendering.taskBarHeightFactor;
  const milestoneHalf = (rowH * rendering.milestoneSizeFactor) / 2;
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
      const pts  = `${n(cx)},${n(cy - half)} ${n(cx + half)},${n(cy)} ${n(cx)},${n(cy + half)} ${n(cx - half)},${n(cy)}`;
      milestonesSvg += `<polygon points="${pts}" fill="${color}" stroke="${style.milestoneStrokeColor}" stroke-width="${rendering.milestoneStrokeWidth}"/>`;

      taskGeom.set(task.id, {
        absRow,
        rowCenterY: cy,
        barTopY:    cy - half,   // top diamond tip
        barBottomY: cy + half,   // bottom diamond tip
        originX:    cx + half,   // rightmost diamond tip
        termX:      cx - half,   // leftmost diamond tip
        startDate:  task.startDate,
        finishDate: task.finishDate,
      });

      const milestoneLabel = buildLabelText(task, config.preferences.chartDateFormat);
      if (milestoneLabel) {
        const lx = n(cx + half + task.labelOffset);
        const ly = n(rowY + rowH * typography.taskAlignmentFactor);
        taskLabelsSvg += `<text x="${lx}" y="${ly}" text-anchor="start" font-family="'${escapeXml(typography.fontFamily)}'" font-size="${typography.taskFontSize}" fill="${style.outsideLabelTextColor}">${escapeXml(milestoneLabel)}</text>`;
      }
    } else {
      const x1   = Math.max(innerX1, xFor(task.startDate));
      const x2   = Math.min(innerX2, xFor(task.finishDate));
      const bw   = x2 - x1;
      if (bw <= 0) continue;
      const barY = rowY + (rowH - barH) / 2;
      barsSvg += `<rect x="${n(x1)}" y="${n(barY)}" width="${n(bw)}" height="${n(barH)}" rx="${rendering.taskCornerRadius}" fill="${color}" stroke="${style.taskStrokeColor}" stroke-width="${rendering.taskStrokeWidth}"/>`;

      taskGeom.set(task.id, {
        absRow,
        rowCenterY,
        barTopY:    barY,
        barBottomY: barY + barH,
        originX:    xFor(task.finishDate),   // right edge at finish date (unclamped)
        termX:      xFor(task.startDate),    // left edge at start date (unclamped)
        startDate:  task.startDate,
        finishDate: task.finishDate,
      });

      const barLabel = buildLabelText(task, config.preferences.chartDateFormat);
      if (barLabel) {
        if (task.labelPlacement === 'inside') {
          const availW    = bw - 2 * rendering.insideLabelPadding;
          const truncated = truncateLabel(barLabel, availW, typography.taskFontSize);
          if (truncated) {
            const lx = n(x1 + rendering.insideLabelPadding);
            const ly = n(rowY + rowH * typography.taskAlignmentFactor);
            taskLabelsSvg += `<text x="${lx}" y="${ly}" text-anchor="start" font-family="'${escapeXml(typography.fontFamily)}'" font-size="${typography.taskFontSize}" fill="${style.insideLabelTextColor}">${escapeXml(truncated)}</text>`;
          }
        } else {
          const lx = n(xFor(task.finishDate) + task.labelOffset);
          const ly = n(rowY + rowH * typography.taskAlignmentFactor);
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
    const dashAttr = link.lineStyle === 'dashed' ? ' stroke-dasharray="4 3"' : '';

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
      const rawR    = (link.routing || '').trim().toUpperCase();
      const routing = ['HV', 'VH'].includes(rawR) ? rawR : 'AUTO';
      const sameRow = pred.absRow === succ.absRow;

      if (routing === 'AUTO' && sameRow) {
        // Direct horizontal line — V-H-V collapses to zero-length vertical legs here
        pathD    = `M ${n(origX)},${n(origY)} L ${n(termX)},${n(termY)}`;
        arrowDir = 'right';
      } else if (routing === 'HV') {
        pathD    = `M ${n(origX)},${n(origY)} L ${n(termX)},${n(origY)} L ${n(termX)},${n(termY)}`;
        arrowDir = (origY === termY) ? 'right' : (termY > origY ? 'down' : 'up');
      } else if (routing === 'VH') {
        pathD    = `M ${n(origX)},${n(origY)} L ${n(origX)},${n(termY)} L ${n(termX)},${n(termY)}`;
        arrowDir = 'right';
      } else {
        // AUTO V-H-V: midpoint y is the mean of origin y and termination y
        const midY = (origY + termY) / 2;
        pathD    = `M ${n(origX)},${n(origY)} L ${n(origX)},${n(midY)} L ${n(termX)},${n(midY)} L ${n(termX)},${n(termY)}`;
        arrowDir = termY > origY ? 'down' : 'up';
      }
    }

    renderedLinks.push({ pathD, arrowDir, termX, termY, origX, origY, color, dashAttr });
  }

  // Slot 8: link bodies
  for (const rl of renderedLinks) {
    linkBodySvg += `<path d="${rl.pathD}" stroke="${rl.color}" stroke-width="${rendering.linkStrokeWidth}" fill="none"${rl.dashAttr}/>`;
  }

  // Slot 11: link arrowheads and origin markers
  for (const rl of renderedLinks) {
    linkHeadSvg += `<circle cx="${n(rl.origX)}" cy="${n(rl.origY)}" r="${n(oR)}" fill="${rl.color}"/>`;

    const { termX: tx, termY: ty, arrowDir: dir } = rl;
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

  // ── Assemble SVG (painter's algorithm, back to front) ────────────────────────
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${outerWidth}" height="${outerHeight}">`,
    `<g id="bg">${bg}</g>`,
    `<g id="swimlane-bands">${bandsSvg}</g>`,
    `<g id="gridlines">${gridlines}</g>`,
    `<g id="scale-bands">${scaleSvg}</g>`,
    `<g id="swimlane-dividers">${dividersSvg}</g>`,
    `<g id="link-bodies">${linkBodySvg}</g>`,
    `<g id="task-bars">${barsSvg}</g>`,
    `<g id="milestones">${milestonesSvg}</g>`,
    `<g id="link-heads">${linkHeadSvg}</g>`,
    `<g id="task-labels">${taskLabelsSvg}</g>`,
    `<g id="swimlane-labels">${labelsSvg}</g>`,
    `<g id="header-footer">${headerSvg}${footerSvg}</g>`,
    `</svg>`,
  ].join('');
}
