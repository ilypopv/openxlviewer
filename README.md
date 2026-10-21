# OpenXL Viewer

View and edit **Excel and CSV files** in VS Code. Fast on huge files, and it keeps your workbook's formatting intact.

[![Install from the VS Code Marketplace](https://img.shields.io/badge/VS%20Code-Install%20from%20Marketplace-1f9d6b?logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=ilypopv.openxlviewer)

<img src="docs/images/excel.png" alt="Excel Editor" width="49%"> <img src="docs/images/csv.png" alt="CSV Editor" width="49%">

## Features

- Opens `.xlsx`, `.xlsm`, `.csv` and `.tsv` in a canvas grid that stays smooth on very large files.
- Edit cells with undo/redo; formulas recalculate live (about 150 functions).
- XLSX is saved by patching the original file, so styles, charts, drawings and conditional formatting are preserved.
- Sheet tabs, merged cells, frozen panes, number formats, hyperlinks.
- Find, go to cell, formula bar, selection statistics (sum, average, count, min, max).
- Sort and filter any column. This changes the view only, never the file.

## Install

Search for **OpenXL Viewer** in the Extensions view, or run `ext install ilypopv.openxlviewer`.
If the older "Spreadsheet Viewer" extension is installed, disable it so the two do not compete for the same files.

## Use

- **Excel files** open in the Excel Editor automatically.
- **CSV / TSV**: right-click the file, choose **Open With...**, then **CSV Editor**. For a read-only view run `CSV: Open Preview` (`Shift+Cmd/Ctrl+V`).

| Action | Shortcut |
| --- | --- |
| Edit cell | type, or `F2` |
| Find | `Ctrl/Cmd+F` |
| Go to cell | `Ctrl/Cmd+G` |
| Fill down / right | `Ctrl/Cmd+D` / `Ctrl/Cmd+R` |
| Zoom | `Ctrl/Cmd` + mouse wheel |
| Sort or filter | right-click a column header |

## Limitations

- No row or column insert/delete in XLSX. Charts, images and validation are kept but cannot be edited.
- Array and dynamic-array formulas show cached results and update when the file is opened in Excel.
- Back up important files before editing.

## Settings

Open Settings and search for `csv-preview` to change the separator, header row, line numbers, number format and more.

## Development

```bash
npm install
npm test
npm run package   # builds openxlviewer.vsix
```

Press `F5` to debug.
