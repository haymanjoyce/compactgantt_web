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
| `parser.js` | Exports `parseWorkbook(workbook)`, `createEmptyProjectData()`, and per-entity factories `createEmpty<Entity>()` |
| `renderer.js` | Exports `renderChart(projectData)` → SVG string; no DOM dependency, no side effects |
| `writer.js` | Exports `writeWorkbook(projectData)` → `Uint8Array`; no DOM dependency, no side effects |
| `validation.js` | Exports `validateProject(projectData)` → `ValidationReport`; pure, no DOM, no side effects |
| `ui.js` | UI entry point; owns the live `projectData` reference; exports `initUI()` |

Script loading order: SheetJS CDN → date-fns CDN (`3.6.0`, global `dateFns`) → `dates.js` → `parser.js` → `renderer.js` → `writer.js` → `validation.js` → `ui.js` → inline script.

## Date helpers (dates.js)

`dates.js` is loaded before `parser.js`, `renderer.js`, `writer.js`, and `ui.js`. All date conversion and arithmetic is centralised here; no local copies exist in those files. (`validation.js` does only string comparison on YYYY-MM-DD and does not import.) Signatures and bodies are in `dates.js` — exports: `toISODate`, `toJsDate`, `daysBetween`, `formatDate`, `isoWeekLabel`, `weekdayName(iso, length)` where `length` is `'full'` / `'short'` / `'letter'`. Non-obvious invariants:

- `toISODate` is timezone-safe (`getFullYear/getMonth/getDate`, never `toISOString`) and filters Invalid `Date` objects (`isNaN(getTime())`) — guards against SheetJS surfacing Invalid Date on round-tripped empty cells. Non-slash strings pass through as-is (assumes already YYYY-MM-DD); shape validation happens at `parseDate` / `kvDate` in `parser.js`.
- `toJsDate` constructs via `new Date(y, m-1, d)` (timezone-safe). `daysBetween` uses `Date.UTC` arithmetic.
- `formatDate` / `isoWeekLabel` / `weekdayName` require the `dateFns` global. ISO week semantics — Monday is first day.

## Top-level state

`ui.js` owns the live `projectData` reference for the current session:

```js
let projectData = createEmptyProjectData();
```

It is initialised at startup by calling `createEmptyProjectData()` (exported from `parser.js`) — never `null`. The "no file loaded" condition is `projectData.tasks.length === 0`, the same as before.

`parseWorkbook(workbook)` is a pure function: it builds a fresh `projectData` object locally and returns it. `ui.js` assigns the return value to its `projectData` on every file load. `renderer.js` and `writer.js` take `projectData` as a parameter and have no dependency on the global.

`createEmptyProjectData()` is the single source of truth for the `projectData` shape and all default config values. `parseWorkbook` calls it to get a clean starting object, then overwrites entity arrays and config sections from the workbook.

After parse, all in-app mutations route through `dispatch()` in `ui.js` (see Mutation dispatcher). The file-load and New Project handlers are the only other write sites; both replace `projectData` wholesale (New Project seeds a default swimlane via post-replacement dispatches).

## Mutation dispatcher (ui.js)

`dispatch({ entity, action, id, block, field, value, index })` is the single-writer entry point for all in-app mutations to `projectData`. Centralising mutation here is what makes the post-mutation hook (validation re-run + active-tab re-render + Issues-tab-label refresh) unbypassable.

`entity` ∈ `task` / `swimlane` / `link` / `pipe` / `curtain` / `note` / `config`. `action` ∈ `update` / `add` / `delete` / `duplicate` / `moveUp` / `moveDown`. Config supports `update` only (with `block` naming the section); other actions on config silently no-op with `console.warn`. Unknown entity/action, missing required field, or id miss → same: `console.warn` + no-op (never throws).

`add` uses per-entity factories in `parser.js` (`createEmptyTask`, etc.) for the empty record, then assigns `id = max(existing) + 1` or `1` if empty. `duplicate` clones via shallow spread and assigns a fresh id the same way.

**Deletion blocking** (silent no-op, no hook fires): a task delete is blocked if a link points to or from it. No other delete is blocked — deleting the last task in a swimlane is allowed (Issues surfaces the empty swimlane as a warning), and deleting a swimlane that still has tasks is allowed (those tasks remain in `projectData` with their original `swimlaneId`; validation flags them as orphans and the renderer skips them).

**Derived-field maintenance.** `task.isMilestone` is recomputed on task `update`; `swimlane.order` is recomputed (1-based array index) after any swimlane array mutation. Factory records start with `isMilestone: false` / `order: null` and the dispatcher fills in.

**Post-mutation hook** runs in order: `validateProject` → `activateTab(activeTab)` → `updateIssuesTabLabel`. Active tab is tracked in module-scope `activeTab`, set by `activateTab` itself; the dispatcher reads it to know which panel to re-render. `update` runs the hook unconditionally even if `value` equals the existing field value — equality check at the call site if it's cheap, dispatcher doesn't bother (Dates, string-numeric mismatches make a robust check not worth it).

## Excel file format

`XLSX.read` is called with `{ cellDates: true }` so date-formatted cells arrive as JS `Date` objects.

