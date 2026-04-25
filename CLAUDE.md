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
| `index.html` | Script tags, `renderEntityTable`/`renderConfigTable` helpers, tab switcher, event wiring |
| `parser.js` | Owns `projectData`; exports `parseWorkbook(workbook)` |
| `renderer.js` | Exports `renderChart(projectData)` → SVG string; no DOM dependency, no side effects |

Script loading order: SheetJS CDN → `parser.js` → `renderer.js` → inline script.

## Top-level state

`parser.js` defines and owns `projectData`:

```js
const projectData = {
  tasks: [], swimlanes: [], links: [], pipes: [], curtains: [], notes: [],
  config: { layout: {}, timeline: {}, titles: {}, style: {}, typography: {}, preferences: {}, rendering: {} }
};
```

`parseWorkbook(workbook)` resets and repopulates it on every file load. The renderer reads from it; nothing else writes to it.

## Excel file format

`XLSX.read` is called with `{ cellDates: true }` so date-formatted cells arrive as JS `Date` objects.

**Entity sheets** (tabular, row 1 = column headers):
- Tasks, Swimlanes, Links, Pipes, Curtains, Notes
- Parsed via `parseEntitySheet(worksheet, colDefs)` — header-based, never positional
- Missing columns silently receive their declared default (backward-compatibility requirement)
- Column-name fallbacks handle old-format files: `"Row"→"Swimlane Row"`, `"Name"→"Title"`, `"Routing"→"Link Routing"`

**Config sheets** (key-value: col A = field name, col B = value):
- Layout, Timeline, Titles, Style, Typography, Preferences
- Parsed via `parseConfigSheet(worksheet)` → plain map, then read with `kvStr/kvInt/kvFloat/kvBool/kvDate`

**Date parsing** (`toISODate`): handles both `instanceof Date` (uses `getFullYear/getMonth/getDate` — never `toISOString`, timezone-safe) and DD/MM/YYYY strings (split on `/`, never passed to `new Date()`).

**Confirmed Excel column headers** (from real project file):

| Sheet | Headers |
|---|---|
| Tasks | ID, Swimlane ID, Swimlane Row\*, Name, Start Date, Finish Date, Label Content, Label Placement, Label Offset, Fill Color, Fill Pattern, Date Format |
| Swimlanes | ID, Title\*, Row Count, Label Position, Background Color |
| Links | ID, From Task ID, To Task ID, Line Color, Line Style, Link Routing\* |

\* Old-format name; new name is "Row" / "Name" / "Routing". Fallback handles both.

Config sheet key names are confirmed. The `kv*` helpers (`kvStr/kvInt/kvFloat/kvBool/kvDate`) each accept an optional `fallback` key — same try-new-first pattern as entity column fallbacks. Known config key renames (new → old fallback):

- **Layout** — padding keys: `"Padding Top/Right/Bottom/Left"` → `"Margin Top/Right/Bottom/Left"`
- **Style** — all 12 keys: `"… Color"` → `"… Colour"`
- **Timeline** — gridline keys: `"Gridline X"` → `"Vertical Gridline X"`
- **Typography** — alignment factors: `"X Alignment Factor"` → `"X Vertical Alignment Factor"`; also `"Header Footer Font Size"` → `"Header & Footer Font Size"`

## Derived fields

- `task.isMilestone = startDate !== null && startDate === finishDate` (null-guard prevents false positive when both dates are absent)
- `swimlane.order` = 1-based sheet-row position (not stored in Excel)
- `config.timeline.chartStartDate/chartEndDate` derived from `min(task.startDate)` / `max(task.finishDate)` if absent from the Timeline sheet

## Renderer (renderer.js)

`renderChart(projectData)` returns a raw SVG string. Key design rules:

- **Coordinate areas:** `innerX1 = paddingLeft`; `innerX2 = outerWidth - paddingRight`; `taskRowY1 = paddingTop + headerHeight + scaleTotalHeight`; `taskRowY2 = outerHeight - paddingBottom - footerHeight`
- **Scale band height:** `max(rendering.minScaleBandHeight, scaleFontSize * 2.5)` per visible scale; total = count × bandHeight
- **Render order (painter's algorithm, 15 slots):** (1) chart background → (2) swimlane backgrounds → (4) gridlines → (5) scale bands → (6) swimlane dividers → (8) link bodies → (9) task bars → (10) milestones → (11) link heads → (13) swimlane labels → (15) header/footer. Slots 3 curtains, 7 pipes, 12 task labels, 14 notes are reserved but not yet implemented (no empty `<g>` emitted). Header/footer paint last so they frame the chart regardless of unusual layout dimensions.
- **Swimlane bands:** use `s.backgroundColor` directly (not through `sanitizeColor`) — value comes pre-validated from the parser
- **Task/milestone colors:** go through `sanitizeColor`; invalid names fall back to `'steelblue'`
- **`sanitizeColor`:** accepts the domain spec named-color set, common CSS named colors (including `lavender`, `lightcyan`), hex `#xxx`/`#xxxxxx`, and `rgb`/`rgba`
- **Swimlane labels:** `swimlaneTopAlignmentFactor` for top variants, `swimlaneBottomAlignmentFactor` for bottom variants
- **`daysBetween(a, b)`:** uses `Date.UTC()` — timezone-safe, no `toISOString()`
- **Milestones:** SVG `<polygon>` diamond centred on `startDate`; bars: `<rect rx="${rendering.taskCornerRadius}">`
- **Skip rules:** orphaned tasks, `finishDate < startDate`, tasks outside chart date range all silently skipped; out-of-range `row` clamped to 1

## config.rendering

Not driven by any Excel sheet — populated unconditionally by `parseWorkbook` with hard-coded defaults. Also reset to `{}` at the top of `parseWorkbook` so reloads start clean.

| Key | Default | Description |
|---|---|---|
| `taskBarHeightFactor` | 0.7 | task bar height as fraction of rowHeight |
| `milestoneSizeFactor` | 0.7 | milestone diamond size as fraction of rowHeight |
| `arrowheadSizeFactor` | 0.3 | link arrowhead triangle size as fraction of rowHeight |
| `originMarkerSizeFactor` | 0.15 | link origin circle radius as fraction of rowHeight |
| `taskCornerRadius` | 2 | task bar `rx` in px |
| `swimlaneLabelPadding` | 4 | label inset from chart edge in px |
| `minScaleBandHeight` | 20 | floor for scale band height in px |
| `gridlineStrokeWidth` | 0.5 | vertical gridline stroke width |
| `scaleTickStrokeWidth` | 0.5 | scale band tick and bottom-border stroke width |
| `taskStrokeWidth` | 0.5 | task bar outline stroke width |
| `milestoneStrokeWidth` | 0.5 | milestone diamond outline stroke width |
| `swimlaneDividerStrokeWidth` | 1 | swimlane divider stroke width |
| `linkStrokeWidth` | 1 | link path stroke width |

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

## Current UI

Two-tab layout: **Data** tab shows debug tables (one per entity type + seven config KV tables); **Chart** tab calls `renderChart(projectData)` on every activation and injects the SVG into a horizontally-scrollable container. "No project loaded" shown if tasks array is empty when Chart tab is opened.
