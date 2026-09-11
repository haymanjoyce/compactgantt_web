# compactgantt_web

## Project overview

A compact Gantt chart web application in vanilla JavaScript, HTML, and CSS. The **web app itself** has no build step, bundler, framework, or runtime Node.js/Python — open files directly in a browser or serve with any static file server. A separate, optional **Electron desktop packaging layer** (dev-tooling only, never touching the web sources) wraps it for a Windows portable build.

## Repository layout

Source files live at the repo root; `index.html` is the sole entry point. `/vendor/` holds the two locally-vendored third-party libraries (committed, not gitignored). `main.js` + `package.json` are the Electron packaging layer. `/assets/` holds `icon.ico`. `/temp/` is scratch, ignored by git (along with OS artefacts, `.vscode/`, `node_modules/`, and `dist/`).

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

Script loading order: SheetJS (global `XLSX`) → date-fns (global `dateFns`) → `dates.js` → `parser.js` → `renderer.js` → `writer.js` → `validation.js` → `ui.js` → inline script. Both libraries vendored locally (plain `<script src>`, no defer/async) so the app loads fully offline — a prerequisite for desktop packaging. **Do not repoint to a CDN or re-pin SheetJS off `0.20.3`** (the former unpinned CDN tag resolved to `0.18.5`).

## Date helpers (dates.js)

Non-obvious invariants:

- `toISODate` is timezone-safe (`getFullYear/getMonth/getDate`, **never** `toISOString`) and filters Invalid `Date` (as SheetJS produces on round-tripped empty cells). Non-slash strings pass through; shape validation happens at `parseDate`/`kvDate`.
- `daysBetween` uses `Date.UTC` arithmetic.
- `formatDate`/`isoWeekLabel`/`weekdayName` require the `dateFns` global; ISO week = Monday-first.
- `validation.js` does string-only YYYY-MM-DD comparison and does not import `dates.js`.

## Top-level state and `projectData`

`ui.js` owns the live `projectData` reference, initialised by `createEmptyProjectData()` — **never `null`**. "No file loaded" = `projectData.tasks.length === 0`. File-load and New Project replace `projectData` wholesale; all other writes route through `dispatch()`.

`createEmptyProjectData()` is the single source of truth for the `projectData` shape and all default config values. `parseWorkbook` calls it, then overwrites entity arrays and config sections from the workbook.

## Id issuance (monotonic, counter-backed)

New entity ids are minted from `projectData.counters` — a top-level object (NOT under `config`), keyed by **singular** entity name so the keys match the dispatch `entity` with no plural↔singular translation; each value is the NEXT id to issue, seeded to `1`. **The counter only ever advances**, so deleting the highest-id entity can't let a later add reuse that id — which would silently re-point a baseline overlay record onto the wrong task, the bug this fixes.

`ui.js` exposes `issueId(entity)` (read-then-advance, for dispatcher `add`/`duplicate`) and `predictId(entity)` (read WITHOUT advancing, for toolbars pre-setting `nextSelectionIntent`). Toolbar predicts then synchronously dispatches an add that issues — nothing mints between, so they agree. Fallback when a counter is absent/non-numeric: `maxExistingId(arr)`; `issueId` self-heals. Never throws, never reuses.

**Counters sheet** (key-value, six singular-key rows): writer always emits it; parser reads via `kvInt` gated to integer ≥ 1. **Load-heal** (after each entity array populated): `counter = max(persisted, maxExistingId+1)` — stale/absent values heal upward, but a gap above max (from a deleted high id) is KEPT, since that gap is the point. Legacy files lack the sheet and fall back to `maxExisting+1`. No notices/validation/UI. **Known residual edge:** blank-id-cell assignment (`id_assigned`) still uses in-sheet `max+1`, so a blank-cell-assigned id can equal a previously-deleted one.

## Mutation dispatcher (ui.js)

`dispatch({ entity, action, id, block, field, value, index })` is the single-writer entry point for all in-app mutations — centralising it makes the post-mutation hook unbypassable.

`action` ∈ `update` / `add` / `delete` / `duplicate` / `moveUp` / `moveDown` (config: `update` only; baseline: `set` / `clear` only, handled before the `VALID_ACTIONS` gate). Unknown entity/action, missing field, or id miss → `console.warn` + no-op, never throws. `add`/`duplicate` use `parser.js` factories and assign a fresh id via `issueId(entity)`.

**No deletion blocking.** Every delete is allowed — referential integrity is advisory: orphans stay in `projectData`, validation flags them, the renderer skips them. A deleted task whose id a link references just orphans those FKs. No `canDeleteTask` / `canDeleteSwimlane` helpers exist.

**Derived-field maintenance.** `task.isMilestone` recomputed on task `update`; `swimlane.order` after any swimlane array mutation. `config.timeline.chartStart/EndDate` recomputed after ANY task-array mutation, each field gated on `!*Explicit` so a user-set date is never clobbered. **Task-gated by design** — a config/Timeline dispatch must NOT re-derive: Timeline clears/sets are two dispatches (value + flag), and an unconditional recompute would fire in the gap before `explicit` is true and overwrite the user's value. Hence the Timeline clear handler seeds the value to the current `taskDateExtents` extent itself.

**Post-mutation hook** (in order): `validateProject` → `activateTab(activeTab)` → `updateIssuesTabLabel`. `update` runs it unconditionally even if `value` is unchanged. Every mutation branch calls `commitMutation()` (= `markDirty()` + `runPostMutationHook()`) AFTER its guards, so dirty is set strictly on a committed change. `runPostMutationHook` stays pure (no flag-set) since it also fires on view-only re-renders via `activateTab`; view changes never go through dispatch, so they can't mark dirty.