**Entity sheets** (tabular, row 1 = column headers):
- Tasks, Swimlanes, Links, Pipes, Curtains, Notes
- Parsed via `parseEntitySheet(worksheet, colDefs)` — header-based, never positional
- Missing columns silently receive their declared default (backward-compatibility requirement)
- Column-name fallbacks for old-format files are listed at each `parseEntitySheet` call site in `parser.js` (`fallback` property in `colDefs`)

**Config sheets** (key-value: col A = field name, col B = value):
- Layout, Bars, Timeline, Titles, Style, Typography, Preferences
- Parsed via `parseConfigSheet(worksheet)` → plain map, then read with `kvStr/kvInt/kvFloat/kvBool/kvDate`

**Date parsing** (`toISODate`): handles both `instanceof Date` (uses `getFullYear/getMonth/getDate` — never `toISOString`, timezone-safe) and DD/MM/YYYY strings (split on `/`, never passed to `new Date()`).

**Excel column headers and config keys** are confirmed against a real project file; `parser.js` is the authoritative list (`colDefs` blocks + `kv*` calls cover every header/key, default, and old-name fallback).

Config sheet key names are confirmed. The `kv*` helpers (`kvStr/kvInt/kvFloat/kvBool/kvDate`) each accept an optional `fallback` key for old-name compatibility — same try-new-first pattern as entity column fallbacks. The new/old name pairs are listed at every call site in `parser.js`; the authoritative list lives there. Schema asymmetry worth knowing: Timeline has five `show*` fields (years/months/weeks/days/dates) but only four `gridline*` fields — days and dates share calendar-day boundary granularity, so a single `gridlineDays` covers both.

## Derived fields

- `task.isMilestone = startDate !== null && startDate === finishDate` (null-guard prevents false positive when both dates are absent)
- `swimlane.order` = 1-based sheet-row position (not stored in Excel)
- `config.timeline.chartStartDate/chartEndDate` derived from `min(task.startDate)` / `max(task.finishDate)` if absent or unparseable in the Timeline sheet; `chartStartDateExplicit` / `chartEndDateExplicit` (booleans in `config.timeline`) record whether the user wrote any non-empty value in the cell (`true`, derived via `isNoticeableInput` on the raw cell) or left it blank (`false`) — used by the writer to decide whether to emit or leave empty. Note the deliberate asymmetry: a cell containing garbage (`"not a date"`) is `explicit=true` with a `chartStartDate` derived from tasks, so save round-trips the garbage cell to a now-valid derived date

## Parse notices (`_parseNotices`)

`projectData._parseNotices` is an array side-channel populated by `parseWorkbook` and seeded to `[]` by `createEmptyProjectData()`. Sits alongside `tasks`, `swimlanes`, `links`, `pipes`, `curtains`, `notes`, and `config`. Each notice records a non-empty source cell that the parser could not interpret and silently defaulted:

```
{ entity, id, field, rawValue, reason }
```

- `entity` — singular lowercase: `'task'` / `'swimlane'` / `'link'` / `'pipe'` / `'curtain'` / `'note'` / `'config'`
- `id` — entity row id (integer for parsed ids, `null` for config rows). Exception: `'id_assigned'` notices (see table below) carry the **newly-assigned** id, not null, so the user can locate the auto-assigned row in the data. Other notices on a row whose id cell was blank/unparseable also carry the assigned id, because `c()` in each entity parse block captures `id` after assignment.
- `field` — JS property name (e.g. `'startDate'`, `'paddingTop'`), never the Excel header
- `rawValue` — original cell value as it appeared in `row[header]` / `map[key]`, unmodified (no stringify, no trim)
- `reason` — closed enum, five values, all emitted by the parser. `validation.js` reads these via `consumeNotice` and emits `Issue` objects with human-readable `message` fields; it does not emit notices itself.

Reason values:

