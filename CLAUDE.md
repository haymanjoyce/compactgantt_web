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

`.gitignore` covers macOS/Windows artefacts, `.vscode/`, and `/temp/`.

## Entry point

`index.html` is the sole entry point — open directly in a browser, no server needed.

## Conventions

- **American spelling** throughout: "color" not "colour" in all property names, comments, and UI text.
- **camelCase** for all JS property names.
- **YYYY-MM-DD** strings for all date values stored in `projectData`.

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

Exports: `toISODate`, `toJsDate`, `daysBetween`, `formatDate`, `isoWeekLabel`, `weekdayName(iso, length)` (length: `'full'` / `'short'` / `'letter'`). Non-obvious invariants:

- `toISODate` is timezone-safe (`getFullYear/getMonth/getDate`, never `toISOString`) and filters Invalid `Date` objects (`isNaN(getTime())`) — guards against SheetJS surfacing Invalid Date on round-tripped empty cells. Non-slash strings pass through as-is; shape validation happens at `parseDate` / `kvDate` in `parser.js`.
- `toJsDate` constructs via `new Date(y, m-1, d)`. `daysBetween` uses `Date.UTC` arithmetic.
- `formatDate` / `isoWeekLabel` / `weekdayName` require the `dateFns` global. ISO week semantics — Monday is first day.
- `validation.js` does only string comparison on YYYY-MM-DD and does not import `dates.js`.

## Top-level state and `projectData`

`ui.js` owns the live `projectData` reference for the session, initialised by `createEmptyProjectData()` — never `null`. The "no file loaded" condition is `projectData.tasks.length === 0`. File-load and New Project replace `projectData` wholesale; all other writes route through `dispatch()`.

`createEmptyProjectData()` is the single source of truth for the `projectData` shape and all default config values. `parseWorkbook` calls it, then overwrites entity arrays and config sections from the workbook. It is a pure function — builds and returns a fresh object.

`renderer.js` and `writer.js` take `projectData` as a parameter and have no dependency on the global.

## Mutation dispatcher (ui.js)

`dispatch({ entity, action, id, block, field, value, index })` is the single-writer entry point for all in-app mutations. Centralising mutation is what makes the post-mutation hook (validation re-run + active-tab re-render + Issues-tab-label refresh) unbypassable.

`entity` ∈ `task` / `swimlane` / `link` / `pipe` / `curtain` / `note` / `config`. `action` ∈ `update` / `add` / `delete` / `duplicate` / `moveUp` / `moveDown`. Config supports `update` only. Unknown entity/action, missing required field, or id miss → `console.warn` + no-op (never throws).

`add` uses per-entity factories in `parser.js` and assigns `id = max(existing) + 1` or `1` if empty. `duplicate` clones via shallow spread and assigns a fresh id the same way.

**Deletion blocking** (silent no-op, no hook fires): a task delete is blocked if a link points to or from it. No other delete is blocked — deleting the last task in a swimlane is allowed, and deleting a swimlane that still has tasks is allowed (orphaned tasks remain in `projectData`; validation flags them and the renderer skips them).

**Derived-field maintenance.** `task.isMilestone` is recomputed on task `update`; `swimlane.order` is recomputed (1-based array index) after any swimlane array mutation.

**Post-mutation hook** runs in order: `validateProject` → `activateTab(activeTab)` → `updateIssuesTabLabel`. Active tab is tracked in module-scope `activeTab`. `update` runs the hook unconditionally even if `value` equals the existing field value (string-numeric mismatches make a robust equality check not worth it).

## Excel file format

`XLSX.read` is called with `{ cellDates: true }` so date-formatted cells arrive as JS `Date` objects.

**Entity sheets** (tabular, row 1 = column headers): Tasks, Swimlanes, Links, Pipes, Curtains, Notes. Parsed via `parseEntitySheet(worksheet, colDefs)` — header-based, never positional. Missing columns silently receive their declared default (backward-compatibility requirement). Old-name fallbacks live in `colDefs` `fallback` properties; `parser.js` is authoritative.

**Config sheets** (key-value: col A = field name, col B = value): Layout, Bars, Timeline, Titles, Style, Typography, Preferences. Parsed via `parseConfigSheet(worksheet)` → plain map, read with `kvStr/kvInt/kvFloat/kvBool/kvDate`. Each `kv*` helper accepts an optional `fallback` key for old-name compatibility — try-new-first.

