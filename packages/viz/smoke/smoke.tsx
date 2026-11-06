import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  SkeletalCanvas,
  JointAngleGauge,
  RepTimelineChart,
  FormScoreRadar,
  SessionTrendCard,
  calculateJointAngle,
  confidenceBand,
  deriveHoldRanges,
  computePrimaryAngle,
  resolvePoseDefinition,
} from "../src/index";
import {
  Button,
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  Badge,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  Dialog,
} from "../../ui/src/index";
import type {
  DownsampledPoint,
  FormScoreBreakdown,
  Keypoint2D,
} from "@pilates/types";
import { POSE_DEFINITIONS } from "@pilates/types";

let failures = 0;
function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ""}`);
  }
}
function near(a: number, b: number, tol = 1e-6) {
  return Math.abs(a - b) <= tol;
}

console.log("\n[1] Joint angle math");
// Right angle at origin: B=(0,0), A=(1,0), C=(0,1) -> 90deg
check(
  "90 deg right angle",
  near(calculateJointAngle({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 }), 90),
);
// Straight line -> 180deg
check(
  "180 deg straight line",
  near(calculateJointAngle({ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }), 180),
);
// Coincident rays -> 0deg
check(
  "0 deg coincident rays",
  near(calculateJointAngle({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 2, y: 0 }), 0),
);
// 45 deg
check(
  "45 deg",
  near(
    calculateJointAngle({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 }),
    45,
    1e-9,
  ),
);
// Degenerate (zero-length vector) must not produce a bogus angle
check(
  "degenerate returns NaN",
  Number.isNaN(calculateJointAngle({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 })),
);

console.log("\n[2] Confidence bands (spec: green >=0.8, yellow 0.5-0.8, red <0.5)");
check("0.95 -> high", confidenceBand(0.95) === "high");
check("0.80 -> high (boundary)", confidenceBand(0.8) === "high");
check("0.79 -> medium", confidenceBand(0.79) === "medium");
check("0.50 -> medium (boundary)", confidenceBand(0.5) === "medium");
check("0.49 -> low", confidenceBand(0.49) === "low");
check("NaN -> low", confidenceBand(Number.NaN) === "low");

console.log("\n[3] Pose definitions");
check("5 poses defined", Object.keys(POSE_DEFINITIONS.poses).length === 5);
for (const [id, def] of Object.entries(POSE_DEFINITIONS.poses)) {
  check(
    `${id}: labels match keypoint_count`,
    def.keypoint_labels.length === def.keypoint_count,
    `${def.keypoint_labels.length} vs ${def.keypoint_count}`,
  );
  const maxIdx = Math.max(
    ...def.bones.flat(),
    def.primary_angle.a,
    def.primary_angle.b,
    def.primary_angle.c,
  );
  check(
    `${id}: all indices in range`,
    maxIdx < def.keypoint_count,
    `max index ${maxIdx} >= ${def.keypoint_count}`,
  );
}
check(
  "resolvePoseDefinition(pose4) works",
  resolvePoseDefinition("pose4")?.display_name === "Side Leg Lift",
);
check("resolvePoseDefinition(unknown) is undefined", resolvePoseDefinition("pose9") === undefined);

console.log("\n[4] Hold-range derivation");
const curve: DownsampledPoint[] = [
  { t_sec: 0, angle: 10, score: 60, phase: "idle" },
  { t_sec: 1, angle: 40, score: 70, phase: "concentric" },
  { t_sec: 2, angle: 88, score: 92, phase: "holding" },
  { t_sec: 3, angle: 90, score: 95, phase: "holding" },
  { t_sec: 4, angle: 90, score: 94, phase: "holding" },
  { t_sec: 5, angle: 60, score: 80, phase: "eccentric" },
  { t_sec: 6, angle: 85, score: 90, phase: "holding" },
  { t_sec: 7, angle: 20, score: 65, phase: "rep_completed" },
];
const ranges = deriveHoldRanges(curve);
check(
  "only the multi-sample hold survives (2s-4s)",
  ranges.length === 1,
  JSON.stringify(ranges),
);
check(
  "first range 2s-4s",
  ranges[0]?.start === 2 && ranges[0]?.end === 4,
  JSON.stringify(ranges[0]),
);
check(
  "single-sample hold at 6s dropped as zero length",
  ranges.every((r) => r.end > r.start),
  JSON.stringify(ranges),
);

console.log("\n[5] computePrimaryAngle from keypoints");
const kneeKpts: Keypoint2D[] = [
  { id: 0, x: 0.5, y: 0.2, confidence: 0.9 },
  { id: 1, x: 0.5, y: 0.5, confidence: 0.9 },
  { id: 2, x: 0.5, y: 0.8, confidence: 0.9 },
];
const pose1 = resolvePoseDefinition("pose1")!;
const straight = computePrimaryAngle(kneeKpts, pose1, 640, 480);
check("straight leg ~180 deg", straight !== null && near(straight, 180, 1e-6), String(straight));
const missing = computePrimaryAngle([kneeKpts[0]], pose1, 640, 480);
check("missing keypoints -> null", missing === null);

console.log("\n[6] UI primitives render");
const uiCases: [string, React.ReactElement][] = [
  ["Button", <Button variant="primary">Start session</Button>],
  ["Button loading", <Button loading>Loading</Button>],
  ["Card", <Card><CardHeader><CardTitle>Title</CardTitle></CardHeader><CardContent>Body</CardContent></Card>],
  ["Badge", <Badge variant="success" dot>Synced</Badge>],
  [
    "Table",
    <Table>
      <TableHeader><TableRow><TableHead>Rep</TableHead></TableRow></TableHeader>
      <TableBody><TableRow><TableCell>1</TableCell></TableRow></TableBody>
    </Table>,
  ],
  ["Dialog closed", <Dialog open={false} onClose={() => {}} title="Closed" />],
  ["Dialog open (SSR -> null)", <Dialog open onClose={() => {}} title="Open" />],
];
for (const [name, element] of uiCases) {
  try {
    const html = renderToStaticMarkup(element);
    check(`${name} renders`, typeof html === "string", `type ${typeof html}`);
  } catch (error) {
    check(`${name} renders`, false, (error as Error).message);
  }
}

console.log("\n[7] Visualization components render");
const breakdown: FormScoreBreakdown = {
  angle_accuracy: 88,
  stability: 76,
  speed: 91,
  detection_confidence: 95,
};
const vizCases: [string, React.ReactElement][] = [
  ["SkeletalCanvas", <SkeletalCanvas keypoints={kneeKpts} poseId="pose1" width={320} height={240} showAngles showLabels showGrid />],
  ["SkeletalCanvas (no pose)", <SkeletalCanvas keypoints={kneeKpts} width={320} height={240} />],
  ["JointAngleGauge", <JointAngleGauge angle={88} target={90} label="knee_flexion" />],
  ["JointAngleGauge (no reading)", <JointAngleGauge angle={Number.NaN} target={90} />],
  ["RepTimelineChart", <RepTimelineChart data={curve} targetRom={pose1.target_rom} showScore />],
  ["RepTimelineChart (empty)", <RepTimelineChart data={[]} />],
  ["FormScoreRadar", <FormScoreRadar breakdown={breakdown} baseline={breakdown} />],
  [
    "SessionTrendCard",
    <SessionTrendCard
      sessions={[
        { session_id: "a", started_at: "2026-10-01T10:00:00Z", mean_form_score: 72, total_reps: 8, peak_rom_angle: 95 },
        { session_id: "b", started_at: "2026-10-08T10:00:00Z", mean_form_score: 81, total_reps: 10, peak_rom_angle: 102 },
      ]}
    />,
  ],
  ["SessionTrendCard (empty)", <SessionTrendCard sessions={[]} />],
];
for (const [name, element] of vizCases) {
  try {
    const html = renderToStaticMarkup(element);
    check(`${name} renders`, html.length > 0, "empty markup");
  } catch (error) {
    check(`${name} renders`, false, (error as Error).message);
  }
}

console.log(`\n${failures === 0 ? "ALL SMOKE CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
