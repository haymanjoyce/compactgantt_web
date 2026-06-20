# compactgantt_web

## Project overview

A compact Gantt chart web application in vanilla JavaScript, HTML, and CSS. No build step, bundler, framework, Node.js, or Python — open files directly in a browser or serve with any static file server.

## Repository layout

Source files (HTML, CSS, JS) live at the repo root; `index.html` is the sole entry point. `/temp/` is scratch, ignored by git (along with OS artefacts and `.vscode/`).

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
| `renderer.js` | Exports `renderChart(projectData, opts)` → SVG string; no DOM dependency, no side effects |
| `writer.js` | Exports `writeWorkbook(projectData)` → `Uint8Array`; no DOM dependency, no side effects |
| `validation.js` | Exports `validateProject(projectData)` → `ValidationReport`; pure, no DOM, no side effects |
| `ui.js` | UI entry point; owns the live `projectData` reference; exports `initUI()` |

Script loading order: SheetJS CDN → date-fns CDN (`3.6.0`, global `dateFns`) → `dates.js` → `parser.js` → `renderer.js` → `writer.js` → `validation.js` → `ui.js` → inline script.

## Date helpers (dates.js)

Exports `toISODate`, `toJsDate`, `daysBetween`, `formatDate`, `isoWeekLabel`, `weekdayName` (`'full'`/`'short'`/`'letter'`). Non-obvious invariants:

- `toISODate` is timezone-safe (`getFullYear/getMonth/getDate`, never `toISOString`) and filters Invalid `Date` (`isNaN(getTime())`, as SheetJS produces on round-tripped empty cells). Non-slash strings pass through; shape validation happens at `parseDate`/`kvDate`.
- `toJsDate` uses `new Date(y, m-1, d)`; `daysBetween` uses `Date.UTC` arithmetic.
- `formatDate`/`isoWeekLabel`/`weekdayName` require the `dateFns` global; ISO week = Monday first.
- `validation.js` does string-only YYYY-MM-DD comparison and does not import `dates.js`.

## Top-level state and `projectData`

`ui.js` owns the live `projectData` reference, initialised by `createEmptyProjectData()` — never `null`. "No file loaded" = `projectData.tasks.length === 0`. File-load and New Project replace `projectData` wholesale; all other writes route through `dispatch()`.

`createEmptyProjectData()` is the single source of truth for the `projectData` shape and all default config values — a pure function. `parseWorkbook` calls it, then overwrites entity arrays and config sections from the workbook. `renderer.js` / `writer.js` take `projectData` as a parameter, no dependency on the global.

## Mutation dispatcher (ui.js)

`dispatch({ entity, action, id, block, field, value, index })` is the single-writer entry point for all in-app mutations — centralising it is what makes the post-mutation hook unbypassable.

`entity` ∈ `task` / `swimlane` / `link` / `pipe` / `curtain` / `note` / `config` / `baseline`. `action` ∈ `update` / `add` / `delete` / `duplicate` / `moveUp` / `moveDown` (config: `update` only; baseline: `set` / `clear` only, handled before the `VALID_ACTIONS` gate — see Baseline comparison). Unknown entity/action, missing field, or id miss → `console.warn` + no-op (never throws). `add` uses `parser.js` factories and assigns `id = max(existing) + 1` (or `1`); `duplicate` does the same with a fresh id.

**Deletion blocking** (silent no-op, no hook): a task delete is blocked if any link references it. No other delete is blocked — deleting the last task in a swimlane, or a swimlane that still has tasks, is allowed (orphans stay in `projectData`; validation flags them, renderer skips them).

**Derived-field maintenance.** `task.isMilestone` recomputed on task `update`; `swimlane.order` recomputed (1-based index) after any swimlane array mutation.

**Post-mutation hook** (in order): `validateProject` → `activateTab(activeTab)` → `updateIssuesTabLabel` (active tab in module-scope `activeTab`). `update` runs the hook unconditionally even if `value` is unchanged (string-numeric mismatches make a robust equality check not worth it).

## Excel file format

`XLSX.read` uses `{ cellDates: true }` so date-formatted cells arrive as JS `Date` objects.

**Entity sheets** (tabular, row 1 = headers): Tasks, Swimlanes, Links, Pipes, Curtains, Notes. Parsed via `parseEntitySheet(worksheet, colDefs)` — header-based, never positional. Missing columns silently take their declared default (backward-compat). Old-name fallbacks live in `colDefs.fallback`; `parser.js` is authoritative. The **Baseline** sheet (reference-id snapshot, omitted from the workbook when empty) is also tabular but special — see Baseline comparison.

