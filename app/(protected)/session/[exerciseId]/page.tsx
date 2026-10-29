"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useParams, useRouter } from "next/navigation";
import { GoogleGenerativeAI } from "@google/generative-ai";
import type { PoseLandmarker } from "@mediapipe/tasks-vision";
import { ArrowLeft, CameraOff, ShieldAlert, Volume2, X, Sparkles, CheckCircle2 } from "lucide-react";

const JointVisualizer3D = dynamic(() => import("../../../components/JointVisualizer3D"), { ssr: false });
import { createNotification } from "../../../components/NotificationBell";
import { getUser } from "../../../lib/auth";
import { saveLocalSession, getGeminiApiKey } from "../../../lib/supabase";
import {
  EmaSmoother,
  LandmarkSmoother,
  RepCounter,
  SideTracker,
  calculateExerciseAngle,
  redZoneState,
  roundAngle,
  shouldEmitDisplayAngle,
} from "../../../lib/poseSmoothing";
import {
  speakPhysioGuidance,
  getSpecialistCoachLine,
  stopAllSpeech,
} from "../../../lib/voiceCoach";

type CameraState = "starting" | "ready" | "denied" | "error";
type PoseState = "loading" | "ready" | "error";
type FeedbackType = "correction" | "encouragement" | "danger";

type FeedbackMessage = {
  text: string;
  type: FeedbackType;
  t: number;
};

type AngleLog = {
  t: number;
  a: number;
};

type PoseLandmark = {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
};

type PoseResult = {
  landmarks?: PoseLandmark[][];
};

const exerciseConfig: Record<string, { name: string; targetAngle: number; targetReps: number; recoveryWeek: number; surgeryType: string }> = {
  "knee-flexion": { name: "Knee Flexion", targetAngle: 90, targetReps: 10, recoveryWeek: 3, surgeryType: "Total Knee Replacement" },
  "straight-leg-raise": { name: "Straight Leg Raise", targetAngle: 45, targetReps: 10, recoveryWeek: 3, surgeryType: "Total Knee Replacement" },
  "heel-slides": { name: "Heel Slides", targetAngle: 90, targetReps: 10, recoveryWeek: 3, surgeryType: "Total Knee Replacement" },
  "quad-sets": { name: "Quad Sets", targetAngle: 0, targetReps: 10, recoveryWeek: 3, surgeryType: "Total Knee Replacement" },
  "terminal-knee-extension": { name: "Terminal Knee Extension", targetAngle: 10, targetReps: 10, recoveryWeek: 3, surgeryType: "Total Knee Replacement" },
  "aaos-heel-slides": { name: "Heel Slides", targetAngle: 90, targetReps: 10, recoveryWeek: 3, surgeryType: "Post-Surgery Knee Rehab" },
  "aaos-quad-sets": { name: "Quad Sets", targetAngle: 0, targetReps: 10, recoveryWeek: 3, surgeryType: "Post-Surgery Knee Rehab" },
  "aaos-straight-leg-raise": { name: "Straight Leg Raise", targetAngle: 45, targetReps: 10, recoveryWeek: 3, surgeryType: "Post-Surgery Knee Rehab" },
  "aaos-knee-flexion": { name: "Knee Flexion", targetAngle: 90, targetReps: 10, recoveryWeek: 3, surgeryType: "Post-Surgery Knee Rehab" },
};

const poseConnections = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [27, 29], [29, 31], [27, 31],
  [24, 26], [26, 28], [28, 30], [30, 32], [28, 32],
];

function formatTime(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function formatTimecode(ms: number) {
  return `+${formatTime(ms)}`;
}

const POSE_MODEL_URLS = [
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
];

function getAngleTone(angle: number, targetAngle: number) {
  const isBeyondTarget = angle > targetAngle + 15;
  const isNearTarget = Math.abs(angle - targetAngle) <= 8;
  const isAtRest = angle <= 22 && targetAngle >= 45;

  if (isBeyondTarget) return { color: "#EF4444", glow: "rgba(239,68,68,0.35)", label: "⚠️ Beyond target" };
  if (isNearTarget) return { color: "#10B981", glow: "rgba(16,185,129,0.35)", label: "✓ Target reached" };
  if (isAtRest) return { color: "#94A3B8", glow: "rgba(148,163,184,0.2)", label: "Ready · Start position" };
  return { color: "#0EA5E9", glow: "rgba(14,165,233,0.35)", label: "Bending smoothly" };
}

function painColor(value: number) {
  if (value >= 7) return "var(--danger)";
  if (value >= 4) return "var(--warn)";
  return "var(--accent)";
}

async function getBrowserSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  const { createClient } = await import("@supabase/supabase-js");
  return createClient(url, key);
}

function StatMini({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={{
      borderRadius: "var(--r-sm)", border: "1px solid var(--border)",
      background: "var(--bg-subtle)", padding: 14,
    }}>
      <div style={{ fontSize: 11, color: "var(--text-3)", fontWeight: 500 }}>{label}</div>
      <div style={{ marginTop: 4, fontFamily: "var(--font-data)", fontSize: 20, color: "var(--text-1)", fontWeight: 500 }}>{value}</div>
    </div>
  );
}

