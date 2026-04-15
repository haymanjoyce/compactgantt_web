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

## Domain reference

`temp/DOMAIN_SPEC.md` is the authoritative reference for all domain logic, data model, and business rules. Read it in full before writing any domain-related code.

## Conventions

- **American spelling** throughout: "color" not "colour" in all property names, comments, and UI text
- **camelCase** for all JS property names
- **YYYY-MM-DD** strings for all date values stored in `projectData`

## File responsibilities

| File | Role |
|---|---|
| `index.html` | Script tags, `renderEntityTable`/`renderConfigTable` helpers, event wiring only |
| `parser.js` | Owns `projectData`; exports `parseWorkbook(workbook)` |
| `renderer.js` | (future) SVG generation |

Script loading order: SheetJS CDN → `parser.js` → `renderer.js` (when it exists) → inline script.

## Top-level state

`parser.js` defines and owns `projectData`:

```js
const projectData = {
  tasks: [], swimlanes: [], links: [], pipes: [], curtains: [], notes: [],
  config: { layout: {}, timeline: {}, titles: {}, style: {}, typography: {}, preferences: {} }
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

- **Style** — all 12 keys: `"… Color"` → `"… Colour"`
- **Timeline** — gridline keys: `"Gridline X"` → `"Vertical Gridline X"`
- **Typography** — alignment factors: `"X Alignment Factor"` → `"X Vertical Alignment Factor"`; also `"Header Footer Font Size"` → `"Header & Footer Font Size"`

## Derived fields

- `task.isMilestone = startDate !== null && startDate === finishDate` (null-guard prevents false positive when both dates are absent)
- `swimlane.order` = 1-based sheet-row position (not stored in Excel)
- `config.timeline.chartStartDate/chartEndDate` derived from `min(task.startDate)` / `max(task.finishDate)` if absent from the Timeline sheet

## Current UI (Slice 2 in progress — debug tables)

File input → `parseWorkbook()` → Data panel shows one table per entity type (Tasks, Swimlanes, Links, Pipes, Curtains, Notes) followed by six config key/value tables. Status line: `"Loaded: file.xlsx — N tasks, M swimlanes, …"`. Chart tab not yet implemented.
