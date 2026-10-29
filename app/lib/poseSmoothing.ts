/**
 * Stabilizes pose landmarks, joint angles, and rep detection against MediaPipe frame noise.
 * Eliminates visual skeleton jitter and provides responsive, accurate exercise kinematics.
 */

export type BodySide = "RIGHT" | "LEFT";

export type PoseLandmark = {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
};

const DEFAULT_VISIBILITY_MIN = 0.25;

export function landmarkVisibility(lm: PoseLandmark | undefined): number {
  return lm?.visibility ?? 1;
}

export function calculateAngle(a: PoseLandmark, b: PoseLandmark, c: PoseLandmark): number {
  const rad = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(a.y - b.y, a.x - b.x);
  let angle = Math.abs((rad * 180) / Math.PI);
  if (angle > 180) angle = 360 - angle;
  return angle;
}

/**
 * Velocity-adaptive multi-landmark coordinate filter with dropout hold.
 * Eliminates camera frame jitter, sensor noise, and skeleton trembling
 * while tracking intentional physical therapy movements with zero perceived lag.
 */
export class LandmarkSmoother {
  private smoothedLandmarks: PoseLandmark[] = [];
  private missedFrames: number[] = [];

  constructor(
    private readonly baseAlpha: number = 0.25,
    private readonly noiseDeadband: number = 0.005, // ~5px normalized threshold
  ) {}

  reset() {
    this.smoothedLandmarks = [];
    this.missedFrames = [];
  }

  update(landmarks: PoseLandmark[]): PoseLandmark[] {
    if (!landmarks || landmarks.length === 0) {
      return this.smoothedLandmarks;
    }

    if (this.smoothedLandmarks.length !== landmarks.length) {
      this.smoothedLandmarks = landmarks.map((lm) => ({ ...lm }));
      this.missedFrames = new Array(landmarks.length).fill(0);
      return this.smoothedLandmarks;
    }

    const smoothed: PoseLandmark[] = new Array(landmarks.length);

    for (let i = 0; i < landmarks.length; i++) {
      const raw = landmarks[i];
      const prev = this.smoothedLandmarks[i];

      // If landmark is missing or low visibility, hold last known position for up to 6 frames
      if (!raw || (raw.visibility !== undefined && raw.visibility < 0.2)) {
        if (prev && this.missedFrames[i] < 6) {
          this.missedFrames[i] += 1;
          smoothed[i] = prev;
          continue;
        }
        smoothed[i] = raw;
        continue;
      }

      this.missedFrames[i] = 0;

      if (!prev) {
        smoothed[i] = raw;
        continue;
      }

      const dx = raw.x - prev.x;
      const dy = raw.y - prev.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Deadband: Sensor micro-jitter - heavily damp to keep skeleton rock-still
      if (dist < this.noiseDeadband) {
        smoothed[i] = {
          x: prev.x * 0.95 + raw.x * 0.05,
          y: prev.y * 0.95 + raw.y * 0.05,
          z: raw.z !== undefined && prev.z !== undefined ? prev.z * 0.95 + raw.z * 0.05 : raw.z,
          visibility: raw.visibility,
        };
      } else {
        // Dynamic adaptive alpha: scale smoothly with intentional speed
        const adaptiveAlpha = Math.min(0.55, Math.max(this.baseAlpha, this.baseAlpha + dist * 3.5));
        smoothed[i] = {
          x: prev.x + adaptiveAlpha * dx,
          y: prev.y + adaptiveAlpha * dy,
          z: raw.z !== undefined && prev.z !== undefined ? prev.z + adaptiveAlpha * (raw.z - prev.z) : raw.z,
          visibility: raw.visibility,
        };
      }
    }

    this.smoothedLandmarks = smoothed;
    return smoothed;
  }
}

/**
 * 2-Stage Angle Stabilizer with Median Filtering and Velocity Gating.
 * Prevents angular fluttering, flattens sensor noise, and maintains rock-solid readouts.
 */
export class EmaSmoother {
  private value: number | null = null;
  private readonly history: number[] = [];
  private readonly historySize = 5;

  constructor(
    private readonly alpha: number = 0.22,
    private readonly deadband: number = 1.2, // degrees
  ) {}

  reset() {
    this.value = null;
    this.history.length = 0;
  }

  update(sample: number): number {
    // 1. Median filter window to reject frame glitches and single-sample outliers
    this.history.push(sample);
    if (this.history.length > this.historySize) {
      this.history.shift();
    }

    const sorted = [...this.history].sort((a, b) => a - b);
    const medianSample = sorted[Math.floor(sorted.length / 2)];

    if (this.value === null) {
      this.value = medianSample;
      return medianSample;
    }

    const diff = Math.abs(medianSample - this.value);

    // 2. Deadband: ignore micro-tremors and breathing motions when holding
    if (diff < this.deadband) {
      return this.value;
    }

    // 3. Velocity-scaled smoothing: smooth gradual holds, lag-free intentional reps
    const adaptiveAlpha = Math.min(0.50, Math.max(this.alpha, diff / 40));
    this.value = adaptiveAlpha * medianSample + (1 - adaptiveAlpha) * this.value;
    return this.value;
  }
}

