/**
 * Single-pass native chart insertion for the analysis workbook.
 *
 * chartsheet's public `addChart`/`addCharts` reload and re-zip the whole .xlsx
 * for every chart. On a large clinic that is N full zip round-trips and a
 * frozen tab. This module uses chartsheet's own OOXML helpers once, so all
 * charts land in the same ZIP pass. If those internals ever drift, the caller
 * falls back to the public API — the exported file stays the same.
 *
 * The internal import paths are pinned by pnpm-lock.yaml to chartsheet@0.3.2.
 */

export interface BatchChartSpec {
  type: "column" | "bar" | "scatter" | "line";
  title?: string;
  series: Array<{
    ref: string;
    xRef?: string;
    name?: string;
    colour?: string;
  }>;
  categories?: string;
  sheet: string;
  anchor: {
    col: number;
    row: number;
    colOffset?: number;
    rowOffset?: number;
  };
  width: number;
  height: number;
  dataLabels?: boolean;
  legend?: boolean;
  numberFormat?: string;
  xTitle?: string;
  yTitle?: string;
  horizontal?: boolean;
}

export class ExportCancelledError extends Error {
  constructor() {
    super("Export cancelled");
    this.name = "ExportCancelledError";
  }
}

type InteropModule = Record<string, any>;

function unwrap(module: InteropModule): InteropModule {
  return (module.default ?? module) as InteropModule;
}

function anchorXml(
  spec: BatchChartSpec,
  chartRelId: string,
  shapeId: number,
  escapeXml: (value: string) => string,
): string {
  const { col = 5, row = 1, colOffset = 0, rowOffset = 0 } = spec.anchor;
  const cx = Math.round((spec.width || 600) * 9525);
  const cy = Math.round((spec.height || 340) * 9525);
  const name = escapeXml(spec.title || `Chart ${shapeId}`);

  return (
    "<xdr:oneCellAnchor>" +
    `<xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>${colOffset}</xdr:colOff>` +
    `<xdr:row>${row}</xdr:row><xdr:rowOff>${rowOffset}</xdr:rowOff></xdr:from>` +
    `<xdr:ext cx="${cx}" cy="${cy}"/>` +
    "<xdr:graphicFrame macro=\"\"><xdr:nvGraphicFramePr>" +
    `<xdr:cNvPr id="${shapeId}" name="${name}"/><xdr:cNvGraphicFramePr/>` +
    "</xdr:nvGraphicFramePr>" +
    "<xdr:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/></xdr:xfrm>" +
    `<a:graphic><a:graphicData uri="${"http://schemas.openxmlformats.org/drawingml/2006/chart"}">` +
    `<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${chartRelId}"/>` +
    "</a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:oneCellAnchor>"
  );
}

/**
 * Add every chart to one already-loaded ZIP, then write it once.
 * Throws ExportCancelledError when `signal` aborts between charts.
 */
export async function addChartsInOnePass(
  workbook: Uint8Array | ArrayBuffer,
  specs: BatchChartSpec[],
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const check = () => {
    if (signal?.aborted) throw new ExportCancelledError();
  };
  check();

  const [{ default: JSZip }, packageModule, chartModule] = await Promise.all([
    import("jszip"),
    import("chartsheet/src/package.js"),
    import("chartsheet/src/chart-xml.js"),
  ]);
  const pkg = unwrap(packageModule as InteropModule);
  const { chartXml, validateSpec } = unwrap(chartModule as InteropModule);
  check();

  const zip = await JSZip.loadAsync(workbook);
  for (const spec of specs) {
    check();
    const validated = validateSpec(spec);
    const sheetPath =
      validated.sheetPath || (await pkg.resolveSheetPath(zip, validated.sheet));
    const drawing = await pkg.ensureDrawing(zip, sheetPath);

    const chartIndex = pkg.nextPartIndex(
      zip,
      /^xl\/charts\/chart(\d+)\.xml$/,
    );
    const chartPath = `xl/charts/chart${chartIndex}.xml`;
    let xml = chartXml(validated) as string;
    if (spec.type === "scatter") {
      xml = xml.replace('scatterStyle val="lineMarker"', 'scatterStyle val="marker"');
    }
    zip.file(chartPath, xml);

    const drawingRelsPath = pkg.relsPathFor(drawing.path);
    const drawingRels = (await pkg.readPart(zip, drawingRelsPath)) as string;
    const chartRelId = pkg.nextRelId(drawingRels) as string;
    zip.file(
      drawingRelsPath,
      pkg.addRelationship(
        drawingRels,
        chartRelId,
        "chart",
        `../charts/chart${chartIndex}.xml`,
      ),
    );

    const drawingXml = (await pkg.readPart(zip, drawing.path)) as string;
    const usedIds = [...drawingXml.matchAll(/<xdr:cNvPr id="(\d+)"/g)].map(
      (match) => Number(match[1]),
    );
    const shapeId = (usedIds.length ? Math.max(...usedIds) : 1) + 1;
    zip.file(
      drawing.path,
      drawingXml.replace(
        "</xdr:wsDr>",
        anchorXml(spec, chartRelId, shapeId, pkg.escapeXml) + "</xdr:wsDr>",
      ),
    );

    await pkg.declareContentType(zip, `/${drawing.path}`, pkg.CT.drawing);
    await pkg.declareContentType(zip, `/${chartPath}`, pkg.CT.chart);
    check();
  }

  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
