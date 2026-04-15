// renderer.js — SVG chart generation
// Exports renderChart(projectData) → SVG string. Does not modify projectData.

// ── Color validation ───────────────────────────────────────────────────────────
// Named colors from the domain spec plus CSS defaults used in config.
// Hex (#xxx / #xxxxxx) and rgb/rgba values are also accepted.
// Anything outside the set falls back to 'steelblue'.
const VALID_CSS_COLORS = new Set([
  // Domain spec named colors
  'blue','red','green','yellow','orange','purple','black','white','grey','gray',
  'cyan','magenta',
  // Config default colors
  'lightgrey','lightgray','steelblue',
  // Common CSS named colors likely to appear in project files
  'navy','teal','aqua','fuchsia','maroon','olive','lime','silver',
  'darkblue','darkgreen','darkred','darkorange','darkgrey','darkgray',
  'lightblue','lightgreen','lightyellow','lightsalmon',
  'cornflowerblue','royalblue','mediumblue','skyblue','deepskyblue',
  'coral','salmon','tomato','crimson','firebrick',
  'gold','goldenrod','khaki',
  'pink','hotpink','deeppink',
  'violet','indigo','plum','orchid',
  'brown','chocolate','saddlebrown','sienna','tan','beige',
  'turquoise','mediumturquoise','mediumseagreen','seagreen',
  'transparent',
]);

function sanitizeColor(color) {
  if (!color) return 'steelblue';
  const c = String(color).trim();
  if (VALID_CSS_COLORS.has(c.toLowerCase())) return c;
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c)) return c;
  if (/^rgba?\s*\(/i.test(c)) return c;
  return 'steelblue';
}

// ── Helpers ────────────────────────────────────────────────────────────────────

// Calendar days from YYYY-MM-DD string a to b (b - a).
// Uses Date.UTC to avoid timezone shifts.
function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000;
}

// Escape characters that are unsafe in SVG text content and attribute values.
function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Format a number to at most 2 decimal places, dropping trailing zeros.
function n(v) { return parseFloat(v.toFixed(2)); }