| Reason | When emitted |
|---|---|
| `'unparseable_date'` | non-empty value that did not produce a valid YYYY-MM-DD result. `parseDate` (entity rows) and `kvDate` (config) both call `toISODate` and validate the result against `/^\d{4}-\d{2}-\d{2}$/` — `toISODate`'s current pass-through for non-slash strings means a raw `"garbage"` is rejected here, not at `toISODate`. Invalid `Date` objects are filtered at `isNoticeableInput` so a writer-emitted empty cell round-trips clean. |
| `'unparseable_number'` | non-empty value that `parseInt` / `parseFloat` returned `NaN` for; emitted by `toInt` / `toFloat` / `kvInt` / `kvFloat` |
| `'unrecognised_boolean'` | non-empty string in a boolean field that, after trim+lowercase, is neither `'yes'` nor `'no'`; emitted by `kvBool`. Native JS booleans (SheetJS `typeof v === 'boolean'`) pass through silently |
| `'unrecognised_enum'` | non-empty value that a `normalize*` function did not recognise; emitted by each `normalize*` function |
| `'id_assigned'` | id cell was blank, missing, or unparseable; parser assigned `max(existing) + 1` (same invariant as the dispatcher's `add` — never gap-fill). Emitted by `makeIdAssigner` in `parser.js` for every entity sheet. `rawValue` is `null` for blank/missing or the raw garbage (e.g. `"abc"`). Suppresses the upstream `unparseable_number` notice for id cells by parsing id directly rather than via `toInt` — one notice per row, never two. Notably also fires on empty id cells — exception to the "empty cells produce no notice" rule below. |

**Empty vs unparseable distinction.** Empty cells (`null` / `undefined` / `''`), whitespace-only strings (`'   '`), and Invalid `Date` objects (`isNaN(getTime())`, as SheetJS produces when reading an empty date-typed cell after a round trip) NEVER produce a notice — they take the default silently. Notices fire only when the user wrote something meaningful that the parser ignored. This is the entire point of the side-channel: it separates "user wrote nothing" from "user wrote something the parser couldn't use." **Exception:** `'id_assigned'` notices fire on blank/missing id cells too, because the parser-assigned id is a write the user should know about.

**Notice order.** Parser-traversal order: entity sheets first (tasks, swimlanes, links, pipes, curtains, notes), then config sheets (layout, bars, timeline, titles, style, typography, preferences). Within a sheet, top-to-bottom row order. Within a row, left-to-right field order.

**Not emitted from:** `createEmptyProjectData()` (defaults are not user input); column-name fallbacks (`Row`/`Swimlane Row`, `Name`/`Title`, `Routing`/`Link Routing`); config key-name fallbacks (`Margin`→`Padding`, British-spelling `Colour` fallbacks, etc.).

**Enum recognition lives in the parser.** All twelve `normalize*` functions are in `parser.js` (search `normalize`) and emit `unrecognised_enum` notices when given a non-empty unrecognised value. Allowed values, defaults, and the field each covers are colocated at each function. Renderer-side fallbacks for unrecognised enums are no longer reachable in normal flow — the parser supplies a canonical default before the value leaves `parseWorkbook`, and the validation module does not re-encode any enum membership lists.

**Surfaced by the Inspector.** `_parseNotices` is not one of the seven fixed top-level keys, so the Inspector's dynamic walk picks it up as a diagnostic section and renders it via `renderEntityTable`. A clean file produces an empty array.

## Validation (`validation.js`)

`validateProject(projectData)` returns `{ errors: [Issue], warnings: [Issue], notices: [Issue] }` — all three keys always present. Pure: no DOM, no side effects, never mutates `projectData`, never throws.

Each `Issue` is `{ entity, id, field, message, value }`. `entity` is singular lowercase (same enum as `_parseNotices`). `id` is the entity row id, `null` for config issues only — entity rows always have a non-null id at validation time (parser auto-assigns; see Parse notices §`id_assigned`). `field` is a JS property name. `value` is `null` for "missing field" rules, `rawValue` from `_parseNotices` for parse-derived rules, the current field value otherwise.

**Structure.** A thin `validateProject` coordinator calls 14 per-block validators (six entity + eight config, in parse traversal order) and concatenates results. Shared helpers at top of `validation.js`.

**`_parseNotices` consumption.** Entity validators filter notices by entity tag; config validators filter by an explicit field-ownership Set at the top of each function. Matching notices emit Issues into the bucket dictated by the locked rule list — the same `reason` maps to different buckets depending on the field. The array stays in place on `projectData`.

**"Missing X" guard** fires only when (a) the field is `null` AND (b) no `_parseNotices` entry for `(entity, id, field)` with reason `unparseable_number` / `unparseable_date`. Prevents double-emission. **Foreign-key validity Sets** (`Swimlane.id` for tasks; `Task.id` for links) filter `null` ids out, so a row with a missing id does not silently satisfy a reference.

**CSS color recognition.** Inline allowlist (148 CSS Color Level 4 names + `transparent` + `currentcolor`) plus hex/rgb/rgba/hsl/hsla shape regexes. `isValidCssColor("")` is `false`; per-field rules decide whether empty is legal (e.g. Notes colors) or an error (e.g. all 16 Style colors).

**Link classification (R1/R2/R3)** duplicates the renderer's invalid-link logic (see Link rendering) by design — neither module imports from the other. The absRow lookup is built inside `validateLinks` from `swimlane.order` + cumulative `rowCount` + `task.row`. Self-links (`fromTaskId === toTaskId`) skip the R1/R2/R3 block entirely — they would trip R1 trivially (`x >= x`) and R3 for self-linked milestones; the dedicated Self-link error above is the sole issue emitted for them.

**Call site.** `projectData._validation` is written in two places in `ui.js`: the file-load handler (immediately after `parseWorkbook`) and `runPostMutationHook` (after every dispatched mutation). New Project relies on the latter — its seeding dispatches populate `_validation` indirectly. The renderer never consults `_validation` — validation is non-gating in v1. The Inspector surfaces it via the dynamic walk's "plain object of arrays" shape handling (see Current UI).

## Renderer (renderer.js)

`renderChart(projectData)` returns a raw SVG string. Key design rules:

- **Coordinate areas:** `innerX1 = paddingLeft`; `innerX2 = outerWidth - paddingRight`; `taskRowY1 = paddingTop + headerHeight + scaleTotalHeight`; `taskRowY2 = outerHeight - paddingBottom - footerHeight`
- **Scale band height:** `max(rendering.minScaleBandHeight, scaleFontSize * rendering.scaleFontToBandHeightFactor)` per visible scale; total = count × bandHeight
- **Five scale bands** (top-to-bottom): years, months, weeks (ISO `"W03"`), dates (numeric day-of-month), days (named: Monday/Mon/M). Hidden bands occupy no space. Months band reads its single-letter labels from `rendering.monthLetters` (12 entries indexed by `month - 1`). Named-day cells degrade width-adaptively through full→short→letter→empty using `fontSize * rendering.charWidthFactor` per character — the standard `rendering.scaleMinLabelWidth` (default 20 px) label gate applies to years/months/weeks/dates only, not to the days band.
- **Swimlane backgrounds:** `<rect>` fill = `swimlane.backgroundColor` (no renderer-side fallback — the parser supplies the default `"white"`).
- **Render order (painter's algorithm, 15 slots):** defined in `renderer.js` (search for the SVG layer accumulators). Header/footer paint last so they frame the chart regardless of unusual layout dimensions. Slot numbers referenced elsewhere in this doc (e.g. "slot 7", "slot 14") correspond to those accumulators in source order.
- **Color handling:** color values are passed directly from `projectData` to SVG `fill`/`stroke` attributes without renderer-side validation; invalid CSS color names render as SVG's default (black). Validation lives in `validation.js`.
- **Swimlane labels:** `swimlaneTopAlignmentFactor` for top variants, `swimlaneBottomAlignmentFactor` for bottom variants
- **Header/footer text alignment:** per-band via `titles.headerTextAlign` / `titles.footerTextAlign` (`left` / `center` / `right`). Horizontal inset uses `rendering.headerFooterTextPadding` for `left` and `right` only (centred text uses band centre). Vertical positioning via `typography.headerFooterAlignmentFactor`. The renderer trusts the parser's normalisation. Each band also emits a horizontal border `<line>` at its inside edge, stroked with `style.headerFooterBorderColor` / `rendering.headerFooterBorderStrokeWidth`; the border is suppressed together with the band when `headerHeight`/`footerHeight === 0`.
- **Milestones:** centred on `startDate`; size = `bars.milestoneSizeFactor * rowHeight`. Two shapes selected by `bars.milestoneShape`:
  - `circle` — emits `<circle>` circumscribing the diamond's anchors; `milestoneCornerRadius` ignored.
  - `diamond` (default) — `<path>` with rounded corners controlled by `bars.milestoneCornerRadius` (0..1, fraction of half-edge): `0` sharp, `1` inscribed circle (smaller than `shape=circle`). No parser clamping — validation flags out-of-range values.
- **Bars:** `<rect rx="${bars.taskCornerRadius}">`.
- **Task bar pattern fills:** `task.fillPattern` drives SVG `<pattern>` elements in the shared `<defs>` block (see Notes rendering for combined-defs design). `"solid"` (or any unrecognised value) → `fill="${fillColor}"` unchanged. The five named patterns (`hatch`, `cross-hatch`, `horizontal`, `vertical`, `dots`) → `fill="url(#id)"` referencing a deduplicated `<pattern>` keyed by sanitised `(fillPattern, fillColor, patternColor)` triple. Patterns use `patternUnits="userSpaceOnUse"` with no `x`/`y` — tiles anchor at SVG origin so bars on the same row share a continuous-field phase. Milestones are always solid; their `fillPattern` is not consumed by the renderer.
- **Skip rules:** orphaned tasks, `finishDate < startDate`, tasks outside chart date range all silently skipped; `row` clamped to 1 whenever not a positive integer within `[1, swimlane.rowCount]` (covers null, non-numeric, zero, negative, and out-of-range in one expression). Null `task.row` reaches the renderer when the user left the Tasks-sheet Row cell blank or cleared the form input — the parser preserves null end-to-end
- **Milestone labels:** the renderer's milestone branch always renders labels outside unconditionally, without reading `task.labelPlacement`. The parser does not override the stored placement value — milestones retain whatever placement the user set.
- **Task labels (slot 12):** built from `task.labelContent` with date-fns formatting. Per-task `task.dateFormat` overrides `config.preferences.chartDateFormat`. Dates parsed timezone-safely (`new Date(y, m-1, d)` from split). Inside fill: `style.insideLabelTextColor`; outside fill: `style.outsideLabelTextColor`.
  - *Inside labels* (bars only): truncated via character-width estimate (`fontSize * rendering.charWidthFactor` per character, sans-serif approximation). Prefers word-boundary break; falls back to character truncation; emits nothing if `…` alone exceeds available width. Available width = `barWidth - 2 * rendering.insideLabelPadding`.
  - *Outside labels*: no truncation. `x = rightEdge + outsideLabelKissingGap + task.labelOffset`; right edge = `xFor(finishDate)` for bars, `xFor(startDate) + milestoneHalf` for milestones. The kiss gap keeps labels clear of the bar edge even at zero offset.
  - *Leader lines*: horizontal `<line>` at row centre y, from `rightEdge` to `rightEdge + labelOffset` (spans exactly `labelOffset` px, with `outsideLabelKissingGap` clear between line end and label). Drawn when `labelOffset > 0`; for bars also requires `labelPlacement === 'outside'`. Stroke: `style.leaderLineColor` / `rendering.leaderLineStrokeWidth`. Emitted immediately before each task's `<text>` element inside slot 12 (interleaved per task, no separate pass). No clip — may overflow into right padding.

## config.bars

Driven by the "Bars" Excel sheet → `projectData.config.bars` (`taskBarHeightFactor`, `milestoneSizeFactor`, `milestoneShape`, `milestoneCornerRadius`, `taskCornerRadius`). No old-format fallbacks. `milestoneShape` is the only enum (normalised via `normalizeMilestoneShape`); `milestoneCornerRadius` is unclamped float intended for `0..1` (see milestone rendering note). `parser.js` `createEmptyProjectData()` is authoritative for defaults and Excel column names.

## config.titles

Driven by the "Titles" Excel sheet → `projectData.config.titles` (`headerHeight`, `headerText`, `headerTextAlign`, `footerHeight`, `footerText`, `footerTextAlign`). No old-format fallbacks. `headerTextAlign` / `footerTextAlign` normalised via `normalizeTextAlign` (`left` / `center` / `right`, default `center`). Defaults and Excel column names in `parser.js` `createEmptyProjectData()`.

## config.rendering

All rendering tunables (stroke widths, paddings, factors, gaps, corner radii, the `monthLetters` array, `charWidthFactor`, etc.) live in `config.rendering` in `createEmptyProjectData()`. Hard-coded defaults, not Excel-driven — `parseWorkbook` does not touch this object; every reload starts from `createEmptyProjectData()`. Names follow `<element><attribute>`. The writer deliberately excludes this section. Source is authoritative.

## Link rendering

Links are Finish-to-Start dependency arrows. Implementation notes:

**Renderable-task lookup (`taskGeom` Map):** Built during the task-bar/milestone render pass. Keyed by `task.id`; value contains `{ absRow, rowCenterY, barTopY, barBottomY, originX, termX, startDate, finishDate, isMilestone }`. Any task skipped by the bar pass is simply absent, so orphaned-link detection is implicit — no duplicate skip logic in the link renderer. The same Map is iterated twice: once for bodies (slot 8) and once for heads (slot 11).

**Connection points:**
- Task bar origin: `xFor(finishDate)` at row centre; termination: `xFor(startDate)` at row centre
- Milestone origin: `xFor(startDate)` (centre); termination: `xFor(startDate)` (centre) — both connect at the milestone centre so milestone shape can change independently of link geometry

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

**Rounded corners at bends (HV, VH, AUTO V-H-V only):** Each sharp 90° bend becomes a quarter-circle arc, radius `min(linkCornerRadius, segA/2, segB/2)`. Per-bend sweep flag depends on turn direction — a real gotcha worth keeping explicit: `(right→down)=1`, `(right→up)=0`, `(down→right)=0`, `(up→right)=1`. AUTO V-H-V's two bends always carry opposite sweep flags. Same-row AUTO and late-recoverable vertical links have no bends to round.

**Z-order split:** All renderedLinks are pre-computed into an array. The array is iterated once to emit `<path>` bodies into `linkBodySvg` (slot 8), then iterated again to emit `<circle>` origin markers and `<polygon>` arrowheads into `linkHeadSvg` (slot 11). This two-pass approach keeps task bars and milestones between the two link layers without duplicating classification logic.

**Arrowheads:** Per-link `<polygon>` triangles sized by `arrowheadSizeFactor * rowH`, not SVG `<marker>` defs — avoids browser inconsistency with `context-fill`/`context-stroke` at the cost of bytes per link.

**Milestone predecessor/successor special cases (forward links only):**
- *Origin marker suppressed* when `pred.isMilestone` — the link path still starts at the milestone centre but no filled circle is drawn over the shape.
- *Arrowhead backed off* when `succ.isMilestone` — tip is placed at `milestoneHalf + rendering.linkArrowheadMilestoneGap` from the milestone centre along the arrowhead direction, so it sits just outside the milestone perimeter rather than at the centre. Late-recoverable links cannot have milestone successors (proof: milestone `startDate === finishDate` makes the late condition impossible), so no back-off applies to late links.

## Pipes rendering

Pipes are vertical reference lines drawn at a given date with an optional text badge. Rendered in slot 7 (above swimlane dividers, below link bodies).

**Skip rules:** pipe skipped silently if `pipe.date` is null, `pipe.date < chartStartDate`, or `pipe.date > chartEndDate`.

**Line:** `<line>` from `(x, taskRowY1)` to `(x, taskRowY2)` where `x = xFor(pipe.date)`. stroke-dasharray: solid → none, dashed → `rendering.pipeStrokeDasharrayDashed`, dotted → `rendering.pipeStrokeDasharrayDotted`. Stroke color = `pipe.color`, stroke-width = `rendering.pipeStrokeWidth`.

**Badge** (emitted only when `pipe.name` is non-empty): rendered as `<rect>` + `<text>` at the pipe x. `pipe.labelPosition` (float, default `1`) pins to top (`1`) or bottom (`0`); badge may overflow past `innerX2` without clipping. `typography.pipeFontSize` (default `10`) drives text height; padding from `rendering.pipeBadgePaddingX/Y`. Renderer source is authoritative for geometry.

## Curtains rendering

Curtains are tinted vertical bands over a date range with optional boundary lines and a name badge. Rendered across two slots: slot 3 (tinted rectangles, `<g id="curtains">`) and slot 7 (boundary lines + badge, `<g id="curtain-edges">`).

**Skip rules (both slots):** curtain skipped silently if `startDate` is null, `endDate` is null, `endDate <= startDate`, `endDate < chartStartDate`, or `startDate > chartEndDate`.

**Slot 3 — tinted rectangle:** `x1 = max(xFor(startDate), innerX1)`, `x2 = min(xFor(endDate), innerX2)`. Skipped if `x2 <= x1`. `<rect>` fill = `curtain.color`, `fill-opacity` = `curtain.opacity`, no stroke.

**Slot 7 — boundary lines:** `xStart = xFor(startDate)`, `xEnd = xFor(endDate)` (unclamped). Each line emitted only if its x is within `[innerX1, innerX2]`. Stroke = `curtain.color`, stroke-width = `rendering.curtainStrokeWidth`, no dasharray.

**Slot 7 — badge** (emitted only when `curtain.name` is non-empty): anchor x = `xFor(startDate)` when `curtain.labelAnchor !== 'end'`, else `xFor(endDate)`; badge skipped if anchor x falls outside `[innerX1, innerX2]`. Badge always extends right from the anchor, overflow past `innerX2` allowed. `curtain.labelPosition` (float, default `1`) pins to top/bottom; `typography.curtainFontSize` (default `10`) drives text height. Renderer source is authoritative for geometry.

**Curtains entity columns:** parsed and written by `colDefs` for Curtains in `parser.js` / `writer.js`. `labelAnchor` is the only enum (`normalizeLabelAnchor`).

## Notes rendering

Notes are free-positioned text annotations rendered in slot 14 (`<g id="notes">`), above swimlane labels and below header/footer.

**Coordinate model.** Dimensions are percentages of the task row area (`taskRowH = taskRowY2 - taskRowY1`):
- `noteX = innerX1 + (xPct / 100) * innerWidth`
- `noteY = taskRowY1 + (yPct / 100) * taskRowH`
- `noteW = (widthPct / 100) * innerWidth`
- `noteH = (heightPct / 100) * taskRowH`

Partial overflow past task row area boundaries renders as-positioned — no clip to task row area.

**Skip rules (silent):** note skipped entirely when `text === ""`, `widthPct <= 0`, `heightPct <= 0`, or fully off-chart (`xPct >= 100`, `yPct >= 100`, `xPct + widthPct <= 0`, or `yPct + heightPct <= 0`).

**Optional box:** `<rect>` emitted only when `fillColor` is non-empty OR `borderColor` is non-empty. Fill = `fillColor` if non-empty, else `"none"`; stroke = `borderColor` if non-empty, else `"none"`; stroke-width = `rendering.noteBorderStrokeWidth`; `rx` = `rendering.noteCornerRadius`. When both are empty, no rect — note is text-only over a transparent area.

**Text wrapping.** Available width = `noteW - 2 * rendering.notePadding`; if ≤ 0, text is skipped (rect still emits). Character-width estimate: `fontSize * rendering.charWidthFactor` per character. Algorithm: split `text` on `\n` into segments; each segment wraps independently. Empty segments (from consecutive `\n`) produce a blank line — at `<tspan>` emission, an empty wrapped line is substituted with `&#160;` (NBSP) so the tspan reserves glyph height; an empty tspan would be zero-height and collapse the intended blank line. Within each segment, greedy line-fill from whitespace-split tokens. Unbreakable tokens (estimated width > availW) are character-truncated with `…` and emitted as their own line.

**Alignment.** `note.verticalAlign` (`top`/`middle`/`bottom`, default `top`) positions the text block within `noteH`; `note.textAlign` (`left`/`center`/`right`, default `left`) sets each `<tspan>`'s `x` and `text-anchor`. The renderer reads both directly with no `||` fallback — the parser is the sole source of defaults (normalised via `normalizeNoteVerticalAlign` / `normalizeNoteTextAlign`).

**Clip path.** Each note that emits text gets a per-note `<clipPath id="note-clip-${id}">` (rect matching note bounds) in `<defs>`. The `<text>` element references it via `clip-path="url(#note-clip-${id})"`. Overflow text is silently hidden.

**`<defs>` block (combined).** Pattern-fill defs and note clip paths share one `<defs>` block placed between the `<svg>` open tag and slot 1. Pattern content is collected first but assembly is deferred until after the notes pass so both kinds of content can be combined. `<defs>` is omitted entirely when neither patterns nor note clip paths are needed.

**Notes columns / typography / style keys:** see Notes `colDefs` in `parser.js` plus the Note Font Size / Note Text Color entries. Non-obvious defaults: `borderColor` / `fillColor` default to `""` (no border / transparent) — empty is the "skip the rect" signal, not an error.

## Current UI

Four-tab layout (left to right): Data → Issues → Chart → Inspector.

**Data** tab hosts entity-specific data-entry panels. Second-tier tab strip (Tasks / Swimlanes / Links / Pipes / Curtains / Notes); all six panels are live. `renderDataPanel()` is the single render entry point — invoked on tab activation, on file load, on New Project, and after any `dispatch()` mutation via the post-mutation hook. The two-pane skeleton (`.entity-left` + `.entity-right`) is rebuilt on second-tier tab switch only; the form container survives mutations so commit-on-blur preserves focus. **Chart** tab calls `renderChart(projectData)` on every activation and injects the SVG into a horizontally-scrollable container ("No project loaded" shown if tasks array is empty). **Inspector** tab renders every field of `projectData` as flat tables on every activation — exhaustive, read-only, developer-facing, always reflects current state including defaults before any file is loaded.

**Tasks panel internals.** Toolbar (Add / Delete / Duplicate / Move Up / Move Down) + nav table (left) + edit form (right). Nav table sort: `(swimlane.order, task.row, array index)`; orphans (no matching swimlane) and null/undefined `task.row` sort last via Infinity sentinels in `buildTasksDisplayOrder`. Sort is display-only — `projectData.tasks` array order is never mutated, so writer round-trip preserves the user's Excel ordering. Move Up / Move Down on the Tasks toolbar dispatch `update` on `task.row` (NOT the dispatcher's `moveUp`/`moveDown` array-reorder actions, which remain in use by other entity types); enablement uses `typeof task.row === 'number'` guards (so null-row tasks have both disabled) combined with `row > 1` / `row < swimlane.rowCount`, plus an explicit "Task has no swimlane" tooltip for orphans (no tooltip on the other disabled cases — the visible row value in the form makes them self-explanatory). The row form input commits empty as `null` (same empty-as-null pattern as `task.dateFormat`); non-finite numeric input is silently dropped. Post-delete selection uses sorted display order, not array order. Form rebuild is gated on `formRenderedForId` so commit-on-blur preserves focus on surviving inputs; the row input is targeted-DOM-updated via `syncTaskRowInput` after Move Up / Move Down because the form does not rebuild on same-id updates. `nextSelectionIntent` is the module-scope baton that toolbar handlers and row clicks use to communicate post-mutation selection to the next `renderDataPanel` call. Selection-intent key plurality gotcha: dispatcher entity names are singular (`'swimlane'`), but `nextSelectionIntent.entity` and `entitySelections` keys are plural (`'swimlanes'`) to match the second-tier tab ids.

**Swimlanes panel internals.** Same shape as Tasks (toolbar + nav + form) with two notable simplifications and one parallel: (a) display order = array order, no sort needed — there's no orphan or out-of-range concept for swimlanes; (b) Move Up / Move Down dispatch the dispatcher's real `moveUp`/`moveDown` array-reorder actions (Tasks' row-field hack is unique to Tasks); (c) `syncSwimlaneOrderCell` is the parallel of `syncTaskRowInput` — keeps the form's read-only `order` cell fresh after a same-id Move Up/Down, since `swimlane.order` is derived from array index and the form does not rebuild. This is a declared exception to the form-rebuild-only-on-selection-change rule, justified because the user clicked an explicit button to change a visible field. The `addReadonlyRow` helper sets `data-field` on its cell to support this targeted DOM update.

**Links / Pipes / Curtains / Notes panel internals.** All four share `renderSimpleEntityToolbar(entitySingular, entityPlural, arr, selectedId)` and `attachNavTableRowHandlers(table, entityPlural)` — same shape as Tasks/Swimlanes but factored because the four behave identically (no Add prerequisite, no delete-block, dispatcher-driven array `moveUp`/`moveDown`, no derived-field sync helper needed because no visible field changes on reorder). Tasks (delete-block + row-field Move Up/Down) and Swimlanes (predates the helpers, plus the order-cell sync exception) keep their own dedicated toolbars and inline row handlers — the asymmetry is deliberate; do not retrofit without a separate slice.

**Links FK posture.** `fromTaskId` / `toTaskId` dropdowns are populated via `buildTaskRefOptions(currentValue)`. If the current value is an orphan id (non-null, no matching task), a `{id} — (missing)` option is prepended at the top of the option list so the orphan state is visible and the user can re-point or save with it persisting. `null` (user hasn't filled it in yet) is distinct from orphan and shows the standard `—` placeholder option. Nav-table FK cells use `formatTaskRefCell` with the same null vs orphan distinction. This orphan-prepend pattern is scoped to Links FKs only — the Tasks `swimlaneId` dropdown does *not* do this yet (separate slice if wanted).

**Notes textarea.** `addTextareaRow` is the textarea analogue of `addTextRow`; relies on `attachCommitHandlers`' Enter-to-blur gate being `tagName === 'INPUT'` so Enter inserts newlines in a textarea instead of committing. Multi-line text round-trips through dispatch unchanged. The nav-table preview collapses any whitespace (newlines, tabs, runs of spaces) via `notePreviewText` to single spaces before 40-char truncation; the full untouched text lives in the cell's `title` attribute. CSS rule `.entity-form textarea { resize: none; … }` lives in `index.html` alongside the input/select rule.

**Form helper conventions.** `addNumberRow(form, field, value, commitFn, opts)` accepts an optional `opts = { step, min, max }`; defaults to integer-stepping (`step=1`, no bounds) so all existing call sites work unchanged. Parsing is the caller's responsibility (`parseInt` vs `parseFloat` inside `commitFn`); the helper only configures HTML attributes. Float call sites (Pipes `labelPosition`, Curtains `opacity`/`labelPosition`, Notes `xPct`/`yPct`/`widthPct`/`heightPct`) use `parseFloat` in the commit and pass `step: '0.1'` (or `'1'` for Notes) plus bounds where applicable. Enum `<select>` options use the canonical lowercase values that the parser stores (`auto/hv/vh`, `solid/dashed/dotted`, etc.) — not the §7 Excel-facing display casing.

**Issues tab** is a read-only, user-facing surface for `projectData._validation` — renders on tab activation, never re-validates. Four panel states (undefined / clean / no-match / table), controls (search, three severity checkboxes, grouping toggle), six-column table, severity-then-entity grouping, and three-state sort header cycle all live in `renderIssuesPanel` and friends in `ui.js`. Non-obvious bits worth keeping in mind:

- Sort is stable, tie-broken to parser-emission order — implemented by always sorting from a canonical emission-ordered list (`flattenIssues`), never from the current view. ID and value place nulls/placeholders last regardless of direction.
- Filter/sort/group state lives in module-scope `issuesFilterState`, persists across tab switches, resets on every file load. No `localStorage`. Search input keeps focus while typing because only `#issuesBody` re-renders on filter changes — the controls DOM is built once per `renderIssuesPanel` call.
- Tab label: plain `Issues` when no issues, else `Issues (E/W/N)` with a single severity tint chosen by the highest non-zero bucket. Active-tab styling overrides the tint via CSS specificity.

Validation is non-gating: Save xlsx and Save SVG remain enabled regardless of `_validation` content. The Inspector also surfaces `_validation` raw via its dynamic walk (developer-facing); duplication with the Issues tab (user-facing) is intentional.

**ui.js helpers:** `renderEntityTable(container, data, derivedKeys = [])` — the optional third argument lists keys whose column headers should be suffixed with ` (derived)` in the Inspector. Currently `['isMilestone']` for tasks and `['order']` for swimlanes; extend this list when new derived fields are added. `renderConfigTable(container, config)` renders a two-column key/value table. Both helpers serve the Inspector tab only — the Data tab uses dedicated per-entity panel renderers (see Tasks panel internals above). The Issues tab does not reuse these helpers — `renderIssuesPanel` and friends are dedicated, with their own column model, sortable headers, pill rendering, and truncation rules.

**Inspector dynamic walk:** `renderInspector` skips the seven fixed top-level keys and renders remaining keys (e.g. `_parseNotices`, `_validation`) as "diagnostic" sections. Plain object whose every value is an array → one sub-section per sub-key via `renderEntityTable` (this is how `_validation`'s `{errors, warnings, notices}` buckets render); array → entity table; plain object → key-value table; primitive → single-cell table; else `JSON.stringify` fallback.

Toolbar buttons (left to right): **New Project** → file input → **Save** (xlsx) → **Save SVG**. New Project replaces `projectData` with `createEmptyProjectData()`, clears `loadedFilename`, resets data-panel and issues-filter state, activates the Data tab, then dispatches two swimlane mutations to seed a default `"Swimlane 1"`. Both Save buttons share the same disabled gate (`tasks.length === 0 && swimlanes.length === 0`), toggled by `refreshStatusAndButtons` — the shared status/button helper called by both the file-load and New Project handlers. The Save SVG button calls `renderChart(projectData)` directly regardless of which tab is active, wraps the result in a `Blob('image/svg+xml')`, and downloads via `URL.createObjectURL`. Filename: loaded filename with last extension replaced by `.svg` (e.g. `report.final.xlsx` → `report.final.svg`); defaults to `"compactgantt_chart.svg"` if no file is loaded.

`initUI()` finishes with a `renderDataPanel()` call so the empty entity tab strip + empty Tasks panel are present on page load, before any file load or New Project click.

## Excel export (writer.js)

`writeWorkbook(projectData)` returns a `Uint8Array` (SheetJS `type: 'array'`), ready for `new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })`.

**Named-column policy:** columns are identified by header name, not index. The writer emits named headers; column order within each sheet is presentation-only and not load-bearing for the schema.

**Sheet order:** matches the `addSheet` call sequence in `writer.js`. `config.rendering` is deliberately excluded (hard-coded defaults; not user-configurable at this stage).

**Entity sheets:** header row + one data row per entity; always emitted even if the array is empty. Derived fields (`task.isMilestone`, `swimlane.order`) are not written. `task.dateFormat` and null date fields write as empty cells (`null` in the AOA → empty cell in SheetJS).

**Date cells:** YYYY-MM-DD strings converted timezone-safely via `split('-')` → `new Date(y, m-1, d)` before being passed to SheetJS. Null → empty cell. Timeline dates obey `chartStartDateExplicit` / `chartEndDateExplicit` — only written when explicit; otherwise left empty so auto-derivation from task dates continues to work after a save/reload cycle.

**Boolean cells:** `"Yes"` / `"No"` strings — matches `kvBool`'s string parsing.

**Config sheets:** two-column layout with `["Field", "Value"]` header row in row 1. `parseConfigSheet` picks up the header as a harmless extra map entry that no `kv*` call looks up — round-trip is safe.

**Save button:** disabled until `tasks.length > 0 || swimlanes.length > 0` (i.e. at least one entity array is non-empty). Suggested download filename is the originally loaded filename if one was loaded, otherwise `"compactgantt_project.xlsx"`. See also Save SVG in the Current UI section above.
