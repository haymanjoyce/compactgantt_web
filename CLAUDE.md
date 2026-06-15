# compactgantt_web

## Project overview

A compact Gantt chart web application in vanilla JavaScript, HTML, and CSS. No build step, bundler, framework, Node.js, or Python — open files directly in a browser or serve with any static file server.

## Repository layout

Source files (HTML, CSS, JS) live at the repo root; `index.html` is the sole entry point (open directly in a browser, no server). `/temp/` is scratch, ignored by git (`.gitignore` also covers macOS/Windows artefacts and `.vscode/`).

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

Exports: `toISODate`, `toJsDate`, `daysBetween`, `formatDate`, `isoWeekLabel`, `weekdayName(iso, length)` (`'full'`/`'short'`/`'letter'`). Non-obvious invariants:

- `toISODate` is timezone-safe (`getFullYear/getMonth/getDate`, never `toISOString`) and filters Invalid `Date` (`isNaN(getTime())`) — guards against SheetJS surfacing Invalid Date on round-tripped empty cells. Non-slash strings pass through; shape validation happens at `parseDate`/`kvDate` in `parser.js`.
- `toJsDate` uses `new Date(y, m-1, d)`; `daysBetween` uses `Date.UTC` arithmetic.
- `formatDate`/`isoWeekLabel`/`weekdayName` require the `dateFns` global; ISO week = Monday first.
- `validation.js` does string-only YYYY-MM-DD comparison and does not import `dates.js`.

## Top-level state and `projectData`

`ui.js` owns the live `projectData` reference, initialised by `createEmptyProjectData()` — never `null`. "No file loaded" = `projectData.tasks.length === 0`. File-load and New Project replace `projectData` wholesale; all other writes route through `dispatch()`.

`createEmptyProjectData()` is the single source of truth for the `projectData` shape and all default config values — a pure function returning a fresh object. `parseWorkbook` calls it, then overwrites entity arrays and config sections from the workbook. `renderer.js` / `writer.js` take `projectData` as a parameter with no dependency on the global.

## Mutation dispatcher (ui.js)

`dispatch({ entity, action, id, block, field, value, index })` is the single-writer entry point for all in-app mutations — centralising it is what makes the post-mutation hook unbypassable.

`entity` ∈ `task` / `swimlane` / `link` / `pipe` / `curtain` / `note` / `config`. `action` ∈ `update` / `add` / `delete` / `duplicate` / `moveUp` / `moveDown` (config: `update` only). Unknown entity/action, missing field, or id miss → `console.warn` + no-op (never throws). `add` uses `parser.js` factories and assigns `id = max(existing) + 1` (or `1`); `duplicate` shallow-spreads with a fresh id the same way.

**Deletion blocking** (silent no-op, no hook): a task delete is blocked if any link references it. No other delete is blocked — deleting the last task in a swimlane, or a swimlane that still has tasks, is allowed (orphans stay in `projectData`; validation flags them, renderer skips them).

**Derived-field maintenance.** `task.isMilestone` recomputed on task `update`; `swimlane.order` recomputed (1-based index) after any swimlane array mutation.

**Post-mutation hook** (in order): `validateProject` → `activateTab(activeTab)` → `updateIssuesTabLabel`. Active tab tracked in module-scope `activeTab`. `update` runs the hook unconditionally even if `value` is unchanged (string-numeric mismatches make a robust equality check not worth it).

## Excel file format

`XLSX.read` uses `{ cellDates: true }` so date-formatted cells arrive as JS `Date` objects.

**Entity sheets** (tabular, row 1 = headers): Tasks, Swimlanes, Links, Pipes, Curtains, Notes. Parsed via `parseEntitySheet(worksheet, colDefs)` — header-based, never positional. Missing columns silently take their declared default (backward-compat). Old-name fallbacks live in `colDefs.fallback`; `parser.js` is authoritative.

**Config sheets** (key-value: col A = field, col B = value): Layout, Bars, Timeline, Titles, Style, Typography, Preferences. Parsed via `parseConfigSheet(worksheet)` → map, read with `kvStr/kvInt/kvFloat/kvBool/kvDate` (each takes an optional `fallback` key, try-new-first).

