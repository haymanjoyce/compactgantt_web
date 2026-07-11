# compactgantt_web

## Project overview

A compact Gantt chart web application in vanilla JavaScript, HTML, and CSS. No build step, bundler, framework, Node.js, or Python — open files directly in a browser or serve with any static file server.

## Repository layout

Source files (HTML, CSS, JS) live at the repo root; `index.html` is the sole entry point. `/vendor/` holds the two locally-vendored third-party libraries (committed, not gitignored) — see Script loading order. `/temp/` is scratch, ignored by git (along with OS artefacts and `.vscode/`).

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

**Post-mutation hook** (in order): `validateProject` → `activateTab(activeTab)` → `updateIssuesTabLabel` (active tab in module-scope `activeTab`). `update` runs the hook unconditionally even if `value` is unchanged. Every dispatch mutation branch calls `commitMutation()` (= `markDirty()` + `runPostMutationHook()`) AFTER its guards, NOT the hook directly — so the unsaved-changes flag is set strictly on a committed `projectData` change. `runPostMutationHook` itself stays pure (no flag-set) since it also fires on view-only re-renders via `activateTab`; view changes (tab switch, Chart `showBaseline`/`showOnlyMoved` toggles, row selection, inline-editor open/cancel) never go through dispatch, so they can't mark dirty. Cleared by save / load / New Project — see the Toolbar buttons section.

## Excel file format

`XLSX.read` uses `{ cellDates: true }` so date-formatted cells arrive as JS `Date` objects.

**Entity sheets** (tabular, row 1 = headers): Tasks, Swimlanes, Links, Pipes, Curtains, Notes. Parsed via `parseEntitySheet(worksheet, colDefs)` — header-based, never positional. Missing columns silently take their declared default (backward-compat). Old-name fallbacks live in `colDefs.fallback`; `parser.js` is authoritative. The **Baseline** sheet is also tabular but special — see Baseline comparison.

**Config sheets** (key-value: col A = field, col B = value): Layout, Bars, Timeline, Titles, Style, Typography. Parsed via `parseConfigSheet` → map, read with `kvStr/kvInt/kvFloat/kvBool/kvDate` (each takes an optional `fallback` key, try-new-first).

Schema asymmetry: Timeline has five `show*` fields (years/months/weeks/days/dates) but only four `gridline*` — days and dates share calendar-day granularity, so one `gridlineDays` covers both.

**Legacy Preferences sheet (removed).** `chartDateFormat` (the global default task-label date format) lived in a one-field `config.preferences` block / Preferences sheet; it now lives in `config.timeline` (written as a `Chart Date Format` Timeline row). The parser still reads the legacy Preferences sheet — ONLY to seed the fallback default: `kvStr(timelineKV, 'Chart Date Format', legacyPrefsValue)`, where `legacyPrefsValue` is the Preferences cell if non-empty else `'dd MMM'`. So new files read Timeline; old files fall back to Preferences; neither → `'dd MMM'`. The writer omits the Preferences sheet entirely, so an old file gains the Timeline row and loses the sheet on next save. `config.preferences` no longer exists anywhere.

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