## Excel file format

`XLSX.read` uses `{ cellDates: true }` so date-formatted cells arrive as JS `Date` objects.

**Entity sheets** (tabular, row 1 = headers): Tasks, Swimlanes, Links, Pipes, Curtains, Notes. Parsed **header-based, never positional**; missing columns silently take their declared default. Old-name fallbacks live in `colDefs.fallback`; `parser.js` is authoritative. The **Baseline** sheet is tabular but special — see Baseline comparison.

**Config sheets** (key-value: col A = field, col B = value): Layout, Bars, Timeline, Titles, Style, Typography. Read with `kvStr/kvInt/kvFloat/kvBool/kvDate`, each taking an optional `fallback` key (try-new-first).

Schema asymmetry: Timeline has five `show*` fields (years/months/weeks/days/dates) but only four `gridline*` — days and dates share calendar-day granularity, so one `gridlineDays` covers both.

**Legacy Preferences sheet (removed).** `chartDateFormat` lives in `config.timeline` (`Chart Date Format` row); `config.preferences` no longer exists. The parser still reads the legacy sheet ONLY to seed that fallback, and the writer omits it — so old files gain the Timeline row and lose the sheet on next save.

**`tableDateFormat` (Timeline sheet, `Table Date Format` row).** date-fns format governing ONLY the nav-table date cells — separate from `chartDateFormat` (chart labels). Default `'dd MMM yyyy'`, standalone/unambiguous unlike `chartDateFormat`'s `'dd MMM'`. No legacy fallback; old files take the default. Empty → `validateTimeline` error, and like `chartDateFormat` it is NOT in the `OWNED` notice set (a `kvStr` read emits no notice).

**The colophon has no Excel presence at all** — the Titles sheet is the six header/footer rows and nothing else. See Renderer.

## Derived fields

- `task.isMilestone = startDate !== null && startDate === finishDate` (null-guard avoids a false positive when both dates are absent).
- `swimlane.order` = 1-based array index (not stored in Excel).
- `config.timeline.chartStartDate/chartEndDate` derived from `min(task.startDate)` / `max(task.finishDate)` via `taskDateExtents(tasks)`, shared by parse + hook. `chart{Start,End}DateExplicit` record whether the user wrote a non-empty value, driving the writer's emit-or-leave-empty and the recompute gating. **Gate asymmetry:** parser derives on `!value`, the post-mutation hook on `!explicit` — distinct on purpose, since the parser must overwrite a garbage-but-explicit cell while the hook must never touch an explicit one.

## Parse notices (`_parseNotices`)

`projectData._parseNotices` is an array side-channel populated by `parseWorkbook` (seeded `[]`). Each notice records a non-empty source cell the parser could not interpret and silently defaulted: `{ entity, id, field, rawValue, reason }`.