/**
 * Locks to the tracked leg using landmark visibility to prevent side-flipping.
 * Only requires the 3 leg landmarks (hip, knee, ankle) for a side.
 */
export class SideTracker {
  private side: BodySide = "RIGHT";
  private switchVotes = 0;

  constructor(
    private readonly visibilityMargin = 0.15,
    private readonly framesToSwitch = 25, // ~1 second consistency to change side
  ) {}

  getSide(): BodySide {
    return this.side;
  }

  reset(side: BodySide = "RIGHT") {
    this.side = side;
    this.switchVotes = 0;
  }

  update(lm: PoseLandmark[], visibilityMin = DEFAULT_VISIBILITY_MIN): BodySide | null {
    if (!lm || lm.length < 29) return this.side;

    const hasRight = lm[24] && lm[26] && lm[28];
    const hasLeft = lm[23] && lm[25] && lm[27];

    if (!hasRight && !hasLeft) return this.side;

    const rightVis = hasRight
      ? (landmarkVisibility(lm[24]) + landmarkVisibility(lm[26]) + landmarkVisibility(lm[28])) / 3
      : 0;
    const leftVis = hasLeft
      ? (landmarkVisibility(lm[23]) + landmarkVisibility(lm[25]) + landmarkVisibility(lm[27])) / 3
      : 0;

    if (rightVis < visibilityMin && leftVis < visibilityMin) return this.side;

    let preferred: BodySide;
    if (rightVis >= visibilityMin && leftVis >= visibilityMin) {
      if (rightVis >= leftVis + this.visibilityMargin) preferred = "RIGHT";
      else if (leftVis >= rightVis + this.visibilityMargin) preferred = "LEFT";
      else preferred = this.side;
    } else {
      preferred = rightVis >= leftVis ? "RIGHT" : "LEFT";
    }

    if (preferred === this.side) {
      this.switchVotes = 0;
      return this.side;
    }

    this.switchVotes += 1;
    if (this.switchVotes >= this.framesToSwitch) {
      this.side = preferred;
      this.switchVotes = 0;
    }
    return this.side;
  }
}

/**
 * Calculates raw knee angle for the selected side.
 */
export function kneeAngleForSide(
  lm: PoseLandmark[],
  side: BodySide,
  visibilityMin = DEFAULT_VISIBILITY_MIN,
): number | null {
  if (!lm) return null;
  const [hipIdx, kneeIdx, ankleIdx] = side === "RIGHT" ? [24, 26, 28] : [23, 25, 27];
  const hip = lm[hipIdx];
  const knee = lm[kneeIdx];
  const ankle = lm[ankleIdx];
  if (!hip || !knee || !ankle) return null;

  const vis = Math.min(
    landmarkVisibility(hip),
    landmarkVisibility(knee),
    landmarkVisibility(ankle),
  );
  if (vis < visibilityMin) return null;

  return calculateAngle(hip, knee, ankle);
}

/**
 * Clinically normalized angle calculation for rehabilitation exercises:
 *
 * - Knee Flexion / Heel Slides:
 *   Normalized flexion ROM (0° when leg is straight, counting UP to 90° as knee bends).
 *
 * - Straight Leg Raise:
 *   Leg elevation off the floor/bed (0° when resting flat, counting UP to 45°).
 *
 * - Quad Sets / Terminal Knee Extension:
 *   Knee extension deficit (0° when pressed completely flat).
 */
export function calculateExerciseAngle(
  lm: PoseLandmark[],
  side: BodySide,
  exerciseKey: string,
  visibilityMin = DEFAULT_VISIBILITY_MIN,
): { angle: number; auxiliaryAngle?: number } | null {
  if (!lm) return null;
  const [shoulderIdx, hipIdx, kneeIdx, ankleIdx] =
    side === "RIGHT" ? [12, 24, 26, 28] : [11, 23, 25, 27];

  const shoulder = lm[shoulderIdx];
  const hip = lm[hipIdx];
  const knee = lm[kneeIdx];
  const ankle = lm[ankleIdx];

  if (!hip || !knee || !ankle) return null;

  const kneeVis = Math.min(
    landmarkVisibility(hip),
    landmarkVisibility(knee),
    landmarkVisibility(ankle),
  );
  if (kneeVis < visibilityMin) return null;

  const rawKneeAngle = calculateAngle(hip, knee, ankle);

  // 1. Straight Leg Raise: Elevation off the bed/floor
  if (exerciseKey.includes("straight-leg-raise")) {
    if (shoulder && landmarkVisibility(shoulder) >= visibilityMin) {
      const hipAngle = calculateAngle(shoulder, hip, knee);
      const elevation = Math.max(0, Math.min(90, Math.round(180 - hipAngle)));
      return { angle: elevation, auxiliaryAngle: rawKneeAngle };
    }
    // Fallback if upper body/shoulder is outside camera frame:
    // Compute elevation of hip-to-ankle vector relative to floor horizontal
    const dy = hip.y - ankle.y;
    const dx = Math.abs(ankle.x - hip.x) || 0.001;
    const legAngleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
    const elevation = Math.max(0, Math.min(90, Math.round(Math.max(0, legAngleDeg))));
    return { angle: elevation, auxiliaryAngle: rawKneeAngle };
  }

  // 2. Quad Sets: Patient pushes knee flat into bed (Target: 0° flexion / 180° extension)
  if (exerciseKey.includes("quad-sets")) {
    const extensionDeficit = Math.max(0, Math.min(45, Math.round(180 - rawKneeAngle)));
    return { angle: extensionDeficit, auxiliaryAngle: rawKneeAngle };
  }

  // 3. Terminal Knee Extension (TKE): Straightening from slight bend to flat (0°-10°)
  if (exerciseKey.includes("terminal-knee-extension")) {
    const extensionDeficit = Math.max(0, Math.min(60, Math.round(180 - rawKneeAngle)));
    return { angle: extensionDeficit, auxiliaryAngle: rawKneeAngle };
  }

  // 4. Standard Knee Flexion & Heel Slides:
  // Clinically normalized flexion degrees:
  // 0° = straight extended leg at rest
  // 90° = bent knee at 90 degrees
  const flexionAngle = Math.max(0, Math.min(145, Math.round(180 - rawKneeAngle)));
  return { angle: flexionAngle, auxiliaryAngle: rawKneeAngle };
}

