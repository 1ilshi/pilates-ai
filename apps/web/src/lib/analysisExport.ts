import type { Worksheet } from "exceljs";

/** Which charts the workbook contains. */
export type ExportScope = "cohort" | "all";

/** Whether each chart sheet carries its data table. */
export type ExportContent = "graphs" | "tables";

/** A single table placed under a chart. */
export interface ExportTable {
  title?: string;
  columns: string[];
  rows: Array<Array<string | number | null | undefined>>;
}

/** One series on a native Excel chart, addressed by column in a table. */
export interface ExportChartSeries {
  /** Series name; defaults to the table header. */
  name?: string;
  /** Table that holds this series; defaults to the chart's table. */
  table?: number;
  /** Value column (or y column for a scatter). */
  column: number;
  /** X column for a scatter chart. */
  xColumn?: number;
  /** Restrict the series to these data rows, relative to the table body. */
  rows?: { start: number; end: number };
  /** Hex colour, e.g. #2dd4bf. */
  color?: string;
}

/** A native Excel chart built from one or more exported tables. */
export interface ExportChartSpec {
  type: "column" | "bar" | "scatter" | "line";
  /** Table used for categories and series; defaults to the first table. */
  table?: number;
  /** Category column for bar/column/line charts. */
  categoriesColumn?: number;
  series: ExportChartSeries[];
  title?: string;
  xTitle?: string;
  yTitle?: string;
  numberFormat?: string;
  legend?: boolean;
  dataLabels?: boolean;
  /** Horizontal bars instead of vertical columns. */
  horizontal?: boolean;
  /** Chart height in pixels. */
  height?: number;
}

/** One chart sheet: a native chart plus the data behind it. */
export interface ExportChart {
  id: string;
  title: string;
  section: "cohort" | "clinic";
  tables: ExportTable[];
  chart: ExportChartSpec;
}

export interface AnalysisExportMeta {
  scope: ExportScope;
  includeTables: boolean;
  /** Enabled cohort names, in the order they are shown on the page. */
  cohorts: string[];
  /** Human-readable names of the per-chart pose filters that narrow the data. */
  poseFilters: string[];
  patients: number;
  sessions: number;
}

export interface AnalysisExportResult {
  fileName: string;
  charts: number;
  /** Charts that could not be built, usually because their table was empty. */
  failedCharts: string[];
}

type ChartsheetSpec = {
  type: ExportChartSpec["type"];
  title?: string;
  series: Array<{
    ref: string;
    xRef?: string;
    name?: string;
    colour?: string;
  }>;
  categories?: string;
  sheet: string;
  anchor: { col: number; row: number };
  width: number;
  height: number;
  dataLabels?: boolean;
  legend?: boolean;
  numberFormat?: string;
  xTitle?: string;
  yTitle?: string;
  horizontal?: boolean;
};

type AddChart = (
  workbook: Uint8Array | ArrayBuffer,
  spec: ChartsheetSpec,
) => Promise<Uint8Array>;

const TABLE_BORDER = {
  top: { style: "thin" as const, color: { argb: "FFE2E8F0" } },
  left: { style: "thin" as const, color: { argb: "FFE2E8F0" } },
  bottom: { style: "thin" as const, color: { argb: "FFE2E8F0" } },
  right: { style: "thin" as const, color: { argb: "FFE2E8F0" } },
};

const SHEET_WIDTHS = Array.from({ length: 14 }, (_, index) => ({
  width: index === 0 ? 30 : 18,
}));

interface TableLayout {
  headerRow: number;
  firstDataRow: number;
  rowCount: number;
}

interface ChartPlan {
  chart: ExportChart;
  chartSheetName: string;
  dataSheetName: string;
  layouts: TableLayout[];
  chartStartRow: number;
}

