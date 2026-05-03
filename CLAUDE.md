# compactgantt_web

## Project overview

A compact Gantt chart web application built with vanilla JavaScript, HTML, and CSS.

- No build step, no bundler, no framework
- No Node.js, no Python
- Open files directly in a browser or serve with any static file server

## Stack

| Layer      | Technology            |
|------------|-----------------------|
| Markup     | HTML                  |
| Styling    | CSS                   |
| Behaviour  | Vanilla JavaScript    |

## Repository layout

```
/           — source files (HTML, CSS, JS)
/temp/      — scratch/working files, ignored by git
```

## .gitignore

Ignores:
- macOS artefacts (`.DS_Store`, Spotlight, Trashes, resource forks)
- Windows artefacts (`Thumbs.db`, `ehthumbs.db`, `Desktop.ini`)
- VS Code directory (`.vscode/`)
- `/temp/` folder and all contents

## Entry point

`index.html` is the sole entry point — open directly in a browser, no server needed.

## Conventions

- **American spelling** throughout: "color" not "colour" in all property names, comments, and UI text
- **camelCase** for all JS property names
- **YYYY-MM-DD** strings for all date values stored in `projectData`

## File responsibilities

| File | Role |
|---|---|
| `index.html` | Script tags, single `initUI()` call to boot the UI |
| `dates.js` | Date helpers — single source of truth for all date conversion and arithmetic |
| `parser.js` | Exports `parseWorkbook(workbook)` and `createEmptyProjectData()` |
| `renderer.js` | Exports `renderChart(projectData)` → SVG string; no DOM dependency, no side effects |
| `writer.js` | Exports `writeWorkbook(projectData)` → `Uint8Array`; no DOM dependency, no side effects |
| `ui.js` | UI entry point; owns the live `projectData` reference; exports `initUI()` |

Script loading order: SheetJS CDN → date-fns CDN (`3.6.0`, global `dateFns`) → `dates.js` → `parser.js` → `renderer.js` → `writer.js` → `ui.js` → inline script.

## Date helpers (dates.js)

`dates.js` is a shared module loaded before all four consuming files. All date conversion and arithmetic is centralised here; no local copies exist in `parser.js`, `renderer.js`, `writer.js`, or `ui.js`.

| Function | Signature | Description |
|---|---|---|
| `toISODate` | `(val) → string\|null` | Accepts a JS `Date`, DD/MM/YYYY string, or YYYY-MM-DD string; returns YYYY-MM-DD or `null`. Timezone-safe. |
| `toJsDate` | `(iso) → Date\|null` | Takes a YYYY-MM-DD string; returns a JS `Date` via `new Date(y, m-1, d)`. Returns `null` for absent input. |
| `daysBetween` | `(a, b) → number` | Calendar days between two YYYY-MM-DD strings (`b − a`), computed via `Date.UTC`. |
| `formatDate` | `(iso, formatStr) → string` | Formats a YYYY-MM-DD string using a date-fns format string. Timezone-safe via local-Date construction. Requires `dateFns` global. |
| `isoWeekLabel` | `(iso) → string` | Returns ISO week label, e.g. `"W03"`. Monday is the first day of the ISO week. Requires `dateFns` global. |
| `weekdayName` | `(iso, length) → string` | Returns weekday name. `length`: `'full'`→`"Monday"`, `'short'`→`"Mon"`, `'letter'`→`"M"`. Requires `dateFns` global. |

## Top-level state

`ui.js` owns the live `projectData` reference for the current session:

```js
let projectData = createEmptyProjectData();
```

It is initialised at startup by calling `createEmptyProjectData()` (exported from `parser.js`) — never `null`. The "no file loaded" condition is `projectData.tasks.length === 0`, the same as before.

`parseWorkbook(workbook)` is a pure function: it builds a fresh `projectData` object locally and returns it. `ui.js` assigns the return value to its `projectData` on every file load. `renderer.js` and `writer.js` take `projectData` as a parameter and have no dependency on the global.

`createEmptyProjectData()` is the single source of truth for the `projectData` shape and all default config values. `parseWorkbook` calls it to get a clean starting object, then overwrites entity arrays and config sections from the workbook.

## Excel file format

`XLSX.read` is called with `{ cellDates: true }` so date-formatted cells arrive as JS `Date` objects.