Schema asymmetry worth knowing: Timeline has five `show*` fields (years/months/weeks/days/dates) but only four `gridline*` fields — days and dates share calendar-day boundary granularity, so a single `gridlineDays` covers both.

## Derived fields

- `task.isMilestone = startDate !== null && startDate === finishDate` (null-guard prevents false positive when both dates are absent).
- `swimlane.order` = 1-based array-index position (not stored in Excel).
- `config.timeline.chartStartDate/chartEndDate` derived from `min(task.startDate)` / `max(task.finishDate)` if absent or unparseable in the Timeline sheet. `chartStartDateExplicit` / `chartEndDateExplicit` record whether the user wrote any non-empty value in the cell (`true`, via `isNoticeableInput`) or left it blank (`false`) — used by the writer to decide whether to emit or leave empty. Deliberate asymmetry: a cell containing garbage (`"not a date"`) is `explicit=true` with a `chartStartDate` derived from tasks, so save round-trips the garbage cell to a now-valid derived date.

## Parse notices (`_parseNotices`)

`projectData._parseNotices` is an array side-channel populated by `parseWorkbook` and seeded to `[]` by `createEmptyProjectData()`. Each notice records a non-empty source cell that the parser could not interpret and silently defaulted:

```
{ entity, id, field, rawValue, reason }
```

- `entity` — singular lowercase (`'task'` / `'swimlane'` / `'link'` / `'pipe'` / `'curtain'` / `'note'` / `'config'`).
- `id` — entity row id (integer for parsed ids, `null` for config rows). Rows whose id cell was blank/unparseable carry the **newly-assigned** id, not null — so the user can locate them in the data.
- `field` — JS property name (e.g. `'startDate'`), never the Excel header.
- `rawValue` — original cell value, unmodified.
- `reason` — closed enum, five values, all emitted by the parser. `validation.js` reads these via `consumeNotice`; it does not emit notices itself.

Reason values:

| Reason | When emitted |
|---|---|
| `'unparseable_date'` | non-empty value that did not produce a valid YYYY-MM-DD result. `parseDate` / `kvDate` validate the result of `toISODate` against `/^\d{4}-\d{2}-\d{2}$/` (so a raw `"garbage"` string is rejected here, not at `toISODate`). |
| `'unparseable_number'` | non-empty value that `parseInt` / `parseFloat` returned `NaN` for; emitted by `toInt` / `toFloat` / `kvInt` / `kvFloat`. |
| `'unrecognised_boolean'` | non-empty string in a boolean field that, after trim+lowercase, is neither `'yes'` nor `'no'`; emitted by `kvBool`. Native JS booleans pass through silently. |
| `'unrecognised_enum'` | non-empty value that a `normalize*` function did not recognise. |
| `'id_assigned'` | id cell was blank, missing, or unparseable; parser assigned `max(existing) + 1`. Suppresses the upstream `unparseable_number` notice for id cells (one notice per row, never two). Notably also fires on empty id cells — exception to the "empty cells produce no notice" rule. |

**Empty vs unparseable distinction.** Empty cells (`null` / `undefined` / `''`), whitespace-only strings (`'   '`), and Invalid `Date` objects (`isNaN(getTime())`, as SheetJS produces for round-tripped empty date cells) NEVER produce a notice — they take the default silently. Notices fire only when the user wrote something meaningful that the parser ignored. **Exception:** `'id_assigned'` notices fire on blank/missing id cells too. This separation is the whole point of the side-channel.

**Notice order.** Parser-traversal order: entity sheets first (tasks, swimlanes, links, pipes, curtains, notes), then config sheets (layout, bars, timeline, titles, style, typography, preferences). Top-to-bottom within a sheet, left-to-right within a row.

**Not emitted from:** `createEmptyProjectData()`; column-name fallbacks; config key-name fallbacks (British-spelling `Colour` fallbacks, etc.).

**Enum recognition lives in the parser** — twelve `normalize*` functions, all in `parser.js`. The renderer's fallbacks for unrecognised enums are no longer reachable in normal flow: the parser supplies a canonical default before the value leaves `parseWorkbook`, and `validation.js` does not re-encode any enum membership lists (it reads only via `consumeNotice`).

## Validation (`validation.js`)

`validateProject(projectData)` returns `{ errors: [Issue], warnings: [Issue], notices: [Issue] }` — all three keys always present. Pure: no DOM, no side effects, never mutates `projectData`, never throws.