// ── Main render function ───────────────────────────────────────────────────────
function renderChart(projectData) {
  const { tasks, swimlanes, config } = projectData;
  const { layout, timeline, titles, style, typography } = config;

  const { outerWidth, outerHeight, marginLeft, marginRight, marginTop, marginBottom } = layout;
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

  const bandH        = Math.max(20, typography.scaleFontSize * 2.5);
  const scaleTotalH  = visibleScales.length * bandH;

  // ── Coordinate areas ─────────────────────────────────────────────────────────
  const innerX1      = marginLeft;
  const innerX2      = outerWidth - marginRight;
  const innerWidth   = innerX2 - innerX1;

  const scaleY       = marginTop + titles.headerHeight;          // top of scale bands
  const taskRowY1    = marginTop + titles.headerHeight + scaleTotalH;
  const taskRowY2    = outerHeight - titles.footerHeight - marginBottom;
  const taskRowH     = taskRowY2 - taskRowY1;

  // ── Time scale ───────────────────────────────────────────────────────────────
  const timeScale = innerWidth / totalDays;
  function xFor(dateStr) {
    return innerX1 + daysBetween(chartStartDate, dateStr) * timeScale;
  }

  // ── Swimlane geometry ────────────────────────────────────────────────────────
  const sorted     = [...swimlanes].sort((a, b) => a.order - b.order);
  const totalRows  = sorted.reduce((sum, s) => sum + s.rowCount, 0);
  const rowH       = totalRows > 0 ? taskRowH / totalRows : 0;

  const startRowOf = {};   // swimlaneId → 0-based start row
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
  let bg = '', bands = '', gridlines = '', scaleSvg = '', headerSvg = '', footerSvg = '',
      barsSvg = '', labelsSvg = '';

  // ── 1. Chart background ──────────────────────────────────────────────────────
  bg = `<rect x="0" y="0" width="${outerWidth}" height="${outerHeight}" fill="${sanitizeColor(style.chartBackgroundColor)}"/>`;

  // ── 2. Swimlane bands ────────────────────────────────────────────────────────
  sorted.forEach((s, i) => {
    const sy = n(taskRowY1 + startRowOf[s.id] * rowH);
    const sh = n(s.rowCount * rowH);
    bands += `<rect x="${innerX1}" y="${sy}" width="${innerWidth}" height="${sh}" fill="${sanitizeColor(s.backgroundColor)}"/>`;
    if (layout.showRowDividers && i < sorted.length - 1) {
      const ly = n(sy + sh);
      bands += `<line x1="${innerX1}" y1="${ly}" x2="${innerX2}" y2="${ly}" stroke="${sanitizeColor(style.swimlaneDividerColor)}" stroke-width="1"/>`;
    }
  });

  // ── 3. Vertical gridlines ────────────────────────────────────────────────────
  function vLine(x) {
    const xr = n(x);
    return `<line x1="${xr}" y1="${n(taskRowY1)}" x2="${xr}" y2="${n(taskRowY2)}" stroke="${sanitizeColor(style.gridlineVerticalColor)}" stroke-width="0.5"/>`;
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

  // ── 4. Scale bands ───────────────────────────────────────────────────────────
  const MONTH_LETTERS = ['J','F','M','A','M','J','J','A','S','O','N','D'];

  visibleScales.forEach((scale, idx) => {
    const bY  = n(scaleY + idx * bandH);
    const bY2 = n(bY + bandH);

    scaleSvg += `<rect x="${innerX1}" y="${bY}" width="${innerWidth}" height="${n(bandH)}" fill="${sanitizeColor(style.scaleBackgroundColor)}"/>`;

    function tick(x) {
      const xr = n(x);
      return `<line x1="${xr}" y1="${bY}" x2="${xr}" y2="${bY2}" stroke="${sanitizeColor(style.scaleTickColor)}" stroke-width="0.5"/>`;
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
    scaleSvg += `<line x1="${innerX1}" y1="${bY2}" x2="${innerX2}" y2="${bY2}" stroke="${sanitizeColor(style.scaleTickColor)}" stroke-width="0.5"/>`;
  });

  // ── 5. Header band ───────────────────────────────────────────────────────────
  if (titles.headerHeight > 0) {
    headerSvg += `<rect x="0" y="0" width="${outerWidth}" height="${titles.headerHeight}" fill="${sanitizeColor(style.headerFooterBackgroundColor)}"/>`;
    if (titles.headerText) {
      const ty = n(titles.headerHeight * typography.headerFooterAlignmentFactor);
      headerSvg += `<text x="${n(outerWidth / 2)}" y="${ty}" text-anchor="middle" font-family="'${escapeXml(typography.fontFamily)}'" font-size="${typography.headerFooterFontSize}" fill="black">${escapeXml(titles.headerText)}</text>`;
    }
  }

  // ── 6. Footer band ───────────────────────────────────────────────────────────
  if (titles.footerHeight > 0) {
    const fy = outerHeight - titles.footerHeight;
    footerSvg += `<rect x="0" y="${fy}" width="${outerWidth}" height="${titles.footerHeight}" fill="${sanitizeColor(style.headerFooterBackgroundColor)}"/>`;
    if (titles.footerText) {
      const ty = n(fy + titles.footerHeight * typography.headerFooterAlignmentFactor);
      footerSvg += `<text x="${n(outerWidth / 2)}" y="${ty}" text-anchor="middle" font-family="'${escapeXml(typography.fontFamily)}'" font-size="${typography.headerFooterFontSize}" fill="black">${escapeXml(titles.footerText)}</text>`;
    }
  }

  // ── 7. Task bars and milestones ──────────────────────────────────────────────
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
    const barH2      = rowH * 0.7;
    const barY       = rowY + (rowH - barH2) / 2;
    const color      = sanitizeColor(task.fillColor);

    if (task.isMilestone) {
      const cx   = n(xFor(task.startDate || task.finishDate));
      const cy   = n(rowY + rowH / 2);
      const half = n(barH2 / 2);
      const pts  = `${cx},${n(cy - half)} ${n(cx + half)},${cy} ${cx},${n(cy + half)} ${n(cx - half)},${cy}`;
      barsSvg += `<polygon points="${pts}" fill="${color}" stroke="${sanitizeColor(style.milestoneStrokeColor)}" stroke-width="0.5"/>`;
    } else {
      const x1  = Math.max(innerX1, xFor(task.startDate));
      const x2  = Math.min(innerX2, xFor(task.finishDate));
      const bw  = x2 - x1;
      if (bw <= 0) continue;
      barsSvg += `<rect x="${n(x1)}" y="${n(barY)}" width="${n(bw)}" height="${n(barH2)}" rx="2" fill="${color}" stroke="${sanitizeColor(style.taskStrokeColor)}" stroke-width="0.5"/>`;
    }
  }

  // ── 8. Swimlane labels ───────────────────────────────────────────────────────
  for (const s of sorted) {
    const sy  = taskRowY1 + startRowOf[s.id] * rowH;
    const sh  = s.rowCount * rowH;
    const pos = s.labelPosition;

    let tx, anchor, ty;
    if (pos === 'top-right') {
      tx = innerX2 - 4;  anchor = 'end';
      ty = n(sy + rowH * typography.swimlaneTopAlignmentFactor);
    } else if (pos === 'top-left') {
      tx = innerX1 + 4;  anchor = 'start';
      ty = n(sy + rowH * typography.swimlaneTopAlignmentFactor);
    } else if (pos === 'bottom-right') {
      tx = innerX2 - 4;  anchor = 'end';
      ty = n(sy + sh - rowH * (1 - typography.swimlaneBottomAlignmentFactor));
    } else {  // bottom-left
      tx = innerX1 + 4;  anchor = 'start';
      ty = n(sy + sh - rowH * (1 - typography.swimlaneBottomAlignmentFactor));
    }

    labelsSvg += `<text x="${n(tx)}" y="${ty}" text-anchor="${anchor}" font-family="'${escapeXml(typography.fontFamily)}'" font-size="${typography.swimlaneFontSize}" fill="${sanitizeColor(style.swimlaneLabelColor)}">${escapeXml(s.name)}</text>`;
  }

  // ── Assemble SVG ─────────────────────────────────────────────────────────────
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${outerWidth}" height="${outerHeight}">`,
    `<g id="bg">${bg}</g>`,
    `<g id="swimlane-bands">${bands}</g>`,
    `<g id="gridlines">${gridlines}</g>`,
    `<g id="scale-bands">${scaleSvg}</g>`,
    `<g id="header">${headerSvg}</g>`,
    `<g id="footer">${footerSvg}</g>`,
    `<g id="tasks">${barsSvg}</g>`,
    `<g id="labels">${labelsSvg}</g>`,
    `</svg>`,
  ].join('');
}