**Config sheets** (key-value: col A = field, col B = value): Layout, Bars, Timeline, Titles, Style, Typography, Preferences. Parsed via `parseConfigSheet` → map, read with `kvStr/kvInt/kvFloat/kvBool/kvDate` (each takes an optional `fallback` key, try-new-first).

Schema asymmetry: Timeline has five `show*` fields (years/months/weeks/days/dates) but only four `gridline*` — days and dates share calendar-day granularity, so one `gridlineDays` covers both.

## Derived fields

- `task.isMilestone = startDate !== null && startDate === finishDate` (null-guard avoids a false positive when both dates are absent).
- `swimlane.order` = 1-based array index (not stored in Excel).
- `config.timeline.chartStartDate/chartEndDate` derived from `min(task.startDate)` / `max(task.finishDate)` when absent/unparseable in the Timeline sheet. `chart{Start,End}DateExplicit` record whether the user wrote a non-empty value (via `isNoticeableInput`) — drives the writer's emit-or-leave-empty choice. Deliberate asymmetry: a garbage cell is `explicit=true` with a task-derived date, so save round-trips it to a now-valid date.

## Parse notices (`_parseNotices`)

`projectData._parseNotices` is an array side-channel populated by `parseWorkbook` (seeded `[]` by `createEmptyProjectData()`). Each notice records a non-empty source cell the parser could not interpret and silently defaulted: `{ entity, id, field, rawValue, reason }`.

- `entity` — singular lowercase (same set as the dispatcher). `id` — entity row id (`null` for config rows); rows with a blank/unparseable id cell carry the **newly-assigned** id, not null, so the user can locate them.
- `field` — JS property name (e.g. `'startDate'`), never the Excel header. `rawValue` — original cell, unmodified.
- `reason` — closed five-value enum, all parser-emitted. `validation.js` reads them via `consumeNotice`; it never emits notices.

Reason values:

| Reason | When emitted |
|---|---|
| `'unparseable_date'` | non-empty value that didn't yield a valid YYYY-MM-DD. `parseDate`/`kvDate` validate `toISODate`'s result against `/^\d{4}-\d{2}-\d{2}$/` (so raw `"garbage"` is rejected here, not at `toISODate`). |
| `'unparseable_number'` | non-empty value `parseInt`/`parseFloat` returned `NaN` for; from `toInt`/`toFloat`/`kvInt`/`kvFloat`. |
| `'unrecognised_boolean'` | non-empty boolean-field string that, trimmed+lowercased, is neither `'yes'` nor `'no'`; from `kvBool`. Native booleans pass silently. |
| `'unrecognised_enum'` | non-empty value a `normalize*` function didn't recognise. |
| `'id_assigned'` | id cell blank/missing/unparseable; parser assigned `max(existing) + 1`. Suppresses the upstream `unparseable_number` for id cells (one notice per row). Fires on empty id cells too — exception to "empty produces no notice". |

**Empty vs unparseable distinction** (the whole point of the side-channel). Empty cells, whitespace-only strings, and Invalid `Date` objects (`isNaN(getTime())`, as SheetJS produces for round-tripped empty date cells) never produce a notice — only meaningful input the parser ignored does. **Exception:** `'id_assigned'` also fires on blank/missing id cells.

**Notice order:** parser-traversal — entity sheets then config sheets, top-to-bottom, left-to-right within a row. **Not emitted from:** `createEmptyProjectData()`, column-name fallbacks, config key-name fallbacks (British `Colour`, etc.).

**Enum recognition lives in the parser** — `normalize*` functions supply a canonical default before the value leaves `parseWorkbook`, so the renderer's enum fallbacks are unreachable in normal flow and `validation.js` re-encodes no membership lists (reads only via `consumeNotice`).

## Validation (`validation.js`)

`validateProject(projectData)` returns `{ errors: [Issue], warnings: [Issue], notices: [Issue] }` — all three keys always present. Pure: no DOM, no side effects, never mutates `projectData`, never throws.

Each `Issue` is `{ entity, id, field, message, value }`. `entity` singular lowercase (same enum as `_parseNotices`); `id` is the row id, `null` for config issues only. `value` is `null` for "missing field" rules, `rawValue` for parse-derived rules, the current field value otherwise.