**Entity sheets** (tabular, row 1 = column headers):
- Tasks, Swimlanes, Links, Pipes, Curtains, Notes
- Parsed via `parseEntitySheet(worksheet, colDefs)` — header-based, never positional
- Missing columns silently receive their declared default (backward-compatibility requirement)
- Column-name fallbacks handle old-format files: `"Row"→"Swimlane Row"`, `"Name"→"Title"`, `"Routing"→"Link Routing"`

**Config sheets** (key-value: col A = field name, col B = value):
- Layout, Bars, Timeline, Titles, Style, Typography, Preferences
- Parsed via `parseConfigSheet(worksheet)` → plain map, then read with `kvStr/kvInt/kvFloat/kvBool/kvDate`

**Date parsing** (`toISODate`): handles both `instanceof Date` (uses `getFullYear/getMonth/getDate` — never `toISOString`, timezone-safe) and DD/MM/YYYY strings (split on `/`, never passed to `new Date()`).

**Confirmed Excel column headers** (from real project file):

| Sheet | Headers |
|---|---|
| Tasks | ID, Swimlane ID, Swimlane Row\*, Name, Start Date, Finish Date, Label Content, Label Placement, Label Offset, Fill Color, Fill Pattern, Pattern Color, Date Format |
| Swimlanes | ID, Title\*, Row Count, Label Position, Background Color |
| Links | ID, From Task ID, To Task ID, Line Color, Line Style, Link Routing\* |

\* Old-format name; new name is "Row" / "Name" / "Routing". Fallback handles both.

Config sheet key names are confirmed. The `kv*` helpers (`kvStr/kvInt/kvFloat/kvBool/kvDate`) each accept an optional `fallback` key — same try-new-first pattern as entity column fallbacks. Known config key renames (new → old fallback):

- **Layout** — padding keys: `"Padding Top/Right/Bottom/Left"` → `"Margin Top/Right/Bottom/Left"`
- **Style** — 11 existing keys: `"… Color"` → `"… Colour"` (the newer `insideLabelTextColor` has no old-format fallback)
- **Timeline** — gridline keys for years/months/weeks: `"Gridline X"` → `"Vertical Gridline X"`; the four days/dates keys (`"Show Days"`, `"Show Dates"`, `"Gridline Days"`, `"Gridline Dates"`) have no old-format fallback
- **Typography** — alignment factors: `"X Alignment Factor"` → `"X Vertical Alignment Factor"`; also `"Header Footer Font Size"` → `"Header & Footer Font Size"`; `"Pipe Font Size"` and `"Curtain Font Size"` have no old-format fallback

## Derived fields

- `task.isMilestone = startDate !== null && startDate === finishDate` (null-guard prevents false positive when both dates are absent)
- `swimlane.order` = 1-based sheet-row position (not stored in Excel)
- `config.timeline.chartStartDate/chartEndDate` derived from `min(task.startDate)` / `max(task.finishDate)` if absent from the Timeline sheet; `chartStartDateExplicit` / `chartEndDateExplicit` (booleans in `config.timeline`) record whether each came from the cell (`true`) or was derived (`false`) — used by the writer to decide whether to emit or leave empty, preserving auto-derive behaviour across save/reload cycles

## Renderer (renderer.js)

`renderChart(projectData)` returns a raw SVG string. Key design rules:

