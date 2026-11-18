import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

import {
  addChartsInOnePass,
  ExportCancelledError,
  type BatchChartSpec,
} from "../src/lib/exportChartsBatch.ts";

const require = createRequire(import.meta.url);
const ExcelJS = require("exceljs");
const JSZip = require("jszip");

async function sampleWorkbook(): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Data");
  sheet.addRow(["Pose", "Score", "Angle"]);
  sheet.addRow(["pose1", 88, 120]);
  sheet.addRow(["pose2", 91, 135]);
  return (await workbook.xlsx.writeBuffer()) as Uint8Array;
}

const specs: BatchChartSpec[] = [
  {
    type: "column",
    title: "Scores",
    series: [{ ref: "'Data'!$B$2:$B$3", name: "Score" }],
    categories: "'Data'!$A$2:$A$3",
    sheet: "Data",
    anchor: { col: 0, row: 6 },
    width: 600,
    height: 340,
  },
  {
    type: "scatter",
    title: "Score vs angle",
    series: [
      {
        ref: "'Data'!$B$2:$B$3",
        xRef: "'Data'!$C$2:$C$3",
        name: "Score",
      },
    ],
    sheet: "Data",
    anchor: { col: 8, row: 6 },
    width: 600,
    height: 340,
  },
];

test("all charts are written in one ZIP pass and the package validates", async () => {
  const result = await addChartsInOnePass(await sampleWorkbook(), specs);
  const zip = await JSZip.loadAsync(result);
  const chartParts = Object.keys(zip.files).filter((name) =>
    /^xl\/charts\/chart\d+\.xml$/.test(name),
  );
  assert.equal(chartParts.length, specs.length, "one chart part per spec");

  const scatterXml = await zip.file(chartParts[1]!).async("string");
  assert.match(scatterXml, /scatterStyle val="marker"/);
  assert.doesNotMatch(scatterXml, /scatterStyle val="lineMarker"/);

  const drawingName = Object.keys(zip.files).find((name) =>
    /^xl\/drawings\/drawing\d+\.xml$/.test(name),
  )!;
  const drawingXml = await zip.file(drawingName).async("string");
  const shapeIds = [...drawingXml.matchAll(/<xdr:cNvPr id="(\d+)"/g)].map(
    (match) => match[1],
  );
  assert.equal(shapeIds.length, specs.length, "one anchor per chart");
  assert.equal(new Set(shapeIds).size, shapeIds.length, "shape ids are unique");

  const chartsheet = await import("chartsheet");
  const validate =
    chartsheet.validate ??
    (chartsheet as unknown as { default: typeof chartsheet }).default.validate;
  const report = await validate(result);
  assert.deepEqual(report.errors, [], "OOXML package is valid");
});

test("an aborted export fails before any download", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    addChartsInOnePass(await sampleWorkbook(), specs, controller.signal),
    ExportCancelledError,
  );
});