**Structure.** A thin `validateProject` coordinator calls 15 per-block validators (seven entity + eight config, the seventh being `validateBaseline` after `validateNotes`) in parse traversal order, concatenating results.

**`_parseNotices` consumption.** Entity validators filter notices by entity tag, config validators by an explicit field-ownership Set; matching notices emit Issues into the bucket dictated by the locked rule list (same `reason` → different buckets per field). Array stays in place on `projectData`.

**"Missing X" guard** fires only when the field is `null` AND no `_parseNotices` entry exists for `(entity, id, field)` with reason `unparseable_number`/`unparseable_date` (prevents double-emission). **Foreign-key validity Sets** filter `null` ids out, so a missing id doesn't silently satisfy a reference.

**CSS color recognition.** Inline allowlist (CSS Color Level 4 names + `transparent`/`currentcolor`) plus hex/rgb(a)/hsl(a) regexes. `isValidCssColor("")` is `false`; per-field rules decide whether empty is legal (Notes border/fill) or an error (Style colors).

**Link classification (R1/R2).** Both rules run inside an outer gate of `pred.finishDate > succ.startDate`, so the block only classifies links the renderer treats as non-forward (mirroring its else-branch; neither module imports the other). Inside: R1 (`pred.finishDate >= succ.finishDate`) flags pred at/past succ's finish; R2 flags late-recoverable (`pred.finishDate < succ.finishDate`) on the same row. **The gate is essential:** without it R1 misfires on zero-lag F-S links to milestone successors (`succ.finishDate === succ.startDate` collapses R1 to `pred.finishDate >= succ.startDate`, tripping valid shared-date dependencies). The renderer's `origX >= termX` geometric skip has no validation counterpart — zero-travel forward links drop at render but are valid zero-lag F-S deps, so not flagged. Self-links skip R1/R2 — the dedicated Self-link error is their sole issue.

**Call site.** `projectData._validation` is written by the file-load handler (after `parseWorkbook`) and `runPostMutationHook` (New Project relies on the latter via its seeding dispatches). The renderer never consults `_validation` — validation is non-gating.

## Renderer (renderer.js)

`renderChart(projectData, opts)` returns a raw SVG string. `opts.showBaseline` (default shown) gates the baseline overlay layer; `opts.showOnlyMoved` (default off) hides zero-slip baselines — see Baseline comparison. Key design rules:

- **Coordinate areas:** `innerX1/innerX2` (left/right padding), `taskRowY1/taskRowY2` (bracket the task rows) — formulas in source.
- **Scale band height:** per visible scale, `max(rendering.minScaleBandHeight, scaleFontSize * rendering.scaleFontToBandHeightFactor)`.
- **Five scale bands** (top-to-bottom): years, months (single-letter from `rendering.monthLetters`), weeks (ISO `"W03"`), dates (numeric day), days (named: Monday/Mon/M). Hidden bands occupy no space. Named-day cells degrade width-adaptively (full→short→letter→empty); the `rendering.scaleMinLabelWidth` gate applies to all bands **except** days.
- **Render order (painter's algorithm, 15 slots):** SVG layer accumulators in source order; header/footer paint last. Slot numbers referenced elsewhere ("slot 7", etc.) are those accumulators.
- **Color handling:** colors pass directly to SVG `fill`/`stroke`, no renderer-side validation — invalid names render as SVG default (black); validation lives in `validation.js`.
- **Swimlane backgrounds/labels:** `<rect>` fill = `swimlane.backgroundColor` (no renderer fallback; parser default `"white"`); labels always bold — fixed, not configurable.
- **Header/footer text alignment:** per-band via `titles.headerTextAlign` / `footerTextAlign` (inset `rendering.headerFooterTextPadding` for `left`/`right` only); each band emits an inside-edge `<line>` border, suppressed at band height 0.
- **Milestones:** centred on `startDate`, size = `bars.milestoneSizeFactor * rowHeight`. `bars.milestoneShape`: `circle` (`milestoneCornerRadius` ignored) or `diamond` (default; rounded corners via `bars.milestoneCornerRadius` 0..1 — no parser clamping, validation flags out-of-range).
- **Bars:** `<rect rx="${bars.taskCornerRadius}">`. **Pattern fills:** `task.fillPattern` drives deduplicated `<pattern>` defs keyed by `(fillPattern, fillColor, patternColor)`; `"solid"`/unrecognised → solid fill, five named patterns → `url(#id)`. `patternUnits="userSpaceOnUse"` with no `x`/`y` — tiles anchor at SVG origin so same-row bars share a continuous-field phase. Milestones always solid.
- **Live vertical offset:** `bars.taskBarVerticalOffsetFactor` / `bars.milestoneVerticalOffsetFactor` (default `0`, any sign) shift the whole live bar / milestone — shape, labels, leader, and link-attach — by `factor × rowH` within the row (`0` = centred). The link-attach point is the shifted bar/milestone centre, stored as `taskGeom.rowCenterY`; labels add the same offset to their `taskAlignmentFactor` baseline. Validation: both in the Bars OWNED set + unparseable loop, no range check.
- **Skip rules:** orphaned tasks, `finishDate < startDate`, and fully-out-of-range tasks silently skipped; `row` clamped to 1 when not a positive integer in `[1, swimlane.rowCount]` (parser preserves a cleared null end-to-end).
- **Milestone labels:** always rendered outside, ignoring `task.labelPlacement` (but the parser doesn't override the stored value — the user's setting is kept).
- **Task labels (slot 12):** from `task.labelContent` with date-fns formatting; per-task `task.dateFormat` overrides `config.preferences.chartDateFormat`. *Inside* (bars only): truncated via `fontSize * rendering.charWidthFactor`, emits nothing if `…` alone overflows. *Outside*: no truncation, past the right edge plus `outsideLabelKissingGap + task.labelOffset`. *Leader lines*: drawn when `labelOffset > 0` (bars also require `labelPlacement === 'outside'`); no clip, may overflow into right padding.

## config.rendering

All rendering tunables (stroke widths, paddings, factors, corner radii, `monthLetters`, `charWidthFactor`, …) live in `config.rendering` in `createEmptyProjectData()`. **Hard-coded defaults, not Excel-driven** — `parseWorkbook` never touches it, the writer excludes it; source is authoritative. Names mostly follow `<element><attribute>`.

## Link rendering

Finish-to-Start dependency arrows.

**Renderable-task lookup (`taskGeom` Map):** built during the bar/milestone pass, keyed by `task.id`. Tasks skipped by the bar pass are absent, so orphaned-link detection is implicit (no duplicate skip logic). Each entry also carries the task's `startDate`/`finishDate`, `fillColor`, `rowCenterY`, and `isMilestone` — consumed by the link classifier and the baseline overlay.

**Connection points:** bar origin = `xFor(finishDate)`, termination = `xFor(startDate)` (both at row centre); milestone origin/termination both = `xFor(startDate)`, so geometry is milestone-shape-independent.

**Link classification (render-time, not stored):**
- *Forward* (`pred.finishDate <= succ.startDate`, non-zero travel): routing per `link.routing` — same-row → direct horizontal, different-rows → V-H-V (midY = mean of endpoints).
- *Vertical forward*: zero-lag forward (`pred.finishDate === succ.startDate`, surfaces as `origX >= termX`) on different rows — pure vertical at `x = origX = termX`, routing ignored.
- *Late-recoverable* (`pred.finishDate > succ.startDate AND < succ.finishDate AND different rows`): vertical-only, termination x = origin x, y = top edge of succ if below pred else bottom.
- *Invalid* (skip): `pred.finishDate >= succ.finishDate`; same-row late; same-row zero-lag forward.
- Milestone successors can't be late-recoverable but routinely appear as vertical-forward successors.

**Rounded corners at bends (HV, VH, AUTO V-H-V only):** quarter-circle arc, radius `min(linkCornerRadius, segA/2, segB/2)`. Per-bend sweep flag by turn direction — gotcha: `(right→down)=1`, `(right→up)=0`, `(down→right)=0`, `(up→right)=1`; AUTO V-H-V's two bends always carry opposite flags.

**Z-order split:** `renderedLinks` is pre-computed, then iterated twice — `<path>` bodies (slot 8) and origin-marker + arrowhead (slot 11) — keeping bars/milestones between the two layers without re-classifying. **Arrowheads:** per-link `<polygon>` triangles (sized by `arrowheadSizeFactor * rowH`), not `<marker>` defs — avoids browser `context-fill`/`context-stroke` inconsistency.

**Milestone pred/succ special cases:** origin marker suppressed when `pred.isMilestone`; arrowhead backed off when `succ.isMilestone` (tip at `milestoneHalf + rendering.linkArrowheadMilestoneGap` from centre). The back-off is calibrated for `termY === succ.rowCenterY`, so vertical-forward → milestone deliberately uses `rowCenterY` (not `barTopY`/`barBottomY`) to keep it holding. Late-recoverable links can't have milestone successors.

## Pipes / Curtains / Notes rendering

**Pipes** (slot 7): vertical reference line at a date with optional badge. Skipped if `date` null or off-chart. Dasharray from `pipe.lineStyle`. Badge only when `name` non-empty; `labelPosition` (float, default `1`) pins top (`1`) / bottom (`0`).

**Curtains** (slots 3 and 7): tinted band + optional boundary lines + name badge. Skipped if `startDate`/`endDate` null, `endDate <= startDate`, or fully off-chart. Slot 3 `<rect>` clamped to `[innerX1, innerX2]`; boundary lines emit only when in-range; badge anchors at `xFor(startDate)` (or `xFor(endDate)` if `labelAnchor === 'end'`).

**Notes** (slot 14, above swimlane labels, below header/footer): free-positioned text annotations.

- **Coordinate model.** Dimensions are percentages of the task row area, mapped into the inner chart rect; partial overflow renders as-positioned (no clip). **Skip (silent):** `text === ""`, `widthPct <= 0`, `heightPct <= 0`, or fully off-chart.
- **Add-flow defaults diverge from parser blank-cell defaults.** `createEmptyNote()` returns non-zero dims + `text: 'Note'` so a freshly Added note dodges all four skip conditions; parser Notes defs stay at `0` / `''` so blank Excel cells round-trip blank. Two contracts (Excel-blank = "left empty"; Add = "usable starting state") — do not align them.
- **Optional box:** `<rect>` emitted only when `fillColor` OR `borderColor` is non-empty (empty = "skip the rect" signal); when only one is set, the empty side falls back to SVG `"none"`.
- **Text wrapping.** AvailW = `noteW - 2 * rendering.notePadding`; ≤ 0 → text skipped (rect still emits). Empty wrapped lines emit `&#160;` (NBSP) so the `<tspan>` reserves glyph height. Unbreakable tokens char-truncate with `…`. `textAlign` sets each `<tspan>`'s `x`/`text-anchor` (no `||` fallback — parser is sole default source); each text-emitting note gets a per-note `<clipPath>`.

**`<defs>` block (combined).** Pattern-fill defs and note clip paths share one `<defs>`; pattern content is collected first but assembled after the notes pass. Omitted when neither is needed.

## Baseline comparison

A persisted snapshot of prior task dates, rendered as a tinted **overlay** above the live chart for plan-vs-actual comparison. Cross-cuts data layer, renderer, validation, and UI.

**Data / Excel.** `projectData.baseline` is an array of `{ id, startDate, finishDate }` records (seeded `[]`, **no `createEmpty*` factory**). `id` is a **reference to an existing task's id**, not auto-assigned: parsed verbatim with `toInt`, skipping `makeIdAssigner`, so baseline rows never emit `'id_assigned'` (bad id → `unparseable_number`, bad dates → `unparseable_date`, all entity-tagged `'baseline'`). The Baseline sheet (`ID` / `Start Date` / `Finish Date`) parses like an entity sheet but is **omitted from the workbook when empty** so non-baselined files don't gain a stray sheet (writer position: after Notes, before Layout).

**Capture (UI) / dispatcher.** Global-toolbar buttons `Load Baseline` (hidden `#baselineInput` picker) / `Clear Baseline` — NOT a Data-panel entity (absent from `ENTITY_TABS`). Load parses another `.xlsx` via `parseWorkbook`, maps its **tasks** to `{ id, startDate, finishDate }` records, sets `showBaseline = true`, and dispatches `baseline`/`set` (replaces the array wholesale, `Array.isArray` guard else `[]`); Clear dispatches `baseline`/`clear`. Both run `runPostMutationHook()`.

**Rendering (renderer.js).** Overlay layer = `<g id="baseline-overlay">` (accumulator `baselineSvg`) between the `milestones` and `link-heads` slots — **above** the live bars/milestones so it pairs visibly with them (live arrowheads and labels still paint on top). Gated by `opts.showBaseline !== false` (omitted → shown). Each record matched to a live task by `id` via the `taskGeom` Map (unmatched → no overlay). **Appearance is task-relative, not hard-coded:** fill tints from the matched live task's own `fillColor` (carried on `taskGeom`; a patterned live bar tints from its base colour, pattern ignored) at `bars.baselineFillOpacity`, with a **full-opacity same-hue stroke** — the crisp hue edge does the pairing. Size/placement come from the five `config.bars` keys below, **not** the live `barH`/`milestoneHalf`. **Shape derives from the baseline's own dates** (`startDate === finishDate` → milestone marker; else bar), so a task that flipped milestone↔bar still overlays correctly. **The baseline milestone marker is ALWAYS an upward triangle** (apex up — the top-half-of-a-diamond reading) — deliberately distinct from and independent of `bars.milestoneShape` (which still drives only the live milestone, diamond/circle). Skip rules: unmatched id, null date, `finishDate < startDate`, fully off-chart, non-positive clipped width, plus the only-moved gate below.

**Appearance config (`config.bars`).** Five user-editable, persisted, Inspector-visible keys (fine `0.01` step in the Bars form): `baselineBarHeightFactor` (0.35), `baselineBarVerticalOffsetFactor` (0), `baselineMilestoneSizeFactor` (0.4), `baselineMilestoneVerticalOffsetFactor` (0), `baselineFillOpacity` (0.4). Offsets shift the overlay by `factor × rowH` off the matched task's `rowCenterY` (any sign); the bar reuses the live `bars.taskCornerRadius` (no baseline-specific radius key). Validation: the two size factors get `≤ 0` error / `> 1` warning (mirroring the live size factors); opacity gets out-of-`[0,1]` warning (SVG clamps anyway); offsets unchecked. These **replaced** the former hard-coded `config.rendering` `ghost*` fields, now removed.

**View toggles (Chart tab).** Two transient, never-persisted flags, surfaced as a slim `.chart-controls` strip above the chart **only when `baseline.length > 0`**: module-scope `showBaseline` (default `true`; `#showBaselineToggle`) hides the whole overlay, and `showOnlyMoved` (default `false`; `#showOnlyMovedToggle`) hides baselines whose dates exactly match the live task's (zero slip — the renderer's `opts.showOnlyMoved` delta gate compares `b.{start,finish}Date` to the `taskGeom` live dates; a partial change still shows). Both reset on file-load / New Project (`resetDataPanelState`); `showBaseline` additionally resets on baseline-load so a freshly loaded baseline is visible. Save SVG passes both flags for WYSIWYG.