Each `Issue` is `{ entity, id, field, message, value }`. `entity` is singular lowercase (same enum as `_parseNotices`). `id` is the entity row id, `null` for config issues only — entity rows always have a non-null id at validation time (parser auto-assigns). `value` is `null` for "missing field" rules, `rawValue` from `_parseNotices` for parse-derived rules, the current field value otherwise.

**Structure.** A thin `validateProject` coordinator calls 14 per-block validators (six entity + eight config, including `validateRendering`) in parse traversal order and concatenates results.

**`_parseNotices` consumption.** Entity validators filter notices by entity tag; config validators filter by an explicit field-ownership Set. Matching notices emit Issues into the bucket dictated by the locked rule list — the same `reason` maps to different buckets depending on the field. The array stays in place on `projectData`.

**"Missing X" guard** fires only when (a) the field is `null` AND (b) no `_parseNotices` entry for `(entity, id, field)` with reason `unparseable_number` / `unparseable_date`. Prevents double-emission. **Foreign-key validity Sets** filter `null` ids out, so a row with a missing id does not silently satisfy a reference.

**CSS color recognition.** Inline allowlist (148 CSS Color Level 4 names + `transparent` + `currentcolor`) plus hex/rgb/rgba/hsl/hsla shape regexes. `isValidCssColor("")` is `false`; per-field rules decide whether empty is legal (e.g. Notes border/fill) or an error (e.g. all 16 Style colors).

**Link classification (R1/R2).** Both rules run inside an outer gate of `pred.finishDate > succ.startDate`, so the block only classifies links the renderer would treat as non-forward — mirroring the renderer's else-branch (neither module imports from the other). Inside the gate, R1 (`pred.finishDate >= succ.finishDate`) flags pred running at or past succ's finish; R2 flags late-recoverable (`pred.finishDate < succ.finishDate`) on the same absolute row. The gate exists because without it, R1 misfired on canonical zero-lag F-S links to milestone successors — `succ.finishDate === succ.startDate` collapses R1 to `pred.finishDate >= succ.startDate`, tripping on shared-date arrangements that are valid F-S dependencies. The renderer's `origX >= termX` geometric skip has no validation counterpart: zero-horizontal-travel forward links are silently dropped at render time but are NOT classified as invalid, because same-day forward links (`pred.finishDate === succ.startDate`) are valid zero-lag F-S dependencies that simply happen to be unrenderable at zero x-distance. Self-links (`fromTaskId === toTaskId`) skip the R1/R2 block entirely; the dedicated Self-link error is the sole issue emitted for them.

**Call site.** `projectData._validation` is written by the file-load handler (immediately after `parseWorkbook`) and `runPostMutationHook`. New Project relies on the latter via its seeding dispatches. The renderer never consults `_validation` — validation is non-gating.

## Renderer (renderer.js)

`renderChart(projectData)` returns a raw SVG string. Key design rules:

- **Coordinate areas:** `innerX1 = paddingLeft`; `innerX2 = outerWidth - paddingRight`; `taskRowY1 = paddingTop + headerHeight + scaleTotalHeight`; `taskRowY2 = outerHeight - paddingBottom - footerHeight`.
- **Scale band height:** `max(rendering.minScaleBandHeight, scaleFontSize * rendering.scaleFontToBandHeightFactor)` per visible scale; total = count × bandHeight.
- **Five scale bands** (top-to-bottom): years, months, weeks (ISO `"W03"`), dates (numeric day-of-month), days (named: Monday/Mon/M). Hidden bands occupy no space. Months band reads single-letter labels from `rendering.monthLetters`. Named-day cells degrade width-adaptively through full→short→letter→empty using `fontSize * rendering.charWidthFactor` per character — the standard `rendering.scaleMinLabelWidth` (default 20 px) gate applies to years/months/weeks/dates only, not to the days band.
- **Render order (painter's algorithm, 15 slots):** defined in `renderer.js` (search for the SVG layer accumulators). Header/footer paint last so they frame the chart regardless of unusual layout dimensions. Slot numbers referenced elsewhere (e.g. "slot 7", "slot 14") correspond to those accumulators in source order.
- **Color handling:** colors are passed directly from `projectData` to SVG `fill`/`stroke` attributes without renderer-side validation; invalid CSS color names render as SVG's default (black). Validation lives in `validation.js`.
- **Swimlane backgrounds:** `<rect>` fill = `swimlane.backgroundColor` — no renderer-side fallback. The parser supplies the default `"white"`.
- **Header/footer text alignment:** per-band via `titles.headerTextAlign` / `titles.footerTextAlign`. Horizontal inset uses `rendering.headerFooterTextPadding` for `left` and `right` only (centred text uses band centre). Each band also emits an inside-edge `<line>` border (`style.headerFooterBorderColor`), suppressed with the band when its height is 0.
- **Milestones:** centred on `startDate`; size = `bars.milestoneSizeFactor * rowHeight`. Two shapes via `bars.milestoneShape`:
  - `circle` — `<circle>` circumscribing the diamond's anchors; `milestoneCornerRadius` ignored.
  - `diamond` (default) — `<path>` with rounded corners controlled by `bars.milestoneCornerRadius` (0..1, fraction of half-edge). No parser clamping; validation flags out-of-range values.
- **Bars:** `<rect rx="${bars.taskCornerRadius}">`.
- **Task bar pattern fills:** `task.fillPattern` drives SVG `<pattern>` elements in the shared `<defs>` block. `"solid"` (or any unrecognised value) → `fill="${fillColor}"`. The five named patterns (`hatch`, `cross-hatch`, `horizontal`, `vertical`, `dots`) → `fill="url(#id)"` referencing a deduplicated `<pattern>` keyed by sanitised `(fillPattern, fillColor, patternColor)` triple. Patterns use `patternUnits="userSpaceOnUse"` with no `x`/`y` — tiles anchor at SVG origin so bars on the same row share a continuous-field phase. Milestones are always solid.
- **Skip rules:** orphaned tasks, `finishDate < startDate`, tasks fully outside chart date range all silently skipped; `row` clamped to 1 whenever not a positive integer within `[1, swimlane.rowCount]` (covers null, non-numeric, zero, negative, out-of-range). Null `task.row` reaches the renderer when the user cleared the cell — the parser preserves null end-to-end.
- **Milestone labels:** the renderer's milestone branch always renders labels outside, without reading `task.labelPlacement`. The parser does not override the stored placement value — milestones retain whatever placement the user set.
- **Task labels (slot 12):** built from `task.labelContent` with date-fns formatting. Per-task `task.dateFormat` overrides `config.preferences.chartDateFormat`. Inside fill: `style.insideLabelTextColor`; outside fill: `style.outsideLabelTextColor`.
  - *Inside labels* (bars only): truncated via `fontSize * rendering.charWidthFactor` per character. Prefers word-boundary break; falls back to character truncation; emits nothing if `…` alone exceeds available width. AvailW = `barWidth - 2 * rendering.insideLabelPadding`.
  - *Outside labels*: no truncation. `x = rightEdge + outsideLabelKissingGap + task.labelOffset`; right edge = `xFor(finishDate)` for bars, `xFor(startDate) + milestoneHalf` for milestones.
  - *Leader lines*: horizontal `<line>` at row centre y from `rightEdge` to `rightEdge + labelOffset` (spans exactly `labelOffset` px). Drawn when `labelOffset > 0`; for bars also requires `labelPlacement === 'outside'`. Stroke: `style.leaderLineColor`. No clip — may overflow into right padding.

## config.rendering

All rendering tunables (stroke widths, paddings, factors, gaps, corner radii, `monthLetters`, `charWidthFactor`, etc.) live in `config.rendering` in `createEmptyProjectData()`. **Hard-coded defaults, not Excel-driven** — `parseWorkbook` does not touch this object; every reload starts from `createEmptyProjectData()`. The writer deliberately excludes this section. Source is authoritative. Most names follow `<element><attribute>` (e.g. `linkCornerRadius`, `pipeStrokeWidth`); a minority are non-element-bound (`charWidthFactor`, `monthLetters`).

## Link rendering

Finish-to-Start dependency arrows. Implementation notes:

**Renderable-task lookup (`taskGeom` Map):** built during the task-bar/milestone render pass. Keyed by `task.id`; value contains `{ absRow, rowCenterY, barTopY, barBottomY, originX, termX, startDate, finishDate, isMilestone }`. Any task skipped by the bar pass is absent, so orphaned-link detection is implicit — no duplicate skip logic.

**Connection points:**
- Task bar origin: `xFor(finishDate)` at row centre; termination: `xFor(startDate)` at row centre.
- Milestone origin and termination both = `xFor(startDate)` (centre) — link geometry stays independent of milestone shape.

**Link classification (render-time, not stored):**
- *Forward*: `pred.finishDate <= succ.startDate` with non-zero horizontal travel — H/V/V-H/AUTO V-H-V routing per `link.routing`.
- *Vertical forward*: zero-lag forward (`pred.finishDate === succ.startDate`, surfaces as `origX >= termX`) on different absolute rows — pure vertical line at `x = origX = termX`. Routing ignored. Termination y differs by successor type — see milestone-successor note below.
- *Late-recoverable*: `pred.finishDate > succ.startDate AND pred.finishDate < succ.finishDate AND different absolute rows` — vertical-only path, termination x = origin x, termination y = top edge of succ if below pred, bottom edge if above.
- *Invalid* (skip silently): `pred.finishDate >= succ.finishDate`; same-row late links; same-row zero-lag forward links.
- Milestone successors cannot be late-recoverable (their `startDate === finishDate` makes the late condition impossible) but routinely appear as vertical-forward successors — the canonical "task bar finishes day X, milestone marks completion day X on a different row" case.

**Routing (forward only):** `HV`, `VH`, `AUTO`+same-row (direct horizontal), `AUTO`+different-rows (V-H-V with midY = mean of endpoints).

**Rounded corners at bends (HV, VH, AUTO V-H-V only):** quarter-circle arc, radius `min(linkCornerRadius, segA/2, segB/2)`. Per-bend sweep flag depends on turn direction — gotcha worth keeping explicit: `(right→down)=1`, `(right→up)=0`, `(down→right)=0`, `(up→right)=1`. AUTO V-H-V's two bends always carry opposite sweep flags.

**Z-order split:** `renderedLinks` is pre-computed, then iterated twice — once for `<path>` bodies (slot 8) and once for `<circle>` origin markers + `<polygon>` arrowheads (slot 11). This keeps task bars and milestones between the two link layers without duplicating classification logic.

**Arrowheads:** per-link `<polygon>` triangles sized by `arrowheadSizeFactor * rowH`, not SVG `<marker>` defs — avoids browser inconsistency with `context-fill`/`context-stroke`.

**Milestone predecessor/successor special cases:**
- *Origin marker suppressed* when `pred.isMilestone` — path still starts at the milestone centre but no filled circle is drawn over the shape.
- *Arrowhead backed off* when `succ.isMilestone` — tip is placed at `milestoneHalf + rendering.linkArrowheadMilestoneGap` from the centre along the arrowhead direction. The back-off is calibrated for `termY === succ.rowCenterY`; vertical-forward → milestone deliberately uses `rowCenterY` (vs. `barTopY` / `barBottomY` for bar successors) so this calibration holds for both forward and vertical-forward branches. Late-recoverable links cannot have milestone successors.

## Pipes / Curtains / Notes rendering

**Pipes** (slot 7): vertical reference lines at a date with optional text badge. Skipped silently if `date` is null or outside chart range. Dasharray driven by `pipe.lineStyle` (solid/dashed/dotted). Badge emitted only when `name` is non-empty; `labelPosition` (float, default `1`) pins to top (`1`) or bottom (`0`); may overflow past `innerX2`.

**Curtains** (slots 3 and 7): tinted vertical band with optional boundary lines and name badge. Skipped silently if `startDate`/`endDate` null, `endDate <= startDate`, or fully off-chart. Slot 3 tinted `<rect>` is clamped to `[innerX1, innerX2]`; boundary lines emit only when their x is in-range; badge anchors at `xFor(startDate)` (or `xFor(endDate)` when `labelAnchor === 'end'`) and always extends right (overflow allowed).

**Notes** (slot 14, above swimlane labels, below header/footer): free-positioned text annotations.

- **Coordinate model.** Dimensions are percentages of the task row area (`taskRowH = taskRowY2 - taskRowY1`): `noteX = innerX1 + (xPct / 100) * innerWidth`, similar for Y/W/H. Partial overflow renders as-positioned (no clip to task row area).
- **Skip rules (silent):** `text === ""`, `widthPct <= 0`, `heightPct <= 0`, or fully off-chart (`xPct >= 100`, `yPct >= 100`, `xPct + widthPct <= 0`, or `yPct + heightPct <= 0`).
- **Add-flow defaults diverge from parser blank-cell defaults.** `createEmptyNote()` returns `widthPct: 20`, `heightPct: 10`, `borderColor: 'black'`, `fillColor: 'white'`, `text: 'Note'` so a freshly Added note dodges all four skip conditions and renders immediately. The parser's Notes column defs stay at `0` / `''` so blank Excel cells still round-trip as blank. Two user contracts (Excel-blank means "left empty"; Add button means "give me a usable starting state") — do not align them.
- **Optional box:** `<rect>` emitted only when `fillColor` is non-empty OR `borderColor` is non-empty. Empty `borderColor` / `fillColor` are the "skip the rect" signal, not errors. When only one is non-empty, the empty side falls back to the SVG keyword `"none"` so the rect emits with no fill (or no stroke) as the user expects.
- **Text wrapping.** AvailW = `noteW - 2 * rendering.notePadding`; if ≤ 0, text is skipped (rect still emits). Character-width estimate: `fontSize * rendering.charWidthFactor`. Algorithm: split on `\n`, wrap each segment independently. Empty wrapped lines (from consecutive `\n`) emit `&#160;` (NBSP) so the `<tspan>` reserves glyph height — an empty `<tspan>` is zero-height and collapses the intended blank line. Unbreakable tokens are character-truncated with `…` as their own line.
- **Alignment.** `verticalAlign` (`top`/`middle`/`bottom`) positions the text block; `textAlign` (`left`/`center`/`right`) sets each `<tspan>`'s `x` and `text-anchor`. Renderer reads both directly with no `||` fallback — parser is the sole source of defaults.
- **Clip path.** Each note that emits text gets a per-note `<clipPath id="note-clip-${id}">` in `<defs>`. Overflow text is silently hidden.

**`<defs>` block (combined).** Pattern-fill defs and note clip paths share one `<defs>` block placed between the `<svg>` open tag and slot 1. Pattern content is collected first but assembly is deferred until after the notes pass. `<defs>` is omitted entirely when neither patterns nor note clip paths are needed.

## Current UI

Five-tab layout (left to right): **Data → Chart → Issues → Config → Inspector**.

**Data** tab hosts entity-specific data-entry panels. Second-tier tab strip (Tasks / Swimlanes / Links / Pipes / Curtains / Notes); all six panels are live. `renderDataPanel()` is the single render entry point — invoked on tab activation, on file load, on New Project, and after any `dispatch()` mutation via the post-mutation hook. The two-pane skeleton (`.entity-left` + `.entity-right`) is rebuilt on second-tier tab switch only; the form container survives mutations so commit-on-blur preserves focus.

**Chart** tab calls `renderChart(projectData)` on every activation and injects the SVG into a horizontally-scrollable container ("No project loaded" shown if tasks array is empty).

**Inspector** tab renders every field of `projectData` as flat tables on every activation — exhaustive, read-only, developer-facing, always reflects current state including defaults before any file is loaded.

**Issues** tab — see Issues tab section below.

### Data panel — entity panels

**Tasks panel.** Toolbar (Add / Delete / Duplicate / Move Up / Move Down) + nav table (left) + edit form (right). Nav table sort: `(swimlane.order, task.row, finishDate, startDate, array index)`, all ascending; orphans, null `task.row`, and null/empty dates sort last within their group via Infinity / `'￿'` sentinels. Sort is display-only — `projectData.tasks` array order is never mutated, so writer round-trip preserves the user's Excel ordering. Move Up / Move Down dispatch `update` on `task.row` (NOT the dispatcher's `moveUp`/`moveDown` array-reorder actions). Enablement uses `typeof task.row === 'number'` guards combined with `row > 1` / `row < swimlane.rowCount`, plus a "Task has no swimlane" tooltip for orphans. The row form input commits empty as `null`; non-finite input is silently dropped. Form rebuild is gated on `formRenderedForId` so commit-on-blur preserves focus; the row input is targeted-DOM-updated via `syncTaskRowInput` after Move Up / Move Down because the form does not rebuild on same-id updates.

