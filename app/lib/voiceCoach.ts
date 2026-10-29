/**
 * RecoverX Clinical Voice AI Coaching Engine
 *
 * Provides specialist physical therapy audio guidance.
 * Supports:
 * 1. ElevenLabs Voice AI (if an API key is provided) for ultra-realistic human clinical voice.
 * 2. High-fidelity Browser SpeechSynthesis with natural vocal selection, zero latency, and zero cost.
 */

export const ELEVENLABS_VOICE_RACHEL = "21m00Tcm4TlvDq8ikWAM"; // Calm, warm, clinical female voice
export const ELEVENLABS_VOICE_ADAM = "pNInz6obpgDQGcFmaJgB"; // Deep, reassuring male voice

export function getElevenLabsApiKey(): string {
  if (typeof window !== "undefined") {
    const customKey = localStorage.getItem("recoverx_elevenlabs_api_key");
    if (customKey && customKey.trim()) return customKey.trim();
  }
  return process.env.NEXT_PUBLIC_ELEVENLABS_API_KEY || "";
}

export function saveElevenLabsApiKey(key: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem("recoverx_elevenlabs_api_key", key.trim());
}

let activeAudio: HTMLAudioElement | null = null;
let isCurrentlySpeaking = false;

export function isAudioPlaying(): boolean {
  if (typeof window === "undefined") return false;
  return isCurrentlySpeaking || (window.speechSynthesis ? window.speechSynthesis.speaking : false);
}

export function stopAllSpeech(): void {
  if (typeof window === "undefined") return;
  if (activeAudio) {
    activeAudio.pause();
    activeAudio.currentTime = 0;
    activeAudio = null;
  }
  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
  isCurrentlySpeaking = false;
}

/**
 * Speaks a specialist guidance message.
 * Falls back seamlessly to Web Speech API if ElevenLabs is not configured or fails.
 */
export async function speakPhysioGuidance(
  text: string,
  options?: {
    priority?: boolean;
    voiceId?: string;
    onStart?: () => void;
    onEnd?: () => void;
  },
): Promise<void> {
  if (typeof window === "undefined") return;

  const priority = options?.priority ?? false;

  // If already speaking and this isn't an emergency priority message, skip to avoid overlap
  if (isAudioPlaying() && !priority) {
    return;
  }

  if (priority) {
    stopAllSpeech();
  }

  isCurrentlySpeaking = true;
  options?.onStart?.();

  const elevenLabsKey = getElevenLabsApiKey();

  if (elevenLabsKey) {
    try {
      const voiceId = options?.voiceId || ELEVENLABS_VOICE_RACHEL;
      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: "POST",
        headers: {
          Accept: "audio/mpeg",
          "Content-Type": "application/json",
          "xi-api-key": elevenLabsKey,
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_monolingual_v1",
          voice_settings: {
            stability: 0.65,
            similarity_boost: 0.75,
          },
        }),
      });

      if (response.ok) {
        const blob = await response.blob();
        const audioUrl = URL.createObjectURL(blob);
        const audio = new Audio(audioUrl);
        activeAudio = audio;

        audio.onended = () => {
          isCurrentlySpeaking = false;
          activeAudio = null;
          URL.revokeObjectURL(audioUrl);
          options?.onEnd?.();
        };

        audio.onerror = () => {
          isCurrentlySpeaking = false;
          activeAudio = null;
          URL.revokeObjectURL(audioUrl);
          // Fallback to web speech
          speakViaBrowserSynth(text, options?.onEnd);
        };

        await audio.play();
        return;
      }
    } catch (err) {
      console.warn("ElevenLabs TTS error, falling back to browser speech:", err);
    }
  }

  // Fallback: Browser Web Speech API
  speakViaBrowserSynth(text, () => {
    isCurrentlySpeaking = false;
    options?.onEnd?.();
  });
}

function speakViaBrowserSynth(text: string, onEnd?: () => void): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    onEnd?.();
    return;
  }

  try {
    const synth = window.speechSynthesis;
    const utterance = new SpeechSynthesisUtterance(text);

    // Pick the most natural, human-like voice available
    const voices = synth.getVoices();
    if (voices && voices.length > 0) {
      const preferredVoices = [
        "Samantha", // macOS natural
        "Ava",       // macOS premium
        "Daniel",    // macOS UK natural
        "Victoria",  // macOS natural
        "Karen",     // macOS Australian
        "Google US English",
        "Google UK English Female",
        "Microsoft Jenny Online",
        "Microsoft Aria Online",
        "Natural",
      ];

      let chosen: SpeechSynthesisVoice | undefined;
      for (const name of preferredVoices) {
        chosen = voices.find((v) => v.name.includes(name));
        if (chosen) break;
      }

      if (!chosen) {
        chosen = voices.find(
          (v) =>
            v.lang.startsWith("en") &&
            !v.name.toLowerCase().includes("whisper") &&
            !v.name.toLowerCase().includes("bells"),
        );
      }

      if (chosen) utterance.voice = chosen;
    }

    utterance.rate = 0.95; // Calm, empathetic healthcare speaking rate
    utterance.pitch = 1.0;
    utterance.volume = 1.0;

    utterance.onend = () => {
      onEnd?.();
    };

    utterance.onerror = () => {
      onEnd?.();
    };

    synth.speak(utterance);
  } catch (err) {
    console.warn("Speech synthesis error:", err);
    onEnd?.();
  }
}

/**
 * Specialist clinical dialogue generation for physiotherapy
 */
export function getSpecialistCoachLine(
  exerciseName: string,
  targetAngle: number,
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
  context?: {
    repNumber?: number;
    targetReps?: number;
    currentAngle?: number;
  },
): string {
  const rep = context?.repNumber ?? 1;
  const targetReps = context?.targetReps ?? 10;
  const angle = context?.currentAngle ?? 0;

  switch (event) {
    case "intro":
      return `Welcome to your session. Let's do ${exerciseName}. Our target today is ${targetAngle} degrees. Sit or lie comfortably, and when you are ready, begin your first repetition.`;

    case "rep_start":
      return "Bending smoothly. Keep your motion steady and controlled.";

    case "approaching":
      return `Almost at your target, passing ${angle} degrees. Gentle pull.`;

    case "target_reached": {
      const phrases = [
        `Target reached! Hold it right here. Breathe steadily.`,
        `Right at ${targetAngle} degrees, excellent control. Hold for a moment.`,
        `Perfect angle achieved. Hold that position.`,
        `Great depth! Hold steady. Three, two, one.`,
      ];
      return phrases[Math.floor(Math.random() * phrases.length)];
    }

    case "hold_guidance":
      return "Hold that stretch gently. Breathe in, and slowly breathe out.";

    case "return_start":
      return "Now slowly straighten back out. Control the movement all the way down.";

    case "rep_completed": {
      if (rep === Math.floor(targetReps / 2)) {
        return `Halfway through! ${rep} repetitions complete with strong form. Take a breath and continue.`;
      }
      if (rep >= targetReps) {
        return `Set complete! All ${targetReps} reps finished. Outstanding work today! Rest and relax your leg.`;
      }
      const phrases = [
        `Repetition ${rep} complete. Great control.`,
        `Rep ${rep} counted. Smooth return.`,
        `Nice repetition ${rep}. Keep that exact rhythm.`,
        `Rep ${rep} finished. Looking very steady.`,
      ];
      return phrases[(rep - 1) % phrases.length];
    }

    case "safe_limit":
      return "You've reached your safe range for today. Hold gently right here without pushing further.";

    case "camera_prompt":
      return "Please adjust so your leg and knee are clearly in view of the camera.";

    default:
      return "";
  }
}

