/**
 * AUTO-GENERATED FILE - DO NOT EDIT.
 *
 * Source of truth: config/pose-definitions.json
 * Regenerate with:  node tools/generate-pose-definitions.mjs
 */

import type { PoseDefinitionMap } from "./pose-definitions";

export const POSE_DEFINITIONS_SOURCE_SHA256: string =
  "dd5fd66f34a32c5b70acb7c8e85c265367afc218b7fd97fd61a047c22c5fb8fb";

export const POSE_DEFINITIONS: PoseDefinitionMap = {
  "schema_version": "1.0.0",
  "description": "Canonical joint connectivity, angle triplets and target ROM limits for the five Pilates pose models. This file is the single source of truth: packages/types/src/pose-definitions.generated.ts is generated from it by tools/generate-pose-definitions.mjs, and the Rust engine embeds it as a Tauri resource.",
  "label_source": "provisional",
  "label_note": "The five checkpoints are custom-trained YOLO-pose models whose keypoint NAMES were not persisted with the weights (only kpt_shape). Indices below follow a clinically coherent convention derived from each model's keypoint count and class names. Labels must be confirmed against the original training dataset before clinical use; because every consumer reads connectivity and angle triplets from this file, correcting a label requires no code change.",
  "confidence_bands": {
    "high": 0.8,
    "medium": 0.5
  },
  "default_hold_seconds": 3,
  "poses": {
    "pose1": {
      "pose_id": "pose1",
      "display_name": "The Hundred",
      "keypoint_count": 3,
      "keypoint_labels": [
        "hip",
        "knee",
        "ankle"
      ],
      "bones": [
        [
          0,
          1
        ],
        [
          1,
          2
        ]
      ],
      "primary_angle": {
        "name": "knee_flexion",
        "a": 0,
        "b": 1,
        "c": 2,
        "unit": "degrees"
      },
      "secondary_angle": null,
      "target_rom": {
        "min": 0,
        "max": 140,
        "target": 90
      },
      "hold_seconds": 3,
      "detection": {
        "start_class": "start",
        "end_class": "end",
        "min_confidence": 0.25,
        "confirm_frames": 3,
        "min_hold_sec": 2.5,
        "max_hold_sec": 60,
        "grace_sec": 0.6
      }
    },
    "pose2": {
      "pose_id": "pose2",
      "display_name": "Roll Up",
      "keypoint_count": 3,
      "keypoint_labels": [
        "shoulder",
        "elbow",
        "wrist"
      ],
      "bones": [
        [
          0,
          1
        ],
        [
          1,
          2
        ]
      ],
      "primary_angle": {
        "name": "elbow_flexion",
        "a": 0,
        "b": 1,
        "c": 2,
        "unit": "degrees"
      },
      "secondary_angle": null,
      "target_rom": {
        "min": 0,
        "max": 150,
        "target": 90
      },
      "hold_seconds": 3,
      "detection": {
        "start_class": "start",
        "end_class": "end",
        "min_confidence": 0.25,
        "confirm_frames": 3,
        "min_hold_sec": 2.5,
        "max_hold_sec": 60,
        "grace_sec": 0.6
      }
    },
    "pose3": {
      "pose_id": "pose3",
      "display_name": "Single Leg Stretch",
      "keypoint_count": 5,
      "keypoint_labels": [
        "shoulder",
        "elbow",
        "wrist",
        "hip",
        "knee"
      ],
      "bones": [
        [
          0,
          1
        ],
        [
          1,
          2
        ],
        [
          0,
          3
        ],
        [
          3,
          4
        ]
      ],
      "primary_angle": {
        "name": "elbow_flexion",
        "a": 0,
        "b": 1,
        "c": 2,
        "unit": "degrees"
      },
      "secondary_angle": {
        "name": "hip_flexion",
        "a": 0,
        "b": 3,
        "c": 4,
        "unit": "degrees"
      },
      "target_rom": {
        "min": 0,
        "max": 145,
        "target": 90
      },
      "hold_seconds": 3,
      "detection": {
        "start_class": "start",
        "end_class": "end",
        "min_confidence": 0.25,
        "confirm_frames": 3,
        "min_hold_sec": 2.5,
        "max_hold_sec": 60,
        "grace_sec": 0.6
      }
    },
    "pose4": {
      "pose_id": "pose4",
      "display_name": "Side Leg Lift",
      "keypoint_count": 7,
      "keypoint_labels": [
        "shoulder_l",
        "elbow_l",
        "wrist_l",
        "shoulder_r",
        "elbow_r",
        "wrist_r",
        "head"
      ],
      "bones": [
        [
          6,
          0
        ],
        [
          6,
          3
        ],
        [
          0,
          1
        ],
        [
          1,
          2
        ],
        [
          3,
          4
        ],
        [
          4,
          5
        ]
      ],
      "primary_angle": {
        "name": "elbow_flexion_l",
        "a": 0,
        "b": 1,
        "c": 2,
        "unit": "degrees"
      },
      "secondary_angle": {
        "name": "elbow_flexion_r",
        "a": 3,
        "b": 4,
        "c": 5,
        "unit": "degrees"
      },
      "target_rom": {
        "min": 0,
        "max": 150,
        "target": 90
      },
      "hold_seconds": 3,
      "detection": {
        "start_class": "start",
        "end_class": "end",
        "min_confidence": 0.25,
        "confirm_frames": 3,
        "min_hold_sec": 2.5,
        "max_hold_sec": 60,
        "grace_sec": 0.6
      }
    },
    "pose5": {
      "pose_id": "pose5",
      "display_name": "Swimming",
      "keypoint_count": 15,
      "keypoint_labels": [
        "head",
        "neck",
        "shoulder_l",
        "elbow_l",
        "wrist_l",
        "shoulder_r",
        "elbow_r",
        "wrist_r",
        "hip_l",
        "knee_l",
        "ankle_l",
        "hip_r",
        "knee_r",
        "ankle_r",
        "spine"
      ],
      "bones": [
        [
          0,
          1
        ],
        [
          1,
          2
        ],
        [
          1,
          5
        ],
        [
          2,
          3
        ],
        [
          3,
          4
        ],
        [
          5,
          6
        ],
        [
          6,
          7
        ],
        [
          1,
          14
        ],
        [
          14,
          8
        ],
        [
          14,
          11
        ],
        [
          8,
          9
        ],
        [
          9,
          10
        ],
        [
          11,
          12
        ],
        [
          12,
          13
        ]
      ],
      "primary_angle": {
        "name": "knee_flexion_l",
        "a": 8,
        "b": 9,
        "c": 10,
        "unit": "degrees"
      },
      "secondary_angle": {
        "name": "knee_flexion_r",
        "a": 11,
        "b": 12,
        "c": 13,
        "unit": "degrees"
      },
      "target_rom": {
        "min": 0,
        "max": 140,
        "target": 90
      },
      "hold_seconds": 3,
      "detection": {
        "start_class": "start",
        "end_class": "end",
        "min_confidence": 0.25,
        "confirm_frames": 3,
        "min_hold_sec": 2.5,
        "max_hold_sec": 60,
        "grace_sec": 0.6
      }
    }
  },
  "detection_note": "In every pose model the class named 'end' is the exercise itself (the position being held) and 'start' is the neutral position between repetitions. A repetition is one hold of the action pose: it begins when 'end' is confirmed for confirm_frames frames and ends when 'start' is detected, when the pose goes undetected for grace_sec, or when the hold exceeds max_hold_sec. Holds shorter than min_hold_sec are discarded."
} as PoseDefinitionMap;