**Structure.** A thin `validateProject` coordinator calls 14 per-block validators (seven entity + seven config, the seventh entity validator being `validateBaseline` after `validateNotes`) in parse traversal order. `validateTimeline` owns the empty-`chartDateFormat` error (formerly `validatePreferences`, now removed).

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
- **Swimlane backgrounds/labels:** `<rect>` fill = `swimlane.backgroundColor` (no renderer fallback; parser default `"white"`). Label text styling is config-level (uniform across all swimlanes) via three independent `config.typography` booleans — `swimlaneLabelBold` (default `true`, reproduces the former hard-coded bold), `swimlaneLabelItalic`/`swimlaneLabelUnderline` (default `false`): `font-weight` always emitted (`bold`/`normal`), `font-style="italic"` / `text-decoration="underline"` emitted ONLY when true (inserted between `font-weight` and `fill`), so all-default output is byte-identical to the former literal `font-weight="bold"`. Round-tripped as `Yes`/`No` Typography rows; validated as booleans like other config booleans (`unrecognised_boolean` → warning in `validateTypography`'s OWNED set); UI checkboxes under a "Swimlane label" Typography section.
- **Header/footer text alignment:** per-band via `titles.headerTextAlign` / `footerTextAlign` (inset `rendering.headerFooterTextPadding` for `left`/`right` only); each band emits an inside-edge `<line>` border, suppressed at height 0.
- **Milestones:** centred on `startDate`, size = `bars.milestoneSizeFactor * rowHeight`. `bars.milestoneShape`: `circle` (`milestoneCornerRadius` ignored) or `diamond` (default; rounded corners via `bars.milestoneCornerRadius` 0..1 — no parser clamping, validation flags out-of-range).
- **Bars:** `<rect rx="${bars.taskCornerRadius}">`. **Pattern fills:** `task.fillPattern` drives dedup'd `<pattern>` defs keyed by `(fillPattern, fillColor, patternColor)`; `"solid"`/unrecognised → solid, five named patterns → `url(#id)`. `patternUnits="userSpaceOnUse"`, no `x`/`y` — tiles anchor at SVG origin so same-row bars share a continuous-field phase. Milestones always solid.
- **Live vertical offset:** `bars.taskBarVerticalOffsetFactor` / `bars.milestoneVerticalOffsetFactor` (default `0`, any sign) shift the whole live bar / milestone — shape, labels, leader, link-attach — by `factor × rowH` (`0` = centred). The shifted centre is stored as `taskGeom.rowCenterY`; labels add the same offset to their `taskAlignmentFactor` baseline. No range check.
- **Skip rules:** orphaned tasks, `finishDate < startDate`, and fully-out-of-range tasks silently skipped; `row` clamped to 1 when not a positive integer in `[1, swimlane.rowCount]` (parser preserves a cleared null end-to-end).
- **Milestone labels:** always rendered outside, ignoring `task.labelPlacement` (but the parser doesn't override the stored value — the user's setting is kept).
- **Task labels (slot 12):** from `task.labelContent`, date-fns formatted; per-task `task.dateFormat` overrides `config.timeline.chartDateFormat`. *Inside* (bars only): truncated via `fontSize * rendering.charWidthFactor`, emits nothing if `…` alone overflows. *Outside*: no truncation, past the right edge plus `outsideLabelKissingGap + task.labelOffset`. *Leader lines* when `labelOffset > 0` (bars also require `labelPlacement === 'outside'`). **Per-task `labelColor` override:** the three label-fill sites (bar-inside, bar-outside, milestone-outside) use `task.labelColor || style.<inside|outside>LabelTextColor` — falsy-fallthrough, so both `null` and `''` keep the config color. Optional, nullable (parser raw-passthrough, no normalization, no notice; default `null`); covers milestones since a milestone is a task. Injected raw like other colors (no `escapeXml`). The baseline overlay renders no label text, so it doesn't honor it. Validation: one warning mirroring `patternColor` (non-empty, non-null, invalid CSS → `'Invalid CSS color'`; empty/null = no issue, unlike `fillColor`). Form-only (Tasks form `addColorRow … { allowEmpty: true }`), not a nav column / inline field.

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

**Z-order split:** `renderedLinks` is pre-computed, then iterated twice — bodies (slot 8) and origin-marker + arrowhead (slot 11) — so bars/milestones sit between the layers. **Arrowheads:** per-link `<polygon>` triangles (sized by `bars.arrowheadSizeFactor * rowH`), not `<marker>` defs — avoids browser `context-fill`/`context-stroke` inconsistency. Origin marker sized by `bars.originMarkerSizeFactor * rowH`. **Both end-marker size factors live in `config.bars`** (user-editable, Excel-round-tripped, validated — ≤0 error / >1 warning), not `config.rendering`: a deliberate low-churn home for two link-marker factors in the nominally bar/milestone block.

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

**Rendering (renderer.js).** Overlay `<g id="baseline-overlay">` between the `milestones` and `link-heads` slots — **above** live bars/milestones (live arrowheads/labels still paint on top). Gated by `opts.showBaseline !== false`. Each record matched to a live task by `id` via `taskGeom` (unmatched → no overlay). **Appearance is task-relative:** fill tints from the live task's `fillColor` (patterned bars from base colour) at `bars.baselineFillOpacity` — the tinted fill is what pairs overlay to live by hue. The stroke is full-opacity and takes the live element's stroke colour from `config.style` (bar → `taskStrokeColor`, milestone triangle → `milestoneStrokeColor`), so the border stays visible over a like-coloured live element. Size/placement from the five `config.bars` keys below, **not** the live `barH`/`milestoneHalf`. **Shape derives from the baseline's own dates** (`startDate === finishDate` → milestone; else bar), so a flipped task still overlays correctly. **The baseline milestone marker is ALWAYS an upward triangle**, independent of `bars.milestoneShape`. Skip: unmatched id, null date, `finishDate < startDate`, off-chart, non-positive width, plus the only-moved gate.

**Appearance config (`config.bars`).** Five user-editable, persisted, Inspector-visible keys (Bars form): the four factors (`baselineBarHeightFactor`, `baselineBarVerticalOffsetFactor`, `baselineMilestoneSizeFactor`, `baselineMilestoneVerticalOffsetFactor`) at `0.01` step; `baselineFillOpacity` at `0.1` step bounded `min 0` / `max 1` (matching the Curtains opacity + pipe/curtain label-position fields), two-decimal display. Offsets shift the overlay by `factor × rowH` off the matched task's `rowCenterY`; the bar reuses the live `bars.taskCornerRadius`. Validation: size factors `≤ 0` error / `> 1` warning; opacity out-of-`[0,1]` warning; offsets unchecked.

**View toggles (Chart tab).** Two transient, never-persisted flags in a `.chart-controls` strip shown **only when `baseline.length > 0`**: `showBaseline` (default `true`) hides the whole overlay; `showOnlyMoved` (default `false`) hides zero-slip baselines (gate compares `b.{start,finish}Date` to `taskGeom` live dates; partial change still shows). Both reset on file-load / New Project; `showBaseline` also resets on baseline-load. Save SVG passes both for WYSIWYG.

**Validation.** `validateBaseline` emits **only notices** — one per record whose `id` is non-null and matches no current task. No structural checks (capture keeps data clean, single-author); baseline-tagged parse notices stay Inspector-only.

**Inspector / Issues.** Inspector renders baseline via a fixed `appendSection` (one of the eight FIXED keys the dynamic walk skips). Issues tab: `baseline` sits in `ISSUE_ENTITY_ORDER` (after `note`) and `ISSUE_ENTITY_LABEL`.

## Current UI

Five-tab layout (left to right): **Chart → Data → Config → Issues → Inspector**. Visible order is DOM order of the `.tabs` buttons in `index.html`; show/hide and click wiring key off element id, so order is independent of the default. **Data remains the landing tab** (the `active` class travels with its button; it is not leftmost).

**Viewport-height flex shell (CSS-only, `index.html`).** `<body>` is a `height: 100vh` flex column (`margin: 0` + `box-sizing: border-box` so padding stays inside the viewport, `overflow: hidden` so only a panel scrolls). Chrome rows (`.app-toolbar` / `#status` / `.tabs`) are `flex: none`; the active tab panel carries the shared `.app-panel` class (`flex: 1 1 auto; min-height: 0`) and fills the rest. **Gotcha — the `min-height: 0` chain:** every flex/grid ancestor from `<body>` down to a scrolling pane must set `min-height: 0` or the panel overflows the viewport instead of scrolling. The two strip-bearing panels (`#dataPanel`/`#configPanel`) are themselves nested flex columns (`overflow: hidden`) so their `.entity-tabs` strip (`flex: none`) stays fixed while `#entityArea`/`#configArea` (`flex: 1; min-height: 0`) fill. The Data two-pane `.entity-panel` uses `grid-template-rows: minmax(0, 1fr)` + `height: 100%` so its table/form panes stretch to equal height (bottom borders align even when the form is taller — the Tasks-tab case). `.config-panel` needs `box-sizing: border-box` so its `height: 100%` includes padding/border. Replaces a former hard-coded `max-height: calc(100vh - 220px)` cap. A new top-level panel must get `.app-panel`; a new strip-bearing panel must replicate the nested-flex-column setup.

**Data** tab hosts entity-entry panels behind a second-tier strip (Swimlanes / Tasks / Links / Pipes / Curtains / Notes — visible order is the `ENTITY_TABS` list order; default active is selected by entity name, so **Tasks stays the default** despite not being leftmost). `renderDataPanel()` is the single entry point (tab activation, file load, New Project, every `dispatch()` via the hook). The two-pane skeleton rebuilds on second-tier switch only; the form container survives mutations so commit-on-blur keeps focus.

**Chart** tab calls `renderChart(projectData, { showBaseline, showOnlyMoved })` on every activation into a horizontally-scrollable container ("No project loaded" if no tasks); a `.chart-controls` strip with `Show baseline` / `Only moved` checkboxes precedes it when a baseline is loaded (see Baseline comparison).

**Inspector** tab renders every `projectData` field as flat read-only tables on every activation. **Issues** tab: see its section below.

### Data panel — entity panels

**Editable-cell cue (all entity nav tables).** `data-field` presence marks an inline-editable cell; CSS keys off it — display-only `td:not([data-field])` (under `tr[data-id]`, so group-header / empty rows are spared) reads muted, editable `td[data-field]` gets a subtle hover tint composing over the selected-row background. Sticky `th` paints its bottom rule as an inset box-shadow (collapsed borders drop on scroll).

**Tasks panel.** Toolbar (Add / Delete / Duplicate / Move Up / Move Down) + nav table + edit form. **Nav columns** `id` / `symbol` / `name` / `startDate` / `finishDate` (`id` retained as the link-FK reference; `row` and the derived calendar-day span are form-only — `row` editable, `calendarDays` a read-only `(derived)` row after `finishDate` via `addReadonlyRow(form, 'calendarDays', taskDays(task), …)`; `swimlaneId` form-only). `taskDays(task)` is the integer span (null → blank, 0 milestone, negative for finish<start, all left as-is) — also the `computeBarWidth` basis for the symbol bar. `buildTasksDisplayOrder()` sorts `(swimlane.order, task.row, finishDate, startDate, array index)` ascending — orphans/nulls last via Infinity / `'￿'` sentinels; display-only, `projectData.tasks` order never mutated. **Swimlane grouping:** sorted tasks bucket by `swimlaneId` under group-header rows (no `data-id`); defined swimlanes show headers **even when empty**, synthetic `Unassigned` (null id) / `Misassigned` (non-empty id, no match) only when populated. **Chart-row dividers (Tasks-only):** within each bucket, `emitBucket` marks a task `chart-row-start` when it is not the bucket's first AND its `row` differs (`!==`) from the previous task's — so equal/consecutive-null rows cluster; the CSS draws a `2px #ccc` border-top that out-weighs the ambient `1px #ccc` grid under border-collapse. Empty chart rows (a swimlane row with no tasks) are not drawn. **Symbol cell:** duration-proportional CSS marker (fill = `task.fillColor`, background = swimlane `backgroundColor`); `SYMBOL_COL_WIDTH_PX (64)` in `ui.js` must stay in sync with the `.task-symbol-col` CSS width. **Move Up / Down** dispatch `update` on `task.row` (NOT array-reorder), enabled `row > 1` / `row < swimlane.rowCount`; `syncTaskRowInput` updates the row input after a same-id move. **Inline cell editing:** double-click a `data-field` cell (`.nav-cell-input`). One canonical `attachInlineEditor(table, entitySingular)` serves all five inline-edit tabs, driven by `INLINE_EDIT_REGISTRY` (singular key → `fields` mapping each editable field to `'text'`/`'date'`/`'select'`; a `'select'` field also supplies an `options: (field, obj) => [{value,label}]` getter so the editor stays generic). Date editors seed from the **canonical** stored value, not the formatted display cell, and commit empty → `null` (text → `''`, with select-all). `'select'` builds its `<select>` exactly like `addSelectRow` (`'—'` placeholder only when unset, options from the getter, value seeded from the canonical id) and auto-opens via best-effort `select.showPicker()` on mount. Module-scope `editingCell` (`{ entity, id, field }`) is `entity`-scoped, so one entity's mount block / stale-marker drop is inert in another's render; cleared on commit/cancel (Escape reverts). **Non-destructive selection:** a pure click routes through `selectTask`, updating selection/highlight/toolbar/form in place WITHOUT rebuilding the nav table (scroll + row DOM survive); a click mid-edit instead sets `nextSelectionIntent` and blurs to commit first — `mousedown`, not `click`, so selection precedes the blur teardown.

**Swimlanes panel.** Nav columns `id` / `color` / `name` / `rowCount` (`order` is form-only — read-only `(derived)`). Same shape as Tasks with: (a) display order = array order, no sort; (b) Move Up/Down dispatch real array-reorder actions; (c) `syncSwimlaneOrderCell` parallels `syncTaskRowInput`, refreshing the form's read-only `order` cell (`.entity-form .readonly[data-field="order"]`) after a same-id move (a form-rebuild exception justified by the explicit button). **Color cell:** raw `swimlane.backgroundColor` as cell background, no validation (empty/invalid/null → CSS no-op); selected-row highlight overridden here by design. **Non-destructive selection** via `selectSwimlane` and **inline `name` editing** (the only `data-field` cell; empty → `''`) take the same shared `attachInlineEditor` / `mousedown` commit-first / `left.scrollTop` path as Tasks.

**Links / Pipes / Curtains / Notes panels.** Share `renderSimpleEntityToolbar`, `attachNavTableRowHandlers`, and a `SIMPLE_ENTITY_REGISTRY` (plural → `{ singular, arr (getter, not a captured ref — `projectData` is replaced wholesale), renderForm }`) — the four behave identically (no Add prerequisite, no delete-block, array `moveUp`/`moveDown`, no derived-field sync). Tasks/Swimlanes keep dedicated toolbars/handlers — deliberate asymmetry. **Nav columns** are trimmed to `id` + the inline-editable fields (Links `id`/`fromTaskId`/`line`/`toTaskId`; Pipes `id`/`date`/`name`; Curtains `id`/`startDate`/`endDate`/`name`; Notes `id`/`text`) — all other fields (colors, styles, routing, opacity, anchors, …) are form-only. **Links `line` glyph (non-editable, no `data-field`):** `buildLinkGlyph(lineColor, lineStyle)` returns an inline `<svg>` (origin `<circle>` → styled `<line>`, `stroke-dasharray="4 3"` iff `dashed` → right `<polygon>` arrowhead) mirroring the renderer's same-row link; `lineColor` interpolated raw (browser judges validity) but escaped into the attribute, and the markup is emitted RAW (not via `escapeHtml`). Renders for every link regardless of FK state. The two FK columns share a `.link-fk-col` class (`width: 50%` each) so they stay equal-width proportionally. **Non-destructive selection** via `selectSimpleEntity(entityPlural, id)` — a registry-driven mirror of `selectSwimlane` (in-place highlight/toolbar/form swap, nav-table scroll + DOM survive); `attachNavTableRowHandlers`' pure-click branch routes here, a click mid-edit (focus inside `.entity-form` OR `.entity-nav-table`) sets `nextSelectionIntent` and blurs to commit first. **Inline cell editing — Links/Pipes/Curtains** via the canonical `attachInlineEditor` (see Tasks panel): Links `fromTaskId`+`toTaskId` (both `'select'`), Pipes `name`+`date`, Curtains `name`+`startDate`+`endDate`. `notes` is absent from `INLINE_EDIT_REGISTRY` (multi-line text needs a textarea). All three panels add `left.scrollTop` preservation and an entity-scoped stale-marker drop.

**Links FK posture.** `fromTaskId` / `toTaskId` dropdowns via `buildTaskRefOptions`, which always prepends a single selectable clear option (`value ''`, label `— (none)`) and, for an orphan id (non-null, no matching task), a `{id} — (missing)` option; nav-table FK cells use `formatTaskRefCell` with the same null-vs-orphan distinction. That clear option's `''` value doubles as the unset placeholder, so `addSelectRow` / the inline editor suppress their own when-null `—` placeholder once an option list carries a `''` (no duplicate; non-null enum selects like `lineStyle`/`routing` never carry one). The right-pane form (`addSelectRow`) and the inline nav-cell `'select'` editor share that one options mechanism, so inline ≡ form; both commit identically — `''` → dispatch `null` (clearing the FK; FK integrity is advisory, and `null` is a tolerated/flagged state the editor must reach), a finite id re-points, anything else reverts (inline) / ignores (form). Scoped to Links FKs only — the Tasks `swimlaneId` dropdown does *not* do this yet.

**Notes textarea.** `addTextareaRow` relies on `attachCommitHandlers`' Enter-to-blur gate being `tagName === 'INPUT' && type !== 'date'`, so Enter inserts newlines in textareas. Nav-table preview collapses whitespace via `notePreviewText` before truncation.

**Nav-table date display.** `formatNavTableDateCell` delegates to `dates.js` `toLocaleDateDisplay`, which renders the canonical YYYY-MM-DD via `toJsDate` + `toLocaleDateString()` (browser default locale short date, no explicit locale/options) so the read-only display matches the native date inputs; stored values stay canonical YYYY-MM-DD. Null/empty → blank cell; a malformed stored value falls back to the raw string. Form date pickers (`addDateRow`) use HTML5 `<input type="date">` (browser locale). The renderer's chart labels are a separate concern, still driven by `config.timeline.chartDateFormat`.

### Config panel

Form-only tab — no nav table/toolbar/selection. Six sub-tabs in parser order; `renderConfigPanel(panel)` mirrors `renderDataPanel`'s persistent-skeleton pattern (`activeConfigBlock` / `configBlockRenderedFor`, reset in `resetDataPanelState`). `config.rendering` is excluded (Inspector surfaces it via a static `appendSection`, not the dynamic walk).

**Tab labels vs keys.** Two `CONFIG_TABS` labels are presentation-only renames that diverge from their keys/blocks: `bars` → "Elements", `style` → "Colors". The tab `key`, dispatch `block`, `config.bars`/`config.style` keys, Excel sheet names, and Inspector source labels all keep the original names.

**Section headings (presentation-only).** `addFormSection(form, title)` appends a full-width label-only `.form-section-heading` row (no input, not focusable, no commit wiring) to group a form's fields; CSS gives it a top hairline + spacing, suppressed on the first heading via `:first-child`. **Shared by both the Config sub-tab forms and the six Data-tab entity edit forms** (Tasks/Swimlanes/Links/Pipes/Curtains/Notes) — same helper, same class, styled against the shared `.entity-form` container. Grouping/order only, no field add/remove/retype; entity-form fields were repositioned under their headings without changing any row's builder call.

Timeline date fields commit two dispatches — the date AND the paired (non-user-editable) `*Explicit` flag — so the writer emits user-set vs auto-derive dates correctly. File-load re-renders Config if active.

**Typography Font Family.** A closed `addSelectRow` picklist (not free-text) from module-level `FONT_FAMILY_OPTIONS` (most-common-first, NOT alphabetized; option value === label === bare family name, no quotes/fallback chains). Pure UI list — never enters `projectData.config` / Excel / Inspector; stored value/default/validation unchanged. **Orphan-prepend:** a non-empty stored value not in the list (e.g. a font from a loaded file) is prepended as its own selectable option so it displays and round-trips unchanged. **Empty/null** passes `null` to `addSelectRow` (display-only → `—` placeholder) WITHOUT coercing the stored value, so the empty-`fontFamily` validation error still fires and save still writes empty. A **live font-preview specimen swatch** (bordered/padded `.font-preview`, neutral UI-font chrome) sits directly below the select: sample text gets `style.fontFamily` set imperatively to the live value; non-empty shows a `FONT_PREVIEW_PANGRAMS` pangram via `pickPangram()` (random, never the `lastPangram` shown immediately before, so each update visibly changes); empty shows muted `(no font selected)` via `.is-empty` with no font applied. Updated imperatively from the select's own `change` listener (additive — the form isn't rebuilt on same-block config changes) and seeded from the stored value on (re)entry.