- `entity` — singular lowercase (dispatcher set). `id` — entity row id (`null` for config rows); rows with a blank/unparseable id cell carry the **newly-assigned** id, not null.
- `field` — JS property name, never the Excel header. `rawValue` — original cell, unmodified.
- `reason` — closed five-value enum, all parser-emitted: `unparseable_date`, `unparseable_number`, `unrecognised_boolean` (a string that is neither `'yes'` nor `'no'`; native booleans pass silently), `unrecognised_enum` (a `normalize*` didn't recognise it), `id_assigned` (id cell blank/unparseable, parser assigned `max(existing)+1`). `validation.js` reads them via `consumeNotice`; it never emits notices. Non-obvious: `parseDate`/`kvDate` regex-check `toISODate`'s result, so raw `"garbage"` is rejected there rather than at `toISODate`; and `id_assigned` suppresses the upstream `unparseable_number` and fires on empty id cells too — the exception to "empty produces no notice".

**Empty vs unparseable distinction** (the whole point). Empty cells, whitespace-only strings, and Invalid `Date` objects never produce a notice — only meaningful input the parser ignored does. Order is parser-traversal. **Not emitted from:** `createEmptyProjectData()`, column-name fallbacks, or config key-name fallbacks (British `Colour`, etc.).

**Enum recognition lives in the parser** — `normalize*` functions supply a canonical default before the value leaves `parseWorkbook`, so the renderer's enum fallbacks are unreachable in normal flow and `validation.js` re-encodes no membership lists.

## Validation (`validation.js`)

`validateProject(projectData)` returns `{ errors, warnings, notices }` — all three keys always present. Pure: never mutates, never throws. Each `Issue` is `{ entity, id, field, message, value }` (`value` null for missing-field rules, `rawValue` for parse-derived, else current value).

**Structure.** A thin coordinator calls 14 per-block validators (7 entity + 7 config) in parse traversal order. `validateTimeline` owns the empty-`chartDateFormat` and empty-`tableDateFormat` errors. `validateTitles` covers only the six header/footer fields — the colophon is entirely code-tier, so it has no validation surface beyond `validateLayout`'s collapse sum below.

**Layout-collapse check ↔ renderer band stack (two-site sync).** `validateLayout`'s collapse error sums `paddingTop + headerHeight + scales + footerHeight + rendering.colophonHeight + paddingBottom` against `outerHeight`, and must mirror the renderer's band stack term for term — including the code-tier `colophonHeight`, or a genuinely collapsed layout goes unflagged. The scale-band sub-formula likewise mirrors the renderer's `bandH`.

**`_parseNotices` consumption.** Entity validators filter notices by entity tag, config validators by an explicit field-ownership Set. The array stays in place on `projectData`.

**"Missing X" guard** fires only when the field is `null` AND no `_parseNotices` entry exists for `(entity, id, field)` with reason `unparseable_number`/`unparseable_date` — prevents double-emission. **Foreign-key validity Sets** filter `null` ids out, so a missing id doesn't silently satisfy a reference.

**CSS color recognition.** Inline allowlist (CSS Color Level 4 names + `transparent`/`currentcolor`) plus hex/rgb(a)/hsl(a) regexes. `isValidCssColor("")` is `false`; per-field rules decide whether empty is legal (Notes border/fill) or an error (Style colors).

**Link classification (R1/R2).** Both run inside an outer gate `pred.finishDate > succ.startDate` (mirrors the renderer's non-forward else-branch; neither imports the other). R1 (`pred.finishDate >= succ.finishDate`) flags pred at/past succ's finish; R2 flags same-row late-recoverable. **The gate is essential:** without it R1 misfires on zero-lag F-S links to milestone successors, where `succ.finishDate === succ.startDate` collapses R1 to `pred.finishDate >= succ.startDate`. Self-links skip R1/R2 — the dedicated Self-link error is their sole issue.

**Call site.** `projectData._validation` written by the file-load handler and `runPostMutationHook`. The renderer never consults it — validation is non-gating.

## Renderer (renderer.js)

`renderChart(projectData, opts)` returns a raw SVG string. `opts.showBaseline` / `opts.showOnlyMoved` — see Baseline comparison. Key design rules:

- **Root `<svg>` attributes:** `width`/`height` = `layout.outerWidth`/`outerHeight` plus a `viewBox` that must always mirror them exactly — the viewBox is what makes a scaled display (exported SVG in a smaller container) scale rather than clip. Emitted at **three** sites that must stay in sync: the two early-return guards (falsy date range, `totalDays <= 0`) and the main assembled tag.
- **Five scale bands** (top-to-bottom): years, months (single-letter from `rendering.monthLetters`), weeks (ISO `"W03"`), dates (numeric day), days (named). Hidden bands occupy no space. Named-day cells degrade width-adaptively (full→short→letter→empty); the `rendering.scaleMinLabelWidth` gate applies to all bands except days.
- **Render order (painter's algorithm):** ~21 layer accumulators assembled back-to-front into 20 `<g>` groups, `colophon` last. The source's z-order comment numbers them 1–16 but reuses/omits labels — "slot N" follows that numbering, not a strict count.
- **Vertical band stack:** bottom-up `paddingBottom` → colophon → footer → task rows, derived as ONE chain (`colophonY`, then `footerY = colophonY - footerHeight`, then `taskRowY2 = footerY`). `footerY` is simultaneously the footer band's top edge and the task-row bottom, so **the footer band consumes `footerY` and must never recompute its own `y`** — re-deriving either silently overlaps the band. `taskRowY2` is the single source for ~9 downstream sites (gridlines, pipes, curtains, badge areas, `taskRowH` → `rowH` → notes and baseline), so band heights propagate from that one line. `validateLayout` mirrors the sum — see Validation.
- **Color handling:** colors pass directly to SVG `fill`/`stroke`, no renderer-side validation — invalid names render black; validation lives in `validation.js`.
- **Swimlane backgrounds/labels:** `<rect>` fill = `swimlane.backgroundColor` (parser default `"white"`, no renderer fallback). Label styling via three `config.typography` booleans — `swimlaneLabelBold` (default `true`), `swimlaneLabelItalic`/`swimlaneLabelUnderline` (default `false`): `font-weight` always emitted, `font-style`/`text-decoration` only when true.
- **Header/footer text alignment:** per-band via `titles.headerTextAlign` / `footerTextAlign` (inset `rendering.headerFooterTextPadding` for `left`/`right` only); each band emits an inside-edge `<line>` border, suppressed at height 0.
- **Colophon (slot 16, group `colophon`, last):** structural brand band below the footer (or the task rows when `footerHeight` is 0), spanning the header/footer extent. **Unconditional, with no exposed field of any kind** — not presence, size, or color. It reserves its own space in the band stack, so nothing can overlap it and no config can remove it. Right-aligned literal `compactgantt.com`, ASCII only. Top-edge border mirrors the header/footer rule. **Colors are the fixed `rendering.colophon*Color` constants and deliberately do NOT track `config.style`** — an earlier design inherited the footer's palette and went illegible against a restyled footer. The early-return guards emit no colophon — the one deliberate exception to "always present".
- **Milestones:** centred on `startDate`, size = `bars.milestoneSizeFactor * rowHeight`. `bars.milestoneShape`: `circle` (corner radius ignored) or `diamond` (default; rounded corners via `bars.milestoneCornerRadius` 0..1 — no parser clamping, validation flags out-of-range).
- **Bars/pattern fills:** `task.fillPattern` → dedup'd `<pattern>` defs; `"solid"`/unrecognised → solid, milestones always solid. `patternUnits="userSpaceOnUse"` with no `x`/`y`, so same-row bars share a continuous-field phase.
- **Live vertical offset:** `bars.taskBarVerticalOffsetFactor` / `bars.milestoneVerticalOffsetFactor` (default `0`, any sign) shift the whole live bar/milestone — shape, labels, leader, link-attach — by `factor × rowH`; the shifted centre is stored as `taskGeom.rowCenterY`. No range check.
- **Skip rules:** orphaned tasks, `finishDate < startDate`, fully-out-of-range tasks silently skipped; `row` clamped to 1 when not a positive integer in `[1, swimlane.rowCount]`.
- **Milestone labels:** always rendered outside, ignoring `task.labelPlacement` (parser keeps the user's stored value).
- **Task labels (slot 12):** from `task.labelContent`, date-fns formatted; per-task `task.dateFormat` overrides `chartDateFormat`. *Inside* (bars) truncated via `fontSize * rendering.charWidthFactor`; *outside* untruncated, past the right edge plus `outsideLabelKissingGap + task.labelOffset`; *leader lines* when `labelOffset > 0` (bars also require `labelPlacement === 'outside'`). **Per-task `labelColor`:** three fill sites use `task.labelColor || style.<inside|outside>LabelTextColor` — falsy-fallthrough keeps the config color; nullable, form-only, baseline overlay renders no label.

## config.rendering

All rendering tunables (stroke widths, paddings, factors, corner radii, `monthLetters`, `charWidthFactor`, …) live in `config.rendering` in `createEmptyProjectData()`. **Hard-coded defaults, not Excel-driven** — `parseWorkbook` never touches it, the writer excludes it. Names mostly follow `<element><attribute>`.

The six `colophon*` constants live here and are its **only** configuration. **Floors, not preferences:** `colophonFontSize` `6` is the minimum — at 5px antialiasing destroys the URL — and the text grey holds ~6.3:1 on the band, which has to stay unconditional since nothing can restyle it, so don't lighten it. **`colophonAlignmentFactor` is deliberately NOT `typography.headerFooterAlignmentFactor`** — that field is Excel-exposed, and a thin band the user cannot remove must not depend on a value someone tunes for the header. Font family, right inset, and top-rule width are reused from `typography`/`rendering` rather than duplicated. `colophonHeight` is code-tier yet consumes layout space, so `validateLayout` must include it.

## Link rendering

Finish-to-Start dependency arrows.

**Renderable-task lookup (`taskGeom` Map):** built during the bar/milestone pass, keyed by `task.id`. Bar-pass-skipped tasks are absent, so orphaned-link detection is implicit. Entries carry per-task dates/geometry consumed by the link classifier and baseline overlay. **Connection points:** bar origin `xFor(finishDate)` / term `xFor(startDate)` at row centre; milestone both = `xFor(startDate)`, so geometry is shape-independent.

**Link classification (render-time, not stored):**
- *Forward* (`pred.finishDate <= succ.startDate`, non-zero travel): routing per `link.routing` — same-row direct horizontal, different-rows V-H-V.
- *Vertical forward*: zero-lag forward on different rows — pure vertical, routing ignored.
- *Late-recoverable* (`pred.finishDate > succ.startDate AND < succ.finishDate AND different rows`): vertical-only, terminating at succ's near edge.
- *Invalid* (skip): `pred.finishDate >= succ.finishDate`; same-row late; same-row zero-lag forward.
- Milestone successors can't be late-recoverable but routinely appear as vertical-forward successors.

**Rounded corners at bends (HV, VH, AUTO V-H-V only):** quarter-circle arc, radius `min(linkCornerRadius, segA/2, segB/2)`. Per-bend sweep flag by turn direction — gotcha: `(right→down)=1`, `(right→up)=0`, `(down→right)=0`, `(up→right)=1`; AUTO V-H-V's two bends carry opposite flags.

**Z-order split:** `renderedLinks` pre-computed, iterated twice — bodies (slot 8) and origin-marker + arrowhead (slot 11) — so bars/milestones sit between the layers. **Arrowheads:** per-link `<polygon>` triangles, not `<marker>` defs — avoids browser `context-fill`/`context-stroke` inconsistency. **Both end-marker size factors live in `config.bars`** (Excel-round-tripped, validated ≤0 error / >1 warning), not `config.rendering`.

**Milestone pred/succ special cases:** origin marker suppressed when `pred.isMilestone`; arrowhead backed off when `succ.isMilestone`. The back-off is calibrated for `termY === succ.rowCenterY`, so vertical-forward → milestone deliberately uses `rowCenterY`. Late-recoverable links can't have milestone successors.

## Pipes / Curtains / Notes rendering

**Pipes** (line in slot 7, badge in `pipe-badges`): vertical reference line at a date + optional badge. Skipped if `date` null or off-chart. Badge only when `name` non-empty; `labelPosition` (float, default `1`) pins top (`1`) / bottom (`0`).

**Curtains** (slots 3 and 7, badge in `curtain-badges`): tinted band + optional boundary lines + name badge. Skipped if `startDate`/`endDate` null, `endDate <= startDate`, or fully off-chart. Slot 3 `<rect>` clamped to `[innerX1, innerX2]`; boundary lines emit only in-range; badge anchors at `xFor(startDate)`, or `xFor(endDate)` if `labelAnchor === 'end'`.

**Badges** (shared, pipes + curtains): `<g>` groups `pipe-badges` then `curtain-badges`, after `curtain-edges` before `link-bodies`. `roundedRightRectPath` is an **open-left tab** — no closing `Z`, so the line-side edge is unstroked while SVG still fills the implied closed subpath; left x + text centre inset right by half the line's stroke width so the fill butts flush. Per-entity `invertLabel` (default `false`): off → background fill + `color` border/text; on → solid `color` fill + background text. Empty `name` suppresses the badge.

**Notes** (slot 14, above swimlane labels, below header/footer): free-positioned text annotations, dimensions as percentages of the task row area (partial overflow renders as-positioned, no clip). **Skip (silent):** `text === ""`, `widthPct <= 0`, `heightPct <= 0`, or fully off-chart.

- **Add-flow defaults diverge from parser blank-cell defaults.** `createEmptyNote()` returns non-zero dims + `text: 'Note'` so a freshly Added note dodges all four skip conditions; parser Notes defs stay at `0` / `''` so blank Excel cells round-trip blank. Two contracts — do not align them.
- **Optional box:** `<rect>` emitted only when `fillColor` OR `borderColor` non-empty (empty side → SVG `"none"`).
- **Text wrapping.** AvailW ≤ 0 → text skipped, rect still emits. Empty wrapped lines emit `&#160;` (NBSP) to reserve glyph height. Unbreakable tokens char-truncate with `…`; each text-emitting note gets a per-note `<clipPath>`.

**`<defs>` block:** pattern-fill defs and note clip paths share one combined `<defs>`, assembled after the notes pass and omitted when neither is needed.

## Baseline comparison

A persisted snapshot of prior task dates, rendered as a tinted **overlay** above the live chart for plan-vs-actual comparison. Cross-cuts data layer, renderer, validation, and UI.

**Data / Excel.** `projectData.baseline` = array of `{ id, startDate, finishDate }` (seeded `[]`, **no `createEmpty*` factory**). `id` is a **reference to an existing task's id**, parsed verbatim with `toInt` skipping `makeIdAssigner`, so baseline rows never emit `'id_assigned'` (bad id → `unparseable_number`, bad dates → `unparseable_date`, all tagged `'baseline'`). The Baseline sheet parses like an entity sheet but is **omitted when empty**.

**Capture (UI) / dispatcher.** Toolbar `Load Baseline` / `Clear Baseline` — NOT a Data-panel entity. Load parses another `.xlsx`, maps its **tasks** to `{ id, startDate, finishDate }`, sets `showBaseline = true`, dispatches `baseline`/`set` (wholesale replace, `Array.isArray` guard else `[]`); Clear dispatches `baseline`/`clear`.

**Rendering (renderer.js).** Overlay `<g id="baseline-overlay">` between `milestones` and `link-heads`. Gated by `opts.showBaseline !== false`; each record matched to a live task by `id` via `taskGeom` (unmatched → skip). **Appearance:** fill tints from the live task's `fillColor` (patterned → base colour) at `bars.baselineFillOpacity`; stroke full-opacity from `config.style` so it stays visible over a like-coloured live element. Size/placement from the five `config.bars` `baseline*` keys, **not** live `barH`/`milestoneHalf`. **Shape from the baseline's own dates** (`start===finish` → milestone), so a flipped task overlays correctly. **The baseline milestone marker is ALWAYS an upward triangle**, independent of `bars.milestoneShape`.

**Appearance config (`config.bars`).** Five user-editable/persisted keys: four `baseline*` factors + `baselineFillOpacity` (bounded `[0,1]`). Offsets shift by `factor × rowH` off the matched task's `rowCenterY`. Validation: size factors `≤ 0` error / `> 1` warning; opacity out-of-`[0,1]` warning; offsets unchecked.

**View toggles (Chart tab).** Two transient, never-persisted flags in a `.chart-controls` strip shown **only when `baseline.length > 0`**: `showBaseline` (default `true`) hides the overlay; `showOnlyMoved` (default `false`) hides zero-slip baselines (partial change still shows). Both reset on file-load / New Project; `showBaseline` also resets on baseline-load. Save SVG passes both for WYSIWYG.

**Validation.** `validateBaseline` emits **only notices** — one per record whose `id` is non-null and matches no current task. No structural checks (capture keeps data clean, single-author). Inspector renders baseline via a fixed `appendSection`; Issues tab carries `baseline` in `ISSUE_ENTITY_ORDER` (after `note`).

## Current UI

Five-tab layout (left to right): **Chart → Data → Config → Issues → Inspector**. Visible order = DOM order of the `.tabs` buttons; show/hide and click wiring key off element id, so order is independent of the default. **Data remains the landing tab** despite not being leftmost.

**Viewport-height flex shell (CSS-only, `index.html`).** `<body>` is a `height: 100vh` flex column (`overflow:hidden` so only a panel scrolls); the active panel carries `.app-panel`. **Gotcha — the `min-height:0` chain:** every flex/grid ancestor from `<body>` down to a scrolling pane must set `min-height:0` or the panel overflows instead of scrolling. Strip-bearing panels (`#dataPanel`/`#configPanel`) are nested flex columns so their strip stays fixed while `#entityArea`/`#configArea` fill. A new top-level panel needs `.app-panel`; a new strip-bearing panel must replicate the nested-flex setup.

**Data** tab hosts entity-entry panels behind a second-tier strip (order = `ENTITY_TABS`; default active by name, so **Tasks stays the default** despite not being leftmost). `renderDataPanel()` is the single entry point (tab activation, file load, New Project, every `dispatch()` via the hook). The two-pane skeleton rebuilds on second-tier switch only; the form container survives mutations so commit-on-blur keeps focus.

**Chart** tab calls `renderChart(projectData, { showBaseline, showOnlyMoved })` on every activation into a horizontally-scrollable container ("No project loaded" if no tasks). **Inspector** renders every `projectData` field as flat read-only tables on activation.

### Data panel — entity panels

**Editable-cell cue (all entity nav tables).** `data-field` presence marks an inline-editable cell and CSS keys off it. Sticky `th` paints its bottom rule as an inset box-shadow, because collapsed borders drop on scroll.

**Inline editing + non-destructive selection (all five inline-edit tabs).** Double-click a `data-field` cell → `.nav-cell-input`; canonical `attachInlineEditor(table, entitySingular)` driven by `INLINE_EDIT_REGISTRY` (singular → field → editor type; `select` carries an `options` getter). Date editors seed from the **canonical** stored value, not the formatted cell; commit empty → `null` (text → `''`). Escape reverts. **Selection:** a pure click routes through `selectTask`/`selectSwimlane`/`selectSimpleEntity` (in-place swap, DOM/scroll survive); a click mid-edit sets `nextSelectionIntent` and blurs to commit first — bound to `mousedown` not `click`, so selection precedes teardown. `notes` absent from the registry (multi-line needs a textarea).

**Tasks panel.** Toolbar (Add / Delete / Duplicate / Move Up / Move Down) + nav table + edit form. `taskDays(task)` = integer span (null→blank, 0 milestone, negative kept), feeding the read-only `calendarDays` cell and the symbol bar's `computeBarWidth`. `buildTasksDisplayOrder()` sorts `(swimlane.order, task.row, finishDate, startDate, array index)` ascending, orphans/nulls last via sentinels — display-only, never mutates `projectData.tasks`. **Swimlane grouping:** defined swimlanes show group headers **even when empty**; synthetic `Unassigned` (null id) / `Misassigned` (unmatched id) only when populated. **Chart-row dividers (Tasks-only):** `emitBucket` marks `chart-row-start` when a task's `row` differs from the previous in-bucket task's. **`SYMBOL_COL_WIDTH_PX (64)` in `ui.js` must stay in sync with the `.task-symbol-col` CSS width.** **Move Up/Down** dispatch `update` on `task.row` (NOT array-reorder), gated `row > 1` / `row < swimlane.rowCount`.

**Swimlanes panel.** Differs from Tasks: (a) display = array order, no sort; (b) Move Up/Down dispatch real array-reorder; (c) `syncSwimlaneOrderCell` refreshes the read-only `order` cell after a same-id move. **Color cell:** raw `backgroundColor` as cell background, no validation; the selected-row highlight is overridden here by design.

**Links / Pipes / Curtains / Notes panels.** Share `renderSimpleEntityToolbar`, `attachNavTableRowHandlers`, and `SIMPLE_ENTITY_REGISTRY` — identical behaviour (no Add prerequisite, no delete-block, array `moveUp`/`moveDown`, no derived-field sync). Tasks/Swimlanes keep dedicated toolbars/handlers, a deliberate asymmetry. Nav columns are `id` + the inline-editable fields; all else form-only. **Links `line` glyph (non-editable):** `buildLinkGlyph` returns an inline `<svg>` mirroring the renderer's same-row link — `lineColor` escaped, but the markup emitted RAW.

**Links FK posture.** `fromTaskId`/`toTaskId` dropdowns via `buildTaskRefOptions` always prepend a clear option (`value ''`, label `— (none)`) plus, for an orphan id, a `{id} — (missing)` option. The `''` clear value doubles as the unset placeholder, so `addSelectRow`/the inline editor suppress their own `—` once an option list carries a `''` (non-null enum selects like `lineStyle`/`routing` never do). Form and inline share the one mechanism; both commit `''` → dispatch `null` (integrity advisory), a finite id re-points. Scoped to Links FKs only — Tasks `swimlaneId` does *not* do this yet.

**Notes textarea.** `addTextareaRow` relies on `attachCommitHandlers`' Enter-to-blur gate being `tagName === 'INPUT' && type !== 'date'`, so Enter inserts newlines.

**Nav-table date display.** `formatNavTableDateCell` formats canonical YYYY-MM-DD via `formatDate(iso, config.timeline.tableDateFormat)` — an explicit date-fns format, deliberately **locale-independent**: the former `toLocaleDateString()` path hit a Chromium locale bug and showed en-US in the packaged build regardless of OS settings, so do not go back to it. Guards: null/empty → blank; malformed → raw string. Form date pickers (`addDateRow`) use native `<input type="date">` — OS-locale-driven and out of our control, but stored data stays canonical ISO.

### Config panel

Form-only tab — no nav table/toolbar/selection. Six sub-tabs in parser order; `renderConfigPanel(panel)` mirrors `renderDataPanel`'s persistent-skeleton pattern. `config.rendering` excluded (Inspector surfaces it via static `appendSection`).

**Tab labels vs keys.** Two `CONFIG_TABS` labels are presentation-only renames diverging from their keys/blocks: `bars` → "Elements", `style` → "Colors". The tab `key`, dispatch `block`, `config.*` keys, Excel sheet names, and Inspector labels all keep the original names.

**Titles sub-tab sections.** `Header` → `Footer` only. The colophon has no UI control of any kind — everything about it is code-tier.

**Section headings (presentation-only).** `addFormSection(form, title)` appends a label-only row to group fields — shared by the Config sub-tab forms AND the six Data-tab entity edit forms.

Timeline date fields commit **two** dispatches — the date AND the paired `*Explicit` flag — so the writer emits user-set vs auto-derived dates correctly.

**Typography Font Family.** Closed `addSelectRow` picklist from module-level `FONT_FAMILY_OPTIONS` — a pure UI list that never enters `projectData`/Excel. **Orphan-prepend:** a stored value not in the list is prepended so it round-trips. **Empty/null** passes `null` to `addSelectRow` WITHOUT coercing the stored value, so the empty-`fontFamily` validation error still fires. A live `.font-preview` renders a pangram at the current `fontFamily`.

### Form helper conventions

`addNumberRow` parsing is the caller's job; float call sites pass `step: '0.1'`, `*Factor` keys `step: '0.01'`. Enum `<select>` options use the parser's canonical lowercase values. `opts.decimals` is **display-only** — it `toFixed`s the initial input value so accepted precision is discoverable, never touching the stored value or commit path. Config-tab number commits use local `commitInt`/`commitFloat` (empty → null, non-finite → no-op).

`addCheckboxRow` auto-commits on `'change'` — atomic, no Escape-to-revert.

`addColorRow` — text input (source of truth) + native color swatch; `opts.allowEmpty` appends a clear ✕. Alpha is stripped from the swatch but preserved verbatim in the stored text. **Empty-state cue (`allowEmpty` only):** `applyUnsetState` toggles `.is-unset` on the swatch when `null`/`''`, because a native color well paints `#000000` when blank and misreads as deliberate black.

### Issues tab

Read-only surface for `projectData._validation` — renders on tab activation, **never re-validates**. Four panel states; search + severity + grouping controls.

- Sort is stable, tie-broken to parser-emission order — always from the canonical `flattenIssues` list, never the current view; ID/value place nulls last.
- Filter state lives in `issuesFilterState`; persists across tab switches, resets on file load. Search keeps focus because only `#issuesBody` re-renders on filter changes.
- Tab label is always `Issues`, with a `.tab-dot` appended when any issue exists, coloured by worst severity (error > warning > notice) and titled with the breakdown. Independent of which tab is active.

Non-gating: Save xlsx/SVG stay enabled regardless of `_validation`.

### Inspector helpers

`renderEntityTable(container, data, derivedKeys)` suffixes listed keys' headers with ` (derived)`. **Dynamic walk:** `renderInspector` skips the eight fixed top-level keys (entities + `baseline` + `config`) and renders the rest (`_parseNotices`, `_validation`) as diagnostic sections.

### Toolbar buttons

**About** (`#aboutBtn`, always enabled) opens `<dialog id="aboutDialog">` — the **single source** of third-party license attribution (own licences only, not transitive deps; full texts in committed `LICENSES.txt`). Do not duplicate it; the desktop native menu opens the same dialog. **Hand-synced paired values (no build step, unreadable at runtime):** the About `Version` line bumps in lockstep with `package.json` `version`, and a bump also needs `npm install` to re-sync `package-lock.json`'s two root `version` fields (else they silently drift) — **only those two: match on the surrounding root keys, never the bare version string, which can also hit an unrelated dependency sitting on the same number**; an `electron` devDependency bump must move the Electron version in BOTH the About entry and `LICENSES.txt` (same for vendored SheetJS/date-fns).

**EULA — the `License Agreement` section.** Sits ABOVE `Third-party licenses`, reusing the same `<h3>` + `.about-license` markup, closed by a `Full text also in EULA.txt.` footer. **Browse-wrap only:** nothing gates app use on it — no first-launch prompt, no accept/decline flow. **Root `EULA.txt` is the copy source and the dialog is a verbatim hand-synced duplicate** (a third paired value, and in the `files` allowlist so it ships). Sole permitted transform: one `.about-license` paragraph per clause, clause title in the existing `.about-lib` span, txt blank lines becoming paragraph breaks — never reword, summarise, or truncate, and change both sites together.

**Scroll anchor — `<h2 tabindex="-1" autofocus>` is load-bearing, not decoration.** Without it `showModal()` focuses the first focusable descendant (the SheetJS link) and scrolls it into view, which once the EULA grew opened the dialog *past* the `Version` line. The autofocus heading pins `scrollTop 0` on every open and reopen, for both entry paths (both just call `showModal()`). The paired `#aboutDialog h2:focus{outline:none}` exists ONLY because of this. Anything lengthening the dialog above the first link re-arms the bug — keep the attributes and the rule together.

New Project replaces `projectData`, clears `loadedFilename` + `fileHandle`, resets data-panel + issues-filter state, activates Data, seeds `"Swimlane 1"`. Save / Save As / Save SVG share one disabled gate (`tasks.length === 0 && swimlanes.length === 0`); Baseline buttons gate via `refreshBaselineButtons`. Save SVG calls `renderChart` (both toggles) regardless of active tab; xlsx filenames use `loadedFilename`, SVG swaps the extension.

**File open / save — File System Access API write-back.** Module-scope `fileHandle` (UI state, never in `projectData`) lets xlsx Save write back in place. Without FSAA, open drives hidden `#fileInput` and save falls back to a Blob download. Both open paths feed shared `loadProjectFromBytes(bytes, name)`, which is tab-preserving. **Failure policy — the distinction that matters:** a picker that won't open is NOT data loss (cancel silent, other throw → `#fileInput` or download), but a failed **write** IS → `writeBytesToHandle` `alert()`s and leaves handle/filename intact (write `AbortError` silent). **Folder memory:** all three pickers share one `XLSX_PICKER_ID` so Chromium reopens the last-used directory per-origin — the only persistence.

**Status bar (`#status`).** `refreshStatusAndButtons(prefix)` composes a `.status-text` span (textContent, so a filename can't inject markup) plus a `.status-chip` reflecting `baseline.length`. The prefix is remembered in `lastStatusPrefix` so a prefix-less recompose keeps it.

**Unsaved-changes guard.** Module-scope `isDirty` — set by `commitMutation` on every committed mutation, cleared by `markClean()` on file-load, New Project (AFTER its seeding dispatches), and any successful save **including the Blob-download fallbacks** (a completed download counts as saved). NOT cleared on picker `AbortError` or failed write. Changes only via `markDirty`/`markClean`, each calling `updateSaveDirtyCue()`. A `beforeunload` handler `preventDefault`s when dirty — **load-bearing for the desktop build too**, where `main.js`'s reload guard hangs its confirm dialog off that cancellation. Save SVG does not touch the flag.

## Excel export (writer.js)

`writeWorkbook(projectData)` returns a `Uint8Array`. **Named-column policy:** columns by header name, not index (column order presentation-only). Sheet order = `addSheet` sequence (entities, then Baseline if non-empty, Counters, then the six config sheets in parser order); `config.rendering` excluded.

**Entity sheets:** always emitted even when empty — **except Baseline**, omitted when empty. Derived fields (`isMilestone`, `order`) not written. **Date cells:** YYYY-MM-DD → `new Date(y, m-1, d)`; null → empty. Timeline dates obey `chart{Start,End}DateExplicit` — written only when explicit, else left empty so auto-derivation survives save/reload. **Booleans:** `"Yes"` / `"No"`. Config sheets carry a `["Field","Value"]` header row that `parseConfigSheet` picks up as a harmless unused entry.

## Desktop packaging (Electron)

`main.js` + `package.json` wrap the unmodified web app as a Windows portable exe — sources served as-is, no runtime Node dependency, no preload, no IPC. `electron` + `electron-builder` are **devDependencies only** (exact-pinned), so the app has zero production deps and no `node_modules` ships. `npm start` runs it; `npm run dist` builds to `dist/`.

**Load-bearing constraint — custom secure protocol, never `file://`.** The renderer is served over an `app://` scheme registered at module load (before `whenReady` — privileges bake in as Chromium's network service inits on `ready`) with `standard` + **`secure`** + `supportFetchAPI` + `corsEnabled`. The `secure` privilege makes `app://` a secure context, which re-enables the File System Access API (in-place Save / Save As / folder memory). `loadFile()`'s `file://` origin is NOT secure → FSAA dormant, as when `index.html` is double-clicked. Do not switch to `loadFile`/`file://` or drop `secure`.

**URL resolution.** Fixed constant host `app://bundle/`, resolved pathname-only against `app.getAppPath()` — the constant host sidesteps the standard-scheme gotcha where `new URL('app://index.html')` parses `index.html` as the HOST. Nested `vendor/…` inherit the host via relative refs. Path-traversal guard via `path.relative`. **Files read with `fs.promises.readFile`** (asar-transparent), NOT `net.fetch` — net's `file://` loader is unreliable inside asar.

**Window/menu.** Single `BrowserWindow`, `contextIsolation: true`, `nodeIntegration: false`, `webSecurity` on. Menu keeps default roles — including **View**, a deliberate keep for the developer-and-sole-user build — plus **Help → Reload App** then **Help → About**. About reuses the EXISTING `#aboutDialog` via `showModal()` through `executeJavaScript`, guarded against not-yet-loaded (no-op) and already-open (`showModal` throws). Reload App is discoverability only: `reloadApp()` makes the same `webContents.reload()` call the View role makes, inheriting the guard below. **No accelerator** (`Ctrl+R` is View's), and deliberately a `click` handler rather than `{ role: 'reload', label: … }` — the role binds that accelerator implicitly with no clean way to strip it.

**Reload guard (`attachReloadGuard`) — main-process half of the renderer's dirty guard.** Electron drops a cancelled `beforeunload` silently instead of prompting, so without this View → Reload discards unsaved work. Load-bearing on `ui.js`'s `isDirty` `beforeunload` firing at all; covers BOTH Reload and Force Reload, since `will-prevent-unload` is webContents-level and names no command. Cancel/dismiss touches the event, leaving the reload blocked. **Window-close is deliberately NOT guarded.** **GOTCHA — the one-shot `allowNextUnload` flag:** Electron reads `defaultPrevented` the instant the handler returns, so `preventDefault()` from an async `.then()` is a no-op on that event. The dialog must stay async (`showMessageBoxSync` stalls the main-process event loop), so `Reload Anyway` arms the flag and re-issues `reload()`; the re-fired event preventDefaults synchronously. `once('did-finish-load')` disarms it, strictly after the unload decision so it can't race the handler.

**Build config (`package.json` `build`):** a `files` **allowlist** (`main.js`, `index.html`, six root `*.js`, `vendor/**/*`, `assets/**/*`, `LICENSES.txt`, `EULA.txt`) implicitly excludes everything else. `assets/**/*` must stay so `icon.ico` is packed into the asar and reachable at runtime.

**App icon.** `assets/icon.ico` is a **single-source asset** referenced from `build.win.icon`, `BrowserWindow` `icon`, and `<link rel="icon">`. Nothing hand-synced — all three point at the one file, so a redesign only replaces `icon.ico`.

**Display name vs technical identifiers.** User-facing text is **`Compact Gantt`** (spaced) in four spots: `build.productName`, `index.html` `<title>`, the About `<h2>`, and the Help→About menu label. The colophon carries **`compactgantt.com`** alone — no product name, and the only occurrence of that domain in the app's source; it ships in every exported chart and can't be switched off, so the URL must resolve to something. Technical identifiers stay spaceless/lowercase — do NOT space them: npm `name` (`compactgantt`), `build.appId` (`com.compactgantt.app`), repo name (`compactgantt_web`).