- **Coordinate areas:** `innerX1 = paddingLeft`; `innerX2 = outerWidth - paddingRight`; `taskRowY1 = paddingTop + headerHeight + scaleTotalHeight`; `taskRowY2 = outerHeight - paddingBottom - footerHeight`
- **Scale band height:** `max(rendering.minScaleBandHeight, scaleFontSize * 2.5)` per visible scale; total = count × bandHeight
- **Five scale bands** (top-to-bottom): years, months, weeks (ISO `"W03"`), days (named: Monday/Mon/M), dates (numeric day-of-month). Hidden bands occupy no space. Named-day cells degrade width-adaptively through full→short→letter→empty using `fontSize * 0.6` per character — the standard ≥20 px label gate does not apply to the days band.
- **Render order (painter's algorithm, 15 slots):** (1) chart background → (2) swimlane backgrounds → (3) curtain tinted rectangles → (4) gridlines → (5) scale bands → (6) swimlane dividers → (7) pipes + curtain boundary lines/badges → (8) link bodies → (9) task bars → (10) milestones → (11) link heads → (12) task labels → (13) swimlane labels → (15) header/footer. Slot 14 notes is reserved but not yet implemented (no empty `<g>` emitted). Header/footer paint last so they frame the chart regardless of unusual layout dimensions.
- **Color handling:** all color values are passed directly from `projectData` to SVG `fill`/`stroke` attributes without validation. Invalid CSS color names render as SVG's default (black). Validation is moving to a separate module — the renderer trusts its input.
- **Swimlane labels:** `swimlaneTopAlignmentFactor` for top variants, `swimlaneBottomAlignmentFactor` for bottom variants
- **`daysBetween(a, b)`:** uses `Date.UTC()` — timezone-safe, no `toISOString()`
- **Milestones:** SVG `<polygon>` diamond centred on `startDate`; bars: `<rect rx="${bars.taskCornerRadius}">`
- **Skip rules:** orphaned tasks, `finishDate < startDate`, tasks outside chart date range all silently skipped; out-of-range `row` clamped to 1
- **Milestone labels:** the renderer's milestone branch always renders labels outside unconditionally, without reading `task.labelPlacement`. The parser does not override the stored placement value — milestones retain whatever placement the user set.
- **Task labels (slot 12):** built from `task.labelContent` (`none`/`name`/`date`/`name_and_date`) with date-fns formatting. Per-task `task.dateFormat` overrides `config.preferences.chartDateFormat`. Dates parsed timezone-safely: split YYYY-MM-DD on `-` then `new Date(y, m-1, d)`. Inside label fill: `config.style.insideLabelTextColor`; outside label fill: `config.style.outsideLabelTextColor`.
  - *Inside labels* (bars only): truncated via character-width estimate (`fontSize * 0.6` per character, sans-serif approximation). Prefers word-boundary break; falls back to character truncation; emits nothing if `…` alone exceeds available width. Available width = `barWidth - 2 * rendering.insideLabelPadding`.
  - *Outside labels*: no truncation. `x = rightEdge + task.labelOffset`; right edge = `xFor(finishDate)` for bars, `xFor(startDate) + milestoneHalf` for milestones.

## config.bars

Driven by the "Bars" Excel config sheet. Parsed via `parseConfigSheet` / `kvFloat` / `kvInt`. No old-format fallbacks. Missing sheet or absent key silently falls back to the default.

| Key | Default | Excel column name |
|---|---|---|
| `taskBarHeightFactor` | 0.7 | `Task Bar Height Factor` |
| `milestoneSizeFactor` | 0.7 | `Milestone Size Factor` |
| `taskCornerRadius` | 2 | `Task Corner Radius` |

## config.rendering

Not driven by any Excel sheet — hard-coded defaults only. Defined in `createEmptyProjectData()` alongside all other config defaults. `parseWorkbook` does not touch `config.rendering`; every reload gets a fresh object from `createEmptyProjectData()`.

| Key | Default | Description |
|---|---|---|
| `arrowheadSizeFactor` | 0.3 | link arrowhead triangle size as fraction of rowHeight |
| `originMarkerSizeFactor` | 0.15 | link origin circle radius as fraction of rowHeight |
| `swimlaneLabelPadding` | 4 | label inset from chart edge in px |
| `minScaleBandHeight` | 20 | floor for scale band height in px |
| `gridlineStrokeWidth` | 0.5 | vertical gridline stroke width |
| `scaleTickStrokeWidth` | 0.5 | scale band tick and bottom-border stroke width |
| `taskStrokeWidth` | 0.5 | task bar outline stroke width |
| `milestoneStrokeWidth` | 0.5 | milestone diamond outline stroke width |
| `swimlaneDividerStrokeWidth` | 1 | swimlane divider stroke width |
| `linkStrokeWidth` | 1 | link path stroke width |
| `insideLabelPadding` | 2 | horizontal inset of inside-label text from bar edges, in px |
| `pipeStrokeWidth` | 1 | pipe line and badge border stroke width |
| `pipeBadgePaddingX` | 4 | horizontal inset of badge text from badge edges, in px |
| `pipeBadgePaddingY` | 2 | vertical inset of badge text from badge edges, in px |
| `curtainStrokeWidth` | 1 | curtain boundary line and badge border stroke width |
| `curtainBadgePaddingX` | 4 | horizontal inset of curtain badge text from badge edges, in px |
| `curtainBadgePaddingY` | 2 | vertical inset of curtain badge text from badge edges, in px |

## Link rendering

Links are Finish-to-Start dependency arrows. Implementation notes:

**Renderable-task lookup (`taskGeom` Map):** Built during the task-bar/milestone render pass. Keyed by `task.id`; value contains `{ absRow, rowCenterY, barTopY, barBottomY, originX, termX, startDate, finishDate }`. Any task skipped by the bar pass is simply absent, so orphaned-link detection is implicit — no duplicate skip logic in the link renderer. The same Map is iterated twice: once for bodies (slot 8) and once for heads (slot 11).

**Connection points:**
- Task bar origin: `xFor(finishDate)` at row centre; termination: `xFor(startDate)` at row centre
- Milestone origin: `xFor(startDate) + milestoneHalf`; termination: `xFor(startDate) - milestoneHalf`

**Link classification (computed at render time, not stored):**
- *Forward*: `pred.finishDate <= succ.startDate` — terminate at left edge of succ; skip if `origX >= termX` (backwards geometry)
- *Late-recoverable*: `pred.finishDate > succ.startDate AND pred.finishDate < succ.finishDate AND different absolute rows` — vertical-only path, termination x = origin x (always exactly vertical regardless of predecessor type), termination y = top edge of succ bar if succ is below pred, bottom edge if above
- *Invalid* (skipped silently): `pred.finishDate >= succ.finishDate`; same-row late links; forward links where `origX >= termX`
- Milestone successors cannot be late-recoverable (their `startDate === finishDate` makes the late condition impossible)

**Routing (forward links only; late links always use vertical-only path):**
- `HV`: H to termX, V to termY; arrowhead direction = vertical (up/down), or right if final V is zero-length
- `VH`: V to termY, H to termX; arrowhead direction = right
- `AUTO` + same row: direct horizontal line, arrowhead right
- `AUTO` + different rows: V-H-V with midY = mean of origY and termY; arrowhead direction = vertical

**Z-order split:** All renderedLinks are pre-computed into an array. The array is iterated once to emit `<path>` bodies into `linkBodySvg` (slot 8), then iterated again to emit `<circle>` origin markers and `<polygon>` arrowheads into `linkHeadSvg` (slot 11). This two-pass approach keeps task bars and milestones between the two link layers without duplicating classification logic.

**Arrowheads:** Per-link `<polygon>` triangles (not SVG `<marker>` in `<defs>`). Per-link polygons are simpler, have no browser-consistency issues with `context-fill`/`context-stroke`, and are trivially sized by `arrowheadSizeFactor * rowH` per link. The SVG `<marker>` approach would save bytes on charts with many links but introduces marker-scaling and color-inheritance complexity that outweighs the benefit at this scale.

## Pipes rendering

Pipes are vertical reference lines drawn at a given date with an optional text badge. Rendered in slot 7 (above swimlane dividers, below link bodies).

**Skip rules:** pipe skipped silently if `pipe.date` is null, `pipe.date < chartStartDate`, or `pipe.date > chartEndDate`.

**Line:** `<line>` from `(x, taskRowY1)` to `(x, taskRowY2)` where `x = xFor(pipe.date)`. stroke-dasharray: solid → none, dashed → `"4 3"`, dotted → `"1 2"`. Stroke color = `pipe.color`, stroke-width = `rendering.pipeStrokeWidth`.

**Badge** (emitted only when `pipe.name` is non-empty):
- Text width estimated as `typography.pipeFontSize * 0.6 * pipe.name.length`
- `badgeW = textWidth + 2 * rendering.pipeBadgePaddingX`; `badgeH = pipeFontSize + 2 * rendering.pipeBadgePaddingY`
- `badgeTopY = taskRowY1 + (1 - pipe.labelPosition) * (taskRowAreaH - badgeH)` — `labelPosition = 1` pins badge to top, `0` to bottom
- Badge left edge abuts the pipe line at `x`; badge may overflow past `innerX2` (no clipping)
- `<rect>` fill = `style.chartBackgroundColor`, stroke = `pipe.color`
- `<text>` centred horizontally in badge; vertical position = `badgeTopY + badgeH * typography.scaleAlignmentFactor`; font from `typography.fontFamily` / `typography.pipeFontSize`; fill = `pipe.color`

**`pipe.labelPosition`** — float, Excel column `"Label Position"`, default `1`. No old-format fallback. `typography.pipeFontSize` — integer, Typography sheet key `"Pipe Font Size"`, default `10`. No old-format fallback.

## Curtains rendering

Curtains are tinted vertical bands over a date range with optional boundary lines and a name badge. Rendered across two slots: slot 3 (tinted rectangles, `<g id="curtains">`) and slot 7 (boundary lines + badge, `<g id="curtain-edges">`).

**Skip rules (both slots):** curtain skipped silently if `startDate` is null, `endDate` is null, `endDate <= startDate`, `endDate < chartStartDate`, or `startDate > chartEndDate`.

**Slot 3 — tinted rectangle:** `x1 = max(xFor(startDate), innerX1)`, `x2 = min(xFor(endDate), innerX2)`. Skipped if `x2 <= x1`. `<rect>` fill = `curtain.color`, `fill-opacity` = `curtain.opacity`, no stroke.

**Slot 7 — boundary lines:** `xStart = xFor(startDate)`, `xEnd = xFor(endDate)` (unclamped). Each line emitted only if its x is within `[innerX1, innerX2]`. Stroke = `curtain.color`, stroke-width = `rendering.curtainStrokeWidth`, no dasharray.

**Slot 7 — badge** (emitted only when `curtain.name` is non-empty):
- Anchor x = `xFor(startDate)` when `curtain.labelAnchor !== 'end'`, else `xFor(endDate)`; badge skipped if anchor x is outside `[innerX1, innerX2]`
- Text width estimated as `curtainFontSize * 0.6 * curtain.name.length`; `badgeW = textWidth + 2 * curtainBadgePaddingX`; `badgeH = curtainFontSize + 2 * curtainBadgePaddingY`
- `badgeTopY = taskRowY1 + (1 - curtain.labelPosition) * (taskRowAreaH - badgeH)` — `labelPosition = 1` pins to top, `0` to bottom
- Badge left edge = anchor x, always extends right; overflow past `innerX2` is allowed (no clip)
- `<rect>` fill = `style.chartBackgroundColor`, stroke = `curtain.color`; `<text>` centred horizontally, vertical position = `badgeTopY + badgeH * typography.scaleAlignmentFactor`; fill = `curtain.color`

**Curtains entity columns:** ID, Start Date, End Date, Name, Color, Opacity, Label Position, Label Anchor. `labelPosition` — float, default `1`, no old-format fallback. `labelAnchor` — string (`'start'` or `'end'`), default `'start'`, no old-format fallback; anything other than `'end'` treated as `'start'` by renderer. `typography.curtainFontSize` — integer, Typography sheet key `"Curtain Font Size"`, default `10`, no old-format fallback.

## Current UI

Two-tab layout: **Data** tab shows debug tables (one per entity type + eight config KV tables); **Chart** tab calls `renderChart(projectData)` on every activation and injects the SVG into a horizontally-scrollable container. "No project loaded" shown if tasks array is empty when Chart tab is opened.

## Excel export (writer.js)

`writeWorkbook(projectData)` returns a `Uint8Array` (SheetJS `type: 'array'`), ready for `new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })`.

**Named-column policy:** columns are identified by header name, not index. The writer emits named headers; column order within each sheet is presentation-only and not load-bearing for the schema.

**Sheet order:** Tasks → Swimlanes → Links → Pipes → Curtains → Notes → Layout → Bars → Timeline → Titles → Style → Typography → Preferences. `config.rendering` is deliberately excluded (hard-coded defaults; not a user-configurable concern at this stage).

**Entity sheets:** header row + one data row per entity; always emitted even if the array is empty. Derived fields (`task.isMilestone`, `swimlane.order`) are not written. `task.dateFormat` and null date fields write as empty cells (`null` in the AOA → empty cell in SheetJS).

**Date cells:** YYYY-MM-DD strings converted timezone-safely via `split('-')` → `new Date(y, m-1, d)` before being passed to SheetJS. Null → empty cell. Timeline dates obey `chartStartDateExplicit` / `chartEndDateExplicit` — only written when explicit; otherwise left empty so auto-derivation from task dates continues to work after a save/reload cycle.

**Boolean cells:** `"Yes"` / `"No"` strings — matches `kvBool`'s string parsing.

**Config sheets:** two-column layout with `["Field", "Value"]` header row in row 1. `parseConfigSheet` picks up the header as a harmless extra map entry that no `kv*` call looks up — round-trip is safe.

**Save button:** disabled until `tasks.length > 0 || swimlanes.length > 0` (i.e. at least one entity array is non-empty). Suggested download filename is the originally loaded filename if one was loaded, otherwise `"compactgantt_project.xlsx"`.