**Validation.** `validateBaseline` emits **only notices** — one per record whose `id` is non-null and matches no current task. No structural checks (capture keeps data clean, single-author); baseline-tagged parse notices stay Inspector-only.

**Inspector / Issues.** Inspector renders baseline via a fixed `appendSection` (one of the eight FIXED keys the dynamic walk skips). Issues tab: `baseline` sits in `ISSUE_ENTITY_ORDER` (after `note`) and `ISSUE_ENTITY_LABEL`.

## Current UI

Five-tab layout (left to right): **Data → Chart → Issues → Config → Inspector**.

**Data** tab hosts entity-entry panels behind a second-tier strip (Tasks / Swimlanes / Links / Pipes / Curtains / Notes). `renderDataPanel()` is the single entry point (tab activation, file load, New Project, every `dispatch()` via the hook). The two-pane skeleton rebuilds on second-tier switch only; the form container survives mutations so commit-on-blur preserves focus.

**Chart** tab calls `renderChart(projectData, { showBaseline, showOnlyMoved })` on every activation into a horizontally-scrollable container ("No project loaded" if no tasks); a `.chart-controls` strip with `Show baseline` / `Only moved` checkboxes precedes it when a baseline is loaded (see Baseline comparison).

**Inspector** tab renders every `projectData` field as flat read-only tables on every activation — exhaustive, developer-facing. **Issues** tab: see its section below.

