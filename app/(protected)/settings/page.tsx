"use client";

import { useMemo, useState, useEffect } from "react";
import { Download, ShieldAlert, Trash2 } from "lucide-react";
import { getUser } from "../../lib/auth";
import {
  speakPhysioGuidance,
  getElevenLabsApiKey,
  saveElevenLabsApiKey,
} from "../../lib/voiceCoach";

type Tab = "Account" | "Notifications" | "AI & Diagnostics" | "Privacy & Data";

const sampleExport = {
  sessions: [{ exercise_name: "Knee Flexion", achieved_angle: 82, rep_count: 10 }],
  checkins: [{ pain_score: 4, mood: "Good", created_at: "2026-05-21" }],
  report: { surgeryType: "Total Knee Replacement", allowedROM: { min: 0, max: 90 } },
};

function strength(password: string) {
  let score = 0;
  if (password.length >= 8) score++;
  if (/[A-Z]/.test(password)) score++;
  if (/\d/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;
  return score;
}

function Toggle({ on, setOn }: { on: boolean; setOn: (value: boolean) => void }) {
  return <button onClick={() => setOn(!on)} className={`toggle ${on ? "on" : ""}`} aria-pressed={on} />;
}

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<Tab>("Account");
  const [email, setEmail] = useState("arjun@example.com");
  const [geminiKey, setGeminiKey] = useState("");
  const [keySaved, setKeySaved] = useState(false);
  const [elevenLabsKey, setElevenLabsKey] = useState("");
  const [elevenLabsSaved, setElevenLabsSaved] = useState(false);
  const [speechTesting, setSpeechTesting] = useState(false);

  useEffect(() => {
    const user = getUser();
    if (user?.email) {
      setEmail(user.email);
    }
    const savedKey =
      localStorage.getItem("recoverx_gemini_api_key") ||
      localStorage.getItem("gemini_api_key") ||
      "";
    setGeminiKey(savedKey);
    setElevenLabsKey(getElevenLabsApiKey());
  }, []);

  const handleSaveGeminiKey = (e: React.FormEvent) => {
    e.preventDefault();
    localStorage.setItem("recoverx_gemini_api_key", geminiKey.trim());
    localStorage.setItem("gemini_api_key", geminiKey.trim());
    setKeySaved(true);
    setTimeout(() => setKeySaved(false), 3000);
  };

  const handleSaveElevenLabsKey = (e: React.FormEvent) => {
    e.preventDefault();
    saveElevenLabsApiKey(elevenLabsKey);
    setElevenLabsSaved(true);
    setTimeout(() => setElevenLabsSaved(false), 3000);
  };

  const handleTestSpeech = () => {
    setSpeechTesting(true);
    speakPhysioGuidance("Welcome to your knee rehabilitation session. Let's do Knee Flexion with a target of 90 degrees. Move slowly and listen to your body.", {
      priority: true,
      onEnd: () => setSpeechTesting(false),
    });
  };

  const [newPassword, setNewPassword] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleteDataConfirm, setDeleteDataConfirm] = useState("");
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);
  const [showDeleteData, setShowDeleteData] = useState(false);
  const [sessionReminders, setSessionReminders] = useState(true);
  const [progressMilestones, setProgressMilestones] = useState(true);
  const [painAlerts, setPainAlerts] = useState(true);
  const [weeklySummaries, setWeeklySummaries] = useState(true);

  const passwordStrength = strength(newPassword);
  const deviceStatus = useMemo(() => ({
    webgl: typeof window !== "undefined" && !!document.createElement("canvas").getContext("webgl"),
    camera: typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia ? "Available" : "Needs browser permission",
    speech: typeof window !== "undefined" && "speechSynthesis" in window,
  }), []);

  function downloadData() {
    const blob = new Blob([JSON.stringify(sampleExport, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "recoverx-patient-data-export.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="relative min-h-screen overflow-hidden px-5 py-8 md:px-8">
      <div className="space-grid" />
      <div className="relative z-10 mx-auto max-w-5xl pb-12">
        <header className="mb-6">
          <p className="font-data text-xs uppercase tracking-[0.22em] text-[var(--primary)]">System & Patient Preferences</p>
          <h1 className="mt-2 font-display text-3xl font-semibold text-[var(--text-1)] md:text-4xl">Settings</h1>
        </header>

        <div className="mb-6 flex flex-wrap gap-2">
          {(["Account", "Notifications", "AI & Diagnostics", "Privacy & Data"] as Tab[]).map((tab) => (
            <button key={tab} onClick={() => setActiveTab(tab)} className={`rounded-full border px-5 py-2 text-sm font-medium transition ${activeTab === tab ? "border-[var(--primary)] bg-[var(--primary-dim)] text-[var(--primary)] shadow-sm" : "border-[var(--border)] text-[var(--text-3)] hover:text-[var(--text-2)]"}`}>
              {tab}
            </button>
          ))}
        </div>

        {activeTab === "Account" && (
          <section className="grid gap-6 lg:grid-cols-2">
            <div className="card p-5">
              <h2 className="font-display text-xl font-semibold text-[var(--text-1)]">Change email</h2>
              <label className="mt-5 block text-xs text-[var(--text-3)]">Current email</label>
              <input value={email} readOnly className="mt-2 w-full rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--bg-input)] p-3 text-sm text-[var(--text-2)]" />
              <label className="mt-4 block text-xs text-[var(--text-3)]">New email</label>
              <input className="mt-2 w-full rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--bg-input)] p-3 text-sm text-[var(--text-1)] outline-none focus:border-[var(--primary)]" />
              <label className="mt-4 block text-xs text-[var(--text-3)]">Confirm new email</label>
              <input className="mt-2 w-full rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--bg-input)] p-3 text-sm text-[var(--text-1)] outline-none focus:border-[var(--primary)]" />
              <button className="btn-primary mt-5 px-6 py-3 text-sm">Update email</button>
            </div>

            <div className="card p-5">
              <h2 className="font-display text-xl font-semibold text-[var(--text-1)]">Change password</h2>
              {["Current password", "New password", "Confirm new password"].map((label, index) => (
                <div key={label}>
                  <label className="mt-5 block text-xs text-[var(--text-3)]">{label}</label>
                  <input type="password" value={index === 1 ? newPassword : undefined} onChange={index === 1 ? (event) => setNewPassword(event.target.value) : undefined} className="mt-2 w-full rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--bg-input)] p-3 text-sm text-[var(--text-1)] outline-none focus:border-[var(--primary)]" />
                </div>
              ))}
              <div className="mt-3 grid grid-cols-4 gap-2">
                {[1, 2, 3, 4].map((step) => <div key={step} className={`h-2 rounded-full ${passwordStrength >= step ? "bg-[var(--accent)]" : "bg-[var(--bg-elevated)]"}`} />)}
              </div>
              <button className="btn-primary mt-5 px-6 py-3 text-sm">Update password</button>
            </div>

            <div className="card border-[rgba(239,68,68,0.28)] bg-[rgba(239,68,68,0.05)] p-5 lg:col-span-2">
              <h2 className="font-display text-xl font-semibold text-[var(--danger)]">Danger Zone</h2>
              <p className="mt-2 text-sm text-[var(--text-2)]">Deleting your account permanently removes your profile, reports, sessions, and check-ins.</p>
              <button onClick={() => setShowDeleteAccount(true)} className="btn-danger mt-5 inline-flex items-center gap-2 px-6 py-3 text-sm"><Trash2 className="h-4 w-4" /> Delete Account</button>
            </div>
          </section>
        )}

        {activeTab === "Notifications" && (
          <section className="card p-5">
            <h2 className="font-display text-xl font-semibold text-[var(--text-1)]">Notifications</h2>
            <div className="mt-5 divide-y divide-[var(--border)]">
              <div className="flex items-center justify-between py-4">
                <div>
                  <div className="font-display text-sm font-semibold text-[var(--text-1)]">Session reminders</div>
                  <input type="time" defaultValue="09:00" className="mt-2 rounded-full border border-[var(--border)] bg-[var(--bg-input)] px-3 py-2 text-sm text-[var(--text-1)]" />
                </div>
                <Toggle on={sessionReminders} setOn={setSessionReminders} />
              </div>
              <NotifyRow label="Progress milestones" on={progressMilestones} setOn={setProgressMilestones} />
              <NotifyRow label="Pain alerts" on={painAlerts} setOn={setPainAlerts} />
              <NotifyRow label="Weekly summaries" on={weeklySummaries} setOn={setWeeklySummaries} />
            </div>
          </section>
        )}

        {activeTab === "AI & Diagnostics" && (
          <section className="grid gap-6 lg:grid-cols-2">
            <div className="card p-6 space-y-4">
              <div className="flex items-center gap-2">
                <span className="text-xl">✨</span>
                <h2 className="font-display text-xl font-semibold text-[var(--text-1)]">
                  Google Gemini Intelligence API Key
                </h2>
              </div>
              <p className="text-xs text-[var(--text-3)] leading-relaxed">
                RecoverX comes with a built-in fallback clinical engine that works 100% offline. If you want live, unbounded generative queries for reports and check-ins, provide your Google Gemini API key below.
              </p>

              <form onSubmit={handleSaveGeminiKey} className="space-y-3 pt-2">
                <label className="block text-xs font-semibold text-[var(--text-2)]">Gemini API Key</label>
                <input
                  type="password"
                  value={geminiKey}
                  onChange={(e) => setGeminiKey(e.target.value)}
                  placeholder="AIzaSy..."
                  className="w-full rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--bg-input)] p-3 text-sm font-mono text-[var(--text-1)] outline-none focus:border-[var(--primary)] transition"
                />
                <div className="flex items-center gap-3 pt-1">
                  <button type="submit" className="btn-primary px-5 py-2.5 text-xs font-semibold">
                    Save Key
                  </button>
                  {geminiKey && (
                    <button
                      type="button"
                      onClick={() => {
                        setGeminiKey("");
                        localStorage.removeItem("recoverx_gemini_api_key");
                        localStorage.removeItem("gemini_api_key");
                      }}
                      className="px-4 py-2.5 text-xs font-medium text-[var(--danger)] hover:bg-[var(--danger-light)] rounded-[var(--r-sm)] transition"
                    >
                      Remove Key
                    </button>
                  )}
                </div>
              </form>

              {keySaved && (
                <div className="p-3 rounded-lg bg-[var(--accent-light)] text-[var(--accent-dark)] text-xs font-semibold border border-[var(--accent)]/30 animate-fadeIn">
                  ✓ Custom Gemini API Key saved to local secure storage!
                </div>
              )}
            </div>

            <div className="card p-6 space-y-4">
              <div className="flex items-center gap-2">
                <span className="text-xl">🗣️</span>
                <h2 className="font-display text-xl font-semibold text-[var(--text-1)]">
                  ElevenLabs Voice AI (Specialist Audio)
                </h2>
              </div>
              <p className="text-xs text-[var(--text-3)] leading-relaxed">
                RecoverX includes high-fidelity clinical audio guidance using browser speech synthesis out-of-the-box. If you want hyper-realistic human AI voice cloning, provide your ElevenLabs API key below.
              </p>

              <form onSubmit={handleSaveElevenLabsKey} className="space-y-3 pt-2">
                <label className="block text-xs font-semibold text-[var(--text-2)]">ElevenLabs API Key (Optional)</label>
                <input
                  type="password"
                  value={elevenLabsKey}
                  onChange={(e) => setElevenLabsKey(e.target.value)}
                  placeholder="xi-api-key..."
                  className="w-full rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--bg-input)] p-3 text-sm font-mono text-[var(--text-1)] outline-none focus:border-[var(--primary)] transition"
                />
                <div className="flex items-center gap-3 pt-1">
                  <button type="submit" className="btn-primary px-5 py-2.5 text-xs font-semibold">
                    Save Key
                  </button>
                  {elevenLabsKey && (
                    <button
                      type="button"
                      onClick={() => {
                        setElevenLabsKey("");
                        saveElevenLabsApiKey("");
                      }}
                      className="px-4 py-2.5 text-xs font-medium text-[var(--danger)] hover:bg-[var(--danger-light)] rounded-[var(--r-sm)] transition"
                    >
                      Remove Key
                    </button>
                  )}
                </div>
              </form>

              {elevenLabsSaved && (
                <div className="p-3 rounded-lg bg-[var(--accent-light)] text-[var(--accent-dark)] text-xs font-semibold border border-[var(--accent)]/30 animate-fadeIn">
                  ✓ ElevenLabs Voice AI Key saved! Live sessions will now use ultra-realistic audio.
                </div>
              )}
            </div>

            <div className="card p-6 space-y-4">
              <div className="flex items-center gap-2">
                <span className="text-xl">🎙️</span>
                <h2 className="font-display text-xl font-semibold text-[var(--text-1)]">
                  Audio & Computer Vision Diagnostics
                </h2>
              </div>
              <p className="text-xs text-[var(--text-3)] leading-relaxed">
                Verify that your browser&apos;s real-time Web Audio coach, WebGL skeleton processor, and camera stream are ready for exercise sessions.
              </p>

              <div className="space-y-3 pt-2">
                <div className="flex items-center justify-between p-3.5 rounded-xl border border-[var(--border)] bg-[var(--bg-input)]">
                  <div>
                    <div className="text-xs font-semibold text-[var(--text-1)]">Audio Coach Voice</div>
                    <div className="text-[11px] text-[var(--text-3)]">
                      {deviceStatus.speech ? "SpeechSynthesis Engine Ready" : "Speech Synthesis Unavailable"}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleTestSpeech}
                    disabled={speechTesting || !deviceStatus.speech}
                    className="px-4 py-2 rounded-lg text-xs font-semibold bg-[var(--primary)] text-white hover:opacity-90 transition disabled:opacity-50"
                  >
                    {speechTesting ? "Playing..." : "Test Voice Coach"}
                  </button>
                </div>

                <div className="flex items-center justify-between p-3.5 rounded-xl border border-[var(--border)] bg-[var(--bg-input)]">
                  <div>
                    <div className="text-xs font-semibold text-[var(--text-1)]">MediaPipe BlazePose Accel</div>
                    <div className="text-[11px] text-[var(--text-3)]">
                      {deviceStatus.webgl ? "WebGL Hardware Acceleration Active" : "Software Fallback"}
                    </div>
                  </div>
                  <span className="text-xs font-semibold text-emerald-500">
                    {deviceStatus.webgl ? "✓ Ready" : "Notice"}
                  </span>
                </div>

                <div className="flex items-center justify-between p-3.5 rounded-xl border border-[var(--border)] bg-[var(--bg-input)]">
                  <div>
                    <div className="text-xs font-semibold text-[var(--text-1)]">Camera Stream Status</div>
                    <div className="text-[11px] text-[var(--text-3)]">{deviceStatus.camera}</div>
                  </div>
                  <a
                    href="/session/knee-flexion"
                    className="text-xs font-semibold text-[var(--primary)] underline hover:opacity-80"
                  >
                    Test In Session
                  </a>
                </div>
              </div>
            </div>
          </section>
        )}

        {activeTab === "Privacy & Data" && (
          <section className="grid gap-6 lg:grid-cols-2">
            <div className="card p-5">
              <h2 className="font-display text-xl font-semibold text-[var(--text-1)]">Your data</h2>
              <button onClick={downloadData} className="btn-primary mt-5 inline-flex items-center gap-2 px-6 py-3 text-sm"><Download className="h-4 w-4" /> Download My Data</button>
              <button onClick={() => setShowDeleteData(true)} className="btn-danger mt-3 inline-flex items-center gap-2 px-6 py-3 text-sm"><Trash2 className="h-4 w-4" /> Delete All My Data</button>
            </div>

            <div className="card p-5">
              <h2 className="font-display text-xl font-semibold text-[var(--text-1)]">Device status</h2>
              <div className="mt-5 space-y-3 text-sm">
                <Status label="WebGL" value={deviceStatus.webgl ? "✓ Supported (required for MediaPipe)" : "Not supported"} />
                <Status label="Camera" value={deviceStatus.camera} href="/session/knee-flexion" />
                <Status label="Microphone" value="N/A (we output only)" />
                <Status label="Speech Synthesis" value={deviceStatus.speech ? "✓ Supported" : "Not supported"} />
              </div>
            </div>
          </section>
        )}
      </div>

      {showDeleteAccount && (
        <ConfirmModal title="Delete Account" confirm={deleteConfirm} setConfirm={setDeleteConfirm} onClose={() => setShowDeleteAccount(false)} />
      )}
      {showDeleteData && (
        <ConfirmModal title="Delete All My Data" confirm={deleteDataConfirm} setConfirm={setDeleteDataConfirm} onClose={() => setShowDeleteData(false)} />
      )}
    </main>
  );
}

function NotifyRow({ label, on, setOn }: { label: string; on: boolean; setOn: (value: boolean) => void }) {
  return (
    <div className="flex items-center justify-between py-4">
      <span className="font-display text-sm font-semibold text-[var(--text-1)]">{label}</span>
      <Toggle on={on} setOn={setOn} />
    </div>
  );
}

function Status({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--bg-input)] p-3">
      <span className="text-[var(--text-3)]">{label}</span>
      {href ? <a href={href} className="text-right text-[var(--primary)]">{value}</a> : <span className="text-right text-[var(--text-1)]">{value}</span>}
    </div>
  );
}

function ConfirmModal({ title, confirm, setConfirm, onClose }: { title: string; confirm: string; setConfirm: (value: string) => void; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,23,42,0.6)] p-4 backdrop-blur-md">
      <div className="card max-w-md border-[rgba(239,68,68,0.3)] p-6">
        <ShieldAlert className="mb-4 h-10 w-10 text-[var(--danger)]" />
        <h2 className="font-display text-2xl font-semibold text-[var(--danger)]">{title}</h2>
        <p className="mt-3 text-sm text-[var(--text-2)]">Type <strong>DELETE</strong> to confirm this permanent action.</p>
        <input value={confirm} onChange={(event) => setConfirm(event.target.value)} className="mt-4 w-full rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--bg-input)] p-3 text-sm text-[var(--text-1)] outline-none focus:border-[var(--danger)]" />
        <div className="mt-5 flex gap-3">
          <button disabled={confirm !== "DELETE"} className="btn-danger flex-1 px-5 py-3 text-sm disabled:opacity-40">Confirm Delete</button>
          <button onClick={onClose} className="btn-ghost flex-1 px-5 py-3 text-sm">Cancel</button>
        </div>
      </div>
    </div>
  );
}
