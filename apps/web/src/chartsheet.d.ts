declare module "chartsheet" {
  export interface ChartSeries {
    ref: string;
    nameRef?: string;
    name?: string;
    colour?: string;
    color?: string;
    xRef?: string;
  }

  export type ChartType =
    | "bar"
    | "column"
    | "line"
    | "pie"
    | "doughnut"
    | "area"
    | "scatter"
    | "radar";

  export interface ChartSpec {
    type?: ChartType;
    title?: string;
    series: ChartSeries[];
    categories?: string;
    sheet?: string;
    anchor?: {
      col?: number;
      row?: number;
      colOffset?: number;
      rowOffset?: number;
    };
    width?: number;
    height?: number;
    stacked?: boolean;
    horizontal?: boolean;
    dataLabels?: boolean;
    legend?: boolean | "r" | "l" | "t" | "b";
    numberFormat?: string;
    gridlines?: boolean;
    xTitle?: string;
    yTitle?: string;
    gapWidth?: number;
    name?: string;
  }

  export function addChart(
    workbook: Uint8Array | ArrayBuffer,
    spec: ChartSpec,
  ): Promise<Uint8Array>;
  export function addCharts(
    workbook: Uint8Array | ArrayBuffer,
    specs: ChartSpec[],
  ): Promise<Uint8Array>;
}