Schema asymmetry: Timeline has five `show*` fields (years/months/weeks/days/dates) but only four `gridline*` — days and dates share calendar-day granularity, so one `gridlineDays` covers both.

## Derived fields

- `task.isMilestone = startDate !== null && startDate === finishDate` (null-guard avoids a false positive when both dates are absent).
- `swimlane.order` = 1-based array index (not stored in Excel).
- `config.timeline.chartStartDate/chartEndDate` derived from `min(task.startDate)` / `max(task.finishDate)` when absent/unparseable in the Timeline sheet. `chartStartDateExplicit` / `chartEndDateExplicit` record whether the user wrote a non-empty value (`true`, via `isNoticeableInput`) or left it blank (`false`) — drives the writer's emit-or-leave-empty choice. Deliberate asymmetry: a garbage cell (`"not a date"`) is `explicit=true` with a task-derived `chartStartDate`, so save round-trips it to a now-valid derived date.

## Parse notices (`_parseNotices`)

`projectData._parseNotices` is an array side-channel populated by `parseWorkbook` (seeded `[]` by `createEmptyProjectData()`). Each notice records a non-empty source cell the parser could not interpret and silently defaulted:

```
{ entity, id, field, rawValue, reason }
```

- `entity` — singular lowercase (`task`/`swimlane`/`link`/`pipe`/`curtain`/`note`/`config`).
- `id` — entity row id (`null` for config rows). Rows with a blank/unparseable id cell carry the **newly-assigned** id, not null, so the user can locate them.
- `field` — JS property name (e.g. `'startDate'`), never the Excel header. `rawValue` — original cell value, unmodified.
- `reason` — closed five-value enum, all parser-emitted. `validation.js` reads them via `consumeNotice`; it never emits notices.

Reason values:

| Reason | When emitted |
|---|---|
| `'unparseable_date'` | non-empty value that didn't yield a valid YYYY-MM-DD. `parseDate`/`kvDate` validate `toISODate`'s result against `/^\d{4}-\d{2}-\d{2}$/` (so raw `"garbage"` is rejected here, not at `toISODate`). |
| `'unparseable_number'` | non-empty value `parseInt`/`parseFloat` returned `NaN` for; from `toInt`/`toFloat`/`kvInt`/`kvFloat`. |
| `'unrecognised_boolean'` | non-empty boolean-field string that, trimmed+lowercased, is neither `'yes'` nor `'no'`; from `kvBool`. Native booleans pass silently. |
| `'unrecognised_enum'` | non-empty value a `normalize*` function didn't recognise. |
| `'id_assigned'` | id cell blank/missing/unparseable; parser assigned `max(existing) + 1`. Suppresses the upstream `unparseable_number` for id cells (one notice per row). Fires on empty id cells too — exception to "empty produces no notice". |

**Empty vs unparseable distinction** (the whole point of the side-channel). Empty cells, whitespace-only strings, and Invalid `Date` objects (`isNaN(getTime())`, as SheetJS produces for round-tripped empty date cells) NEVER produce a notice — they default silently. Notices fire only when the user wrote something meaningful that the parser ignored. **Exception:** `'id_assigned'` also fires on blank/missing id cells.

**Notice order:** parser-traversal — entity sheets (tasks, swimlanes, links, pipes, curtains, notes) then config sheets (layout, bars, timeline, titles, style, typography, preferences); top-to-bottom, left-to-right within a row.

**Not emitted from:** `createEmptyProjectData()`, column-name fallbacks, config key-name fallbacks (British `Colour`, etc.).

**Enum recognition lives in the parser** — twelve `normalize*` functions, all supplying a canonical default before the value leaves `parseWorkbook`, so the renderer's enum fallbacks are unreachable in normal flow and `validation.js` re-encodes no membership lists (reads only via `consumeNotice`).

## Validation (`validation.js`)

`validateProject(projectData)` returns `{ errors: [Issue], warnings: [Issue], notices: [Issue] }` — all three keys always present. Pure: no DOM, no side effects, never mutates `projectData`, never throws.

Each `Issue` is `{ entity, id, field, message, value }`. `entity` singular lowercase (same enum as `_parseNotices`); `id` is the row id, `null` for config issues only (entity rows always have a non-null id — parser auto-assigns). `value` is `null` for "missing field" rules, `rawValue` for parse-derived rules, the current field value otherwise.