/** Excel rejects a handful of characters and limits names to 31 characters. */
function sheetName(index: number, title: string): string {
  const clean = (value: string) =>
    value.replace(/[\\/*?:[\]]/g, " ").replace(/\s+/g, " ").trim();

  const prefixed = clean(`${index + 1}. ${title}`);
  if (prefixed.length <= 31) return prefixed;

  // Drop the ordinal before chopping a meaningful word: the sheet order is
  // still obvious, and the title is what the reader navigates by.
  const plain = clean(title);
  if (plain.length <= 31) return plain;

  const cut = plain.slice(0, 31);
  const boundary = cut.lastIndexOf(" ");
  return boundary > 12 ? cut.slice(0, boundary) : cut;
}

function localDateStamp(date: Date): string {
  return [
    date.getFullYear(),
    `${date.getMonth() + 1}`.padStart(2, "0"),
    `${date.getDate()}`.padStart(2, "0"),
  ].join("-");
}

function columnLetter(index: number): string {
  let letters = "";
  let value = index + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

function quoteSheet(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

function rangeRef(
  sheet: string,
  column: number,
  firstRow: number,
  lastRow: number,
): string {
  return `${quoteSheet(sheet)}!$${columnLetter(column)}$${firstRow}:$${columnLetter(
    column,
  )}$${lastRow}`;
}

function addTable(
  worksheet: Worksheet,
  startRow: number,
  table: ExportTable,
): { nextRow: number; layout: TableLayout } {
  let row = startRow;

  if (table.title) {
    const title = worksheet.getRow(row);
    title.getCell(1).value = table.title;
    title.getCell(1).font = { bold: true, size: 11, color: { argb: "FF0F172A" } };
    row += 1;
  }

  const headerRow = row;
  const header = worksheet.getRow(row);
  table.columns.forEach((column, index) => {
    const cell = header.getCell(index + 1);
    cell.value = column;
    cell.font = { bold: true, size: 10, color: { argb: "FFFFFFFF" } };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF0F766E" },
    };
    cell.alignment = { vertical: "middle", wrapText: true };
    cell.border = TABLE_BORDER;
  });
  header.height = 24;
  row += 1;

  const firstDataRow = row;
  table.rows.forEach((values, rowIndex) => {
    const dataRow = worksheet.getRow(row);
    values.forEach((value, index) => {
      const cell = dataRow.getCell(index + 1);
      // Keep `null` as a blank cell: the native chart reads the same range, so
      // missing observations must stay empty rather than become zero.
      cell.value = value ?? null;
      cell.font = { size: 10, color: { argb: "FF1E293B" } };
      cell.alignment = {
        vertical: "middle",
        wrapText: index === 0,
      };
      cell.border = TABLE_BORDER;
      if (rowIndex % 2 === 1) {
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFF1F5F9" },
        };
      }
    });
    row += 1;
  });

  return {
    nextRow: row + 1,
    layout: { headerRow, firstDataRow, rowCount: table.rows.length },
  };
}

function writeTables(
  worksheet: Worksheet,
  startRow: number,
  tables: ExportTable[],
): { layouts: TableLayout[]; nextRow: number } {
  const layouts: TableLayout[] = [];
  let row = startRow;
  for (const table of tables) {
    const result = addTable(worksheet, row, table);
    layouts.push(result.layout);
    row = result.nextRow;
  }
  return { layouts, nextRow: row };
}

function addSummarySheet(
  workbook: import("exceljs").Workbook,
  charts: ExportChart[],
  meta: AnalysisExportMeta,
): void {
  const sheet = workbook.addWorksheet("Summary");
  sheet.columns = [{ width: 26 }, { width: 90 }];

  sheet.mergeCells("A1:B1");
  const title = sheet.getCell("A1");
  title.value = "Pilates AI — Analysis export";
  title.font = { bold: true, size: 16, color: { argb: "FF0F172A" } };
  sheet.getRow(1).height = 24;

  const generated = new Date();
  const rows: Array<[string, string | number]> = [
    ["Generated", generated.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })],
    ["Charts included", meta.scope === "cohort" ? "Cohort charts only" : "All charts"],
    [
      "Cohorts shown",
      meta.cohorts.length > 0
        ? meta.cohorts.join(", ")
        : "No cohorts enabled — cohort charts cover all patients",
    ],
    [
      "Pose filters",
      meta.poseFilters.length > 0 ? meta.poseFilters.join(" · ") : "None — all poses",
    ],
    ["Patients in clinic", meta.patients],
    ["Sessions synced", meta.sessions],
    ["Contents", meta.includeTables ? "Graphs + tables" : "Graphs only"],
    ["Chart type", "Native Excel charts — edit the source cells to redraw"],
    [
      "Chart data",
      meta.includeTables
        ? "Table below each chart"
        : "Hidden 'Chart data' sheet",
    ],
  ];

  rows.forEach(([label, value], index) => {
    const row = index + 3;
    const labelCell = sheet.getCell(row, 1);
    const valueCell = sheet.getCell(row, 2);
    labelCell.value = label;
    labelCell.font = { bold: true, size: 10, color: { argb: "FF475569" } };
    valueCell.value = value;
    valueCell.font = { size: 10, color: { argb: "FF0F172A" } };
    valueCell.alignment = { wrapText: true };
  });

  const noteRow = rows.length + 4;
  sheet.mergeCells(noteRow, 1, noteRow + 2, 2);
  const note = sheet.getCell(noteRow, 1);
  note.value =
    "This workbook mirrors the Analysis page as it is currently displayed. " +
    "Cohort charts use only the enabled cohorts listed above; disabled cohorts are excluded. " +
    "Charts outside the cohort section always cover the whole clinic. " +
    "Every chart is a native Excel chart: change a source value and it redraws.";
  note.font = { italic: true, size: 10, color: { argb: "FF475569" } };
  note.alignment = { vertical: "top", wrapText: true };

  const sheetsRow = noteRow + 4;
  sheet.getCell(sheetsRow, 1).value = "Sheets";
  sheet.getCell(sheetsRow, 1).font = { bold: true, size: 10, color: { argb: "FF475569" } };
  charts.forEach((chart, index) => {
    const cell = sheet.getCell(sheetsRow + index + 1, 2);
    cell.value = chart.title;
    cell.font = { size: 10, color: { argb: "FF0F172A" } };
  });

  sheet.views = [{ state: "frozen", ySplit: 2 }];
}

function addChartTitle(
  worksheet: Worksheet,
  chart: ExportChart,
  dataHint: string,
): void {
  worksheet.mergeCells("A1:F1");
  const title = worksheet.getCell("A1");
  title.value = chart.title;
  title.font = { bold: true, size: 16, color: { argb: "FF0F172A" } };
  worksheet.getRow(1).height = 24;

  const section = worksheet.getCell("A2");
  section.value =
    chart.section === "cohort" ? "Cohort comparison" : "Whole-clinic analysis";
  section.font = { size: 10, color: { argb: "FF0F766E" } };

  const hint = worksheet.getCell("A3");
  hint.value = dataHint;
  hint.font = { italic: true, size: 9, color: { argb: "FF64748B" } };
}

/** Turn the declarative chart spec into the cell ranges chartsheet expects. */
function buildChartsheetSpec(plan: ChartPlan): ChartsheetSpec | null {
  const { chart } = plan;
  const spec = chart.chart;
  const defaultTable = spec.table ?? 0;
  const series: ChartsheetSpec["series"] = [];

  for (const entry of spec.series) {
    const tableIndex = entry.table ?? defaultTable;
    const layout = plan.layouts[tableIndex];
    const table = chart.tables[tableIndex];
    if (!layout || !table || layout.rowCount === 0) continue;

    const startRow =
      layout.firstDataRow + Math.max(0, entry.rows?.start ?? 0);
    const endRow =
      layout.firstDataRow +
      Math.min(layout.rowCount - 1, entry.rows?.end ?? layout.rowCount - 1);
    if (endRow < startRow) continue;

    const name = entry.name ?? table.columns[entry.column];
    if (spec.type === "scatter") {
      if (entry.xColumn === undefined) continue;
      series.push({
        name,
        xRef: rangeRef(plan.dataSheetName, entry.xColumn, startRow, endRow),
        ref: rangeRef(plan.dataSheetName, entry.column, startRow, endRow),
        colour: entry.color,
      });
    } else {
      series.push({
        name,
        ref: rangeRef(plan.dataSheetName, entry.column, startRow, endRow),
        colour: entry.color,
      });
    }
  }

  if (series.length === 0) return null;

  const categoryLayout = plan.layouts[defaultTable];
  const categories =
    spec.type !== "scatter" && spec.categoriesColumn !== undefined && categoryLayout
      ? rangeRef(
          plan.dataSheetName,
          spec.categoriesColumn,
          categoryLayout.firstDataRow,
          categoryLayout.firstDataRow + categoryLayout.rowCount - 1,
        )
      : undefined;

  return {
    type: spec.horizontal ? "bar" : spec.type,
    title: spec.title ?? chart.title,
    series,
    categories,
    sheet: plan.chartSheetName,
    anchor: { col: 0, row: plan.chartStartRow - 1 },
    width: 900,
    height: spec.height ?? 420,
    dataLabels: spec.dataLabels,
    legend: spec.legend,
    numberFormat: spec.numberFormat,
    xTitle: spec.xTitle,
    yTitle: spec.yTitle,
    horizontal: spec.horizontal,
  };
}

async function loadAddChart(): Promise<AddChart> {
  // chartsheet's browser build uses a Buffer global for its zip round-trip.
  const { Buffer: NodeBuffer } = await import("buffer");
  const globalWithBuffer = globalThis as typeof globalThis & {
    Buffer?: typeof NodeBuffer;
  };
  globalWithBuffer.Buffer ??= NodeBuffer;

  const chartsheet = await import("chartsheet");
  const addChart =
    chartsheet.addChart ??
    (chartsheet as unknown as { default?: { addChart?: AddChart } }).default
      ?.addChart;
  if (!addChart) throw new Error("The native chart writer could not be loaded.");
  return addChart;
}

/** Transparent marker-only points read better than Excel's default lines. */
async function useMarkerOnlyScatter(
  workbook: Uint8Array | ArrayBuffer,
): Promise<Uint8Array> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(workbook);
  for (const name of Object.keys(zip.files)) {
    if (!/^xl\/charts\/chart\d+\.xml$/.test(name)) continue;
    const file = zip.file(name);
    if (!file) continue;
    const xml = await file.async("string");
    if (!xml.includes('scatterStyle val="lineMarker"')) continue;
    zip.file(name, xml.replace('scatterStyle val="lineMarker"', 'scatterStyle val="marker"'));
  }
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

/**
 * Build the workbook in the browser and hand it to the user as a download.
 *
 * Every chart gets its own sheet. The chart is a native Excel chart object
 * pointing at cells in the workbook, so editing a value redraws it — unlike an
 * image, which would only be a screenshot of the portal.
 */
export async function exportAnalysisToExcel(
  charts: ExportChart[],
  meta: AnalysisExportMeta,
): Promise<AnalysisExportResult> {
  const [{ Workbook }, addChart] = await Promise.all([
    import("exceljs"),
    loadAddChart(),
  ]);

  const workbook = new Workbook();
  workbook.creator = "Pilates AI Portal";
  workbook.created = new Date();

  addSummarySheet(workbook, charts, meta);

  const dataSheet = meta.includeTables
    ? null
    : workbook.addWorksheet("Chart data");
  if (dataSheet) {
    dataSheet.state = "hidden";
    dataSheet.columns = SHEET_WIDTHS;
  }

  const plans: ChartPlan[] = [];
  let hiddenRow = 1;

  for (const [index, chart] of charts.entries()) {
    const sheet = workbook.addWorksheet(sheetName(index, chart.title));
    sheet.columns = SHEET_WIDTHS;

    const chartHeight = chart.chart.height ?? 420;
    const chartRows = Math.ceil(chartHeight / 20) + 2;

    let layouts: TableLayout[];
    let dataSheetName: string;

    if (meta.includeTables) {
      addChartTitle(sheet, chart, "Native Excel chart, followed by its data table.");
      const written = writeTables(sheet, 4 + chartRows, chart.tables);
      layouts = written.layouts;
      dataSheetName = sheet.name;
    } else {
      addChartTitle(
        sheet,
        chart,
        "Native Excel chart. Source data is on the hidden 'Chart data' sheet.",
      );
      const written = writeTables(dataSheet!, hiddenRow, chart.tables);
      layouts = written.layouts;
      hiddenRow = written.nextRow + 2;
      dataSheetName = dataSheet!.name;
    }

    plans.push({
      chart,
      chartSheetName: sheet.name,
      dataSheetName,
      layouts,
      chartStartRow: 4,
    });
  }

  const failures: string[] = [];
  const specs: Array<{ title: string; spec: ChartsheetSpec }> = [];
  for (const plan of plans) {
    const spec = buildChartsheetSpec(plan);
    if (!spec) {
      failures.push(plan.chart.title);
      continue;
    }
    specs.push({ title: plan.chart.title, spec });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  let withCharts: Uint8Array | ArrayBuffer = buffer;
  let added = 0;
  for (const { title, spec } of specs) {
    try {
      withCharts = await addChart(withCharts, spec);
      added += 1;
    } catch {
      failures.push(title);
    }
  }
  if (added > 0 && specs.some(({ spec }) => spec.type === "scatter")) {
    try {
      withCharts = await useMarkerOnlyScatter(withCharts);
    } catch {
      // Marker-only points are cosmetic; keep the valid workbook.
    }
  }

  const blob = new Blob([withCharts as ArrayBuffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const fileName = `pilates-analysis-${
    meta.scope === "cohort" ? "cohort-charts" : "all-charts"
  }-${localDateStamp(new Date())}.xlsx`;

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Safari needs the URL to stay alive until after the click is handled.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);

  return { fileName, charts: added, failedCharts: failures };
}
