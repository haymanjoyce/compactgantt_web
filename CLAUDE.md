# compactgantt_web

## Project overview

A compact Gantt chart web application in vanilla JavaScript, HTML, and CSS. The **web app itself** has no build step, bundler, framework, or runtime Node.js/Python — open files directly in a browser or serve with any static file server. A separate, optional **Electron desktop packaging layer** (dev-tooling only, never touching the web sources) wraps it for a Windows portable build — see Desktop packaging (Electron).

## Repository layout

Source files (HTML, CSS, JS) live at the repo root; `index.html` is the sole entry point. `/vendor/` holds the two locally-vendored third-party libraries (committed, not gitignored) — see Script loading order. `main.js` + `package.json` at the root are the Electron packaging layer (see Desktop packaging). `/temp/` is scratch, ignored by git (along with OS artefacts, `.vscode/`, `node_modules/`, and `dist/`).

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

Script loading order: SheetJS (`vendor/xlsx-0.20.3.full.min.js`, full standalone build, global `XLSX`) → date-fns (`vendor/date-fns-3.6.0.min.js`, `3.6.0`, global `dateFns`) → `dates.js` → `parser.js` → `renderer.js` → `writer.js` → `validation.js` → `ui.js` → inline script. Both libraries are vendored locally (plain `<script src>`, no defer/async) so the app loads fully offline — a prerequisite for desktop packaging. Do not repoint to a CDN or re-pin SheetJS off `0.20.3` (the former unpinned CDN tag resolved to `0.18.5`; both are the same full flavour and both assign `window.XLSX`).

## Date helpers (dates.js)

Exports `toISODate`, `toJsDate`, `daysBetween`, `formatDate`, `isoWeekLabel`, `toLocaleDateDisplay`, `weekdayName` (`'full'`/`'short'`/`'letter'`). Non-obvious invariants:

- `toISODate` is timezone-safe (`getFullYear/getMonth/getDate`, never `toISOString`) and filters Invalid `Date` (`isNaN(getTime())`, as SheetJS produces on round-tripped empty cells). Non-slash strings pass through; shape validation happens at `parseDate`/`kvDate`.
- `toJsDate` uses `new Date(y, m-1, d)`; `daysBetween` uses `Date.UTC` arithmetic.
- `formatDate`/`isoWeekLabel`/`weekdayName` require the `dateFns` global; ISO week = Monday-first.
- `validation.js` does string-only YYYY-MM-DD comparison and does not import `dates.js`.

## Top-level state and `projectData`

`ui.js` owns the live `projectData` reference, initialised by `createEmptyProjectData()` — never `null`. "No file loaded" = `projectData.tasks.length === 0`. File-load and New Project replace `projectData` wholesale; all other writes route through `dispatch()`.

`createEmptyProjectData()` is the single source of truth for the `projectData` shape and all default config values — a pure function. `parseWorkbook` calls it, then overwrites entity arrays and config sections from the workbook.

## Id issuance (monotonic, counter-backed)

New entity ids are minted from `projectData.counters` — a top-level object (NOT under `config`), keyed by **singular** entity name (`task`/`swimlane`/`link`/`pipe`/`curtain`/`note`), each value the NEXT id to issue. Singular keys deliberately match the dispatch `entity` so there's no plural↔singular translation. Seeded to `1` each by `createEmptyProjectData`. The counter only ever advances, so deleting the highest-id entity can't let a later add reuse that id (which would silently re-point a baseline overlay record onto the wrong task — the bug this fixes).

`ui.js` exposes `issueId(entity)` (read-then-advance, used by dispatcher `add`/`duplicate`) and `predictId(entity)` (read WITHOUT advancing, used by toolbars to pre-set `nextSelectionIntent`). Toolbar predicts then synchronously dispatches an add that issues — nothing mints between, so they agree. Fallback when a counter is absent/non-numeric: `maxExistingId(arr)` = `max(numeric ids)+1` or `1`; `issueId` also self-heals the counter. Never throws, never reuses.