### Data panel — entity panels

**Tasks panel.** Toolbar (Add / Delete / Duplicate / Move Up / Move Down) + nav table + edit form (`row` read-only in table, editable on form; `swimlaneId` form-only). `buildTasksDisplayOrder()` sorts `(swimlane.order, task.row, finishDate, startDate, array index)` ascending — orphans/nulls last via Infinity / `'￿'` sentinels; display-only, `projectData.tasks` order never mutated (writer preserves Excel ordering). **Swimlane grouping:** sorted tasks bucket by `swimlaneId` under group-header rows; defined swimlanes show headers **even when empty**, synthetic `Unassigned` (null id) / `Misassigned` (non-empty id, no match) only when populated. Group-header rows carry no `data-id` (selection handler skips them). **Symbol cell:** duration-proportional CSS marker (fill = `task.fillColor`, background = swimlane `backgroundColor`); `SYMBOL_COL_WIDTH_PX (64)` in `ui.js` must stay in sync with the `.task-symbol-col` CSS width. **Move Up / Down** dispatch `update` on `task.row` (NOT array-reorder), enabled `row > 1` / `row < swimlane.rowCount`; `syncTaskRowInput` targeted-updates the row input after a same-id move. **Inline cell editing:** double-click a `name`, `startDate`, or `finishDate` cell (those carrying `data-field`) to edit in place via a `.nav-cell-input` (`type="date"` for dates, else text); module-scope `editingCell` (`{taskId, field}`) drives editor-vs-text rendering and is cleared on commit/cancel (Escape reverts and restores the text cell; the editor is focused in a `queueMicrotask` since the table is detached at mount time). **Row selection is non-destructive:** a pure click routes through `selectTask`, updating selection/highlight/toolbar/form in place WITHOUT rebuilding the nav table, so scroll position and row DOM survive; a click landing mid-edit (form input OR inline editor) instead sets `nextSelectionIntent` and blurs to commit first — `mousedown`, not `click`, so selection precedes the blur teardown.