export type RepEvent = "rep_completed" | "target_reached" | null;

/**
 * Adaptive rep counter calibrated for physical therapy ROM curves.
 * Requires intentional movement into target zone and clean return to starting position.
 */
export class RepCounter {
  private state: "start" | "target_reached" = "start";
  private targetHoldStart = 0;
  private hasReportedTarget = false;

  constructor(
    private targetAngle: number = 90,
    private exerciseType: string = "knee-flexion",
  ) {}

  configure(targetAngle: number, exerciseType: string) {
    this.targetAngle = targetAngle;
    this.exerciseType = exerciseType;
    this.reset();
  }

  reset() {
    this.state = "start";
    this.targetHoldStart = 0;
    this.hasReportedTarget = false;
  }

  update(currentAngle: number): RepEvent {
    const isStraightLegRaise = this.exerciseType.includes("straight-leg-raise");
    const isExtensionType = this.exerciseType.includes("quad-sets") || this.exerciseType.includes("terminal-knee-extension");

    if (isStraightLegRaise) {
      // Straight Leg Raise: Target 45° elevation
      const enterTarget = currentAngle >= this.targetAngle - 7;
      const returnStart = currentAngle <= 14;

      if (this.state === "start" && enterTarget) {
        this.state = "target_reached";
        if (!this.hasReportedTarget) {
          this.hasReportedTarget = true;
          return "target_reached";
        }
      } else if (this.state === "target_reached" && returnStart) {
        this.state = "start";
        this.hasReportedTarget = false;
        return "rep_completed";
      }
      return null;
    }

    if (isExtensionType) {
      // Quad Sets / TKE: Target 0° - 10° extension deficit
      const enterTarget = currentAngle <= this.targetAngle + 6;
      const returnStart = currentAngle >= this.targetAngle + 20;

      if (this.state === "start" && enterTarget) {
        this.state = "target_reached";
        if (!this.hasReportedTarget) {
          this.hasReportedTarget = true;
          return "target_reached";
        }
      } else if (this.state === "target_reached" && returnStart) {
        this.state = "start";
        this.hasReportedTarget = false;
        return "rep_completed";
      }
      return null;
    }

    // Standard Flexion / Heel Slides:
    // Starts near 0° - 25° (straight leg).
    // Bends to target angle (e.g. 90° - 8 = 82°).
    // Returns to straight leg (<= 28°).
    const enterTarget = currentAngle >= this.targetAngle - 8;
    const returnExtended = currentAngle <= 28;

    if (this.state === "start" && enterTarget) {
      this.state = "target_reached";
      if (!this.hasReportedTarget) {
        this.hasReportedTarget = true;
        return "target_reached";
      }
    } else if (this.state === "target_reached" && returnExtended) {
      this.state = "start";
      this.hasReportedTarget = false;
      return "rep_completed";
    }

    return null;
  }
}

export function roundAngle(angle: number): number {
  return Math.round(angle);
}

/** Limits UI updates to maintain 60 FPS fluidity without micro-stutters. */
export function shouldEmitDisplayAngle(
  lastEmit: { time: number; value: number },
  rounded: number,
  minIntervalMs = 40,
  minDelta = 1,
): boolean {
  const now = Date.now();
  return (
    now - lastEmit.time >= minIntervalMs && Math.abs(rounded - lastEmit.value) >= minDelta
  );
}

/** Red-zone hysteresis: ONLY triggers when pushing dangerously beyond prescribed ROM */
export function redZoneState(
  current: boolean,
  currentAngle: number,
  targetAngle: number,
): boolean {
  // Overextension threshold: pushing more than 16° past the target
  const enterAbove = targetAngle + 16;
  const exitBelow = targetAngle + 8;

  if (!current && currentAngle > enterAbove) return true;
  if (current && currentAngle <= exitBelow) return false;
  return current;
}