export default function LiveSessionPage() {
  const router = useRouter();
  const routeParams = useParams();
  const exerciseId = typeof routeParams.exerciseId === "string"
    ? routeParams.exerciseId
    : Array.isArray(routeParams.exerciseId)
      ? routeParams.exerciseId[0] ?? "knee-flexion"
      : "knee-flexion";

  const config = exerciseConfig[exerciseId] ?? {
    name: exerciseId.replace(/-/g, " ").replace(/\b\w/g, (char) => char.toUpperCase()),
    targetAngle: 90,
    targetReps: 10,
    recoveryWeek: 3,
    surgeryType: "Post-Surgery Rehab",
  };

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const landmarkerRef = useRef<PoseLandmarker | null>(null);
  const animFrameRef = useRef<number>();
  const lastDetectTime = useRef(0);
  const currentAngleRef = useRef(0);
  const bestAngleRef = useRef(0);
  const repCountRef = useRef(0);
  const angleLogRef = useRef<AngleLog[]>([]);
  const feedbackMessagesRef = useRef<FeedbackMessage[]>([]);
  const lastAngleLogTime = useRef(0);
  const isSpeakingRef = useRef(false);
  const consecutiveMissedFrames = useRef(0);
  const lastSpokenPhase = useRef<string>("");
  const lastSpokenTime = useRef<number>(0);
  const lastCameraPromptTime = useRef(0);
  const landmarkSmootherRef = useRef(new LandmarkSmoother(0.25, 0.005));
  const angleSmootherRef = useRef(new EmaSmoother(0.22, 1.2));
  const sideTrackerRef = useRef(new SideTracker());
  const repCounterRef = useRef(new RepCounter(config.targetAngle, exerciseId));
  const lastDisplayEmitRef = useRef({ time: 0, value: 0 });
  const sessionStartRef = useRef(Date.now());
  const poseDetectedRef = useRef(true);
  const currentSideRef = useRef<"RIGHT" | "LEFT">("RIGHT");
  const simTargetReported = useRef(false);

  const [cameraState, setCameraState] = useState<CameraState>("starting");
  const [poseState, setPoseState] = useState<PoseState>("loading");
  const [poseDetected, setPoseDetected] = useState(true);
  const [currentAngle, setCurrentAngle] = useState(0);
  const [bestAngle, setBestAngle] = useState(0);
  const [repCount, setRepCount] = useState(0);
  const [correctReps, setCorrectReps] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [sessionPain, setSessionPain] = useState(2);
  const [painAfter, setPainAfter] = useState(2);
  const [clinicalSummary, setClinicalSummary] = useState<string>("");
  const [isGeneratingSummary, setIsGeneratingSummary] = useState<boolean>(false);
  const [feedbackMessages, setFeedbackMessages] = useState<FeedbackMessage[]>([
    { text: "Camera ready. Move slowly and stay in frame.", type: "encouragement", t: 0 },
  ]);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [showEndModal, setShowEndModal] = useState(false);
  const [showPainAlert, setShowPainAlert] = useState(false);
  const [showRedFlagWarning, setShowRedFlagWarning] = useState(true);
  const [showMobileWarning, setShowMobileWarning] = useState(false);
  const [sessionCleared, setSessionCleared] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSimulating, setIsSimulating] = useState(false);
  const [show3dTwin, setShow3dTwin] = useState(true);
  const [repHistory, setRepHistory] = useState<{ rep: number; angle: number; correct: boolean }[]>([]);
  const feedbackLogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    repCounterRef.current.configure(config.targetAngle, exerciseId);
  }, [config.targetAngle, exerciseId]);

  const angleDeviation = Math.abs(config.targetAngle - currentAngle);
  const tone = getAngleTone(currentAngle, config.targetAngle);

  // Feature 1: Form Score
  const formScore = repCount > 0 ? Math.round((correctReps / repCount) * 100) : 0;

  // Feature 3: Compensation Detector
  const [compensations, setCompensations] = useState<string[]>([]);
  const lastCompCheck = useRef(0);

  // Feature 4: Pain Predictor
  const predictedPain = Math.min(10, Math.max(0, sessionPain + (angleDeviation > 25 ? 1 : angleDeviation > 10 ? 0 : -1)));
  const predictedPainColor = predictedPain <= 3 ? "var(--accent)" : predictedPain <= 6 ? "var(--warn)" : "var(--danger)";

  // Feature 5: Red Zone Alert
  const [redZoneActive, setRedZoneActive] = useState(false);
  const redZoneRef = useRef(false);

  const circumference = 2 * Math.PI * 50;
  const progressOffset = circumference - (Math.min(correctReps, config.targetReps) / config.targetReps) * circumference;

  const addFeedbackMessage = useCallback((text: string, type: FeedbackType) => {
    setFeedbackMessages((prev) => [...prev.slice(-19), { text, type, t: Date.now() - sessionStartRef.current }]);
  }, []);

  useEffect(() => {
    feedbackMessagesRef.current = feedbackMessages;
    feedbackLogRef.current?.scrollTo({ top: feedbackLogRef.current.scrollHeight, behavior: "smooth" });
  }, [feedbackMessages]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setElapsed(Date.now() - sessionStartRef.current);
    }, 500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (sessionPain >= 7) {
      setShowPainAlert(true);
      createNotification("PAIN_ALERT", "High pain reported", `Live session pain score: ${sessionPain}/10`, "/session");
      addFeedbackMessage("Pain is high. Pause and consider ending the session.", "danger");
    }
  }, [addFeedbackMessage, sessionPain]);

  const speakSpecialistCoach = useCallback(
    (
      event:
        | "intro"
        | "rep_start"
        | "approaching"
        | "target_reached"
        | "hold_guidance"
        | "return_start"
        | "rep_completed"
        | "safe_limit"
        | "camera_prompt",
      angle?: number,
      repNumber?: number,
    ) => {
      const now = Date.now();
      const isPriority = event === "target_reached" || event === "rep_completed" || event === "safe_limit";

      // Throttle non-priority coaching so cues are calm, encouraging, and natural
      if (!isPriority && now - lastSpokenTime.current < 6500) {
        return;
      }

      if (event === "camera_prompt") {
        if (now - lastCameraPromptTime.current < 25000) return;
        lastCameraPromptTime.current = now;
      }

      const text = getSpecialistCoachLine(config.name, config.targetAngle, event, {
        currentAngle: angle ?? currentAngleRef.current,
        repNumber: repNumber ?? (repCountRef.current + 1),
        targetReps: config.targetReps,
      });

      if (!text) return;

      let feedbackType: FeedbackType = "encouragement";
      if (event === "safe_limit") feedbackType = "danger";
      else if (event === "camera_prompt" || event === "approaching") feedbackType = "correction";

      addFeedbackMessage(text, feedbackType);
      lastSpokenTime.current = now;
      lastSpokenPhase.current = event;

      speakPhysioGuidance(text, {
        priority: isPriority,
        onStart: () => {
          isSpeakingRef.current = true;
          setIsSpeaking(true);
        },
        onEnd: () => {
          isSpeakingRef.current = false;
          setIsSpeaking(false);
        },
      });
    },
    [config.name, config.targetAngle, config.targetReps, addFeedbackMessage],
  );

  const drawFrame = useCallback(
    (smoothedLm: PoseLandmark[] | null) => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas) return;

      const videoWidth = video.videoWidth || 1280;
      const videoHeight = video.videoHeight || 720;
      if (canvas.width !== videoWidth || canvas.height !== videoHeight) {
        canvas.width = videoWidth;
        canvas.height = videoHeight;
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const w = canvas.width;
      const h = canvas.height;

      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.scale(-1, 1);
      ctx.drawImage(video, -w, 0, w, h);
      ctx.restore();

      const vignette = ctx.createRadialGradient(w / 2, h / 2, h * 0.3, w / 2, h / 2, h * 0.7);
      vignette.addColorStop(0, "transparent");
      vignette.addColorStop(1, "rgba(2,8,18,0.4)");
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, w, h);

      if (!smoothedLm || smoothedLm.length === 0) {
        if (poseDetectedRef.current) {
          poseDetectedRef.current = false;
          setPoseDetected(false);
        }
        return;
      }

      if (!poseDetectedRef.current) {
        poseDetectedRef.current = true;
        setPoseDetected(true);
      }

      const lm = smoothedLm;

      ctx.strokeStyle = "rgba(255,255,255,0.4)";
      ctx.lineWidth = 2;
      poseConnections.forEach(([i, j]) => {
        const a = lm[i];
        const b = lm[j];
        if (!a || !b) return;
        ctx.beginPath();
        ctx.moveTo((1 - a.x) * w, a.y * h);
        ctx.lineTo((1 - b.x) * w, b.y * h);
        ctx.stroke();
      });

      lm.forEach((point: PoseLandmark, i: number) => {
        const isKeyJoint = [11, 12, 23, 24, 25, 26, 27, 28].includes(i);
        ctx.beginPath();
        ctx.arc((1 - point.x) * w, point.y * h, isKeyJoint ? 6 : 3.5, 0, Math.PI * 2);
        ctx.fillStyle = isKeyJoint ? "#0EA5E9" : "rgba(255,255,255,0.6)";
        ctx.fill();
        if (isKeyJoint) {
          ctx.strokeStyle = "rgba(14,165,233,0.5)";
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      });

      const isStraightLeg = exerciseId.includes("straight-leg-raise");
      const hip = lm[currentSideRef.current === "RIGHT" ? 24 : 23];
      const knee = lm[currentSideRef.current === "RIGHT" ? 26 : 25];
      const ankle = lm[currentSideRef.current === "RIGHT" ? 28 : 27];
      const shoulder = lm[currentSideRef.current === "RIGHT" ? 12 : 11];

      if (isStraightLeg && hip && shoulder && knee) {
        const hx = (1 - hip.x) * w;
        const hy = hip.y * h;
        const angle1 = Math.atan2((shoulder.y - hip.y) * h, ((1 - shoulder.x) - (1 - hip.x)) * w);
        const angle2 = Math.atan2((knee.y - hip.y) * h, ((1 - knee.x) - (1 - hip.x)) * w);
        const arcTone = getAngleTone(currentAngleRef.current, config.targetAngle);

        ctx.beginPath();
        ctx.arc(hx, hy, 55, angle1, angle2);
        ctx.strokeStyle = arcTone.glow;
        ctx.lineWidth = 12;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(hx, hy, 50, angle1, angle2);
        ctx.strokeStyle = arcTone.color;
        ctx.lineWidth = 3;
        ctx.lineCap = "round";
        ctx.stroke();
      } else if (hip && knee && ankle) {
        const kx = (1 - knee.x) * w;
        const ky = knee.y * h;
        const angle1 = Math.atan2((hip.y - knee.y) * h, ((1 - hip.x) - (1 - knee.x)) * w);
        const angle2 = Math.atan2((ankle.y - knee.y) * h, ((1 - ankle.x) - (1 - knee.x)) * w);
        const arcTone = getAngleTone(currentAngleRef.current, config.targetAngle);

        ctx.beginPath();
        ctx.arc(kx, ky, 55, angle1, angle2);
        ctx.strokeStyle = arcTone.glow;
        ctx.lineWidth = 12;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(kx, ky, 50, angle1, angle2);
        ctx.strokeStyle = arcTone.color;
        ctx.lineWidth = 3;
        ctx.lineCap = "round";
        ctx.stroke();
      }
    },
    [config.targetAngle, exerciseId],
  );

  const processAngles = useCallback(
    (smoothedLm: PoseLandmark[]) => {
      if (!smoothedLm?.length || smoothedLm.length < 29) return;

      const side = sideTrackerRef.current.update(smoothedLm);
      if (!side) return;

      // Only require the landmarks for the active side being tracked
      const [hipIdx, kneeIdx, ankleIdx] = side === "RIGHT" ? [24, 26, 28] : [23, 25, 27];
      if (!smoothedLm[hipIdx] || !smoothedLm[kneeIdx] || !smoothedLm[ankleIdx]) return;

      const measurement = calculateExerciseAngle(smoothedLm, side, exerciseId);
      if (!measurement) return;

      currentSideRef.current = side;
      const prevAngle = currentAngleRef.current;
      const smoothed = angleSmootherRef.current.update(measurement.angle);
      const angle = roundAngle(smoothed);

      currentAngleRef.current = angle;
      if (shouldEmitDisplayAngle(lastDisplayEmitRef.current, angle)) {
        lastDisplayEmitRef.current = { time: Date.now(), value: angle };
        setCurrentAngle(angle);
      }

      if (angle > bestAngleRef.current) {
        bestAngleRef.current = angle;
        setBestAngle(angle);
      }

      const now = Date.now();
      if (now - lastAngleLogTime.current > 500) {
        lastAngleLogTime.current = now;
        angleLogRef.current.push({ t: now - sessionStartRef.current, a: angle });
      }

      // Movement phase guidance from specialist PT
      if (prevAngle <= 20 && angle >= 32) {
        speakSpecialistCoach("rep_start", angle);
      } else if (angle >= config.targetAngle - 18 && angle < config.targetAngle - 8) {
        speakSpecialistCoach("approaching", angle);
      }

      const repEvent = repCounterRef.current.update(smoothed);
      if (repEvent === "target_reached") {
        speakSpecialistCoach("target_reached", angle);
      } else if (repEvent === "rep_completed") {
        const nextRep = repCountRef.current + 1;
        repCountRef.current = nextRep;
        setRepCount(nextRep);
        const deviation = Math.abs(config.targetAngle - (bestAngleRef.current || angle));
        const isGood = deviation <= 14;
        if (isGood) setCorrectReps((val) => val + 1);
        setRepHistory((prev) => [...prev, { rep: nextRep, angle: bestAngleRef.current || angle, correct: isGood }]);
        speakSpecialistCoach("rep_completed", angle, nextRep);
        bestAngleRef.current = 0;
      }

      // Feature 5: Red Zone Alert (ONLY fires if pushing dangerously beyond target ROM)
      const nextRedZone = redZoneState(redZoneRef.current, angle, config.targetAngle);
      if (nextRedZone !== redZoneRef.current) {
        redZoneRef.current = nextRedZone;
        setRedZoneActive(nextRedZone);
        if (nextRedZone) {
          speakSpecialistCoach("safe_limit", angle);
        }
      }

      // Feature 3: Compensation Detector (check every 5s)
      const now2 = Date.now();
      if (now2 - lastCompCheck.current > 5000 && smoothedLm[11] && smoothedLm[12] && smoothedLm[23] && smoothedLm[24]) {
        lastCompCheck.current = now2;
        const issues: string[] = [];
        const shoulderTilt = Math.abs(smoothedLm[11].y - smoothedLm[12].y);
        const hipTilt = Math.abs(smoothedLm[23].y - smoothedLm[24].y);
        if (shoulderTilt > 0.08) issues.push("Shoulder tilt detected — keep shoulders level");
        if (hipTilt > 0.07) issues.push("Hip shift detected — keep hips square");
        setCompensations(issues);
      }
    },
    [exerciseId, config.targetAngle, speakSpecialistCoach],
  );

  const detectLoop = useCallback(
    (timestamp: number) => {
      if (
        timestamp - lastDetectTime.current > 33 &&
        landmarkerRef.current &&
        videoRef.current &&
        videoRef.current.readyState >= 2
      ) {
        lastDetectTime.current = timestamp;
        const results = landmarkerRef.current.detectForVideo(videoRef.current, timestamp) as PoseResult;
        if (results.landmarks && results.landmarks.length > 0) {
          consecutiveMissedFrames.current = 0;
          if (!poseDetectedRef.current) {
            poseDetectedRef.current = true;
            setPoseDetected(true);
          }
          const smoothedLm = landmarkSmootherRef.current.update(results.landmarks[0]);
          drawFrame(smoothedLm);
          processAngles(smoothedLm);
        } else {
          consecutiveMissedFrames.current += 1;
          // Hold last known smoothed landmarks during brief momentary drops to avoid flickering
          if (consecutiveMissedFrames.current <= 5) {
            drawFrame(landmarkSmootherRef.current.update([]));
          } else {
            drawFrame(null);
          }

          if (consecutiveMissedFrames.current > 25) {
            if (poseDetectedRef.current) {
              poseDetectedRef.current = false;
              setPoseDetected(false);
              speakSpecialistCoach("camera_prompt");
            }
          }
        }
      }
      animFrameRef.current = requestAnimationFrame(detectLoop);
    },
    [drawFrame, processAngles, speakSpecialistCoach],
  );

  const initMediaPipe = useCallback(async () => {
    setPoseState("loading");
    try {
      const { FilesetResolver, PoseLandmarker } = await import("@mediapipe/tasks-vision");
      const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm",
      );

      const poseOptions = {
        runningMode: "VIDEO" as const,
        numPoses: 1,
        minPoseDetectionConfidence: 0.45,
        minPosePresenceConfidence: 0.45,
        minTrackingConfidence: 0.45,
      };

      let landmarker: PoseLandmarker | null = null;
      const delegates: ("GPU" | "CPU")[] = ["GPU", "CPU"];

      for (const modelAssetPath of POSE_MODEL_URLS) {
        for (const delegate of delegates) {
          try {
            landmarker = await PoseLandmarker.createFromOptions(vision, {
              baseOptions: { modelAssetPath, delegate },
              ...poseOptions,
            });
            break;
          } catch {
            /* try next delegate / model */
          }
        }
        if (landmarker) break;
      }

      if (!landmarker) {
        throw new Error("Could not load any pose model");
      }

      landmarkerRef.current = landmarker;
      setPoseState("ready");
      animFrameRef.current = requestAnimationFrame(detectLoop);
    } catch (error) {
      console.error("MediaPipe init failed:", error);
      setPoseState("error");
    }
  }, [detectLoop]);

  const startCamera = useCallback(async () => {
    setCameraState("starting");
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraState("error");
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: "user",
          frameRate: { ideal: 30, max: 30 },
        },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraState("ready");
      await initMediaPipe();
    } catch (error: unknown) {
      setCameraState(error instanceof DOMException && error.name === "NotAllowedError" ? "denied" : "error");
    }
  }, [initMediaPipe]);

  useEffect(() => {
    sessionStartRef.current = Date.now();
    if (typeof window !== "undefined" && window.innerWidth < 768 && !sessionCleared) {
      setShowMobileWarning(true);
      return;
    }
    if (!sessionCleared || showRedFlagWarning) return;
    startCamera();
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      landmarkerRef.current?.close?.();
      stopAllSpeech();
    };
  }, [sessionCleared, showRedFlagWarning, startCamera]);

  // Virtual Patient Simulation Mode
  useEffect(() => {
    if (!isSimulating) return;
    setCameraState("ready");
    setPoseState("ready");
    setPoseDetected(true);

    let simTime = 0;
    let localReps = repCount;
    let localCorrect = correctReps;

    const interval = setInterval(() => {
      simTime += 0.08;
      const cycle = (Math.sin(simTime) + 1) / 2;
      const simAngle = Math.round(5 + cycle * (config.targetAngle - 5));

      setCurrentAngle(simAngle);
      currentAngleRef.current = simAngle;
      if (simAngle > bestAngleRef.current) {
        bestAngleRef.current = simAngle;
        setBestAngle(simAngle);
      }

      angleLogRef.current.push({ t: Date.now() - sessionStartRef.current, a: simAngle });

      // Check target reached
      if (Math.abs(simAngle - config.targetAngle) <= 6 && !simTargetReported.current) {
        simTargetReported.current = true;
        speakSpecialistCoach("target_reached", simAngle);
      } else if (Math.abs(simAngle - config.targetAngle) > 20) {
        simTargetReported.current = false;
      }

      // Count peak repetition
      if (Math.sin(simTime) > 0.96 && Math.sin(simTime - 0.08) <= 0.96) {
        localReps += 1;
        repCountRef.current = localReps;
        const isGood = Math.abs(simAngle - config.targetAngle) <= 12;
        if (isGood) localCorrect += 1;
        setRepCount(localReps);
        setCorrectReps(localCorrect);
        setRepHistory((prev) => [...prev, { rep: localReps, angle: simAngle, correct: isGood }]);
        speakSpecialistCoach("rep_completed", simAngle, localReps);
      }

      // Draw virtual stick figure skeleton on canvas
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          const w = canvas.width || 640;
          const h = canvas.height || 480;
          ctx.fillStyle = "#09121f";
          ctx.fillRect(0, 0, w, h);

          // Subtle coordinate grid
          ctx.strokeStyle = "rgba(255,255,255,0.06)";
          ctx.lineWidth = 1;
          for (let x = 0; x < w; x += 40) {
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
          }
          for (let y = 0; y < h; y += 40) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
          }

          // Stick figure kinematics
          const hipX = w * 0.44;
          const hipY = h * 0.48;
          const kneeX = hipX + 90;
          const kneeY = hipY + 90;
          const rad = (simAngle * Math.PI) / 180;
          const ankleX = kneeX - 90 * Math.sin(rad * 0.85);
          const ankleY = kneeY + 90 * Math.cos(rad * 0.85);

          // Draw torso
          ctx.strokeStyle = "#38bdf8";
          ctx.lineWidth = 5;
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(hipX - 15, hipY - 120);
          ctx.lineTo(hipX, hipY);
          ctx.stroke();

          // Thigh
          ctx.strokeStyle = "#0ea5e9";
          ctx.beginPath();
          ctx.moveTo(hipX, hipY);
          ctx.lineTo(kneeX, kneeY);
          ctx.stroke();

          // Shin with dynamic flexion color
          ctx.strokeStyle = Math.abs(simAngle - config.targetAngle) < 10 ? "#10b981" : "#0ea5e9";
          ctx.beginPath();
          ctx.moveTo(kneeX, kneeY);
          ctx.lineTo(ankleX, ankleY);
          ctx.stroke();

          // Nodes
          [[hipX, hipY], [kneeX, kneeY], [ankleX, ankleY], [hipX - 15, hipY - 120]].forEach(([px, py]) => {
            ctx.fillStyle = "#38bdf8";
            ctx.beginPath();
            ctx.arc(px, py, 7, 0, 2 * Math.PI);
            ctx.fill();
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = 2;
            ctx.stroke();
          });

          // Head
          ctx.beginPath();
          ctx.arc(hipX - 20, hipY - 150, 22, 0, 2 * Math.PI);
          ctx.fillStyle = "#e2e8f0";
          ctx.fill();

          // Angle arc
          ctx.strokeStyle = "#38bdf8";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(kneeX, kneeY, 34, Math.PI / 2, Math.PI / 2 + rad, false);
          ctx.stroke();

          // Angle text
          ctx.fillStyle = "#38bdf8";
          ctx.font = "bold 18px monospace";
          ctx.fillText(`${simAngle}°`, kneeX + 42, kneeY + 8);
        }
      }
    }, 70);

    return () => clearInterval(interval);
  }, [isSimulating, config.targetAngle, repCount, correctReps, speakSpecialistCoach]);

  const endSession = async () => {
    setPainAfter(sessionPain);
    setShowEndModal(true);

    const apiKey = getGeminiApiKey();
    if (apiKey) {
      setIsGeneratingSummary(true);
      try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        const prompt = `You are a licensed physical therapist writing an encouraging clinical progress note for a patient who just completed an exercise session.
Exercise: ${config.name} (${config.surgeryType}, Week ${config.recoveryWeek})
Target Angle: ${config.targetAngle}°
Best Achieved Angle: ${bestAngleRef.current || currentAngleRef.current}°
Reps: ${repCountRef.current || repCount} (${correctReps} with clean form)
Pain: ${sessionPain}/10 during session.
Compensations: ${compensations.length ? compensations.join(", ") : "None detected, clean form"}.
Write 2 concise, warm, professional sentences assessing their mobility, safety, and encouragement for their recovery journey.`;
        const result = await model.generateContent(prompt);
        setClinicalSummary(result.response.text().trim().replace(/[*_"]/g, ""));
      } catch (err) {
        console.warn("AI summary error:", err);
      } finally {
        setIsGeneratingSummary(false);
      }
    }
  };

  const saveSession = async () => {
    setIsSaving(true);
    const angleLog = angleLogRef.current;
    const avgAngle = angleLog.length
      ? Math.round(angleLog.reduce((sum, entry) => sum + entry.a, 0) / angleLog.length)
      : currentAngle;

    const user = getUser();
    const userId = user?.id || "demo-user";

    const payload = {
      user_id: userId,
      exercise_name: config.name,
      exercise_key: exerciseId,
      target_angle: config.targetAngle,
      achieved_angle: bestAngle,
      avg_angle: avgAngle,
      rep_count: repCount,
      correct_reps: correctReps,
      pain_before: 2,
      pain_after: painAfter,
      duration_seconds: Math.round(elapsed / 1000),
      angle_log: angleLog,
      feedback_log: feedbackMessagesRef.current,
      status: "COMPLETED" as const,
      week_number: config.recoveryWeek,
      ended_at: new Date().toISOString(),
    };

    saveLocalSession(payload);

    try {
      const supabase = await getBrowserSupabase();
      if (supabase) {
        await supabase.from("exercise_sessions").insert(payload);
        await supabase.from("notifications").insert({
          user_id: userId,
          type: "SESSION_REMINDER",
          title: "✅ Session complete",
          message: `${config.name}: ${bestAngle}° achieved · ${correctReps}/${repCount} correct reps`,
        });
      }
    } catch (error) {
      console.warn("Supabase insert skipped, saved locally:", error);
    }

    createNotification(
      bestAngle >= config.targetAngle ? "GREAT_PROGRESS" : "SESSION_REMINDER",
      bestAngle >= config.targetAngle ? "🏆 New personal best!" : "✅ Session complete",
      `${config.name}: ${bestAngle}° achieved · ${correctReps}/${repCount} correct reps`,
      "/activity"
    );

    setIsSaving(false);
    router.refresh();
    router.push("/dashboard");
  };

  const discardSession = () => router.push("/session");

  const headerTitle = useMemo(() => `RecoverX Session — ${config.name}`, [config.name]);

  return (
    <div className="min-h-screen overflow-hidden text-[var(--text-2)]" style={{ background: "var(--bg-page)" }}>
      <main className="relative z-10 flex h-screen flex-col gap-4 p-4 md:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link href="/session" className="btn-ghost inline-flex items-center gap-2 px-4 py-2 text-sm">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Link>
          <div className="min-w-0 flex-1 font-display text-lg font-semibold text-[var(--text-1)] md:text-xl">{headerTitle}</div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShow3dTwin(!show3dTwin)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border transition-all ${
                show3dTwin
                  ? "bg-sky-500/20 text-sky-400 border-sky-500/40"
                  : "bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700"
              }`}
              title="Toggle Live 3D Joint Biomechanics Twin"
            >
              <Sparkles className="w-3.5 h-3.5 text-sky-400" />
              <span>{show3dTwin ? "3D Twin Active" : "3D Twin"}</span>
            </button>
            <button
              onClick={() => setIsSimulating(!isSimulating)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border transition-all ${
                isSimulating
                  ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/40"
                  : "bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700"
              }`}
              title="Toggle Virtual Movement Simulation without camera"
            >
              <Sparkles className="w-3.5 h-3.5" />
              {isSimulating ? "Simulating Active" : "Virtual Demo"}
            </button>
            <div className="flex items-center gap-2 font-display text-xs font-semibold tracking-wider text-[var(--danger)]">
              <span className="h-2 w-2 rounded-full bg-[var(--danger)] animate-pulse-glow" />
              LIVE
            </div>
            <button onClick={endSession} className="btn-danger px-4 py-2 text-sm">End Session</button>
          </div>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[55fr_45fr]">
          <section
            className="card relative min-h-[420px] overflow-hidden rounded-[var(--r-lg)] bg-black"
            style={{
              border: redZoneActive ? "2px solid var(--danger)" : "1px solid var(--border)",
              boxShadow: redZoneActive ? "0 0 0 3px rgba(217,64,64,0.20), var(--shadow-lg)" : "var(--shadow-lg)",
              transition: "border-color 0.3s, box-shadow 0.3s",
            }}
          >
            <video ref={videoRef} playsInline muted autoPlay className="hidden" />

            {!isSimulating && (cameraState === "denied" || cameraState === "error") ? (
              <div className="absolute inset-0 flex items-center justify-center bg-[var(--bg-deep)] p-6">
                <div className="error-card max-w-md text-center">
                  <CameraOff className="mx-auto mb-4 h-12 w-12 text-[var(--danger)]" />
                  <h3 className="font-display text-2xl font-semibold text-[var(--text-1)]">Camera Access Needed</h3>
                  <p className="mt-3 font-body text-sm text-[var(--text-2)]">RecoverX needs your camera to track your exercise form.</p>
                  <p className="mt-2 font-body text-sm text-[var(--text-3)]">Click the camera icon in your browser address bar → Allow, or launch the interactive simulator below.</p>
                  <div className="mt-6 flex flex-col gap-2">
                    <button
                      onClick={() => setIsSimulating(true)}
                      className="btn-primary px-6 py-3 text-sm inline-flex items-center justify-center gap-2"
                    >
                      <Sparkles className="w-4 h-4" /> Launch Virtual Patient Simulator
                    </button>
                    <button onClick={() => window.location.reload()} className="btn-ghost px-6 py-2 text-xs">Try Camera Again</button>
                  </div>
                </div>
              </div>
            ) : (
              <>
                <canvas ref={canvasRef} className="h-full w-full object-cover" />

                {(cameraState === "starting" || poseState === "loading") && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-[rgba(13,27,42,0.82)] text-center">
                    <div className="mb-4 h-14 w-14 animate-spin rounded-full border-4 border-white/20 border-t-[var(--primary)]" />
                    <h3 className="font-display text-xl text-white">Preparing camera and pose model</h3>
                    <p className="mt-2 text-sm text-white/70">First load can take 10–20 seconds. Keep your full body visible once the feed starts.</p>
                  </div>
                )}

                {poseState === "error" && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-[rgba(255,255,255,0.92)] p-6 text-center">
                    <ShieldAlert className="mb-4 h-12 w-12 text-[var(--warn)]" />
                    <h3 className="font-display text-xl text-[var(--text-1)]">Pose tracking could not start</h3>
                    <button onClick={initMediaPipe} className="btn-primary mt-6 px-6 py-3 text-sm">Try Again</button>
                  </div>
                )}

                {!poseDetected && cameraState === "ready" && poseState === "ready" && (
                  <div className="no-pose-overlay absolute inset-0 flex flex-col items-center justify-center bg-[rgba(13,27,42,0.85)] text-center backdrop-blur-md transition-opacity duration-300">
                    <div className="text-5xl">🧘‍♂️</div>
                    <p className="mt-3 font-display text-xl text-white">Adjust your position</p>
                    <p className="mt-1 text-sm text-slate-300">Make sure your leg and knee are clearly in view of the camera (3–5 feet away)</p>
                  </div>
                )}

                <div className="angle-display absolute bottom-5 left-5 rounded-[var(--r-md)] p-5"
                  style={{
                    background: "rgba(13,27,42,0.75)",
                    backdropFilter: "blur(12px)",
                    border: "1px solid rgba(255,255,255,0.15)",
                  }}>
                  <div
                    className="angle-value font-data text-[64px] font-medium leading-none transition-colors md:text-[80px]"
                    style={{ color: tone.color, textShadow: `0 0 20px ${tone.glow}` }}
                  >
                    {currentAngle}°
                  </div>
                  <div className="mt-1 text-[13px] text-[var(--text-3)]">Target: {config.targetAngle}°</div>
                  <div className="badge mt-2" style={{
                    background: "rgba(255,255,255,0.12)",
                    border: "1px solid rgba(255,255,255,0.2)",
                    color: tone.color,
                  }}>
                    {tone.label}
                  </div>
                </div>

                {/* Feature 5: Red Zone overlay inside canvas */}
                {redZoneActive && (
                  <div style={{
                    position: "absolute", inset: 0,
                    border: "3px solid var(--danger)",
                    borderRadius: "inherit",
                    pointerEvents: "none",
                    animation: "redZonePulse 1s ease-in-out infinite",
                  }} />
                )}
              </>
            )}
          </section>

          <aside className="card flex min-h-0 flex-col overflow-hidden p-5" style={{ background: "#fff" }}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="font-display text-2xl font-semibold text-[var(--text-1)]">{config.name}</h2>
                <span className="badge badge-blue mt-2">Week {config.recoveryWeek}</span>
              </div>
              <button onClick={endSession} className="btn-danger px-4 py-2 text-sm">End Session</button>
            </div>

            <div className="my-4 text-center" style={{ borderBottom: "1px solid #F0F4F8", paddingBottom: 16 }}>
              <div className="font-data text-[44px]" style={{ color: "var(--primary)", fontWeight: 500 }}>{formatTime(elapsed)}</div>
              <div className="text-xs text-[var(--text-3)]">Session time</div>
            </div>

            {show3dTwin && (
              <div className="mb-4 rounded-xl overflow-hidden border border-slate-800 bg-slate-950 p-2 shadow-md">
                <div className="flex items-center justify-between px-2 py-1 mb-1 text-xs">
                  <div className="flex items-center gap-1.5 font-semibold text-sky-400">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                    <span>3D Kinematic Twin</span>
                  </div>
                  <span className="text-[11px] font-mono text-slate-300">
                    Live: {currentAngle}° / {config.targetAngle}°
                  </span>
                </div>
                <JointVisualizer3D
                  angle={currentAngle}
                  targetAngle={config.targetAngle}
                  height={170}
                  interactive={true}
                  showLabels={false}
                  showBadges={false}
                />
              </div>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[140px_1fr]">
              <div>
                <svg width="120" height="120" className="mx-auto block">
                  <circle cx="60" cy="60" r="50" fill="none" stroke="#EDF2F7" strokeWidth="8" />
                  <circle
                    cx="60"
                    cy="60"
                    r="50"
                    fill="none"
                    stroke="var(--accent)"
                    strokeWidth="8"
                    strokeLinecap="round"
                    strokeDasharray={circumference}
                    strokeDashoffset={progressOffset}
                    transform="rotate(-90 60 60)"
                    style={{ transition: "stroke-dashoffset 0.5s var(--ease-spring)" }}
                  />
                  <text x="60" y="54" textAnchor="middle" fill="var(--text-1)" fontFamily="var(--font-data)" fontSize="22">
                    {correctReps}
                  </text>
                  <text x="60" y="72" textAnchor="middle" fill="var(--text-3)" fontFamily="var(--font-body)" fontSize="11">
                    of {repCount} reps
                  </text>
                </svg>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <StatMini label="Target Reps" value={config.targetReps} />
                <StatMini label="Best Angle" value={`${bestAngle}°`} />
                {/* Feature 1: Form Score */}
                <StatMini label="Form Score" value={`${formScore}%`} />
                <StatMini label="Total Reps" value={repCount} />
              </div>
            </div>

            {/* Feature 3: Compensation Detector */}
            {compensations.length > 0 && (
              <div style={{
                background: "var(--warn-light)",
                border: "1px solid rgba(232,147,10,0.25)",
                borderLeft: "3px solid var(--warn)",
                borderRadius: "var(--r-md)",
                padding: "12px 14px",
                marginBottom: 16,
              }}>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: "var(--warn)", marginBottom: 6 }}>
                  ⚠️ Form Analysis
                </div>
                {compensations.map((issue, i) => (
                  <div key={i} style={{ fontSize: 12, color: "var(--text-2)", marginBottom: 4 }}>• {issue}</div>
                ))}
              </div>
            )}
            {compensations.length === 0 && cameraState === "ready" && poseState === "ready" && (
              <div style={{
                background: "var(--accent-light)",
                border: "1px solid rgba(14,168,116,0.25)",
                borderLeft: "3px solid var(--accent)",
                borderRadius: "var(--r-md)",
                padding: "10px 14px",
                marginBottom: 16,
                fontSize: 12,
                color: "var(--accent-dark)",
                fontWeight: 500,
              }}>
                ✓ Form clean — no compensations detected
              </div>
            )}

            <div className="my-4">
              <label className="text-xs text-[var(--text-3)]">Pain right now</label>
              <div className="mt-2 flex items-center gap-3">
                <input
                  type="range"
                  min="0"
                  max="10"
                  value={sessionPain}
                  onChange={(event) => setSessionPain(Number(event.target.value))}
                  className="h-2 flex-1 cursor-pointer accent-[var(--primary)]"
                />
                <span className="min-w-7 font-data text-lg" style={{ color: painColor(sessionPain) }}>{sessionPain}</span>
              </div>
            </div>

            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-display text-sm font-semibold uppercase tracking-wider text-[var(--text-3)]">AI Voice Feedback</h3>
              <Volume2 className={`h-4 w-4 ${isSpeaking ? "text-[var(--primary)] animate-pulse" : "text-[var(--text-3)]"}`} />
            </div>

            <div ref={feedbackLogRef} className="feedback-log min-h-0 flex-1 space-y-3 overflow-y-auto pr-2">
              {feedbackMessages.map((msg, i) => (
                <div
                  key={`${msg.t}-${i}`}
                  className="feedback-item flex gap-3 rounded-[var(--r-sm)] border border-[var(--border)] p-3"
                  style={{
                    borderLeft: `3px solid ${msg.type === "correction" ? "var(--warn)" : msg.type === "encouragement" ? "var(--accent)" : "var(--danger)"}`,
                    background: msg.type === "correction" ? "var(--warn-light)" : msg.type === "encouragement" ? "var(--accent-light)" : "var(--danger-light)",
                    animation: "slideInRight 0.3s var(--ease-out)",
                  }}
                >
                  <div className="feedback-icon text-lg">{msg.type === "correction" ? "🔧" : msg.type === "encouragement" ? "✅" : "⚠️"}</div>
                  <div>
                    <div className="text-sm text-[var(--text-1)]">{msg.text}</div>
                    <div className="mt-1 text-[11px] text-[var(--text-3)]">{formatTimecode(msg.t)}</div>
                  </div>
                </div>
              ))}
            </div>
          </aside>
        </div>
      </main>

      {showMobileWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(13,27,42,0.5)", backdropFilter: "blur(8px)" }}>
          <div className="card max-w-md p-6 text-center" style={{ background: "#fff" }}>
            <div style={{
              width: 80, height: 80, borderRadius: "50%",
              background: "var(--primary-light)", border: "1px solid var(--primary-mid)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 36, margin: "0 auto 16px",
            }}>💻</div>
            <h2 className="font-display text-2xl font-semibold text-[var(--text-1)]">Laptop recommended</h2>
            <p className="mt-3 text-sm leading-6 text-[var(--text-2)]">For the best experience, please use RecoverX on a laptop. Your webcam needs to see your full body.</p>
            <button onClick={() => { setShowMobileWarning(false); setSessionCleared(true); }} className="btn-primary mt-6 w-full px-6 py-3 text-sm">Continue anyway</button>
          </div>
        </div>
      )}

      {showRedFlagWarning && !showMobileWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,23,42,0.6)] p-4 backdrop-blur-md">
          <div className="card max-w-lg p-6">
            <h3 className="font-display text-2xl font-semibold text-[var(--text-1)]">Please note these red flags from your report:</h3>
            <ul className="mt-5 space-y-3">
              {["Fever, chills, or wound drainage.", "Sudden calf swelling or shortness of breath.", "Pain that does not improve with rest."].map((flag) => (
                <li key={flag} className="red-flag-item rounded-[var(--r-sm)] border border-[rgba(239,68,68,0.24)] border-l-[3px] border-l-[var(--danger)] bg-[rgba(239,68,68,0.05)] p-3 text-sm text-[var(--text-2)]">
                  🚨 {flag}
                </li>
              ))}
            </ul>
            <p className="mt-5 text-sm leading-6 text-[var(--text-3)]">If you are experiencing any of these, stop your session and contact your physiotherapist immediately.</p>
            <button
              onClick={() => {
                setShowRedFlagWarning(false);
                setSessionCleared(true);
                setTimeout(() => {
                  speakSpecialistCoach("intro");
                }, 600);
              }}
              className="btn-primary mt-6 w-full px-6 py-3 text-sm"
            >
              I understand, start session
            </button>
          </div>
        </div>
      )}

      {showPainAlert && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,23,42,0.6)] p-4 backdrop-blur-md">
          <div className="alert-modal card max-w-md border-[rgba(239,68,68,0.3)] p-6 text-center shadow-[0_0_40px_var(--danger-glow)]">
            <button onClick={() => setShowPainAlert(false)} className="absolute right-5 top-5 text-[var(--text-3)] hover:text-[var(--text-1)]">
              <X className="h-5 w-5" />
            </button>
            <div className="text-4xl">⚠️</div>
            <h2 className="mt-3 font-display text-2xl font-semibold text-[var(--danger)]">High Pain Reported</h2>
            <p className="mt-3 text-sm leading-6 text-[var(--text-2)]">You&apos;ve reported a pain score of <strong>{sessionPain}/10</strong>. We recommend resting today and contacting your physiotherapist before continuing.</p>
            <a href="tel:" className="btn-danger mt-6 inline-flex w-full justify-center px-6 py-3 text-sm">Call My Physiotherapist</a>
            <button onClick={() => setShowPainAlert(false)} className="btn-ghost mt-3 w-full px-6 py-3 text-sm">Continue Anyway</button>
          </div>
        </div>
      )}

      {showEndModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-[rgba(15,23,42,0.6)] p-4 backdrop-blur-md">
          <div className="card w-full max-w-xl p-8 text-center max-h-[90vh] overflow-y-auto">
            <div className="mb-4 text-5xl">🎉</div>
            <h2 className="font-display text-3xl font-semibold text-[var(--text-1)]">Session Complete!</h2>

            <div className="my-6 grid grid-cols-2 gap-4">
              <StatMini label="Duration" value={formatTime(elapsed)} />
              <StatMini label="Best Angle" value={`${bestAngle}°`} />
              <StatMini label="Total Reps" value={repCount} />
              <StatMini label="Correct" value={`${correctReps} / ${repCount}`} />
            </div>

            {/* AI Form Scorecard */}
            <div className="mb-4 rounded-xl border border-slate-700/60 bg-slate-900/60 p-4 text-left">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  <span className="font-display font-bold text-sm text-slate-200">AI Form Scorecard</span>
                </div>
                <span className={`px-2.5 py-0.5 rounded-full text-xs font-bold ${
                  formScore >= 75 ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" : "bg-amber-500/20 text-amber-400 border border-amber-500/30"
                }`}>
                  {formScore}% Clean Form
                </span>
              </div>

              {repHistory.length > 0 ? (
                <div className="space-y-1.5 max-h-32 overflow-y-auto pr-1">
                  {repHistory.map((r) => (
                    <div key={r.rep} className="flex items-center justify-between text-xs py-1.5 px-3 rounded bg-slate-800/80 border border-slate-700/50">
                      <span className="text-slate-400 font-mono font-medium">Rep #{r.rep}</span>
                      <span className="font-mono font-semibold text-sky-400">{r.angle}° / {config.targetAngle}°</span>
                      <span className={r.correct ? "text-emerald-400 font-medium flex items-center gap-1" : "text-amber-400 font-medium flex items-center gap-1"}>
                        {r.correct ? "✓ Target reached" : "↑ Ease deeper"}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-slate-400">Steady tempo maintained throughout workout.</div>
              )}
            </div>

            {/* Dr. AI Clinical Assessment */}
            {(isGeneratingSummary || clinicalSummary) && (
              <div className="mb-4 rounded-xl border border-sky-500/30 bg-sky-500/5 p-4 text-left">
                <div className="flex items-center gap-2 mb-2 text-xs font-bold text-sky-700 uppercase tracking-wider">
                  <Sparkles className="w-3.5 h-3.5 text-sky-600" />
                  <span>Dr. AI Clinical Review</span>
                </div>
                {isGeneratingSummary ? (
                  <div className="flex items-center gap-2 text-xs text-slate-500 py-1">
                    <span className="w-3 h-3 rounded-full border-2 border-sky-500 border-t-transparent animate-spin" />
                    <span>Analyzing biomechanics data...</span>
                  </div>
                ) : (
                  <p className="text-xs leading-5 text-[var(--text-1)] font-medium">{clinicalSummary}</p>
                )}
              </div>
            )}

            {/* Feature 4: Pain Predictor */}
            <div style={{
              background: "var(--secondary-light)",
              border: "1px solid rgba(91,110,245,0.25)",
              borderRadius: "var(--r-md)",
              padding: "14px 16px",
              marginBottom: 16,
              textAlign: "left",
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: "var(--secondary)", marginBottom: 6 }}>
                🔮 Predicted Pain After
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ fontFamily: "var(--font-data)", fontSize: 32, fontWeight: 600, color: predictedPainColor }}>
                  {predictedPain}/10
                </div>
                <div style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.5 }}>
                  Based on your current pain ({sessionPain}/10) and form deviation
                </div>
              </div>
            </div>

            <div className="my-4 text-left">
              <label className="text-sm text-[var(--text-2)]">How is your pain now? (0–10)</label>
              <div className="mt-2 flex items-center gap-3">
                <input type="range" min="0" max="10" value={painAfter} onChange={(event) => setPainAfter(Number(event.target.value))} className="flex-1 accent-[var(--primary)]" />
                <span className="min-w-7 font-data text-lg" style={{ color: painColor(painAfter) }}>{painAfter}</span>
              </div>
            </div>

            <div className="mt-6 flex flex-col gap-3 sm:flex-row">
              <button onClick={saveSession} disabled={isSaving} className="btn-primary flex-1 px-6 py-3 text-sm disabled:opacity-60">
                {isSaving ? "Saving..." : "Save Session ✓"}
              </button>
              <button onClick={discardSession} className="btn-ghost flex-1 px-6 py-3 text-sm">Discard</button>
            </div>
          </div>
        </div>
      )}

      <style jsx global>{`
        @keyframes slideInRight {
          from { opacity: 0; transform: translateX(12px); }
          to { opacity: 1; transform: translateX(0); }
        }
        @keyframes redZonePulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.6; }
        }
        .feedback-log::-webkit-scrollbar { width: 6px; }
        .feedback-log::-webkit-scrollbar-track { background: transparent; }
        .feedback-log::-webkit-scrollbar-thumb { background: var(--border-bright); border-radius: 999px; }
      `}</style>
    </div>
  );
}