### Form helper conventions

`addNumberRow` parsing is the caller's job (`commitFn` does `parseInt`/`parseFloat`); float call sites pass `step: '0.1'`, fine-tuning `*Factor` keys (live/baseline vertical-offset, baseline appearance) `step: '0.01'`. Enum `<select>` options use the canonical lowercase values the parser stores, not Excel casing. `opts.decimals` (opt-in) is **display-only**: it `toFixed`s the initial input value (finite → fixed decimals, null/empty/non-finite → blank) so accepted precision is discoverable, never touching the stored value or commit/parse path; passed (`decimals: 2`) by the Typography alignment factors, the twelve Bars factor/opacity/radius fields, and the Pipe/Curtain `labelPosition`+`opacity` rows — `taskCornerRadius` (integer) and other callers omit it and are unaffected.

`addCheckboxRow` auto-commits on `'change'` (atomic, no Escape-to-revert) and — unlike the raw-string helpers — passes the parsed boolean directly. Config tab plus the pipe/curtain `invertLabel` side-form checkbox (the same-id form guard preserves its state across re-render).

`addColorRow` — text input (source of truth) + native color swatch; `opts.allowEmpty` appends a clear ✕. Text→`#rrggbb` sync via `parseTextToHex6` (hex fast-path, else a transient probe element); alpha stripped from the swatch but preserved verbatim in the stored text. Swatch/✕ auto-commit and update `preEditValue` so a later Escape doesn't desync. **Empty-state swatch cue (`allowEmpty` only):** a native color well always paints a filled colour (`#000000` when blank, misreading as deliberate black), so a centralized `applyUnsetState` helper toggles `.is-unset` on the swatch whenever the value is `null`/`''` (a typed-but-invalid non-empty string counts as set) — driven off the existing initial-build / text-commit / swatch-`change` / clear-✕ events, no new listeners. CSS (index.html) overrides the well's `::-webkit-color-swatch` / `::-moz-color-swatch` under `.is-unset` with `!important` (muted fill + thin diagonal slash). Non-`allowEmpty` rows never receive the class (helper no-ops), so set/required swatches are visually unchanged. Presentation-only — no data-model/commit/validation touch.

