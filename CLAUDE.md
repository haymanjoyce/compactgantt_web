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
- `formatDate`/`isoWeekLabel`/`weekdayName` require the `dateFns` global; ISO week = Monday-first.
- `validation.js` does string-only YYYY-MM-DD comparison and does not import `dates.js`.

## Top-level state and `projectData`

`ui.js` owns the live `projectData` reference, initialised by `createEmptyProjectData()` — never `null`. "No file loaded" = `projectData.tasks.length === 0`. File-load and New Project replace `projectData` wholesale; all other writes route through `dispatch()`.

`createEmptyProjectData()` is the single source of truth for the `projectData` shape and all default config values — a pure function. `parseWorkbook` calls it, then overwrites entity arrays and config sections from the workbook.

## Id issuance (monotonic, counter-backed)

New entity ids are minted from `projectData.counters` — a top-level object (NOT under `config`), keyed by **singular** entity name (`task`/`swimlane`/`link`/`pipe`/`curtain`/`note`), each value the NEXT id to issue. Singular keys deliberately match the dispatch `entity` so there's no plural↔singular translation. Seeded to `1` each by `createEmptyProjectData`. The counter only ever advances, so deleting the highest-id entity can't let a later add reuse that id (which would silently re-point a baseline overlay record onto the wrong task — the bug this fixes).