**Swimlanes panel.** Same shape as Tasks with two simplifications and one parallel: (a) display order = array order, no sort; (b) Move Up / Move Down dispatch the dispatcher's real array-reorder actions; (c) `syncSwimlaneOrderCell` parallels `syncTaskRowInput` — keeps the form's read-only `order` cell fresh after a same-id move, since `swimlane.order` is derived from array index and the form does not rebuild. Declared exception to the form-rebuild-only-on-selection-change rule, justified because the user clicked an explicit button to change a visible field. `addReadonlyRow` sets `data-field` on its cell to support this targeted DOM update.

**Links / Pipes / Curtains / Notes panels.** Share `renderSimpleEntityToolbar(entitySingular, entityPlural, arr, selectedId)` and `attachNavTableRowHandlers(table, entityPlural)` — same shape as Tasks/Swimlanes but factored because the four behave identically (no Add prerequisite, no delete-block, dispatcher-driven array `moveUp`/`moveDown`, no derived-field sync helper). Tasks and Swimlanes keep their own dedicated toolbars and inline row handlers — the asymmetry is deliberate.

**Links FK posture.** `fromTaskId` / `toTaskId` dropdowns are populated via `buildTaskRefOptions(currentValue)`. If the current value is an orphan id (non-null, no matching task), a `{id} — (missing)` option is prepended at the top of the option list. Nav-table FK cells use `formatTaskRefCell` with the same null vs orphan distinction. Scoped to Links FKs only — the Tasks `swimlaneId` dropdown does *not* do this yet.

