# OpenXL Viewer

VS Code extension for viewing and editing CSV, TSV and XLSX files. Built on [Tabulator](https://tabulator.info) (MIT) and [SheetJS CE](https://sheetjs.com) (Apache-2.0); no license keys required.

## Install

From source:

```bash
git clone https://github.com/ilypopv/openxlviewer.git
cd openxlviewer
npm install
npm run package
code --install-extension openxlviewer.vsix --force
```

Then run `Developer: Reload Window`.

## Usage

- **XLSX / XLSM** open in the custom editor by default. Double-click a cell to edit; Enter commits, Shift+Enter inserts a newline, Esc cancels. Undo/redo and save work through VS Code. Sheet tabs are at the bottom.
- **CSV / TSV / TAB**: run `CSV: Open Preview` (explorer or editor title menu, or `Shift+Cmd/Ctrl+V`), or use `Open With` and pick `CSV Editor` to edit. In the editor, use the toolbar to add rows and delete selected rows (click a row number to select).
- `CSV: Clear Preview State` resets saved sort/filter/column widths for the current file.
- Header cells have filter boxes; click a header to sort (Shift for multi-column sort, click again to reverse, third click to clear).

XLSX saving goes through SheetJS CE: cell values and formulas are kept, but styles, charts and conditional formatting are not preserved. Work on a copy of important files.

## Settings

`csv-preview.separator`, `quoteMark`, `hasHeaders`, `capitalizeHeaders`, `resizeColumns` (`all`/`first`/`none`), `lineNumbers` (`none`/`ordinal`/`source`), `commentCharacter`, `skipComments`, `formatValues` (`always`/`never`/`unquoted`), `numberFormat` (.NET-style, default `g2`), and `openStdin`.

## Development

- `npm run compile` / `npm run watch` builds the extension host into `dist/`.
- Press F5 ("Launch Extension") to debug, then open any CSV/XLSX file in the new window.
- Webview code is plain JavaScript in `out/csv.js` and `out/excel.js` (no build step).