**Swimlanes panel.** Same shape as Tasks with: (a) display order = array order, no sort; (b) Move Up/Down dispatch real array-reorder actions; (c) `syncSwimlaneOrderCell` parallels `syncTaskRowInput`, refreshing the read-only `order` cell after a same-id move. Declared exception to form-rebuild-only-on-selection-change, justified by the explicit button. **Color cell:** raw `swimlane.backgroundColor` as cell background, no validation (empty/invalid/null → CSS no-op); selected-row highlight overridden here by design.

**Links / Pipes / Curtains / Notes panels.** Share `renderSimpleEntityToolbar` and `attachNavTableRowHandlers` — the four behave identically (no Add prerequisite, no delete-block, array `moveUp`/`moveDown`, no derived-field sync). Tasks/Swimlanes keep dedicated toolbars/handlers — deliberate asymmetry.

**Nav-table numeric-column alignment (cross-cutting CSS).** Numeric columns right-align via per-column classes on header + data cells; `id` via the shared `th:first-child`/`td:first-child:not(.entity-empty)` rule. Classing a numeric *header* requires breaking it out of the generic header loop. The `width: 1px` shrink-to-content idiom caps a column to content width so slack flows to the flexible `name`/`text` column.

**Links FK posture.** `fromTaskId` / `toTaskId` dropdowns via `buildTaskRefOptions`; an orphan id (non-null, no matching task) prepends a `{id} — (missing)` option, and nav-table FK cells use `formatTaskRefCell` with the same null-vs-orphan distinction. Scoped to Links FKs only — the Tasks `swimlaneId` dropdown does *not* do this yet.

**Notes textarea.** `addTextareaRow` relies on `attachCommitHandlers`' Enter-to-blur gate being `tagName === 'INPUT' && type !== 'date'`, so Enter inserts newlines in textareas (no-op in date inputs). Nav-table preview collapses whitespace via `notePreviewText` before 40-char truncation.

**Nav-table date display.** Date cells format via `formatNavTableDateCell` using `config.preferences.uiDateFormat`; stored values stay canonical YYYY-MM-DD. Malformed format strings throw in date-fns — the helper catches and falls back to the raw value (visible-garbage policy, no validation rule). Form date pickers (`addDateRow`) use HTML5 `<input type="date">` (browser locale, not project-controllable).

### Config panel

Form-only tab — no nav table/toolbar/selection. Seven sub-tabs in parser order; `renderConfigPanel(panel)` mirrors `renderDataPanel`'s persistent-skeleton pattern, with `activeConfigBlock` / `configBlockRenderedFor` paralleling `formRenderedForId`, all reset in `resetDataPanelState`. `config.rendering` is excluded (Inspector surfaces it via a static `appendSection`, not the dynamic walk).

Timeline date fields commit two dispatches — the date AND the paired (non-user-editable) `*Explicit` flag — so the writer emits user-set vs auto-derive dates correctly. File-load re-renders Config if active; New Project doesn't need this (it activates Data before seeding).