**Notes textarea.** `addTextareaRow` is the textarea analogue of `addTextRow`; relies on `attachCommitHandlers`' Enter-to-blur gate being `tagName === 'INPUT' && type !== 'date'` so Enter inserts newlines in textareas (and is also a no-op in date inputs, where the browser's native date picker owns Enter). Multi-line text round-trips through dispatch unchanged. Nav-table preview collapses any whitespace via `notePreviewText` to single spaces before 40-char truncation; full text lives in the cell's `title` attribute.

**Nav-table date display.** Date cells in the Tasks (`startDate`, `finishDate`), Pipes (`date`), and Curtains (`startDate`, `endDate`) nav tables are formatted via `formatNavTableDateCell` using `config.preferences.uiDateFormat`. Stored values remain canonical YYYY-MM-DD; only the displayed string is formatted. Malformed user-supplied format strings throw inside date-fns — the helper catches and falls back to the raw stored value (visible-garbage policy, no validation rule). Form date pickers (`addDateRow`) are unaffected: HTML5 `<input type="date">` displays in the user's browser locale and is not project-controllable.

### Config panel

Form-only top-level tab — no nav table, no toolbar, no selection. Seven sub-tabs in parser order: Layout / Bars / Timeline / Titles / Style / Typography / Preferences. `renderConfigPanel(panel)` is the entry point; mirrors `renderDataPanel`'s persistent-skeleton pattern. `activeConfigBlock` tracks the active sub-tab; `configBlockRenderedFor` gates form rebuilds the same way `formRenderedForId` does for entity forms. Both vars reset alongside data-panel state in `resetDataPanelState` (function name is a soft misnomer kept for low-churn consistency).