**Counters sheet** (key-value, six singular-key rows): writer always emits it (after Baseline, before Layout); parser reads via `kvInt` gated to integer ≥ 1. **Load-heal** (in `parseWorkbook`, after each entity array is populated): `counter = max(persisted, maxExistingId+1)` — stale/absent values heal upward, but a gap above max (left by a deleted high id) is KEPT (that gap is the point). Legacy files lack the sheet → fallback `maxExisting+1` (byte-for-byte pre-counter behaviour), gaining the sheet on next save. No notices/validation/UI (Inspector renders it read-only). `parser.js` keeps its own `maxExistingId` (the files don't import each other).

**Out of scope (v1):** the parser's blank-id-cell assignment (`id_assigned` notice path) still uses in-sheet `max+1`; the counter heals above whatever it assigns. The residual edge — a blank-cell-assigned id equalling a previously-deleted id — is consciously deferred.

## Mutation dispatcher (ui.js)

`dispatch({ entity, action, id, block, field, value, index })` is the single-writer entry point for all in-app mutations — centralising it is what makes the post-mutation hook unbypassable.

`entity` ∈ `task` / `swimlane` / `link` / `pipe` / `curtain` / `note` / `config` / `baseline`. `action` ∈ `update` / `add` / `delete` / `duplicate` / `moveUp` / `moveDown` (config: `update` only; baseline: `set` / `clear` only, handled before the `VALID_ACTIONS` gate). Unknown entity/action, missing field, or id miss → `console.warn` + no-op (never throws). `add`/`duplicate` use `parser.js` factories and assign a fresh id via `issueId(entity)` (see Id issuance).

**No deletion blocking.** Every delete is allowed (referential integrity is advisory — orphans stay in `projectData`, validation flags, renderer skips). A deleted task whose id a link references just orphans those FKs (re-pointable / clearable / deletable). No `canDeleteTask` / `whyCannotDeleteTask` / `canDeleteSwimlane` helpers exist.

**Derived-field maintenance.** `task.isMilestone` recomputed on task `update`; `swimlane.order` recomputed after any swimlane array mutation. `config.timeline.chartStart/EndDate` recomputed via `recomputeTaskDateRange()` after ANY task-array mutation, each field gated on `!*Explicit` so a user-set date is never clobbered. **Task-gated by design** — a config/Timeline dispatch must NOT re-derive: Timeline clears/sets are two dispatches (value + flag), and an unconditional recompute would fire in the gap before `explicit` is true and overwrite the user's value. So the Timeline clear handler seeds the value to the current `taskDateExtents` extent itself when clearing, since the task-gated hook won't fire on that config dispatch.

**Post-mutation hook** (in order): `validateProject` → `activateTab(activeTab)` → `updateIssuesTabLabel`. `update` runs it unconditionally even if `value` is unchanged. Every mutation branch calls `commitMutation()` (= `markDirty()` + `runPostMutationHook()`) AFTER its guards, NOT the hook directly — so the dirty flag is set strictly on a committed `projectData` change. `runPostMutationHook` stays pure (no flag-set) since it also fires on view-only re-renders via `activateTab`; view changes (tab switch, Chart toggles, selection, inline-editor open/cancel) never go through dispatch, so can't mark dirty.

## Excel file format

`XLSX.read` uses `{ cellDates: true }` so date-formatted cells arrive as JS `Date` objects.

**Entity sheets** (tabular, row 1 = headers): Tasks, Swimlanes, Links, Pipes, Curtains, Notes. Parsed via `parseEntitySheet(worksheet, colDefs)` — header-based, never positional. Missing columns silently take their declared default (backward-compat). Old-name fallbacks live in `colDefs.fallback`; `parser.js` is authoritative. The **Baseline** sheet is also tabular but special — see Baseline comparison.

**Config sheets** (key-value: col A = field, col B = value): Layout, Bars, Timeline, Titles, Style, Typography. Parsed via `parseConfigSheet` → map, read with `kvStr/kvInt/kvFloat/kvBool/kvDate` (each takes an optional `fallback` key, try-new-first).

Schema asymmetry: Timeline has five `show*` fields (years/months/weeks/days/dates) but only four `gridline*` — days and dates share calendar-day granularity, so one `gridlineDays` covers both.

**Legacy Preferences sheet (removed).** `chartDateFormat` (global default task-label date format) formerly lived in `config.preferences` / a Preferences sheet; now in `config.timeline` (`Chart Date Format` Timeline row). The parser still reads the legacy sheet ONLY to seed the fallback default: `kvStr(timelineKV, 'Chart Date Format', legacyPrefsValue)` (Preferences cell if non-empty else `'dd MMM'`). Writer omits the sheet, so old files gain the Timeline row and lose the sheet on next save. `config.preferences` no longer exists.

## Derived fields

- `task.isMilestone = startDate !== null && startDate === finishDate` (null-guard avoids a false positive when both dates are absent).
- `swimlane.order` = 1-based array index (not stored in Excel).
- `config.timeline.chartStartDate/chartEndDate` derived from `min(task.startDate)` / `max(task.finishDate)` via `taskDateExtents(tasks)` in `parser.js` (single source of truth, shared by parse + hook). `chart{Start,End}DateExplicit` record whether the user wrote a non-empty value (via `isNoticeableInput`) — drives the writer's emit-or-leave-empty. **Recomputed live** by the post-mutation hook after any task-array mutation, gated per-field on `!explicit`. The parser's gate derives on `!value`, the hook's on `!explicit` — distinct on purpose (the parser must overwrite a garbage-but-explicit cell, the hook must never touch an explicit one).

## Parse notices (`_parseNotices`)

`projectData._parseNotices` is an array side-channel populated by `parseWorkbook` (seeded `[]` by `createEmptyProjectData()`). Each notice records a non-empty source cell the parser could not interpret and silently defaulted: `{ entity, id, field, rawValue, reason }`.

- `entity` — singular lowercase (same set as the dispatcher). `id` — entity row id (`null` for config rows); rows with a blank/unparseable id cell carry the **newly-assigned** id, not null.
- `field` — JS property name (e.g. `'startDate'`), never the Excel header. `rawValue` — original cell, unmodified.
- `reason` — closed five-value enum, all parser-emitted. `validation.js` reads them via `consumeNotice`; it never emits notices.

Reason values:

| Reason | When emitted |
|---|---|
| `'unparseable_date'` | non-empty value not yielding valid YYYY-MM-DD (`parseDate`/`kvDate` regex-check `toISODate`'s result, so raw `"garbage"` is rejected here, not at `toISODate`). |
| `'unparseable_number'` | non-empty value `parseInt`/`parseFloat` returned `NaN` for (`toInt`/`toFloat`/`kvInt`/`kvFloat`). |
| `'unrecognised_boolean'` | non-empty boolean string that trimmed+lowercased is neither `'yes'` nor `'no'` (`kvBool`/`toBool`). Native booleans pass silently. |
| `'unrecognised_enum'` | non-empty value a `normalize*` function didn't recognise. |
| `'id_assigned'` | id cell blank/missing/unparseable; parser assigned `max(existing)+1`. Suppresses the upstream `unparseable_number` for id cells. Fires on empty id cells too — exception to "empty produces no notice". |

**Empty vs unparseable distinction** (the whole point of the side-channel). Empty cells, whitespace-only strings, and Invalid `Date` objects never produce a notice — only meaningful input the parser ignored does. **Exception:** `'id_assigned'` also fires on blank/missing id cells.

**Notice order:** parser-traversal — entity sheets then config sheets, top-to-bottom, left-to-right within a row. **Not emitted from:** `createEmptyProjectData()`, column-name fallbacks, config key-name fallbacks (British `Colour`, etc.).

**Enum recognition lives in the parser** — `normalize*` functions supply a canonical default before the value leaves `parseWorkbook`, so the renderer's enum fallbacks are unreachable in normal flow and `validation.js` re-encodes no membership lists.

## Validation (`validation.js`)

`validateProject(projectData)` returns `{ errors: [Issue], warnings: [Issue], notices: [Issue] }` — all three keys always present. Pure: no DOM, no side effects, never mutates `projectData`, never throws.

Each `Issue` is `{ entity, id, field, message, value }`. `entity` singular lowercase (same enum as `_parseNotices`); `id` is the row id, `null` for config issues only. `value` is `null` for "missing field" rules, `rawValue` for parse-derived rules, the current field value otherwise.

**Structure.** A thin `validateProject` coordinator calls 14 per-block validators (7 entity + 7 config) in parse traversal order; the 7th entity validator is `validateBaseline` (after `validateNotes`). `validateTimeline` owns the empty-`chartDateFormat` error (no `validatePreferences` — removed).

**`_parseNotices` consumption.** Entity validators filter notices by entity tag, config validators by an explicit field-ownership Set; matching notices emit Issues into the bucket dictated by the locked rule list (same `reason` → different buckets per field). Array stays in place on `projectData`.

**"Missing X" guard** fires only when the field is `null` AND no `_parseNotices` entry exists for `(entity, id, field)` with reason `unparseable_number`/`unparseable_date` (prevents double-emission). **Foreign-key validity Sets** filter `null` ids out, so a missing id doesn't silently satisfy a reference.

**CSS color recognition.** Inline allowlist (CSS Color Level 4 names + `transparent`/`currentcolor`) plus hex/rgb(a)/hsl(a) regexes. `isValidCssColor("")` is `false`; per-field rules decide whether empty is legal (Notes border/fill) or an error (Style colors).

**Link classification (R1/R2).** Both rules run inside an outer gate `pred.finishDate > succ.startDate` (mirrors the renderer's non-forward else-branch; neither imports the other). Inside: R1 (`pred.finishDate >= succ.finishDate`) flags pred at/past succ's finish; R2 flags same-row late-recoverable (`pred.finishDate < succ.finishDate`). **The gate is essential:** without it R1 misfires on zero-lag F-S links to milestone successors (`succ.finishDate === succ.startDate` collapses R1 to `pred.finishDate >= succ.startDate`, tripping valid shared-date deps). Self-links skip R1/R2 — the dedicated Self-link error is their sole issue.

**Call site.** `projectData._validation` is written by the file-load handler (after `parseWorkbook`) and `runPostMutationHook` (New Project relies on the latter via its seeding dispatches). The renderer never consults it — validation is non-gating.

## Renderer (renderer.js)

`renderChart(projectData, opts)` returns a raw SVG string. `opts.showBaseline` (default shown) gates the baseline overlay layer; `opts.showOnlyMoved` (default off) hides zero-slip baselines — see Baseline comparison. Key design rules:

- **Coordinate areas / band height:** `innerX1/innerX2`, `taskRowY1/taskRowY2`, per-visible-scale band height `max(minScaleBandHeight, scaleFontSize × scaleFontToBandHeightFactor)` — formulas in source.
- **Five scale bands** (top-to-bottom): years, months (single-letter from `rendering.monthLetters`), weeks (ISO `"W03"`), dates (numeric day), days (named: Monday/Mon/M). Hidden bands occupy no space. Named-day cells degrade width-adaptively (full→short→letter→empty); the `rendering.scaleMinLabelWidth` gate applies to all bands except days.
- **Render order (painter's algorithm):** ~20 layer accumulators assembled back-to-front into 19 `<g>` groups. The source's z-order comment numbers them 1–15 but reuses some labels and leaves a few unnumbered — so "slot N" references elsewhere follow that comment numbering, not a strict count.
- **Color handling:** colors pass directly to SVG `fill`/`stroke`, no renderer-side validation — invalid names render black; validation lives in `validation.js`.
- **Swimlane backgrounds/labels:** `<rect>` fill = `swimlane.backgroundColor` (parser default `"white"`, no renderer fallback). Label styling is config-level (uniform) via three `config.typography` booleans — `swimlaneLabelBold` (default `true`), `swimlaneLabelItalic`/`swimlaneLabelUnderline` (default `false`): `font-weight` always emitted, `font-style`/`text-decoration` only when true, so all-default output is byte-identical to the former hard-coded bold. Round-tripped `Yes`/`No`; validated in `validateTypography`; UI checkboxes under a "Swimlane label" section.
- **Header/footer text alignment:** per-band via `titles.headerTextAlign` / `footerTextAlign` (inset `rendering.headerFooterTextPadding` for `left`/`right` only); each band emits an inside-edge `<line>` border, suppressed at height 0.
- **Milestones:** centred on `startDate`, size = `bars.milestoneSizeFactor * rowHeight`. `bars.milestoneShape`: `circle` (`milestoneCornerRadius` ignored) or `diamond` (default; rounded corners via `bars.milestoneCornerRadius` 0..1 — no parser clamping, validation flags out-of-range).
- **Bars:** `<rect rx="${bars.taskCornerRadius}">`. **Pattern fills:** `task.fillPattern` → dedup'd `<pattern>` defs keyed by `(fillPattern, fillColor, patternColor)`; `"solid"`/unrecognised → solid, five named patterns → `url(#id)`. `patternUnits="userSpaceOnUse"`, no `x`/`y` so same-row bars share a continuous-field phase. Milestones always solid.
- **Live vertical offset:** `bars.taskBarVerticalOffsetFactor` / `bars.milestoneVerticalOffsetFactor` (default `0`, any sign) shift the whole live bar/milestone (shape, labels, leader, link-attach) by `factor × rowH`; the shifted centre is stored as `taskGeom.rowCenterY`. No range check.
- **Skip rules:** orphaned tasks, `finishDate < startDate`, and fully-out-of-range tasks silently skipped; `row` clamped to 1 when not a positive integer in `[1, swimlane.rowCount]` (parser preserves a cleared null end-to-end).
- **Milestone labels:** always rendered outside, ignoring `task.labelPlacement` (but the parser doesn't override the stored value — the user's setting is kept).
- **Task labels (slot 12):** from `task.labelContent`, date-fns formatted; per-task `task.dateFormat` overrides `config.timeline.chartDateFormat`. *Inside* (bars) truncated via `fontSize * rendering.charWidthFactor` (nothing if `…` alone overflows); *outside* untruncated, past the right edge plus `outsideLabelKissingGap + task.labelOffset`; *leader lines* when `labelOffset > 0` (bars also require `labelPlacement === 'outside'`). **Per-task `labelColor`:** the three fill sites use `task.labelColor || style.<inside|outside>LabelTextColor` (falsy-fallthrough, so `null`/`''` keep config color). Optional/nullable (raw-passthrough, no notice; default `null`); baseline overlay renders no label text. Validation mirrors `patternColor` (invalid non-empty → warning; empty/null = no issue). Form-only (`allowEmpty`).

## config.rendering

All rendering tunables (stroke widths, paddings, factors, corner radii, `monthLetters`, `charWidthFactor`, …) live in `config.rendering` in `createEmptyProjectData()`. **Hard-coded defaults, not Excel-driven** — `parseWorkbook` never touches it, the writer excludes it. Names mostly follow `<element><attribute>`.

## Link rendering

Finish-to-Start dependency arrows.

**Renderable-task lookup (`taskGeom` Map):** built during the bar/milestone pass, keyed by `task.id`. Tasks skipped by the bar pass are absent, so orphaned-link detection is implicit (no duplicate skip logic). Entries also carry per-task dates/geometry (`fillColor`, `rowCenterY`, `isMilestone`, …) consumed by the link classifier and baseline overlay. **Connection points:** bar origin `xFor(finishDate)` / term `xFor(startDate)` (row centre); milestone both = `xFor(startDate)`, so geometry is shape-independent.

**Link classification (render-time, not stored):**
- *Forward* (`pred.finishDate <= succ.startDate`, non-zero travel): routing per `link.routing` — same-row direct horizontal, different-rows V-H-V (midY = mean of endpoints).
- *Vertical forward*: zero-lag forward (`pred.finishDate === succ.startDate`, surfaces as `origX >= termX`) on different rows — pure vertical, routing ignored.
- *Late-recoverable* (`pred.finishDate > succ.startDate AND < succ.finishDate AND different rows`): vertical-only, terminating at succ's near edge.
- *Invalid* (skip): `pred.finishDate >= succ.finishDate`; same-row late; same-row zero-lag forward.
- Milestone successors can't be late-recoverable but routinely appear as vertical-forward successors.

**Rounded corners at bends (HV, VH, AUTO V-H-V only):** quarter-circle arc, radius `min(linkCornerRadius, segA/2, segB/2)`. Per-bend sweep flag by turn direction — gotcha: `(right→down)=1`, `(right→up)=0`, `(down→right)=0`, `(up→right)=1`; AUTO V-H-V's two bends always carry opposite flags.

**Z-order split:** `renderedLinks` pre-computed, then iterated twice — bodies (slot 8) and origin-marker + arrowhead (slot 11) — so bars/milestones sit between the layers. **Arrowheads:** per-link `<polygon>` triangles (`bars.arrowheadSizeFactor * rowH`), not `<marker>` defs — avoids browser `context-fill`/`context-stroke` inconsistency. Origin marker `bars.originMarkerSizeFactor * rowH`. **Both end-marker size factors live in `config.bars`** (Excel-round-tripped, validated ≤0 error / >1 warning), not `config.rendering` — a deliberate low-churn home in the bar/milestone block.

**Milestone pred/succ special cases:** origin marker suppressed when `pred.isMilestone`; arrowhead backed off when `succ.isMilestone` (tip at `milestoneHalf + rendering.linkArrowheadMilestoneGap`). The back-off is calibrated for `termY === succ.rowCenterY`, so vertical-forward → milestone deliberately uses `rowCenterY`. Late-recoverable links can't have milestone successors.

## Pipes / Curtains / Notes rendering

**Pipes** (line in slot 7, badge in `pipe-badges`): vertical reference line at a date with optional badge. Skipped if `date` null or off-chart. Dasharray from `pipe.lineStyle`. Badge only when `name` non-empty; `labelPosition` (float, default `1`) pins top (`1`) / bottom (`0`).

**Curtains** (slots 3 and 7, badge in `curtain-badges`): tinted band + optional boundary lines + name badge. Skipped if `startDate`/`endDate` null, `endDate <= startDate`, or fully off-chart. Slot 3 `<rect>` clamped to `[innerX1, innerX2]`; boundary lines emit only in-range; badge anchors at `xFor(startDate)` (or `xFor(endDate)` if `labelAnchor === 'end'`).

**Badges** (shared shape, pipes + curtains): `<g>` groups `pipe-badges` then `curtain-badges`, after `curtain-edges` before `link-bodies`. Shape via `roundedRightRectPath`: an **open-left tab** (no closing `Z` — line-side edge unstroked but SVG still fills the implied closed subpath), right corners rounded to `bars.taskCornerRadius`. Badge left x + text centre inset right by half the line's stroke width so the fill butts flush to the line's outer edge. Per-entity `invertLabel` (default `false`): off → background fill + `color` border/text; on → solid `color` fill + background text. Empty `name` suppresses the badge.

**Notes** (slot 14, above swimlane labels, below header/footer): free-positioned text annotations. Dimensions are percentages of the task row area (partial overflow renders as-positioned, no clip). **Skip (silent):** `text === ""`, `widthPct <= 0`, `heightPct <= 0`, or fully off-chart.

- **Add-flow defaults diverge from parser blank-cell defaults.** `createEmptyNote()` returns non-zero dims + `text: 'Note'` so a freshly Added note dodges all four skip conditions; parser Notes defs stay at `0` / `''` so blank Excel cells round-trip blank. Two contracts (Excel-blank = "left empty"; Add = "usable starting state") — do not align them.
- **Optional box:** `<rect>` emitted only when `fillColor` OR `borderColor` is non-empty (the empty side → SVG `"none"`).
- **Text wrapping.** AvailW = `noteW - 2 * rendering.notePadding`; ≤ 0 → text skipped (rect still emits). Empty wrapped lines emit `&#160;` (NBSP) to reserve glyph height. Unbreakable tokens char-truncate with `…`; each text-emitting note gets a per-note `<clipPath>`.

**`<defs>` block:** pattern-fill defs and note clip paths share one combined `<defs>` (pattern content collected first, assembled after the notes pass; omitted when neither is needed).

## Baseline comparison

A persisted snapshot of prior task dates, rendered as a tinted **overlay** above the live chart for plan-vs-actual comparison. Cross-cuts data layer, renderer, validation, and UI.

**Data / Excel.** `projectData.baseline` = array of `{ id, startDate, finishDate }` (seeded `[]`, **no `createEmpty*` factory**). `id` is a **reference to an existing task's id**, parsed verbatim with `toInt` skipping `makeIdAssigner`, so baseline rows never emit `'id_assigned'` (bad id → `unparseable_number`, bad dates → `unparseable_date`, all tagged `'baseline'`). The Baseline sheet (`ID`/`Start Date`/`Finish Date`) parses like an entity sheet but is **omitted when empty** (writer: after Notes, before Layout).

**Capture (UI) / dispatcher.** Toolbar `Load Baseline` (hidden `#baselineInput` picker) / `Clear Baseline` — NOT a Data-panel entity (absent from `ENTITY_TABS`). Load parses another `.xlsx`, maps its **tasks** to `{ id, startDate, finishDate }`, sets `showBaseline = true`, dispatches `baseline`/`set` (wholesale replace, `Array.isArray` guard else `[]`); Clear dispatches `baseline`/`clear`.

**Rendering (renderer.js).** Overlay `<g id="baseline-overlay">` between `milestones` and `link-heads` — above live bars/milestones (live arrowheads/labels still on top). Gated by `opts.showBaseline !== false`. Each record matched to a live task by `id` via `taskGeom` (unmatched → skip). **Task-relative appearance:** fill tints from the live task's `fillColor` (patterned → base colour) at `bars.baselineFillOpacity` (the hue is what pairs overlay to live); stroke is full-opacity from `config.style` (`taskStrokeColor`/`milestoneStrokeColor`), so the border stays visible over a like-coloured live element. Size/placement from the five `config.bars` `baseline*` keys below, **not** live `barH`/`milestoneHalf`. **Shape from the baseline's own dates** (`start===finish` → milestone), so a flipped task still overlays correctly. **Baseline milestone marker is ALWAYS an upward triangle**, independent of `bars.milestoneShape`. Skip: unmatched id, null date, `finish<start`, off-chart, non-positive width, plus the only-moved gate.

**Appearance config (`config.bars`).** Five user-editable, persisted, Inspector-visible keys (Bars form): four factors (`baselineBarHeightFactor`, `baselineBarVerticalOffsetFactor`, `baselineMilestoneSizeFactor`, `baselineMilestoneVerticalOffsetFactor`) at `0.01` step; `baselineFillOpacity` at `0.1` step bounded `[0,1]`. Offsets shift the overlay by `factor × rowH` off the matched task's `rowCenterY`; the bar reuses `bars.taskCornerRadius`. Validation: size factors `≤ 0` error / `> 1` warning; opacity out-of-`[0,1]` warning; offsets unchecked.

**View toggles (Chart tab).** Two transient, never-persisted flags in a `.chart-controls` strip shown **only when `baseline.length > 0`**: `showBaseline` (default `true`) hides the whole overlay; `showOnlyMoved` (default `false`) hides zero-slip baselines (gate compares `b.{start,finish}Date` to `taskGeom` live dates; partial change still shows). Both reset on file-load / New Project; `showBaseline` also resets on baseline-load. Save SVG passes both for WYSIWYG.

**Validation.** `validateBaseline` emits **only notices** — one per record whose `id` is non-null and matches no current task. No structural checks (capture keeps data clean, single-author).

**Inspector / Issues.** Inspector renders baseline via a fixed `appendSection` (one of the eight FIXED keys the dynamic walk skips). Issues tab: `baseline` sits in `ISSUE_ENTITY_ORDER` (after `note`) and `ISSUE_ENTITY_LABEL`.

## Current UI

Five-tab layout (left to right): **Chart → Data → Config → Issues → Inspector**. Visible order is DOM order of the `.tabs` buttons in `index.html`; show/hide and click wiring key off element id, so order is independent of the default. **Data remains the landing tab** (the `active` class travels with its button; it is not leftmost).

**Viewport-height flex shell (CSS-only, `index.html`).** `<body>` is a `height: 100vh` flex column (`margin:0` + `box-sizing:border-box`, `overflow:hidden` so only a panel scrolls). Chrome rows (`.app-toolbar`/`#status`/`.tabs`) are `flex:none`; the active panel carries `.app-panel` (`flex:1 1 auto; min-height:0`). **Gotcha — the `min-height:0` chain:** every flex/grid ancestor from `<body>` down to a scrolling pane must set `min-height:0` or the panel overflows instead of scrolling. The strip-bearing panels (`#dataPanel`/`#configPanel`) are nested flex columns so their `.entity-tabs` strip stays fixed while `#entityArea`/`#configArea` fill; the Data `.entity-panel` uses `grid-template-rows: minmax(0,1fr)` so table/form panes stretch equal-height. A new top-level panel needs `.app-panel`; a new strip-bearing panel must replicate the nested-flex setup.

**Data** tab hosts entity-entry panels behind a second-tier strip (order = `ENTITY_TABS`: Swimlanes / Tasks / Links / Pipes / Curtains / Notes; default active selected by name, so **Tasks stays the default** despite not being leftmost). `renderDataPanel()` is the single entry point (tab activation, file load, New Project, every `dispatch()` via the hook). The two-pane skeleton rebuilds on second-tier switch only; the form container survives mutations so commit-on-blur keeps focus.

**Chart** tab calls `renderChart(projectData, { showBaseline, showOnlyMoved })` on every activation into a horizontally-scrollable container ("No project loaded" if no tasks); a `.chart-controls` strip with `Show baseline` / `Only moved` checkboxes precedes it when a baseline is loaded (see Baseline comparison).

**Inspector** tab renders every `projectData` field as flat read-only tables on every activation. **Issues** tab: see its section below.

### Data panel — entity panels

**Editable-cell cue (all entity nav tables).** `data-field` presence marks an inline-editable cell; CSS keys off it — display-only `td:not([data-field])` reads muted, editable `td[data-field]` gets a hover tint over the selected-row background. Sticky `th` paints its bottom rule as an inset box-shadow (collapsed borders drop on scroll).

**Inline editing + non-destructive selection (shared across all five inline-edit tabs).** Double-click a `data-field` cell → `.nav-cell-input`. One canonical `attachInlineEditor(table, entitySingular)` driven by `INLINE_EDIT_REGISTRY` (singular → field → `'text'`/`'date'`/`'select'`; `'select'` also supplies an `options: (field, obj) => [{value,label}]` getter). Date editors seed from the **canonical** stored value (not the formatted cell), commit empty → `null` (text → `''`); `'select'` mirrors `addSelectRow` and auto-opens via `select.showPicker()`. Module-scope `editingCell` `{entity,id,field}` is entity-scoped (one entity's mount/stale-drop is inert in another's render); cleared on commit/cancel (Escape reverts). **Selection:** a pure click routes through `selectTask`/`selectSwimlane`/`selectSimpleEntity(plural,id)` — in-place highlight/toolbar/form swap, nav-table scroll + DOM survive; a click mid-edit sets `nextSelectionIntent` and blurs to commit first (`mousedown`, not `click`, so selection precedes teardown; `left.scrollTop` preserved). `notes` is absent from `INLINE_EDIT_REGISTRY` (multi-line needs a textarea).

**Tasks panel.** Toolbar (Add / Delete / Duplicate / Move Up / Move Down) + nav table + edit form. **Nav columns** `id` / `symbol` / `name` / `startDate` / `finishDate`; `row` (editable), `calendarDays` (read-only `(derived)` via `addReadonlyRow`, value `taskDays(task)`), `swimlaneId` are form-only. `taskDays(task)` = integer span (null→blank, 0 milestone, negative kept) and the `computeBarWidth` basis for the symbol bar. `buildTasksDisplayOrder()` sorts `(swimlane.order, task.row, finishDate, startDate, array index)` ascending (orphans/nulls last via sentinels); display-only, never mutates `projectData.tasks`. **Swimlane grouping:** defined swimlanes show group headers **even when empty**; synthetic `Unassigned` (null id) / `Misassigned` (unmatched id) only when populated. **Chart-row dividers (Tasks-only):** `emitBucket` marks a task `chart-row-start` when its `row` differs from the previous in-bucket task's, drawing a `2px` border-top that out-weighs the ambient `1px` grid under border-collapse (equal/consecutive-null rows cluster; empty chart rows undrawn). **Symbol cell:** duration-proportional marker; `SYMBOL_COL_WIDTH_PX (64)` in `ui.js` must stay in sync with the `.task-symbol-col` CSS width. **Move Up/Down** dispatch `update` on `task.row` (NOT array-reorder), gated `row > 1` / `row < swimlane.rowCount`; `syncTaskRowInput` updates the row input after a same-id move.

**Swimlanes panel.** Nav columns `id` / `color` / `name` / `rowCount` (`order` form-only, read-only `(derived)`). Differs from Tasks: (a) display order = array order, no sort; (b) Move Up/Down dispatch real array-reorder; (c) `syncSwimlaneOrderCell` refreshes the form's read-only `order` cell after a same-id move. **Color cell:** raw `backgroundColor` as cell background, no validation (empty/invalid/null → CSS no-op); selected-row highlight overridden here by design. Inline `name` edit only.

**Links / Pipes / Curtains / Notes panels.** Share `renderSimpleEntityToolbar`, `attachNavTableRowHandlers`, `SIMPLE_ENTITY_REGISTRY` (plural → `{ singular, arr (getter, not a captured ref), renderForm }`) — identical behaviour (no Add prerequisite, no delete-block, array `moveUp`/`moveDown`, no derived-field sync). Tasks/Swimlanes keep dedicated toolbars/handlers — deliberate asymmetry. **Nav columns** trimmed to `id` + inline-editable fields (Links `id`/`fromTaskId`/`line`/`toTaskId`; Pipes `id`/`date`/`name`; Curtains `id`/`startDate`/`endDate`/`name`; Notes `id`/`text`); all else form-only. Inline `'select'` fields: Links `fromTaskId`+`toTaskId`, Pipes `date`, Curtains `startDate`+`endDate` (dates), plus the `name`s. **Links `line` glyph (non-editable):** `buildLinkGlyph(lineColor, lineStyle)` returns an inline `<svg>` mirroring the renderer's same-row link (`stroke-dasharray="4 3"` iff `dashed`); `lineColor` escaped into the attribute but the markup emitted RAW. `.link-fk-col` (`width:50%`) keeps the two FK columns equal-width.

**Links FK posture.** `fromTaskId`/`toTaskId` dropdowns via `buildTaskRefOptions`: always prepends a selectable clear option (`value ''`, label `— (none)`) and, for an orphan id, a `{id} — (missing)` option; nav cells use `formatTaskRefCell` (same null-vs-orphan distinction). The `''` clear value doubles as the unset placeholder, so `addSelectRow`/the inline editor suppress their own `—` once an option list carries a `''` (non-null enum selects like `lineStyle`/`routing` never do). Form and inline share the one options mechanism; both commit `''` → dispatch `null` (clearing the FK — integrity is advisory, `null` is tolerated/flagged), a finite id re-points. Scoped to Links FKs only — Tasks `swimlaneId` does *not* do this yet.

**Notes textarea.** `addTextareaRow` relies on `attachCommitHandlers`' Enter-to-blur gate being `tagName === 'INPUT' && type !== 'date'`, so Enter inserts newlines in textareas. Nav-table preview collapses whitespace via `notePreviewText`.

**Nav-table date display.** `formatNavTableDateCell` → `dates.js` `toLocaleDateDisplay` (canonical YYYY-MM-DD via `toJsDate` + `toLocaleDateString()`, browser locale) so the read-only display matches the native date inputs; stored values stay canonical. Null/empty → blank; malformed → raw string. Form date pickers (`addDateRow`) use `<input type="date">`. Chart labels are separate, driven by `config.timeline.chartDateFormat`.

### Config panel

Form-only tab — no nav table/toolbar/selection. Six sub-tabs in parser order; `renderConfigPanel(panel)` mirrors `renderDataPanel`'s persistent-skeleton pattern (`activeConfigBlock` / `configBlockRenderedFor`, reset in `resetDataPanelState`). `config.rendering` is excluded (Inspector surfaces it via a static `appendSection`, not the dynamic walk).

**Tab labels vs keys.** Two `CONFIG_TABS` labels are presentation-only renames that diverge from their keys/blocks: `bars` → "Elements", `style` → "Colors". The tab `key`, dispatch `block`, `config.bars`/`config.style` keys, Excel sheet names, and Inspector source labels all keep the original names.

**Section headings (presentation-only).** `addFormSection(form, title)` appends a full-width label-only `.form-section-heading` row (no input/focus/commit) to group a form's fields. **Shared by both the Config sub-tab forms and the six Data-tab entity edit forms.** Grouping/order only, no field add/remove/retype.

Timeline date fields commit two dispatches — the date AND the paired (non-user-editable) `*Explicit` flag — so the writer emits user-set vs auto-derive dates correctly. File-load re-renders Config if active.

**Typography Font Family.** Closed `addSelectRow` picklist from module-level `FONT_FAMILY_OPTIONS` (most-common-first; bare family names, no quotes/fallbacks). Pure UI list — never enters `projectData`/Excel. **Orphan-prepend:** a stored value not in the list is prepended so it round-trips. **Empty/null** passes `null` to `addSelectRow` (→ `—` placeholder) WITHOUT coercing the stored value, so the empty-`fontFamily` validation error still fires. A live `.font-preview` specimen below the select shows a `FONT_PREVIEW_PANGRAMS` pangram (`pickPangram()`, never repeating the immediately-prior one) at the live `fontFamily`, or muted `(no font selected)` when empty; updated from the select's own `change` listener, seeded on (re)entry.

### Form helper conventions

`addNumberRow` parsing is the caller's job (`commitFn` does `parseInt`/`parseFloat`); float call sites pass `step: '0.1'`, fine-tuning `*Factor` keys `step: '0.01'`. Enum `<select>` options use the parser's canonical lowercase values, not Excel casing. `opts.decimals` (opt-in) is **display-only**: `toFixed`s the initial input value so accepted precision is discoverable, never touching the stored value or commit path; passed (`decimals: 2`) by the Typography alignment factors, the twelve Bars factor/opacity/radius fields, and the Pipe/Curtain `labelPosition`+`opacity` rows.

`addCheckboxRow` auto-commits on `'change'` (atomic, no Escape-to-revert) and — unlike the raw-string helpers — passes the parsed boolean directly. Config tab plus the pipe/curtain `invertLabel` side-form checkbox (the same-id form guard preserves its state across re-render).

`addColorRow` — text input (source of truth) + native color swatch; `opts.allowEmpty` appends a clear ✕. Text→`#rrggbb` via `parseTextToHex6`; alpha stripped from the swatch but preserved verbatim in the stored text. **Empty-state cue (`allowEmpty` only):** `applyUnsetState` toggles `.is-unset` on the swatch when value is `null`/`''` (a native color well always paints `#000000` when blank, misreading as deliberate black); CSS overrides the well's swatch pseudo-elements under `.is-unset`. Non-`allowEmpty` rows never get the class. Presentation-only — no data-model/commit/validation touch.

Config-tab number commits use local `commitInt` / `commitFloat` helpers — empty → null, non-finite → no-op.

### Issues tab

Read-only surface for `projectData._validation` — renders on tab activation, never re-validates. Four panel states (undefined / clean / no-match / table); search + severity + grouping controls; severity-then-entity grouping; three-state sort cycle.

- Sort is stable, tie-broken to parser-emission order — always from the canonical `flattenIssues` list, never the current view; ID/value place nulls/placeholders last.
- Filter/sort/group state lives in `issuesFilterState`; persists across tab switches, resets on file load. Search keeps focus because only `#issuesBody` re-renders on filter changes.
- Tab label: always `Issues`; when any issue exists a `.tab-dot` span is appended, coloured by worst severity (error > warning > notice), with the tab `title` carrying the non-zero-bucket breakdown. No issues → text-only. Dot is independent of the active tab.

Non-gating: Save xlsx/SVG stay enabled regardless of `_validation`.

### Inspector helpers

`renderEntityTable(container, data, derivedKeys)` suffixes the listed keys' headers with ` (derived)` (`['isMilestone']` tasks, `['order']` swimlanes); `renderConfigTable` is a two-column key/value table.

**Inspector dynamic walk:** `renderInspector` skips the eight fixed top-level keys (entities + `baseline` + `config`) and renders the rest (`_parseNotices`, `_validation`) as diagnostic sections.

### Toolbar buttons

Left to right: **New Project** → **Choose file** → **Save** (xlsx) → **Save As…** → **Save SVG** → **Load Baseline** → **Clear Baseline** → (`margin-left:auto`) **About**, in an `.app-toolbar` flex row (`.app-toolbar-divider` splits project from baseline actions). **About** (`#aboutBtn`, always enabled — never in the disabled gate) opens the native `<dialog id="aboutDialog">` (closed by `#aboutCloseBtn` or Esc), the **single source** of third-party license attribution (SheetJS Apache-2.0, date-fns MIT; full texts in the committed `LICENSES.txt`). Do not duplicate the attribution elsewhere — a later desktop native menu opens the same `#aboutDialog`. New Project replaces `projectData`, clears `loadedFilename` + `fileHandle`, resets data-panel + issues-filter state, activates Data, seeds `"Swimlane 1"`. Save / Save As / Save SVG share the disabled gate (`tasks.length === 0 && swimlanes.length === 0`); Baseline buttons gate via `refreshBaselineButtons`. Save SVG calls `renderChart` (both toggles) regardless of active tab, stays a download/export (no handle). Filenames: xlsx uses `loadedFilename`; SVG swaps to `.svg`.

**File open / save — File System Access API write-back.** A module-scope `fileHandle` (UI state, never in `projectData`) lets xlsx Save write back in place. **Open (Choose file):** FSAA path uses `showOpenFilePicker` + `getFile()`; no-FSAA path drives the hidden `#fileInput` and clears `fileHandle`. Both feed the single shared `loadProjectFromBytes(bytes, name)` (parse → validate → reset state → targeted Issues/Config re-render → status → `renderDataPanel`; tab-preserving). Cancel (`AbortError`) silent; any other open-picker throw (e.g. `file://` SecurityError) falls back to `#fileInput`. **Save:** handle present → silent in-place write via `writeBytesToHandle`; no handle → delegates to `saveWorkbookAs`. **Save As (`saveWorkbookAs`)** — shared by the button and Save's no-handle branch — ALWAYS opens `showSaveFilePicker` (the only difference from Save), adopts the chosen handle, writes, sets `loadedFilename`; no FSAA → `downloadWorkbook` Blob download. A save-picker that won't open is not data loss → cancel silent, other throw falls back to download. A failed **write** IS the data-loss path → `writeBytesToHandle` `alert()`s and leaves handle/filename intact (no auto-reprompt); write `AbortError` silent. **Folder memory:** open + both save pickers share one `XLSX_PICKER_ID` so Chromium reopens the last-used directory per-origin — the only persistence (no handle persistence / IndexedDB). Load Baseline stays a read-only hidden-input pick.

**Status bar (`#status`).** `refreshStatusAndButtons(prefix)` composes a `.status-text` span (`<prefix> — <counts>`, textContent so a filename can't inject markup) + a right-aligned `.status-chip` reflecting `baseline.length`. The prefix is remembered in module-scope `lastStatusPrefix` so a prefix-less recompose keeps it; Load/Clear Baseline call `refreshStatusAndButtons()` so the chip stays live. The HTML's initial "No file loaded" stays text-only (chip only added by the recompose).

**Unsaved-changes guard.** Module-scope `isDirty` — set by `commitMutation` on every committed mutation, cleared by `markClean()` on file-load, New Project (AFTER its seeding dispatches, which mark it dirty), and any successful save (in-place write, Save As, AND Blob-download fallbacks — a completed download counts as saved). NOT cleared on picker `AbortError` or a failed write. Only ever changes via `markDirty`/`markClean`, each calling `updateSaveDirtyCue()` (a `save-dot` span on `#saveBtn`, independent of the empty-data disabled gate). A `window` `beforeunload` handler (`initUI`) `preventDefault`s when dirty for Chromium's native leave confirmation. Save SVG does not touch the flag.

## Excel export (writer.js)

`writeWorkbook(projectData)` returns a `Uint8Array`. **Named-column policy:** columns by header name, not index (column order presentation-only). Sheet order matches the `addSheet` sequence; `config.rendering` excluded. Full sheet order: Tasks, Swimlanes, Links, Pipes, Curtains, Notes, Baseline (if non-empty), Counters, Layout, Bars, Timeline, Titles, Style, Typography.

**Entity sheets:** always emitted even when empty — **except Baseline**, omitted when empty. Derived fields (`isMilestone`, `order`) not written; `task.dateFormat` and null dates write empty. **Date cells:** YYYY-MM-DD → `new Date(y, m-1, d)`; null → empty. Timeline dates obey `chart{Start,End}DateExplicit` — only written when explicit, else left empty so auto-derivation survives save/reload. **Boolean cells:** `"Yes"` / `"No"`. **Config sheets:** two-column with a `["Field","Value"]` header row `parseConfigSheet` picks up as a harmless unused map entry — round-trip safe.

## Desktop packaging (Electron)

`main.js` + `package.json` wrap the unmodified web app as a Windows portable exe. The web sources (`index.html`, root `*.js`, `vendor/`) are served as-is — no runtime Node dependency, no preload, no IPC. `electron` + `electron-builder` are **devDependencies only** (exact-pinned) so the app has zero production deps and no `node_modules` ships. Scripts: `npm start` (`electron .`), `npm run dist` (`electron-builder --win portable` → `dist/`).

**Load-bearing constraint — custom secure protocol, never `file://`.** The renderer is served over an `app://` scheme registered (at module load, before `whenReady` — privileges bake in as Chromium's network service inits on `ready`) with `standard` + **`secure`** + `supportFetchAPI` + `corsEnabled`. The `secure` privilege is what makes `app://` a secure context, which is what re-enables the File System Access API (in-place Save / Save As / folder memory). `loadFile()`'s `file://` origin is NOT a secure context → FSAA denied → those features go dormant, exactly as when `index.html` is double-clicked. Do not switch to `loadFile`/`file://` or drop `secure`.

**URL resolution.** Fixed constant host `app://bundle/`; window loads `app://bundle/index.html`. Resolution is pathname-only against `app.getAppPath()` — using a constant host sidesteps the standard-scheme gotcha where `new URL('app://index.html')` parses `index.html` as the HOST (empty pathname). Nested resources (`vendor/…`) inherit the host via relative refs, so they resolve too. Path-traversal guard via `path.relative` (reject `..`/absolute). **Files read with `fs.promises.readFile`** (asar-transparent in Electron), NOT `net.fetch` — net's `file://` loader has been unreliable inside asar across versions. Default `asar: true` kept (no `asar: false` needed). Explicit `content-type` per extension + `cache-control: no-cache`.

**Window/menu.** Single `BrowserWindow`, `contextIsolation: true`, `nodeIntegration: false`, `webSecurity` at default (on). Menu keeps the default roles — including **View** (Reload / Toggle DevTools / zoom), a deliberate keep for the developer-and-sole-user build — plus one **Help → About** item. About reuses the EXISTING `#aboutDialog` (Slice B, the single attribution source) by calling `showModal()` directly via `executeJavaScript` — guarded against the dialog not existing yet (menu clicked pre-load → no-op) and against being already open (`showModal` throws otherwise). Standard `window-all-closed`/`activate` lifecycle, non-darwin-safe for dev on other OSes.

**Build config (`package.json` `build`):** `appId`, `productName`, `directories.output: dist`, `win.target: portable`, `asar: true`, and a `files` **allowlist** (`main.js`, `index.html`, six root `*.js`, `vendor/**/*`, `LICENSES.txt`) — the allowlist implicitly excludes everything else (`CLAUDE.md`, `node_modules`, `.git`, `dist`, `temp`).