### Form helper conventions

`addNumberRow` parsing is the caller's job (`commitFn` does `parseInt`/`parseFloat`); float call sites pass `step: '0.1'` (fine-tuning factors — the live/baseline vertical-offset and baseline appearance `*Factor` keys — pass `step: '0.01'`). Enum `<select>` options use the canonical lowercase values the parser stores, not Excel casing.

`addCheckboxRow` auto-commits on `'change'` (atomic, no Escape-to-revert) and — unlike the raw-string helpers — passes the parsed boolean directly. Config tab only.

`addColorRow` — text input (source of truth) + native color swatch; `opts.allowEmpty` appends a clear ✕. Text→`#rrggbb` sync via `parseTextToHex6` (hex fast-path, else a transient probe element so any CSS Color Level 4 input renders); alpha stripped from the swatch but preserved verbatim in the stored text. Swatch/✕ auto-commit and update `preEditValue` so a later Escape doesn't desync.

Config-tab number commits use local `commitInt` / `commitFloat` helpers — empty → null, non-finite → no-op.

### Issues tab

Read-only surface for `projectData._validation` — renders on tab activation, never re-validates. Four panel states (undefined / clean / no-match / table); controls (search, severity checkboxes, grouping toggle); six-column table; severity-then-entity grouping; three-state sort cycle.

- Sort is stable, tie-broken to parser-emission order — always sorts from the canonical `flattenIssues` list, never the current view; ID/value place nulls/placeholders last regardless of direction.
- Filter/sort/group state lives in module-scope `issuesFilterState`; persists across tab switches, resets on file load. Search keeps focus because only `#issuesBody` re-renders on filter changes (controls DOM built once per `renderIssuesPanel`).
- Tab label: plain `Issues`, else `Issues (E/W/N)` tinted by the highest non-zero bucket (active-tab styling overrides the tint via CSS specificity).

Non-gating: Save xlsx/SVG stay enabled regardless of `_validation`.

### Inspector helpers

`renderEntityTable(container, data, derivedKeys)` suffixes the listed keys' headers with ` (derived)` (`['isMilestone']` tasks, `['order']` swimlanes); `renderConfigTable` renders a two-column key/value table.

**Inspector dynamic walk:** `renderInspector` skips the eight fixed top-level keys (entities + `baseline` + `config`) and renders the rest (`_parseNotices`, `_validation`) as diagnostic sections, dispatching on value shape (all-arrays object → sub-section per key, as `_validation`'s buckets render; array → entity table; object → key-value table; primitive → single-cell).

### Toolbar buttons

Left to right: **New Project** → file input → **Save** (xlsx) → **Save SVG** → **Load Baseline** → **Clear Baseline**. New Project replaces `projectData` with `createEmptyProjectData()`, clears `loadedFilename`, resets data-panel + issues-filter state, activates Data, then seeds `"Swimlane 1"` via two dispatches. Both Save buttons share the disabled gate (`tasks.length === 0 && swimlanes.length === 0`) via `refreshStatusAndButtons`; the Baseline buttons gate via `refreshBaselineButtons` (see Baseline comparison). Save SVG calls `renderChart` (passing both `showBaseline` and `showOnlyMoved`) regardless of active tab. Filenames: xlsx uses `loadedFilename` verbatim; SVG swaps the extension for `.svg`.

`initUI()` ends with a `renderDataPanel()` so the empty tab strip and Tasks panel exist on page load.

## Excel export (writer.js)

`writeWorkbook(projectData)` returns a `Uint8Array`. **Named-column policy:** columns identified by header name, not index; column order is presentation-only. Sheet order matches the `addSheet` sequence; `config.rendering` excluded.

**Entity sheets:** header row + one data row per entity, always emitted even when empty — **except Baseline**, omitted entirely when empty (see Baseline comparison). Derived fields (`isMilestone`, `order`) not written; `task.dateFormat` and null dates write as empty cells.

**Date cells:** YYYY-MM-DD → `new Date(y, m-1, d)`; null → empty. Timeline dates obey `chart{Start,End}DateExplicit` — only written when explicit, else left empty so auto-derivation survives save/reload.

**Boolean cells:** `"Yes"` / `"No"` (matches `kvBool`). **Config sheets:** two-column with a `["Field", "Value"]` header row that `parseConfigSheet` picks up as a harmless unused map entry — round-trip safe.