Config-tab number commits use local `commitInt` / `commitFloat` helpers — empty → null, non-finite → no-op.

### Issues tab

Read-only surface for `projectData._validation` — renders on tab activation, never re-validates. Four panel states (undefined / clean / no-match / table); search + severity + grouping controls; severity-then-entity grouping; three-state sort cycle.

- Sort is stable, tie-broken to parser-emission order — always from the canonical `flattenIssues` list, never the current view; ID/value place nulls/placeholders last regardless of direction.
- Filter/sort/group state lives in `issuesFilterState`; persists across tab switches, resets on file load. Search keeps focus because only `#issuesBody` re-renders on filter changes.
- Tab label: always the word `Issues`; when any issue exists a `.tab-dot` child span is appended, coloured by the worst severity present (error > warning > notice), and the tab `title` carries the non-zero-bucket breakdown (singular/plural, comma-separated). No issues / no `_validation` → text-only, title cleared. Dot is independent of the active tab.

Non-gating: Save xlsx/SVG stay enabled regardless of `_validation`.

### Inspector helpers

`renderEntityTable(container, data, derivedKeys)` suffixes the listed keys' headers with ` (derived)` (`['isMilestone']` tasks, `['order']` swimlanes); `renderConfigTable` is a two-column key/value table.

**Inspector dynamic walk:** `renderInspector` skips the eight fixed top-level keys (entities + `baseline` + `config`) and renders the rest (`_parseNotices`, `_validation`) as diagnostic sections.