`config.rendering` is deliberately excluded from the Config UI and from `writer.js`; the Inspector still surfaces it via an explicit static `appendSection('config.rendering', 'not in Excel', …)` call (not the dynamic walk).

Timeline date fields commit two dispatches: the date value AND the paired `*Explicit` flag (`true` on non-empty, `false` on empty) so the writer round-trip-correctly emits user-set vs auto-derive dates. The explicit flags themselves are not user-editable and not rendered as form rows. The file-load handler re-renders Config if active (parallel to Issues); New Project does not need this because it activates the Data tab before its seed dispatches fire.

### Form helper conventions

`addNumberRow(form, field, value, commitFn, opts)` accepts `opts = { step, min, max }`; defaults to integer-stepping (`step=1`, no bounds). Parsing is the caller's responsibility (`parseInt` vs `parseFloat` inside `commitFn`). Float call sites pass `step: '0.1'` and bounds where applicable.

Enum `<select>` options use the canonical lowercase values the parser stores (`auto/hv/vh`, `solid/dashed/dotted`, etc.) — not Excel-facing display casing.

`addCheckboxRow(form, field, value, commitFn)` is a `<input type="checkbox">` wrapped in `.checkbox-wrapper`. Auto-commits on the native `'change'` event (not blur — toggling is atomic, no Escape-to-revert). **Commit-argument asymmetry:** unlike the other helpers which pass the raw input string to `commitFn`, this helper passes the parsed boolean directly. Used exclusively by the Config tab.

`addColorRow(form, field, value, commitFn, opts)` renders a text input (source of truth — `commitFn` receives the raw string) + native `<input type="color">` swatch inside `.color-row-wrapper`. `opts.allowEmpty` (default `false`): when `true`, a `.color-clear-btn` ✕ button is appended after the swatch (always rendered, not gated on current value); clicking it clears the text, snaps the swatch to `#000000`, and commits empty — so a freshly-cleared field looks identical to a never-set field. Swatch auto-commits on `'change'` (no Escape-to-cancel — re-pick to reverse). Text→`#rrggbb` sync via `parseTextToHex6`: hex passthrough fast-paths; everything else defers to the browser via a transient `display:none` probe element, so any CSS Color Level 4 input (named, `rgb()`, `rgba()`, `hsl()`, `hsla()`, 8-digit hex) renders correctly. Alpha is stripped for the swatch (native control cannot represent it) but preserved verbatim in the stored text value. The helper is NOT pure — UI-only, never call from the renderer or validator. On parse failure the swatch keeps its previous value (on commit) or falls back to `#000000` (on first render). Swatch and ✕-button commits update `preEditValue` via `attachCommitHandlers`' returned handle so a subsequent Escape doesn't desync.