**Structure.** A thin `validateProject` coordinator calls 14 per-block validators (six entity + eight config, incl. `validateRendering`) in parse traversal order, concatenating results.

**`_parseNotices` consumption.** Entity validators filter notices by entity tag, config validators by an explicit field-ownership Set; matching notices emit Issues into the bucket dictated by the locked rule list (same `reason` → different buckets per field). Array stays in place on `projectData`.

**"Missing X" guard** fires only when the field is `null` AND no `_parseNotices` entry exists for `(entity, id, field)` with reason `unparseable_number`/`unparseable_date` (prevents double-emission). **Foreign-key validity Sets** filter `null` ids out, so a missing id doesn't silently satisfy a reference.

**CSS color recognition.** Inline allowlist (148 CSS Color Level 4 names + `transparent` + `currentcolor`) plus hex/rgb/rgba/hsl/hsla shape regexes. `isValidCssColor("")` is `false`; per-field rules decide whether empty is legal (Notes border/fill) or an error (all 16 Style colors).

**Link classification (R1/R2).** Both rules run inside an outer gate of `pred.finishDate > succ.startDate`, so the block only classifies links the renderer treats as non-forward — mirroring its else-branch (neither module imports the other). Inside: R1 (`pred.finishDate >= succ.finishDate`) flags pred at/past succ's finish; R2 flags late-recoverable (`pred.finishDate < succ.finishDate`) on the same row. The gate exists because without it R1 misfired on canonical zero-lag F-S links to milestone successors — `succ.finishDate === succ.startDate` collapses R1 to `pred.finishDate >= succ.startDate`, tripping valid shared-date F-S dependencies. The renderer's `origX >= termX` geometric skip has NO validation counterpart: zero-travel forward links are dropped at render but are valid zero-lag F-S dependencies (`pred.finishDate === succ.startDate`), so not flagged. Self-links (`fromTaskId === toTaskId`) skip R1/R2 entirely — the dedicated Self-link error is their sole issue.

**Call site.** `projectData._validation` is written by the file-load handler (immediately after `parseWorkbook`) and `runPostMutationHook`. New Project relies on the latter via its seeding dispatches. The renderer never consults `_validation` — validation is non-gating.

## Renderer (renderer.js)

`renderChart(projectData)` returns a raw SVG string. Key design rules:

- **Coordinate areas:** `innerX1/innerX2` from left/right padding; `taskRowY1/taskRowY2` bracket the task rows below the scale bands and above the footer (formulas in source).
- **Scale band height:** per visible scale, `max(rendering.minScaleBandHeight, scaleFontSize * rendering.scaleFontToBandHeightFactor)`; total = count × bandHeight.
- **Five scale bands** (top-to-bottom): years, months, weeks (ISO `"W03"`), dates (numeric day-of-month), days (named: Monday/Mon/M). Hidden bands occupy no space. Months band reads single-letter labels from `rendering.monthLetters`. Named-day cells degrade width-adaptively through full→short→letter→empty via `fontSize * rendering.charWidthFactor`; the `rendering.scaleMinLabelWidth` (default 20 px) gate applies to years/months/weeks/dates only, NOT the days band.
- **Render order (painter's algorithm, 15 slots):** the SVG layer accumulators in `renderer.js`; header/footer paint last so they frame the chart regardless of layout. Slot numbers referenced elsewhere ("slot 7", "slot 14") are those accumulators in source order.
- **Color handling:** colors pass directly from `projectData` to SVG `fill`/`stroke` with no renderer-side validation — invalid names render as SVG default (black). Validation lives in `validation.js`.
- **Swimlane backgrounds:** `<rect>` fill = `swimlane.backgroundColor`, no renderer fallback (parser supplies default `"white"`).
- **Swimlane labels:** always `font-weight="bold"` — fixed choice, not configurable (no config/parser/writer/validation entry).
- **Header/footer text alignment:** per-band via `titles.headerTextAlign` / `footerTextAlign`; horizontal inset uses `rendering.headerFooterTextPadding` for `left`/`right` only (centred uses band centre). Each band emits an inside-edge `<line>` border (`style.headerFooterBorderColor`), suppressed when band height is 0.
- **Milestones:** centred on `startDate`, size = `bars.milestoneSizeFactor * rowHeight`. `bars.milestoneShape`: `circle` (`<circle>` circumscribing the diamond anchors, `milestoneCornerRadius` ignored) or `diamond` (default; `<path>`, rounded corners via `bars.milestoneCornerRadius` 0..1 — no parser clamping, validation flags out-of-range).
- **Bars:** `<rect rx="${bars.taskCornerRadius}">`.
- **Task bar pattern fills:** `task.fillPattern` drives `<pattern>` defs. `"solid"`/unrecognised → `fill="${fillColor}"`; the five named patterns (`hatch`, `cross-hatch`, `horizontal`, `vertical`, `dots`) → `fill="url(#id)"` against a deduplicated `<pattern>` keyed by sanitised `(fillPattern, fillColor, patternColor)`. `patternUnits="userSpaceOnUse"` with no `x`/`y` — tiles anchor at SVG origin so same-row bars share a continuous-field phase. Milestones always solid.
- **Skip rules:** orphaned tasks, `finishDate < startDate`, and fully-out-of-range tasks silently skipped; `row` clamped to 1 whenever not a positive integer in `[1, swimlane.rowCount]` (null, non-numeric, zero, negative, out-of-range). Null `task.row` reaches the renderer when the user cleared the cell — parser preserves null end-to-end.
- **Milestone labels:** the milestone branch always renders labels outside, ignoring `task.labelPlacement` (but the parser doesn't override the stored value — milestones keep whatever placement the user set).
- **Task labels (slot 12):** built from `task.labelContent` with date-fns formatting; per-task `task.dateFormat` overrides `config.preferences.chartDateFormat`. Inside/outside fill = `style.insideLabelTextColor` / `outsideLabelTextColor`.
  - *Inside labels* (bars only): truncated via `fontSize * rendering.charWidthFactor`, preferring word-boundary break then char truncation; emits nothing if `…` alone overflows. AvailW = `barWidth - 2 * rendering.insideLabelPadding`.
  - *Outside labels*: no truncation; placed past the right edge (`xFor(finishDate)` for bars, `xFor(startDate) + milestoneHalf` for milestones) plus `outsideLabelKissingGap + task.labelOffset`.
  - *Leader lines*: horizontal `<line>` at row-centre y spanning exactly `labelOffset` px from the right edge. Drawn when `labelOffset > 0`; bars also require `labelPlacement === 'outside'`. Stroke `style.leaderLineColor`. No clip — may overflow into right padding.

## config.rendering

All rendering tunables (stroke widths, paddings, factors, gaps, corner radii, `monthLetters`, `charWidthFactor`, …) live in `config.rendering` in `createEmptyProjectData()`. **Hard-coded defaults, not Excel-driven** — `parseWorkbook` never touches this object, the writer excludes it; source is authoritative. Most names follow `<element><attribute>` (`linkCornerRadius`, `pipeStrokeWidth`); a few are non-element-bound (`charWidthFactor`, `monthLetters`).

## Link rendering

Finish-to-Start dependency arrows.

**Renderable-task lookup (`taskGeom` Map):** built during the bar/milestone render pass, keyed by `task.id` (geometry + dates + `isMilestone`). Any task skipped by the bar pass is absent, so orphaned-link detection is implicit — no duplicate skip logic.

**Connection points:** bar origin = `xFor(finishDate)`, termination = `xFor(startDate)`, both at row centre; milestone origin and termination both = `xFor(startDate)` (centre), so link geometry is independent of milestone shape.

**Link classification (render-time, not stored):**
- *Forward*: `pred.finishDate <= succ.startDate` with non-zero horizontal travel — H/V/V-H/AUTO V-H-V routing per `link.routing`.
- *Vertical forward*: zero-lag forward (`pred.finishDate === succ.startDate`, surfaces as `origX >= termX`) on different absolute rows — pure vertical line at `x = origX = termX`, routing ignored. Termination y differs by successor type (see milestone note).
- *Late-recoverable*: `pred.finishDate > succ.startDate AND pred.finishDate < succ.finishDate AND different rows` — vertical-only, termination x = origin x, termination y = top edge of succ if below pred else bottom edge.
- *Invalid* (skip silently): `pred.finishDate >= succ.finishDate`; same-row late; same-row zero-lag forward.
- Milestone successors can't be late-recoverable (`startDate === finishDate` makes the late condition impossible) but routinely appear as vertical-forward successors — the canonical "bar finishes day X, milestone marks completion day X on a different row" case.

**Routing (forward only):** `HV`, `VH`, `AUTO`+same-row (direct horizontal), `AUTO`+different-rows (V-H-V, midY = mean of endpoints).

**Rounded corners at bends (HV, VH, AUTO V-H-V only):** quarter-circle arc, radius `min(linkCornerRadius, segA/2, segB/2)`. Per-bend sweep flag by turn direction — gotcha: `(right→down)=1`, `(right→up)=0`, `(down→right)=0`, `(up→right)=1`; AUTO V-H-V's two bends always carry opposite flags.

**Z-order split:** `renderedLinks` is pre-computed, then iterated twice — `<path>` bodies (slot 8) and origin-marker `<circle>` + arrowhead `<polygon>` (slot 11) — keeping bars/milestones between the two link layers without duplicating classification.

**Arrowheads:** per-link `<polygon>` triangles sized by `arrowheadSizeFactor * rowH`, not `<marker>` defs — avoids browser `context-fill`/`context-stroke` inconsistency.

**Milestone predecessor/successor special cases:**
- *Origin marker suppressed* when `pred.isMilestone` (path still starts at centre, no filled circle over the shape).
- *Arrowhead backed off* when `succ.isMilestone` — tip at `milestoneHalf + rendering.linkArrowheadMilestoneGap` from centre. Calibrated for `termY === succ.rowCenterY`; vertical-forward → milestone deliberately uses `rowCenterY` (vs. `barTopY`/`barBottomY` for bar successors) so the calibration holds for both branches. Late-recoverable links can't have milestone successors.

## Pipes / Curtains / Notes rendering

**Pipes** (slot 7): vertical reference line at a date with optional badge. Skipped if `date` null or off-chart. Dasharray from `pipe.lineStyle` (solid/dashed/dotted). Badge only when `name` non-empty; `labelPosition` (float, default `1`) pins top (`1`) / bottom (`0`); may overflow past `innerX2`.

**Curtains** (slots 3 and 7): tinted band + optional boundary lines + name badge. Skipped if `startDate`/`endDate` null, `endDate <= startDate`, or fully off-chart. Slot 3 `<rect>` clamped to `[innerX1, innerX2]`; boundary lines emit only when in-range; badge anchors at `xFor(startDate)` (or `xFor(endDate)` when `labelAnchor === 'end'`) and extends right (overflow allowed).

**Notes** (slot 14, above swimlane labels, below header/footer): free-positioned text annotations.

- **Coordinate model.** Dimensions are percentages of the task row area, mapped into the inner chart rect (formulas in source); partial overflow renders as-positioned (no clip).
- **Skip rules (silent):** `text === ""`, `widthPct <= 0`, `heightPct <= 0`, or fully off-chart.
- **Add-flow defaults diverge from parser blank-cell defaults.** `createEmptyNote()` returns `widthPct: 20`, `heightPct: 10`, `borderColor: 'black'`, `fillColor: 'white'`, `text: 'Note'` so a freshly Added note dodges all four skip conditions; parser Notes defs stay at `0` / `''` so blank Excel cells round-trip blank. Two user contracts (Excel-blank = "left empty"; Add = "usable starting state") — do not align them.
- **Optional box:** `<rect>` emitted only when `fillColor` OR `borderColor` is non-empty (empty = "skip the rect" signal, not an error); when only one is set, the empty side falls back to SVG `"none"`.
- **Text wrapping.** AvailW = `noteW - 2 * rendering.notePadding`; ≤ 0 → text skipped (rect still emits). Split on `\n`, wrap each segment via `fontSize * rendering.charWidthFactor`. Empty wrapped lines emit `&#160;` (NBSP) so the `<tspan>` reserves glyph height — an empty `<tspan>` collapses the blank line. Unbreakable tokens char-truncate with `…`.
- **Alignment.** `verticalAlign` positions the text block; `textAlign` sets each `<tspan>`'s `x` and `text-anchor`. Read directly with no `||` fallback — parser is the sole source of defaults.
- **Clip path.** Each text-emitting note gets a per-note `<clipPath id="note-clip-${id}">` in `<defs>`; overflow text is silently hidden.

**`<defs>` block (combined).** Pattern-fill defs and note clip paths share one `<defs>` between the `<svg>` tag and slot 1; pattern content is collected first but assembled after the notes pass. Omitted entirely when neither is needed.

## Current UI

Five-tab layout (left to right): **Data → Chart → Issues → Config → Inspector**.

**Data** tab hosts entity-entry panels behind a second-tier strip (Tasks / Swimlanes / Links / Pipes / Curtains / Notes), all live. `renderDataPanel()` is the single entry point — on tab activation, file load, New Project, and every `dispatch()` via the post-mutation hook. The two-pane skeleton (`.entity-left` + `.entity-right`) rebuilds on second-tier switch only; the form container survives mutations so commit-on-blur preserves focus.

**Chart** tab calls `renderChart(projectData)` on every activation into a horizontally-scrollable container ("No project loaded" if no tasks).

**Inspector** tab renders every `projectData` field as flat read-only tables on every activation — exhaustive, developer-facing, reflects defaults even before a file is loaded. **Issues** tab: see its section below.

### Data panel — entity panels

**Tasks panel.** Toolbar (Add / Delete / Duplicate / Move Up / Move Down) + nav table (left) + edit form (right). Columns: `id`, `row`, `symbol`, `name`, `days`, `startDate`, `finishDate` (`row` shows read-only here and is editable on the form; `swimlaneId` is form-only). `buildTasksDisplayOrder()` sorts `(swimlane.order, task.row, finishDate, startDate, array index)` ascending — orphans, null `row`, null/empty dates sort last via Infinity / `'￿'` sentinels. Display-only: `projectData.tasks` order is never mutated, so writer round-trip preserves Excel ordering. **Swimlane grouping:** sorted tasks bucket by `swimlaneId` under group-header rows; defined swimlanes render in order with headers shown **even when empty**, synthetic `Unassigned` (null id) / `Misassigned` (non-empty id, no match) headers only when populated; zero tasks shows the `entity-empty` message instead. Group-header rows carry no `data-id`, so the selection handler skips them. **Symbol cell:** CSS marker, diamond (milestone) or bar; fill = `task.fillColor` (`fillPattern` ignored, solid only), cell background = matched swimlane's `backgroundColor`. **Bar width is duration-proportional:** `computeBarWidth(t, maxDays)` scales min..max against `maxDays` (largest positive `taskDays` span among non-milestone tasks, pre-pass); a unified `minWidth` guard covers null/non-finite span, span ≤ 0, and `maxDays ≤ 0`. `SYMBOL_COL_WIDTH_PX (64)` in `ui.js` must stay in sync with the `.task-symbol-col` CSS width in `index.html`. `taskDays(t)` is the shared span helper for both the bar and the days cell (empty on missing/non-finite, negatives literal, milestones `0`). **Move Up / Down** dispatch `update` on `task.row` (NOT the dispatcher's array-reorder `moveUp`/`moveDown`); enablement guards `typeof task.row === 'number'` with `row > 1` / `row < swimlane.rowCount`, plus a "Task has no swimlane" tooltip for orphans. Form rebuild gated on `formRenderedForId` to preserve focus; `syncTaskRowInput` targeted-updates the row input after a same-id move since the form doesn't rebuild.

**Swimlanes panel.** Same shape as Tasks with: (a) display order = array order, no sort; (b) Move Up/Down dispatch the dispatcher's real array-reorder actions; (c) `syncSwimlaneOrderCell` parallels `syncTaskRowInput`, refreshing the form's read-only `order` cell after a same-id move (derived from array index, form doesn't rebuild). Declared exception to form-rebuild-only-on-selection-change, justified by the explicit button. `addReadonlyRow` sets `data-field` to support the targeted update. Nav-table columns: `id`, `order` (derived), `color`, `name`, `rowCount` — built via per-column emission (not the old generic loop, which couldn't carry per-column markup). **Color cell:** text-free, fills with raw `swimlane.backgroundColor` as cell background (escaped, emitted unconditionally — the field is always present, unlike the Tasks symbol cell's `sw`-existence guard), no validation/normalisation; empty/invalid/null → CSS no-op showing normal background. Mirrors the Tasks symbol cell minus the marker; selected-row highlight overridden on this cell, by design. `order`/`rowCount` right-aligned via dedicated `.swimlane-order-col` / `.swimlane-rowcount-col` classes (`id` via the shared first-child rule). `.swimlane-order-col` uses `width: 1px` so it shrinks to min-content, forcing the long `order (derived)` header to wrap at the space; reclaimed width flows to `name`.

**Links / Pipes / Curtains / Notes panels.** Share `renderSimpleEntityToolbar(...)` and `attachNavTableRowHandlers(...)` — factored because the four behave identically (no Add prerequisite, no delete-block, dispatcher array `moveUp`/`moveDown`, no derived-field sync). Tasks/Swimlanes keep dedicated toolbars and inline handlers — deliberate asymmetry.

**Links FK posture.** `fromTaskId` / `toTaskId` dropdowns via `buildTaskRefOptions(currentValue)`; an orphan id (non-null, no matching task) prepends a `{id} — (missing)` option. Nav-table FK cells use `formatTaskRefCell` with the same null-vs-orphan distinction. Scoped to Links FKs only — the Tasks `swimlaneId` dropdown does *not* do this yet.

**Notes textarea.** `addTextareaRow` relies on `attachCommitHandlers`' Enter-to-blur gate being `tagName === 'INPUT' && type !== 'date'`, so Enter inserts newlines in textareas (and is a no-op in date inputs, where the native picker owns Enter). Multi-line text round-trips unchanged. Nav-table preview collapses whitespace via `notePreviewText` before 40-char truncation; full text in the cell `title`.

**Nav-table date display.** Tasks (`startDate`/`finishDate`), Pipes (`date`), Curtains (`startDate`/`endDate`) date cells format via `formatNavTableDateCell` using `config.preferences.uiDateFormat`; stored values stay canonical YYYY-MM-DD. Malformed format strings throw in date-fns — the helper catches and falls back to the raw value (visible-garbage policy, no validation rule). Form date pickers (`addDateRow`) are unaffected: HTML5 `<input type="date">` uses browser locale, not project-controllable.

### Config panel

Form-only tab — no nav table/toolbar/selection. Seven sub-tabs in parser order: Layout / Bars / Timeline / Titles / Style / Typography / Preferences. `renderConfigPanel(panel)` mirrors `renderDataPanel`'s persistent-skeleton pattern; `activeConfigBlock` tracks the sub-tab and `configBlockRenderedFor` gates rebuilds (as `formRenderedForId` does for entity forms). Both reset in `resetDataPanelState` (name is a soft misnomer kept for low-churn consistency).

`config.rendering` is excluded from the Config UI and `writer.js`; the Inspector surfaces it via a static `appendSection('config.rendering', 'not in Excel', …)`, not the dynamic walk.

Timeline date fields commit two dispatches — the date AND the paired `*Explicit` flag (`true`/`false` on non-empty/empty) — so the writer emits user-set vs auto-derive dates correctly. The flags are not user-editable / not form rows. File-load re-renders Config if active (parallel to Issues); New Project doesn't need this since it activates Data before seeding.

### Form helper conventions

`addNumberRow(form, field, value, commitFn, opts)` accepts `opts = { step, min, max }`, defaulting to integer-stepping (`step=1`, no bounds); parsing is the caller's job (`parseInt`/`parseFloat` in `commitFn`), float call sites pass `step: '0.1'`.

Enum `<select>` options use the canonical lowercase values the parser stores (`auto/hv/vh`, `solid/dashed/dotted`), not Excel display casing.

`addCheckboxRow(form, field, value, commitFn)` is a `.checkbox-wrapper` checkbox; auto-commits on `'change'` (toggling is atomic, no Escape-to-revert). **Commit-argument asymmetry:** unlike the other helpers (raw string), this passes the parsed boolean directly. Config tab only.

`addColorRow(form, field, value, commitFn, opts)` renders a text input (source of truth) + native `<input type="color">` swatch in `.color-row-wrapper`. `opts.allowEmpty` (default `false`) appends a `.color-clear-btn` ✕ that clears text, snaps the swatch to `#000000`, and commits empty (a cleared field looks identical to a never-set one). Text→`#rrggbb` sync via `parseTextToHex6`: hex fast-paths, everything else defers to the browser via a transient `display:none` probe element (so any CSS Color Level 4 input renders); alpha is stripped from the swatch but preserved verbatim in the stored text. Swatch/✕ auto-commit on `'change'` (no Escape-to-cancel) and update `preEditValue` via `attachCommitHandlers`' handle so a later Escape doesn't desync. UI-only — never call from renderer/validator.

Config-tab number commits use the local `commitInt` / `commitFloat` factory helpers — empty → null, non-finite → no-op.

### Issues tab

Read-only surface for `projectData._validation` — renders on tab activation, never re-validates. Four panel states (undefined / clean / no-match / table); controls (search, three severity checkboxes, grouping toggle); six-column table; severity-then-entity grouping; three-state sort header cycle.

- Sort is stable, tie-broken to parser-emission order — always sorts from a canonical emission-ordered list (`flattenIssues`), never the current view. ID and value place nulls/placeholders last regardless of direction.
- Filter/sort/group state lives in module-scope `issuesFilterState`; persists across tab switches, resets on file load (no `localStorage`). Search keeps focus because only `#issuesBody` re-renders on filter changes — controls DOM is built once per `renderIssuesPanel`.
- Tab label: plain `Issues`, else `Issues (E/W/N)` tinted by the highest non-zero bucket; active-tab styling overrides the tint via CSS specificity.

Non-gating: Save xlsx/SVG stay enabled regardless of `_validation`. The Inspector also surfaces `_validation` raw via its dynamic walk; the duplication is intentional.

### Inspector helpers

`renderEntityTable(container, data, derivedKeys = [])` — the third arg lists keys whose headers get a ` (derived)` suffix (`['isMilestone']` tasks, `['order']` swimlanes; extend when new derived fields appear). `renderConfigTable(container, config)` renders a two-column key/value table. Inspector only.

**Inspector dynamic walk:** `renderInspector` skips the seven fixed top-level keys and renders the rest (`_parseNotices`, `_validation`) as diagnostic sections — plain object of all-arrays → sub-section per key via `renderEntityTable` (how `_validation`'s buckets render); array → entity table; plain object → key-value table; primitive → single-cell; else `JSON.stringify`.

### Toolbar buttons

Left to right: **New Project** → file input → **Save** (xlsx) → **Save SVG**. New Project replaces `projectData` with `createEmptyProjectData()`, clears `loadedFilename`, resets data-panel + issues-filter state, activates Data, then dispatches two swimlane mutations to seed `"Swimlane 1"`. Both Save buttons share the disabled gate (`tasks.length === 0 && swimlanes.length === 0`) via `refreshStatusAndButtons`. Save SVG calls `renderChart` directly regardless of active tab. Filenames: xlsx uses `loadedFilename` verbatim (default `"compactgantt_project.xlsx"`); SVG strips the last extension and appends `.svg` (default `"compactgantt_chart.svg"`).

`initUI()` ends with a `renderDataPanel()` so the empty tab strip and Tasks panel exist on page load.

## Excel export (writer.js)

`writeWorkbook(projectData)` returns a `Uint8Array` (SheetJS `type: 'array'`).

**Named-column policy:** columns identified by header name, not index; column order is presentation-only. **Sheet order** matches the `addSheet` sequence; `config.rendering` deliberately excluded.

**Entity sheets:** header row + one data row per entity, always emitted even when the array is empty. Derived fields (`task.isMilestone`, `swimlane.order`) not written; `task.dateFormat` and null dates write as empty cells.

**Date cells:** YYYY-MM-DD → `new Date(y, m-1, d)` (timezone-safe via `split('-')`); null → empty. Timeline dates obey `chartStartDateExplicit` / `chartEndDateExplicit` — only written when explicit, else left empty so auto-derivation survives a save/reload cycle.

**Boolean cells:** `"Yes"` / `"No"` (matches `kvBool`). **Config sheets:** two-column with a `["Field", "Value"]` header row that `parseConfigSheet` picks up as a harmless unused map entry — round-trip safe.