### Toolbar buttons

Left to right: **New Project** → **Choose file** → **Save** (xlsx) → **Save As…** (xlsx) → **Save SVG** → **Load Baseline** → **Clear Baseline** → (`margin-left:auto`) **About**, wrapped in an `.app-toolbar` flex row (a `.app-toolbar-divider` splits project from baseline actions). **About** (`#aboutBtn`, always enabled — never in the disabled gate) opens the native `<dialog id="aboutDialog">`, closed by `#aboutCloseBtn` or native Esc. That dialog is the **single source** of third-party license attribution (SheetJS Apache-2.0, date-fns MIT — copyright lines lifted verbatim from each vendored package's LICENSE); full texts live in the committed `LICENSES.txt` at repo root. Do not duplicate the attribution elsewhere — a later desktop native menu opens the same `#aboutDialog`. New Project replaces `projectData`, clears `loadedFilename` + `fileHandle`, resets data-panel + issues-filter state, activates Data, then seeds `"Swimlane 1"`. Save / Save As / Save SVG share the disabled gate (`tasks.length === 0 && swimlanes.length === 0`); Baseline buttons gate via `refreshBaselineButtons`. Save SVG calls `renderChart` (both toggles) regardless of active tab and stays a download/export (no handle). Filenames: xlsx uses `loadedFilename` (updated to the chosen name on Save As); SVG swaps the extension for `.svg`.

**File open / save — File System Access API write-back.** A module-scope `fileHandle` (UI state, never in `projectData`) lets xlsx Save write back in place. **Open (Choose file):** FSAA path uses `window.showOpenFilePicker` (`.xlsx` filter, `XLSX_PICKER_TYPES`), adopts the handle, reads via `getFile()`/`arrayBuffer()`; no-FSAA path drives the hidden `#fileInput` (`click()`, change handler resets `e.target.value` so re-selecting re-fires) and clears `fileHandle`. Both feed the single shared `loadProjectFromBytes(bytes, name)` (parse → validate → reset state → targeted Issues/Config re-render → `refreshStatusAndButtons('Loaded: …')` → `renderDataPanel`; tab-preserving, never `activateTab('data')`). Cancel (`AbortError`) is silent; any other open-picker throw (e.g. `file://` SecurityError) falls back to `#fileInput`. **Save:** handle present → silent in-place write via `writeBytesToHandle` (`createWritable`/`write`/`close`), no status change; no handle (e.g. after New Project) → delegates to `saveWorkbookAs`. **Save As (`saveWorkbookAs`)** — shared by the Save As button and Save's no-handle branch — ALWAYS opens `showSaveFilePicker` regardless of any current handle (that's the only difference from Save), then adopts the chosen handle, writes, sets `loadedFilename`, and recomposes status via `refreshStatusAndButtons('Saved: …')`; no FSAA → `downloadWorkbook` Blob download. A save-picker that won't open is not data loss → cancel silent, other throw falls back to download (no alert). A failed **write** is the data-loss path → `writeBytesToHandle` `alert()`s + `console.warn`s and leaves handle/filename intact (no auto-reprompt); `AbortError` on write is silent. **Folder memory:** the open picker and both save pickers share one `XLSX_PICKER_ID` so Chromium reopens the last-used directory per-origin across sessions — the only persistence (no handle persistence / IndexedDB). Load Baseline stays a read-only hidden-input pick (no handle).