Config-tab number commits use the local `commitInt` / `commitFloat` factory helpers — empty → null, non-finite → no-op.

### Issues tab

Read-only, user-facing surface for `projectData._validation` — renders on tab activation, never re-validates. Four panel states (undefined / clean / no-match / table), controls (search, three severity checkboxes, grouping toggle), six-column table, severity-then-entity grouping, three-state sort header cycle.

- Sort is stable, tie-broken to parser-emission order — implemented by always sorting from a canonical emission-ordered list (`flattenIssues`), never from the current view. ID and value place nulls/placeholders last regardless of direction.
- Filter/sort/group state lives in module-scope `issuesFilterState`, persists across tab switches, resets on every file load. No `localStorage`. Search input keeps focus while typing because only `#issuesBody` re-renders on filter changes — the controls DOM is built once per `renderIssuesPanel` call.
- Tab label: plain `Issues` when no issues, else `Issues (E/W/N)` with a single severity tint chosen by the highest non-zero bucket. Active-tab styling overrides the tint via CSS specificity.

Validation is non-gating: Save xlsx and Save SVG remain enabled regardless of `_validation` content. The Inspector also surfaces `_validation` raw via its dynamic walk; duplication with Issues (user-facing) is intentional.

### Inspector helpers

`renderEntityTable(container, data, derivedKeys = [])` — the optional third argument lists keys whose column headers should be suffixed with ` (derived)`. Currently `['isMilestone']` for tasks and `['order']` for swimlanes; extend this list when new derived fields are added. `renderConfigTable(container, config)` renders a two-column key/value table. Both serve the Inspector tab only.

**Inspector dynamic walk:** `renderInspector` skips the seven fixed top-level keys and renders remaining keys (e.g. `_parseNotices`, `_validation`) as "diagnostic" sections. Plain object whose every value is an array → one sub-section per sub-key via `renderEntityTable` (how `_validation`'s `{errors, warnings, notices}` buckets render); array → entity table; plain object → key-value table; primitive → single-cell table; else `JSON.stringify` fallback.

### Toolbar buttons

Left to right: **New Project** → file input → **Save** (xlsx) → **Save SVG**. New Project replaces `projectData` with `createEmptyProjectData()`, clears `loadedFilename`, resets data-panel and issues-filter state, activates the Data tab, then dispatches two swimlane mutations to seed a default `"Swimlane 1"`. Both Save buttons share the same disabled gate (`tasks.length === 0 && swimlanes.length === 0`), toggled by `refreshStatusAndButtons`. Save SVG calls `renderChart(projectData)` directly regardless of active tab. Filename rules differ: Save xlsx uses `loadedFilename` verbatim (default `"compactgantt_project.xlsx"`); Save SVG strips the last extension off `loadedFilename` and appends `.svg` (default `"compactgantt_chart.svg"`).

`initUI()` finishes with a `renderDataPanel()` call so the empty entity tab strip and empty Tasks panel are present on page load.

## Excel export (writer.js)

`writeWorkbook(projectData)` returns a `Uint8Array` (SheetJS `type: 'array'`).

**Named-column policy:** columns are identified by header name, not index. Column order within each sheet is presentation-only.

**Sheet order:** matches the `addSheet` call sequence in `writer.js`. `config.rendering` is deliberately excluded.

**Entity sheets:** header row + one data row per entity; always emitted even if the array is empty. Derived fields (`task.isMilestone`, `swimlane.order`) are not written. `task.dateFormat` and null date fields write as empty cells.

**Date cells:** YYYY-MM-DD strings converted timezone-safely via `split('-')` → `new Date(y, m-1, d)`. Null → empty cell. Timeline dates obey `chartStartDateExplicit` / `chartEndDateExplicit` — only written when explicit; otherwise left empty so auto-derivation continues to work after a save/reload cycle.

**Boolean cells:** `"Yes"` / `"No"` strings — matches `kvBool`'s parsing.

**Config sheets:** two-column layout with `["Field", "Value"]` header row in row 1. `parseConfigSheet` picks up the header as a harmless extra map entry that no `kv*` call looks up — round-trip is safe.
