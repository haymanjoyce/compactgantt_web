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

## Excel file format

- One worksheet per entity type; relevant sheets so far: **Tasks**, **Swimlanes**
- Column lookups are **header-based**, never positional (uses `XLSX.utils.sheet_to_json` with `cellDates: true`)
- Excel headers use title case with spaces; mapped to camelCase internal keys in `TASK_COLS` / `SWIMLANE_COLS`
- Actual header names confirmed from a real project file:

| Sheet | Excel headers |
|---|---|
| Swimlanes | ID, Title, Row Count, Label Position, Background Color |
| Tasks | ID, Swimlane ID, Swimlane Row, Name, Start Date, Finish Date, Label Content, Label Placement, Label Offset, Fill Color, Fill Pattern, Date Format |

- Missing columns are silently skipped; each field has a declared default in the `*_COLS` map — required for backward compatibility with older project files
- Date fields are converted from Excel serial / JS `Date` objects to `YYYY-MM-DD` strings via `toISODate()`

## Top-level state

```js
const projectData = { tasks: [], swimlanes: [] };
```

This object will grow as further entity types are added. Always extend it here rather than introducing new globals.

## Current UI (Slice 1 — temporary)

A file input loads an `.xlsx`; parsed data is shown as two plain debug tables (Swimlanes first, Tasks second) with a status line. These tables will be replaced in Slice 2.