`ui.js` exposes `issueId(entity)` (read-then-advance, used by the dispatcher's `add`/`duplicate`) and `predictId(entity)` (read WITHOUT advancing, used by the Tasks/Swimlanes/shared-simple-entity toolbars to pre-set `nextSelectionIntent`). The toolbar predicts then synchronously dispatches an add that issues — nothing mints between, so they always agree. Fallback when a counter is somehow absent/non-numeric: `maxExistingId(arr)` (the salvaged old `nextIdFor` body — `max(numeric ids)+1` or `1`); `issueId` also self-heals the counter so the broken state can't recur. Never throws, never reuses.

**Counters sheet** (key-value, `['Field','Value']` header, six singular-key rows): writer always emits it (position: after Baseline, before Layout); parser reads via `kvInt` gated to integer ≥ 1 (else treated as 0). **Load-heal** runs in `parseWorkbook` after every entity array is populated (including parser-assigned blank-cell ids): `counter = max(persisted, maxExistingId+1)`. Stale/absent values heal upward; a gap above max (left by a deleted high id) is KEPT — that gap is the point. Legacy files lack the sheet → `parseConfigSheet` returns `{}` → every counter falls back to `maxExisting+1` (byte-for-byte the pre-counter behaviour), so they load unchanged and gain the sheet on next save. No notices, no validation rule, no UI surface (the Inspector dynamic walk renders it read-only). `parser.js` keeps its own `maxExistingId` copy (the two files don't import each other).

**Out of scope (v1):** the parser's blank-id-cell assignment (`id_assigned` notice path) still uses in-sheet `max+1`; the counter heals above whatever it assigns. The residual edge — a blank-cell-assigned id equalling a previously-deleted id — is consciously deferred.

## Mutation dispatcher (ui.js)

`dispatch({ entity, action, id, block, field, value, index })` is the single-writer entry point for all in-app mutations — centralising it is what makes the post-mutation hook unbypassable.

`entity` ∈ `task` / `swimlane` / `link` / `pipe` / `curtain` / `note` / `config` / `baseline`. `action` ∈ `update` / `add` / `delete` / `duplicate` / `moveUp` / `moveDown` (config: `update` only; baseline: `set` / `clear` only, handled before the `VALID_ACTIONS` gate). Unknown entity/action, missing field, or id miss → `console.warn` + no-op (never throws). `add`/`duplicate` use `parser.js` factories and assign a fresh id via `issueId(entity)` (see Id issuance).

**No deletion blocking.** Every delete is allowed (referential integrity is advisory, not enforced — orphans stay in `projectData`, validation flags, renderer skips). A deleted task whose id a link still references just orphans those FKs (re-pointable / clearable / deletable). The former task-delete-if-referenced block — and its `canDeleteTask` / `whyCannotDeleteTask` helpers — were removed, the last survivors of the cleanup that earlier dropped `canDeleteSwimlane`.

**Derived-field maintenance.** `task.isMilestone` recomputed on task `update`; `swimlane.order` recomputed (1-based index) after any swimlane array mutation. `config.timeline.chartStart/EndDate` recomputed via `recomputeTaskDateRange()` after ANY task-array mutation (`update`/`add`/`delete`/`duplicate`/`moveUp`/`moveDown`), each field gated on `!*Explicit` so a user-set date is never clobbered. **Task-gated by design** — a config/Timeline dispatch must NOT re-derive: Timeline date clears/sets are two dispatches (value + flag), and an unconditional recompute would fire in the gap before `explicit` is true and overwrite the user's value. The Timeline clear handler (`renderTimelineConfigForm`) therefore seeds the value to the current `taskDateExtents` extent itself when clearing (flag→false + value→derived), since the task-gated hook won't fire on that config dispatch.

**Post-mutation hook** (in order): `validateProject` → `activateTab(activeTab)` → `updateIssuesTabLabel` (active tab in module-scope `activeTab`). `update` runs the hook unconditionally even if `value` is unchanged.

## Excel file format

`XLSX.read` uses `{ cellDates: true }` so date-formatted cells arrive as JS `Date` objects.

**Entity sheets** (tabular, row 1 = headers): Tasks, Swimlanes, Links, Pipes, Curtains, Notes. Parsed via `parseEntitySheet(worksheet, colDefs)` — header-based, never positional. Missing columns silently take their declared default (backward-compat). Old-name fallbacks live in `colDefs.fallback`; `parser.js` is authoritative. The **Baseline** sheet is also tabular but special — see Baseline comparison.

**Config sheets** (key-value: col A = field, col B = value): Layout, Bars, Timeline, Titles, Style, Typography, Preferences. Parsed via `parseConfigSheet` → map, read with `kvStr/kvInt/kvFloat/kvBool/kvDate` (each takes an optional `fallback` key, try-new-first).

Schema asymmetry: Timeline has five `show*` fields (years/months/weeks/days/dates) but only four `gridline*` — days and dates share calendar-day granularity, so one `gridlineDays` covers both.

## Derived fields

- `task.isMilestone = startDate !== null && startDate === finishDate` (null-guard avoids a false positive when both dates are absent).
- `swimlane.order` = 1-based array index (not stored in Excel).
- `config.timeline.chartStartDate/chartEndDate` derived from `min(task.startDate)` / `max(task.finishDate)` via `taskDateExtents(tasks)` in `parser.js` (the single source of truth, shared by parse and the hook). `chart{Start,End}DateExplicit` record whether the user wrote a non-empty value (via `isNoticeableInput`) — drives the writer's emit-or-leave-empty choice. Deliberate asymmetry: a garbage cell is `explicit=true` with a task-derived date, so save round-trips it to a valid date. **Recomputed live, not parse-time-only:** the post-mutation hook re-derives each field after any task-array mutation, gated per-field on `!explicit` (see Mutation dispatcher → Derived-field maintenance), so New Project + add-task fills the range without a save/reload. The parser's gate derives on `!value`; the hook's on `!explicit` — distinct on purpose (the parser must overwrite a garbage-but-explicit cell, the hook must never touch an explicit one).

## Parse notices (`_parseNotices`)

`projectData._parseNotices` is an array side-channel populated by `parseWorkbook` (seeded `[]` by `createEmptyProjectData()`). Each notice records a non-empty source cell the parser could not interpret and silently defaulted: `{ entity, id, field, rawValue, reason }`.

- `entity` — singular lowercase (same set as the dispatcher). `id` — entity row id (`null` for config rows); rows with a blank/unparseable id cell carry the **newly-assigned** id, not null.
- `field` — JS property name (e.g. `'startDate'`), never the Excel header. `rawValue` — original cell, unmodified.
- `reason` — closed five-value enum, all parser-emitted. `validation.js` reads them via `consumeNotice`; it never emits notices.

Reason values:

| Reason | When emitted |
|---|---|
| `'unparseable_date'` | non-empty value that didn't yield a valid YYYY-MM-DD (`parseDate`/`kvDate` regex-check `toISODate`'s result, so raw `"garbage"` is rejected here, not at `toISODate`). |
| `'unparseable_number'` | non-empty value `parseInt`/`parseFloat` returned `NaN` for; from `toInt`/`toFloat`/`kvInt`/`kvFloat`. |
| `'unrecognised_boolean'` | non-empty boolean-field string that, trimmed+lowercased, is neither `'yes'` nor `'no'` (`kvBool`/`toBool`, e.g. pipe/curtain `invertLabel`). Native booleans pass silently. |
| `'unrecognised_enum'` | non-empty value a `normalize*` function didn't recognise. |
| `'id_assigned'` | id cell blank/missing/unparseable; parser assigned `max(existing) + 1`. Suppresses the upstream `unparseable_number` for id cells (one notice per row). Fires on empty id cells too — exception to "empty produces no notice". |

**Empty vs unparseable distinction** (the whole point of the side-channel). Empty cells, whitespace-only strings, and Invalid `Date` objects never produce a notice — only meaningful input the parser ignored does. **Exception:** `'id_assigned'` also fires on blank/missing id cells.

**Notice order:** parser-traversal — entity sheets then config sheets, top-to-bottom, left-to-right within a row. **Not emitted from:** `createEmptyProjectData()`, column-name fallbacks, config key-name fallbacks (British `Colour`, etc.).

**Enum recognition lives in the parser** — `normalize*` functions supply a canonical default before the value leaves `parseWorkbook`, so the renderer's enum fallbacks are unreachable in normal flow and `validation.js` re-encodes no membership lists.

## Validation (`validation.js`)

`validateProject(projectData)` returns `{ errors: [Issue], warnings: [Issue], notices: [Issue] }` — all three keys always present. Pure: no DOM, no side effects, never mutates `projectData`, never throws.

Each `Issue` is `{ entity, id, field, message, value }`. `entity` singular lowercase (same enum as `_parseNotices`); `id` is the row id, `null` for config issues only. `value` is `null` for "missing field" rules, `rawValue` for parse-derived rules, the current field value otherwise.

**Structure.** A thin `validateProject` coordinator calls 15 per-block validators (seven entity + eight config, the seventh being `validateBaseline` after `validateNotes`) in parse traversal order.

**`_parseNotices` consumption.** Entity validators filter notices by entity tag, config validators by an explicit field-ownership Set; matching notices emit Issues into the bucket dictated by the locked rule list (same `reason` → different buckets per field). Array stays in place on `projectData`.

**"Missing X" guard** fires only when the field is `null` AND no `_parseNotices` entry exists for `(entity, id, field)` with reason `unparseable_number`/`unparseable_date` (prevents double-emission). **Foreign-key validity Sets** filter `null` ids out, so a missing id doesn't silently satisfy a reference.

**CSS color recognition.** Inline allowlist (CSS Color Level 4 names + `transparent`/`currentcolor`) plus hex/rgb(a)/hsl(a) regexes. `isValidCssColor("")` is `false`; per-field rules decide whether empty is legal (Notes border/fill) or an error (Style colors).

**Link classification (R1/R2).** Both rules run inside an outer gate of `pred.finishDate > succ.startDate`, so the block only classifies links the renderer treats as non-forward (mirrors its else-branch; neither module imports the other). Inside: R1 (`pred.finishDate >= succ.finishDate`) flags pred at/past succ's finish; R2 flags same-row late-recoverable (`pred.finishDate < succ.finishDate`). **The gate is essential:** without it R1 misfires on zero-lag F-S links to milestone successors (`succ.finishDate === succ.startDate` collapses R1 to `pred.finishDate >= succ.startDate`, tripping valid shared-date deps). Zero-travel forward links drop at render (`origX >= termX`) but are valid zero-lag F-S deps, so not flagged. Self-links skip R1/R2 — the dedicated Self-link error is their sole issue.

**Call site.** `projectData._validation` is written by the file-load handler (after `parseWorkbook`) and `runPostMutationHook` (New Project relies on the latter via its seeding dispatches). The renderer never consults it — validation is non-gating.

## Renderer (renderer.js)

`renderChart(projectData, opts)` returns a raw SVG string. `opts.showBaseline` (default shown) gates the baseline overlay layer; `opts.showOnlyMoved` (default off) hides zero-slip baselines — see Baseline comparison. Key design rules:

- **Coordinate areas / band height:** `innerX1/innerX2`, `taskRowY1/taskRowY2`, and per-visible-scale band height (`max(minScaleBandHeight, scaleFontSize × scaleFontToBandHeightFactor)`) — formulas in source.
- **Five scale bands** (top-to-bottom): years, months (single-letter from `rendering.monthLetters`), weeks (ISO `"W03"`), dates (numeric day), days (named: Monday/Mon/M). Hidden bands occupy no space. Named-day cells degrade width-adaptively (full→short→letter→empty); the `rendering.scaleMinLabelWidth` gate applies to all bands except days.
- **Render order (painter's algorithm, 15 slots):** SVG layer accumulators in source order; header/footer paint last. Slot numbers referenced elsewhere ("slot 7", etc.) are those accumulators.
- **Color handling:** colors pass directly to SVG `fill`/`stroke`, no renderer-side validation — invalid names render black; validation lives in `validation.js`.
- **Swimlane backgrounds/labels:** `<rect>` fill = `swimlane.backgroundColor` (no renderer fallback; parser default `"white"`); labels always bold — fixed, not configurable.
- **Header/footer text alignment:** per-band via `titles.headerTextAlign` / `footerTextAlign` (inset `rendering.headerFooterTextPadding` for `left`/`right` only); each band emits an inside-edge `<line>` border, suppressed at height 0.
- **Milestones:** centred on `startDate`, size = `bars.milestoneSizeFactor * rowHeight`. `bars.milestoneShape`: `circle` (`milestoneCornerRadius` ignored) or `diamond` (default; rounded corners via `bars.milestoneCornerRadius` 0..1 — no parser clamping, validation flags out-of-range).
- **Bars:** `<rect rx="${bars.taskCornerRadius}">`. **Pattern fills:** `task.fillPattern` drives dedup'd `<pattern>` defs keyed by `(fillPattern, fillColor, patternColor)`; `"solid"`/unrecognised → solid, five named patterns → `url(#id)`. `patternUnits="userSpaceOnUse"`, no `x`/`y` — tiles anchor at SVG origin so same-row bars share a continuous-field phase. Milestones always solid.
- **Live vertical offset:** `bars.taskBarVerticalOffsetFactor` / `bars.milestoneVerticalOffsetFactor` (default `0`, any sign) shift the whole live bar / milestone — shape, labels, leader, link-attach — by `factor × rowH` (`0` = centred). The shifted centre is stored as `taskGeom.rowCenterY`; labels add the same offset to their `taskAlignmentFactor` baseline. No range check.
- **Skip rules:** orphaned tasks, `finishDate < startDate`, and fully-out-of-range tasks silently skipped; `row` clamped to 1 when not a positive integer in `[1, swimlane.rowCount]` (parser preserves a cleared null end-to-end).
- **Milestone labels:** always rendered outside, ignoring `task.labelPlacement` (but the parser doesn't override the stored value — the user's setting is kept).
- **Task labels (slot 12):** from `task.labelContent`, date-fns formatted; per-task `task.dateFormat` overrides `config.preferences.chartDateFormat`. *Inside* (bars only): truncated via `fontSize * rendering.charWidthFactor`, emits nothing if `…` alone overflows. *Outside*: no truncation, past the right edge plus `outsideLabelKissingGap + task.labelOffset`. *Leader lines* when `labelOffset > 0` (bars also require `labelPlacement === 'outside'`).

## config.rendering

All rendering tunables (stroke widths, paddings, factors, corner radii, `monthLetters`, `charWidthFactor`, …) live in `config.rendering` in `createEmptyProjectData()`. **Hard-coded defaults, not Excel-driven** — `parseWorkbook` never touches it, the writer excludes it; source is authoritative. Names mostly follow `<element><attribute>`.

## Link rendering

Finish-to-Start dependency arrows.

**Renderable-task lookup (`taskGeom` Map):** built during the bar/milestone pass, keyed by `task.id`. Tasks skipped by the bar pass are absent, so orphaned-link detection is implicit (no duplicate skip logic). Entries also carry per-task dates/geometry (`fillColor`, `rowCenterY`, `isMilestone`, …) consumed by the link classifier and the baseline overlay.

**Connection points:** bar origin `xFor(finishDate)` / term `xFor(startDate)` (at row centre); milestone both = `xFor(startDate)`, so geometry is shape-independent.

**Link classification (render-time, not stored):**
- *Forward* (`pred.finishDate <= succ.startDate`, non-zero travel): routing per `link.routing` — same-row direct horizontal, different-rows V-H-V (midY = mean of endpoints).
- *Vertical forward*: zero-lag forward (`pred.finishDate === succ.startDate`, surfaces as `origX >= termX`) on different rows — pure vertical, routing ignored.
- *Late-recoverable* (`pred.finishDate > succ.startDate AND < succ.finishDate AND different rows`): vertical-only, terminating at succ's near edge (top if below pred, else bottom).
- *Invalid* (skip): `pred.finishDate >= succ.finishDate`; same-row late; same-row zero-lag forward.
- Milestone successors can't be late-recoverable but routinely appear as vertical-forward successors.

**Rounded corners at bends (HV, VH, AUTO V-H-V only):** quarter-circle arc, radius `min(linkCornerRadius, segA/2, segB/2)`. Per-bend sweep flag by turn direction — gotcha: `(right→down)=1`, `(right→up)=0`, `(down→right)=0`, `(up→right)=1`; AUTO V-H-V's two bends always carry opposite flags.

**Z-order split:** `renderedLinks` is pre-computed, then iterated twice — bodies (slot 8) and origin-marker + arrowhead (slot 11) — so bars/milestones sit between the layers. **Arrowheads:** per-link `<polygon>` triangles (sized by `arrowheadSizeFactor * rowH`), not `<marker>` defs — avoids browser `context-fill`/`context-stroke` inconsistency.

**Milestone pred/succ special cases:** origin marker suppressed when `pred.isMilestone`; arrowhead backed off when `succ.isMilestone` (tip at `milestoneHalf + rendering.linkArrowheadMilestoneGap` from centre). The back-off is calibrated for `termY === succ.rowCenterY`, so vertical-forward → milestone deliberately uses `rowCenterY` (not `barTopY`/`barBottomY`). Late-recoverable links can't have milestone successors.

## Pipes / Curtains / Notes rendering

**Pipes** (line in slot 7, badge in `pipe-badges`): vertical reference line at a date with optional badge. Skipped if `date` null or off-chart. Dasharray from `pipe.lineStyle`. Badge only when `name` non-empty; `labelPosition` (float, default `1`) pins top (`1`) / bottom (`0`).

**Curtains** (slots 3 and 7, badge in `curtain-badges`): tinted band + optional boundary lines + name badge. Skipped if `startDate`/`endDate` null, `endDate <= startDate`, or fully off-chart. Slot 3 `<rect>` clamped to `[innerX1, innerX2]`; boundary lines emit only in-range; badge anchors at `xFor(startDate)` (or `xFor(endDate)` if `labelAnchor === 'end'`).

**Badges** (shared shape, pipes + curtains): `<g>` groups `pipe-badges` then `curtain-badges`, inserted after `curtain-edges`, before `link-bodies` — above pipe lines / curtain edges / slot-3 fill, below tasks/links. Shape via `roundedRightRectPath`: an **open-left tab** (no closing `Z`, so the line-side edge is unstroked but SVG still fills the implied closed subpath), right corners rounded to `bars.taskCornerRadius`. Badge left x and text centre inset right by half the line's stroke width so the fill butts flush to the line's outer edge (self-scales with line width). Per-entity `invertLabel` (default `false`): off → background fill + `color` border/text; on → solid `color` fill + background text. Empty `name` suppresses the badge.

**Notes** (slot 14, above swimlane labels, below header/footer): free-positioned text annotations.

- **Coordinate model.** Dimensions are percentages of the task row area, mapped into the inner chart rect; partial overflow renders as-positioned (no clip). **Skip (silent):** `text === ""`, `widthPct <= 0`, `heightPct <= 0`, or fully off-chart.
- **Add-flow defaults diverge from parser blank-cell defaults.** `createEmptyNote()` returns non-zero dims + `text: 'Note'` so a freshly Added note dodges all four skip conditions; parser Notes defs stay at `0` / `''` so blank Excel cells round-trip blank. Two contracts (Excel-blank = "left empty"; Add = "usable starting state") — do not align them.
- **Optional box:** `<rect>` emitted only when `fillColor` OR `borderColor` is non-empty; when only one is set, the empty side falls back to SVG `"none"`.
- **Text wrapping.** AvailW = `noteW - 2 * rendering.notePadding`; ≤ 0 → text skipped (rect still emits). Empty wrapped lines emit `&#160;` (NBSP) so the `<tspan>` reserves glyph height. Unbreakable tokens char-truncate with `…`; each text-emitting note gets a per-note `<clipPath>`.

**`<defs>` block:** pattern-fill defs and note clip paths share one combined `<defs>` (pattern content collected first, assembled after the notes pass; omitted when neither is needed).

## Baseline comparison

A persisted snapshot of prior task dates, rendered as a tinted **overlay** above the live chart for plan-vs-actual comparison. Cross-cuts data layer, renderer, validation, and UI.

**Data / Excel.** `projectData.baseline` is an array of `{ id, startDate, finishDate }` records (seeded `[]`, **no `createEmpty*` factory**). `id` is a **reference to an existing task's id**, not auto-assigned: parsed verbatim with `toInt`, skipping `makeIdAssigner`, so baseline rows never emit `'id_assigned'` (bad id → `unparseable_number`, bad dates → `unparseable_date`, all entity-tagged `'baseline'`). The Baseline sheet (`ID` / `Start Date` / `Finish Date`) parses like an entity sheet but is **omitted from the workbook when empty** (writer position: after Notes, before Layout).

**Capture (UI) / dispatcher.** Toolbar buttons `Load Baseline` (hidden `#baselineInput` picker) / `Clear Baseline` — NOT a Data-panel entity (absent from `ENTITY_TABS`). Load parses another `.xlsx`, maps its **tasks** to `{ id, startDate, finishDate }`, sets `showBaseline = true`, dispatches `baseline`/`set` (wholesale replace, `Array.isArray` guard else `[]`); Clear dispatches `baseline`/`clear`.

**Rendering (renderer.js).** Overlay `<g id="baseline-overlay">` between the `milestones` and `link-heads` slots — **above** live bars/milestones (live arrowheads/labels still paint on top). Gated by `opts.showBaseline !== false`. Each record matched to a live task by `id` via `taskGeom` (unmatched → no overlay). **Appearance is task-relative:** fill tints from the live task's `fillColor` (patterned bars from base colour) at `bars.baselineFillOpacity`, with a full-opacity same-hue stroke; size/placement from the five `config.bars` keys below, **not** the live `barH`/`milestoneHalf`. **Shape derives from the baseline's own dates** (`startDate === finishDate` → milestone; else bar), so a flipped task still overlays correctly. **The baseline milestone marker is ALWAYS an upward triangle**, independent of `bars.milestoneShape`. Skip: unmatched id, null date, `finishDate < startDate`, off-chart, non-positive width, plus the only-moved gate.

**Appearance config (`config.bars`).** Five user-editable, persisted, Inspector-visible keys (Bars form, `0.01` step): `baselineBarHeightFactor`, `baselineBarVerticalOffsetFactor`, `baselineMilestoneSizeFactor`, `baselineMilestoneVerticalOffsetFactor`, `baselineFillOpacity`. Offsets shift the overlay by `factor × rowH` off the matched task's `rowCenterY`; the bar reuses the live `bars.taskCornerRadius`. Validation: size factors `≤ 0` error / `> 1` warning; opacity out-of-`[0,1]` warning; offsets unchecked.

**View toggles (Chart tab).** Two transient, never-persisted flags in a `.chart-controls` strip shown **only when `baseline.length > 0`**: `showBaseline` (default `true`) hides the whole overlay; `showOnlyMoved` (default `false`) hides zero-slip baselines (gate compares `b.{start,finish}Date` to `taskGeom` live dates; partial change still shows). Both reset on file-load / New Project; `showBaseline` also resets on baseline-load. Save SVG passes both for WYSIWYG.

**Validation.** `validateBaseline` emits **only notices** — one per record whose `id` is non-null and matches no current task. No structural checks (capture keeps data clean, single-author); baseline-tagged parse notices stay Inspector-only.

**Inspector / Issues.** Inspector renders baseline via a fixed `appendSection` (one of the eight FIXED keys the dynamic walk skips). Issues tab: `baseline` sits in `ISSUE_ENTITY_ORDER` (after `note`) and `ISSUE_ENTITY_LABEL`.

## Current UI

Five-tab layout (left to right): **Data → Chart → Issues → Config → Inspector**.

**Data** tab hosts entity-entry panels behind a second-tier strip (Tasks / Swimlanes / Links / Pipes / Curtains / Notes). `renderDataPanel()` is the single entry point (tab activation, file load, New Project, every `dispatch()` via the hook). The two-pane skeleton rebuilds on second-tier switch only; the form container survives mutations so commit-on-blur keeps focus.

**Chart** tab calls `renderChart(projectData, { showBaseline, showOnlyMoved })` on every activation into a horizontally-scrollable container ("No project loaded" if no tasks); a `.chart-controls` strip with `Show baseline` / `Only moved` checkboxes precedes it when a baseline is loaded (see Baseline comparison).

**Inspector** tab renders every `projectData` field as flat read-only tables on every activation. **Issues** tab: see its section below.

### Data panel — entity panels

**Tasks panel.** Toolbar (Add / Delete / Duplicate / Move Up / Move Down) + nav table + edit form (`row` read-only in table, editable on form; `swimlaneId` form-only). `buildTasksDisplayOrder()` sorts `(swimlane.order, task.row, finishDate, startDate, array index)` ascending — orphans/nulls last via Infinity / `'￿'` sentinels; display-only, `projectData.tasks` order never mutated. **Swimlane grouping:** sorted tasks bucket by `swimlaneId` under group-header rows (no `data-id`); defined swimlanes show headers **even when empty**, synthetic `Unassigned` (null id) / `Misassigned` (non-empty id, no match) only when populated. **Symbol cell:** duration-proportional CSS marker (fill = `task.fillColor`, background = swimlane `backgroundColor`); `SYMBOL_COL_WIDTH_PX (64)` in `ui.js` must stay in sync with the `.task-symbol-col` CSS width. **Move Up / Down** dispatch `update` on `task.row` (NOT array-reorder), enabled `row > 1` / `row < swimlane.rowCount`; `syncTaskRowInput` updates the row input after a same-id move. **Inline cell editing:** double-click a `data-field` cell (`.nav-cell-input`). One canonical `attachInlineEditor(table, entitySingular)` serves all five inline-edit tabs, driven by `INLINE_EDIT_REGISTRY` (singular key → `fields` mapping each editable field to `'text'`/`'date'`/`'select'`; a `'select'` field also supplies an `options: (field, obj) => [{value,label}]` getter so the editor stays generic). Date editors seed from the **canonical** stored value, not the formatted display cell, and commit empty → `null` (text → `''`, with select-all). `'select'` builds its `<select>` exactly like `addSelectRow` (`'—'` placeholder only when unset, options from the getter, value seeded from the canonical id) and auto-opens via best-effort `select.showPicker()` on mount. Module-scope `editingCell` (`{ entity, id, field }`) is `entity`-scoped, so one entity's mount block / stale-marker drop is inert in another's render; cleared on commit/cancel (Escape reverts). **Non-destructive selection:** a pure click routes through `selectTask`, updating selection/highlight/toolbar/form in place WITHOUT rebuilding the nav table (scroll + row DOM survive); a click mid-edit instead sets `nextSelectionIntent` and blurs to commit first — `mousedown`, not `click`, so selection precedes the blur teardown.

**Swimlanes panel.** Same shape as Tasks with: (a) display order = array order, no sort; (b) Move Up/Down dispatch real array-reorder actions; (c) `syncSwimlaneOrderCell` parallels `syncTaskRowInput`, refreshing the read-only `order` cell after a same-id move (a form-rebuild exception justified by the explicit button). **Color cell:** raw `swimlane.backgroundColor` as cell background, no validation (empty/invalid/null → CSS no-op); selected-row highlight overridden here by design. **Non-destructive selection** via `selectSwimlane` and **inline `name` editing** (the only `data-field` cell; empty → `''`) take the same shared `attachInlineEditor` / `mousedown` commit-first / `left.scrollTop` path as Tasks.

**Links / Pipes / Curtains / Notes panels.** Share `renderSimpleEntityToolbar`, `attachNavTableRowHandlers`, and a `SIMPLE_ENTITY_REGISTRY` (plural → `{ singular, arr (getter, not a captured ref — `projectData` is replaced wholesale), renderForm }`) — the four behave identically (no Add prerequisite, no delete-block, array `moveUp`/`moveDown`, no derived-field sync). Tasks/Swimlanes keep dedicated toolbars/handlers — deliberate asymmetry. **Non-destructive selection** via `selectSimpleEntity(entityPlural, id)` — a registry-driven mirror of `selectSwimlane` (in-place highlight/toolbar/form swap, nav-table scroll + DOM survive); `attachNavTableRowHandlers`' pure-click branch routes here, a click mid-edit (focus inside `.entity-form` OR `.entity-nav-table`) sets `nextSelectionIntent` and blurs to commit first. **Inline cell editing — Links/Pipes/Curtains** via the canonical `attachInlineEditor` (see Tasks panel): Links `fromTaskId`+`toTaskId` (both `'select'`), Pipes `name`+`date`, Curtains `name`+`startDate`+`endDate`. `notes` is absent from `INLINE_EDIT_REGISTRY` (multi-line text needs a textarea). All three panels add `left.scrollTop` preservation and an entity-scoped stale-marker drop.

**Links FK posture.** `fromTaskId` / `toTaskId` dropdowns via `buildTaskRefOptions`, which always prepends a single selectable clear option (`value ''`, label `— (none)`) and, for an orphan id (non-null, no matching task), a `{id} — (missing)` option; nav-table FK cells use `formatTaskRefCell` with the same null-vs-orphan distinction. That clear option's `''` value doubles as the unset placeholder, so `addSelectRow` / the inline editor suppress their own when-null `—` placeholder once an option list carries a `''` (no duplicate; non-null enum selects like `lineStyle`/`routing` never carry one). The right-pane form (`addSelectRow`) and the inline nav-cell `'select'` editor share that one options mechanism, so inline ≡ form; both commit identically — `''` → dispatch `null` (clearing the FK; FK integrity is advisory, and `null` is a tolerated/flagged state the editor must reach), a finite id re-points, anything else reverts (inline) / ignores (form). Scoped to Links FKs only — the Tasks `swimlaneId` dropdown does *not* do this yet.

**Notes textarea.** `addTextareaRow` relies on `attachCommitHandlers`' Enter-to-blur gate being `tagName === 'INPUT' && type !== 'date'`, so Enter inserts newlines in textareas. Nav-table preview collapses whitespace via `notePreviewText` before truncation.

**Nav-table date display.** `formatNavTableDateCell` formats via `config.preferences.uiDateFormat`; stored values stay canonical YYYY-MM-DD. Malformed format strings throw in date-fns — the helper catches and falls back to the raw value (visible-garbage policy). Form date pickers (`addDateRow`) use HTML5 `<input type="date">` (browser locale).

### Config panel

Form-only tab — no nav table/toolbar/selection. Seven sub-tabs in parser order; `renderConfigPanel(panel)` mirrors `renderDataPanel`'s persistent-skeleton pattern (`activeConfigBlock` / `configBlockRenderedFor`, reset in `resetDataPanelState`). `config.rendering` is excluded (Inspector surfaces it via a static `appendSection`, not the dynamic walk).

Timeline date fields commit two dispatches — the date AND the paired (non-user-editable) `*Explicit` flag — so the writer emits user-set vs auto-derive dates correctly. File-load re-renders Config if active.

### Form helper conventions

`addNumberRow` parsing is the caller's job (`commitFn` does `parseInt`/`parseFloat`); float call sites pass `step: '0.1'`, fine-tuning `*Factor` keys (live/baseline vertical-offset, baseline appearance) `step: '0.01'`. Enum `<select>` options use the canonical lowercase values the parser stores, not Excel casing.

`addCheckboxRow` auto-commits on `'change'` (atomic, no Escape-to-revert) and — unlike the raw-string helpers — passes the parsed boolean directly. Config tab plus the pipe/curtain `invertLabel` side-form checkbox (the same-id form guard preserves its state across re-render).

`addColorRow` — text input (source of truth) + native color swatch; `opts.allowEmpty` appends a clear ✕. Text→`#rrggbb` sync via `parseTextToHex6` (hex fast-path, else a transient probe element); alpha stripped from the swatch but preserved verbatim in the stored text. Swatch/✕ auto-commit and update `preEditValue` so a later Escape doesn't desync.

Config-tab number commits use local `commitInt` / `commitFloat` helpers — empty → null, non-finite → no-op.

### Issues tab

Read-only surface for `projectData._validation` — renders on tab activation, never re-validates. Four panel states (undefined / clean / no-match / table); search + severity + grouping controls; severity-then-entity grouping; three-state sort cycle.

- Sort is stable, tie-broken to parser-emission order — always from the canonical `flattenIssues` list, never the current view; ID/value place nulls/placeholders last regardless of direction.
- Filter/sort/group state lives in `issuesFilterState`; persists across tab switches, resets on file load. Search keeps focus because only `#issuesBody` re-renders on filter changes.
- Tab label: plain `Issues`, else `Issues (E/W/N)` tinted by the highest non-zero bucket.

Non-gating: Save xlsx/SVG stay enabled regardless of `_validation`.

### Inspector helpers

`renderEntityTable(container, data, derivedKeys)` suffixes the listed keys' headers with ` (derived)` (`['isMilestone']` tasks, `['order']` swimlanes); `renderConfigTable` is a two-column key/value table.

**Inspector dynamic walk:** `renderInspector` skips the eight fixed top-level keys (entities + `baseline` + `config`) and renders the rest (`_parseNotices`, `_validation`) as diagnostic sections.

### Toolbar buttons

Left to right: **New Project** → file input → **Save** (xlsx) → **Save SVG** → **Load Baseline** → **Clear Baseline**. New Project replaces `projectData`, clears `loadedFilename`, resets data-panel + issues-filter state, activates Data, then seeds `"Swimlane 1"`. Both Save buttons share the disabled gate (`tasks.length === 0 && swimlanes.length === 0`); Baseline buttons gate via `refreshBaselineButtons`. Save SVG calls `renderChart` (both toggles) regardless of active tab. Filenames: xlsx uses `loadedFilename` verbatim; SVG swaps the extension for `.svg`.

## Excel export (writer.js)

`writeWorkbook(projectData)` returns a `Uint8Array`. **Named-column policy:** columns identified by header name, not index; column order is presentation-only. Sheet order matches the `addSheet` sequence; `config.rendering` excluded.

**Entity sheets:** header row + one data row per entity, always emitted even when empty — **except Baseline**, omitted entirely when empty. Derived fields (`isMilestone`, `order`) not written; `task.dateFormat` and null dates write as empty cells.

**Date cells:** YYYY-MM-DD → `new Date(y, m-1, d)`; null → empty. Timeline dates obey `chart{Start,End}DateExplicit` — only written when explicit, else left empty so auto-derivation survives save/reload.

**Boolean cells:** `"Yes"` / `"No"` (matches `kvBool`). **Config sheets:** two-column with a `["Field", "Value"]` header row that `parseConfigSheet` picks up as a harmless unused map entry — round-trip safe.