**Status bar (`#status`).** `refreshStatusAndButtons(prefix)` composes it: a `.status-text` span (`<prefix> — <counts>`, set as textContent so a filename can't inject markup) + a right-aligned `.status-chip` reflecting `baseline.length` (present "✓ baseline" / absent "no baseline"). The prefix ("Loaded: <name>" / "New project") is remembered in module-scope `lastStatusPrefix` so a prefix-less recompose keeps it; Load/Clear Baseline now call `refreshStatusAndButtons()` (not bare `refreshBaselineButtons`) so the chip stays live after baseline changes, not just file-load / New Project. The HTML's initial "No file loaded" stays text-only (no chip — the chip is only added by the recompose).

**Unsaved-changes guard.** Module-scope `isDirty` (UI state, never in `projectData`) — set by `commitMutation` on every committed mutation (see Mutation dispatcher → Post-mutation hook), cleared by `markClean()` on file-load (`loadProjectFromBytes`), New Project (AFTER its seeding dispatches, which mark it dirty), and any successful save: in-place handle write (on `writeBytesToHandle` truthy), Save As write-ok, AND the Blob-download fallbacks (a completed download counts as saved). NOT cleared on picker `AbortError` (cancel) or a failed write. `isDirty` only ever changes via `markDirty`/`markClean`, each calling `updateSaveDirtyCue()` — adds/removes a `<span class="save-dot">●</span>` child on `#saveBtn` (mirrors `.tab-dot`; independent of the empty-data disabled gate, which only touches `.disabled`). A `window` `beforeunload` handler (`initUI`) calls `preventDefault` + sets `returnValue` when dirty so Chromium shows its native leave/reload confirmation (message browser-controlled). Save SVG does not touch the flag.

## Excel export (writer.js)

`writeWorkbook(projectData)` returns a `Uint8Array`. **Named-column policy:** columns identified by header name, not index; column order is presentation-only. Sheet order matches the `addSheet` sequence; `config.rendering` excluded.

**Entity sheets:** header row + one data row per entity, always emitted even when empty — **except Baseline**, omitted entirely when empty. Derived fields (`isMilestone`, `order`) not written; `task.dateFormat` and null dates write as empty cells.

**Date cells:** YYYY-MM-DD → `new Date(y, m-1, d)`; null → empty. Timeline dates obey `chart{Start,End}DateExplicit` — only written when explicit, else left empty so auto-derivation survives save/reload.

**Boolean cells:** `"Yes"` / `"No"` (matches `kvBool`). **Config sheets:** two-column with a `["Field", "Value"]` header row that `parseConfigSheet` picks up as a harmless unused map entry — round-trip safe.
