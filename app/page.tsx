"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Camera,
  Check,
  X,
  Flame,
  Snowflake,
  Coffee,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Trash2,
  History as HistoryIcon,
  Sparkles,
  Zap,
  Wallet,
  Star,
  Droplet,
} from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, Cell } from "recharts";
import { getDeviceId } from "@/lib/deviceId";
import type { Entry } from "@/lib/types";

// Kinetic Utility palette (Stitch design direction).
const C = {
  bg: "#faf9fe",
  card: "#ffffff",
  cell: "#eeedf3",
  border: "#e6e5ec",
  text: "#1a1b1f",
  muted: "#6e6a75",
  primary: "#bc000a",
  primaryFixed: "#ffdad5",
  blue: "#0058bc",
  blueFixed: "#d8e2ff",
  hotText: "#b3261e",
  hotBg: "#ffdbd3",
  coldText: "#0058bc",
  coldBg: "#d3e3ff",
};

const QUICK_ITEMS = [
  { name: "BOSS Rainbow Mountain", brand: "Suntory", size_ml: 185, caffeine_mg: 90, calories: 30 },
  { name: "Georgia Emerald Mountain", brand: "Coca-Cola", size_ml: 185, caffeine_mg: 95, calories: 40 },
  { name: "Wonda Morning Shot", brand: "Asahi", size_ml: 185, caffeine_mg: 100, calories: 25 },
  { name: "Doutor Blend Coffee", brand: "Doutor", size_ml: 240, caffeine_mg: 130, calories: 5 },
  { name: "Starbucks Iced Coffee", brand: "Starbucks", size_ml: 350, caffeine_mg: 165, calories: 15 },
  { name: "McDonald's Premium Roast", brand: "McDonald's", size_ml: 250, caffeine_mg: 145, calories: 5 },
];

type Num = number | string;
type Temp = "hot" | "cold" | null;

interface Draft {
  jan: string | null;
  brand: string;
  name: string;
  name_is_generic?: boolean;
  size_ml: Num;
  calories: Num;
  carbs_g: Num;
  protein_g: Num;
  fat_g: Num;
  sodium_mg: Num;
  caffeine_mg: Num;
  caffeine_is_estimate: boolean;
  confidence?: string;
  notes?: string;
  price_yen: Num;
  temperature: Temp;
  previewUrl?: string | null;
  fromCache?: boolean;
}

function todayISO() {
  return new Date().toISOString();
}
function monthKey(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function fmtMonthLabel(key: string) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

// Human day heading (Today / Yesterday / "Mon 3") for the grouped history list.
function dayHeading(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

// Downscale the photo before sending. iPhone photos are ~3000-4000px; the model
// resizes them anyway, so shrinking client-side cuts tokens, upload size, and cost
// with no loss of barcode/label legibility at ~1000px.
async function downscaleToBase64(
  file: File,
  maxDim = 1000
): Promise<{ base64: string; mediaType: string }> {
  const dataUrl: string = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = dataUrl;
  });
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { base64: dataUrl.split(",")[1], mediaType: file.type || "image/jpeg" };
  ctx.drawImage(img, 0, 0, w, h);
  const out = canvas.toDataURL("image/jpeg", 0.82);
  return { base64: out.split(",")[1], mediaType: "image/jpeg" };
}

// Postgres numeric columns come back as strings via postgres.js — coerce them.
function normalizeEntry(e: Entry): Entry {
  return {
    ...e,
    size_ml: Number(e.size_ml) || 0,
    calories: Number(e.calories) || 0,
    carbs_g: Number(e.carbs_g) || 0,
    protein_g: Number(e.protein_g) || 0,
    fat_g: Number(e.fat_g) || 0,
    sodium_mg: Number(e.sodium_mg) || 0,
    caffeine_mg: Number(e.caffeine_mg) || 0,
    price_yen: Number(e.price_yen) || 0,
    temperature: e.temperature === "hot" || e.temperature === "cold" ? e.temperature : null,
  };
}

export default function CanLog() {
  const [deviceId, setDeviceId] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [tab, setTab] = useState<"log" | "history" | "wrapped">("log");
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [manualMode, setManualMode] = useState(false);
  const [wrappedMonth, setWrappedMonth] = useState(monthKey(todayISO()));
  const [stage, setStage] = useState<null | "barcode" | "label" | "cache-hit">(null);
  const [lookingUpName, setLookingUpName] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lastFile, setLastFile] = useState<File | null>(null);
  const [lastBase64, setLastBase64] = useState<string | null>(null);
  const [lastMediaType, setLastMediaType] = useState<string>("image/jpeg");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Device id + initial load.
  useEffect(() => {
    const id = getDeviceId();
    setDeviceId(id);
    (async () => {
      try {
        const res = await fetch("/api/entries", { headers: { "x-device-id": id } });
        const data = await res.json();
        if (Array.isArray(data.entries)) setEntries(data.entries.map(normalizeEntry));
      } catch {
        // start empty
      }
    })();
  }, []);

  const postJson = useCallback(
    async (path: string, body: unknown) => {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-device-id": deviceId },
        body: JSON.stringify(body),
      });
      return res.json();
    },
    [deviceId]
  );

  const handleFile = async (file: File | undefined, { skipCache = false } = {}) => {
    if (!file) return;
    setLastFile(file);
    setAnalyzeError(null);
    setManualMode(false);
    const previewUrl = URL.createObjectURL(file);
    setPhotoPreview(previewUrl);
    setAnalyzing(true);
    setDraft(null);
    setStage("barcode");
    try {
      const { base64, mediaType } = await downscaleToBase64(file);
      setLastBase64(base64);
      setLastMediaType(mediaType);

      // Stage 1: barcode (cheap, every scan).
      const bc = await postJson("/api/scan/barcode", { imageBase64: base64, mediaType });
      const jan: string | null = bc?.readable ? bc.jan : null;

      // Cache check against the shared product DB.
      if (!skipCache && jan) {
        const res = await fetch(`/api/products/${encodeURIComponent(jan)}`);
        if (res.ok) {
          const { product } = await res.json();
          setStage("cache-hit");
          setDraft({
            ...product,
            jan,
            previewUrl,
            fromCache: true,
            price_yen: "",
            temperature: null,
            notes: "Loaded from saved products — no scan needed.",
          });
          return;
        }
      }

      // Stage 2: label read (cache miss / unreadable / forced rescan).
      setStage("label");
      const label = await postJson("/api/scan/label", { imageBase64: base64, mediaType });
      if (label?.error) throw new Error(label.error);
      setDraft({ ...label, jan, previewUrl, fromCache: false, price_yen: "", temperature: null });
    } catch (e) {
      console.error(e);
      setAnalyzeError("Couldn't read that label clearly. You can enter it manually below.");
      setDraft({
        brand: "",
        name: "",
        size_ml: 250,
        caffeine_mg: 90,
        calories: 20,
        carbs_g: 0,
        protein_g: 0,
        fat_g: 0,
        sodium_mg: 0,
        caffeine_is_estimate: true,
        confidence: "low",
        notes: "",
        price_yen: "",
        temperature: null,
        jan: null,
        previewUrl,
      });
      setManualMode(true);
    } finally {
      setAnalyzing(false);
      setStage(null);
    }
  };

  const forceRescan = () => {
    if (lastFile) handleFile(lastFile, { skipCache: true });
  };

  const tryLookupName = async () => {
    if (!draft?.jan) return;
    setLookingUpName(true);
    setLookupError(null);
    try {
      const result = await postJson("/api/lookup", { jan: draft.jan });
      if (result.found && result.name) {
        setDraft({
          ...draft,
          name: result.name,
          name_is_generic: false,
          brand: draft.brand || result.brand || "",
        });
      } else {
        setLookupError("Couldn't find this exact product online — type the name yourself.");
      }
    } catch (e) {
      console.error(e);
      setLookupError("Lookup failed — type the name yourself.");
    } finally {
      setLookingUpName(false);
    }
  };

  const startManual = (prefill: Partial<Draft> | null) => {
    setPhotoPreview(null);
    setAnalyzeError(null);
    setManualMode(true);
    setLastBase64(null);
    setLastFile(null);
    setDraft({
      brand: prefill?.brand || "",
      name: prefill?.name || "",
      size_ml: prefill?.size_ml ?? 250,
      caffeine_mg: prefill?.caffeine_mg ?? 90,
      calories: prefill?.calories ?? 20,
      carbs_g: prefill?.carbs_g ?? 0,
      protein_g: prefill?.protein_g ?? 0,
      fat_g: prefill?.fat_g ?? 0,
      sodium_mg: prefill?.sodium_mg ?? 0,
      price_yen: prefill?.price_yen ?? "",
      temperature: null,
      caffeine_is_estimate: true,
      confidence: "manual",
      notes: "",
      jan: null,
      previewUrl: null,
    });
  };

  const resetDraft = () => {
    setDraft(null);
    setPhotoPreview(null);
    setManualMode(false);
    setAnalyzeError(null);
    setLastBase64(null);
  };

  const saveDraft = async () => {
    if (!draft || saving) return;
    setSaving(true);
    try {
      // Store the scanned photo (if any) in Blob, get its URL back.
      let image_url: string | null = null;
      if (lastBase64) {
        try {
          const up = await postJson("/api/upload", {
            imageBase64: lastBase64,
            mediaType: lastMediaType,
          });
          image_url = up?.url ?? null;
        } catch {
          image_url = null;
        }
      }

      const res = await postJson("/api/entries", {
        jan: draft.jan || null,
        brand: draft.brand,
        name: draft.name,
        size_ml: draft.size_ml,
        calories: draft.calories,
        carbs_g: draft.carbs_g,
        protein_g: draft.protein_g,
        fat_g: draft.fat_g,
        sodium_mg: draft.sodium_mg,
        caffeine_mg: draft.caffeine_mg,
        caffeine_is_estimate: !!draft.caffeine_is_estimate,
        price_yen: draft.price_yen,
        temperature: draft.temperature,
        image_url,
        confidence: draft.confidence || "manual",
      });
      if (res?.entry) setEntries((prev) => [normalizeEntry(res.entry), ...prev]);
      resetDraft();
    } finally {
      setSaving(false);
    }
  };

  const deleteEntry = async (id: string) => {
    setEntries((prev) => prev.filter((e) => e.id !== id));
    try {
      await fetch(`/api/entries/${id}`, {
        method: "DELETE",
        headers: { "x-device-id": deviceId },
      });
    } catch {
      // best effort — already removed optimistically
    }
  };

  // ---- Wrapped calculations ----
  const monthEntries = entries.filter((e) => monthKey(e.timestamp) === wrappedMonth);
  const totalCups = monthEntries.length;
  const totalCaffeine = monthEntries.reduce((s, e) => s + e.caffeine_mg, 0);
  const totalMl = monthEntries.reduce((s, e) => s + e.size_ml, 0);
  const totalSpend = monthEntries.reduce((s, e) => s + (e.price_yen || 0), 0);
  const brandCounts: Record<string, number> = {};
  monthEntries.forEach((e) => {
    brandCounts[e.brand] = (brandCounts[e.brand] || 0) + 1;
  });
  const favoriteBrand = Object.entries(brandCounts).sort((a, b) => b[1] - a[1])[0];

  // Weekly rhythm: cups per weekday (Mon–Sun), matching the mockup.
  const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const weekData = WEEKDAYS.map((label, i) => {
    // JS getDay(): 0=Sun..6=Sat. Map Mon..Sun -> 1..6,0.
    const jsDay = (i + 1) % 7;
    const cups = monthEntries.filter((e) => new Date(e.timestamp).getDay() === jsDay).length;
    return { label, cups };
  });
  const peakWeekday = weekData.reduce((max, d) => (d.cups > max.cups ? d : max), { label: "", cups: 0 });

  const shiftMonth = (dir: number) => {
    const [y, m] = wrappedMonth.split("-").map(Number);
    const d = new Date(y, m - 1 + dir, 1);
    setWrappedMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };

  const history = [...entries].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
  // Group the sorted history into day sections (Today / Yesterday / date).
  const historyGroups: { heading: string; items: Entry[] }[] = [];
  history.forEach((e) => {
    const heading = dayHeading(e.timestamp);
    const last = historyGroups[historyGroups.length - 1];
    if (last && last.heading === heading) last.items.push(e);
    else historyGroups.push({ heading, items: [e] });
  });

  const openCamera = () => fileInputRef.current?.click();

  return (
    <div className="w-full min-h-screen flex flex-col" style={{ background: C.bg, color: C.text }}>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: "none" }}
        onChange={(e) => handleFile(e.target.files?.[0])}
      />

      {/* Top app bar */}
      <header
        className="sticky top-0 z-40 flex items-center justify-between px-5"
        style={{ height: 56, background: C.bg, borderBottom: `1px solid ${C.border}` }}
      >
        <div className="flex items-center gap-2">
          <Coffee size={22} color={C.primary} strokeWidth={2.5} />
          <span style={{ fontWeight: 800, fontSize: 20, letterSpacing: "-0.03em", color: C.primary }}>
            CANLOG <span style={{ opacity: 0.6 }}>//</span> 缶ログ
          </span>
        </div>
      </header>

      <main className="flex-1 w-full" style={{ maxWidth: 560, margin: "0 auto", padding: "20px 20px 96px" }}>
        {/* LOG TAB */}
        {tab === "log" && (
          <div>
            {!draft && (
              <div className="flex flex-col gap-6">
                {/* Viewfinder tap-target */}
                <button
                  onClick={openCamera}
                  className="relative w-full overflow-hidden"
                  style={{
                    aspectRatio: "4 / 5",
                    background: "#2f3034",
                    borderRadius: 16,
                    border: `1px solid ${C.border}`,
                  }}
                >
                  {analyzing ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3" style={{ color: "#f1f0f5" }}>
                      {photoPreview && (
                        <img
                          src={photoPreview}
                          alt="preview"
                          style={{ width: 120, height: 120, objectFit: "cover", borderRadius: 12, opacity: 0.85 }}
                        />
                      )}
                      <div className="flex items-center gap-2" style={{ fontSize: 13 }}>
                        <Loader2 size={16} className="animate-spin" />
                        {stage === "barcode" && "Reading barcode…"}
                        {stage === "label" && "New product — reading label…"}
                        {stage === "cache-hit" && "Found it in saved products…"}
                      </div>
                    </div>
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center p-8">
                      <div className="relative flex items-center justify-center" style={{ width: "100%", maxWidth: 260, aspectRatio: "1 / 1" }}>
                        <Bracket pos="tl" />
                        <Bracket pos="tr" />
                        <Bracket pos="bl" />
                        <Bracket pos="br" />
                        <div className="canlog-scanline" />
                        <div
                          className="flex flex-col items-center gap-1"
                          style={{ background: "rgba(0,0,0,0.4)", borderRadius: 999, padding: "8px 16px", backdropFilter: "blur(6px)" }}
                        >
                          <span style={{ color: "#fff", fontSize: 12, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase" }}>
                            Align barcode to scan
                          </span>
                        </div>
                      </div>
                    </div>
                  )}
                  <div className="absolute" style={{ left: 0, right: 0, bottom: 12, textAlign: "center", color: "rgba(255,255,255,0.75)", fontSize: 12 }}>
                    Tap to snap the back of the can
                  </div>
                </button>

                {/* Quick Add */}
                <section>
                  <div className="flex items-end justify-between mb-3">
                    <h2 style={{ fontSize: 20, fontWeight: 700 }}>Quick Add</h2>
                    <span style={{ fontSize: 12, color: C.muted }}>No photo? Tap one</span>
                  </div>
                  <div className="flex gap-3 overflow-x-auto pb-1 canlog-noscroll">
                    {QUICK_ITEMS.map((item) => (
                      <button
                        key={item.name}
                        onClick={() => startManual(item)}
                        className="flex flex-col items-center gap-2 shrink-0"
                        style={{ width: 72 }}
                      >
                        <div
                          className="flex items-center justify-center"
                          style={{ width: 64, height: 64, borderRadius: "50%", background: C.card, border: `1px solid ${C.border}`, boxShadow: "0 1px 2px rgba(0,0,0,0.04)" }}
                        >
                          <span style={{ fontSize: 22, fontWeight: 800, color: C.primary }}>
                            {(item.brand[0] || "?").toUpperCase()}
                          </span>
                        </div>
                        <span style={{ fontSize: 11, fontWeight: 600, color: C.muted, textAlign: "center", lineHeight: 1.2 }}>
                          {item.brand}
                        </span>
                      </button>
                    ))}
                  </div>
                </section>

                {/* Actions */}
                <section className="flex flex-col gap-3">
                  <button
                    onClick={openCamera}
                    className="w-full flex items-center justify-center gap-2"
                    style={{ height: 52, background: C.primary, color: "#fff", borderRadius: 14, fontSize: 16, fontWeight: 700, boxShadow: "0 4px 12px rgba(188,0,10,0.18)" }}
                  >
                    <Camera size={20} /> Log Instantly
                  </button>
                  <button
                    onClick={() => startManual(null)}
                    className="w-full flex items-center justify-center gap-2"
                    style={{ height: 52, background: C.card, color: C.text, border: `1px solid ${C.border}`, borderRadius: 14, fontSize: 14, fontWeight: 700 }}
                  >
                    <Coffee size={18} color={C.primary} /> Manual Entry
                  </button>
                </section>
              </div>
            )}

            {/* Draft confirm card */}
            {draft && (
              <div style={{ background: C.card, borderRadius: 20, border: `1px solid ${C.border}`, padding: 20, boxShadow: "0 4px 16px rgba(0,0,0,0.05)" }}>
                <div className="flex items-center justify-between mb-3">
                  <div style={{ fontWeight: 700, fontSize: 18 }}>
                    {manualMode ? "Add manually" : "Does this look right?"}
                  </div>
                  <div className="flex gap-1.5">
                    {draft.fromCache && (
                      <span style={{ fontSize: 10, background: C.blueFixed, color: C.blue, padding: "3px 9px", borderRadius: 999, fontWeight: 700 }}>SAVED</span>
                    )}
                    {draft.confidence === "low" && !manualMode && (
                      <span style={{ fontSize: 10, background: C.primaryFixed, color: C.primary, padding: "3px 9px", borderRadius: 999, fontWeight: 700 }}>LOW CONFIDENCE</span>
                    )}
                  </div>
                </div>

                {analyzeError && <div style={{ fontSize: 12, color: C.primary, marginBottom: 10 }}>{analyzeError}</div>}
                {draft.fromCache && (
                  <button onClick={forceRescan} style={{ fontSize: 11.5, color: C.blue, textDecoration: "underline", marginBottom: 10, display: "block" }}>
                    Not right? Ignore saved data and rescan the photo
                  </button>
                )}
                {draft.notes && !manualMode && (
                  <details style={{ fontSize: 11.5, color: C.muted, marginBottom: 10 }}>
                    <summary style={{ cursor: "pointer" }}>Scan details</summary>
                    <div style={{ marginTop: 4, fontStyle: "italic" }}>{draft.notes}</div>
                  </details>
                )}

                {draft.previewUrl && (
                  <img src={draft.previewUrl} alt="scanned" style={{ width: "100%", maxHeight: 160, objectFit: "cover", borderRadius: 12, marginBottom: 12 }} />
                )}

                {draft.jan && (
                  <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 12, letterSpacing: "0.03em" }}>JAN {draft.jan}</div>
                )}

                {draft.name_is_generic && !manualMode && (
                  <div style={{ fontSize: 11.5, background: C.cell, color: C.text, borderRadius: 10, padding: "10px 12px", marginBottom: 12 }}>
                    <div style={{ marginBottom: draft.jan ? 8 : 0 }}>
                      The label only shows &quot;{draft.name}&quot; — that&apos;s the food-category label, not the product name.
                    </div>
                    {draft.jan && (
                      <button
                        onClick={tryLookupName}
                        disabled={lookingUpName}
                        style={{ background: C.primary, color: "#fff", fontWeight: 700, fontSize: 11, borderRadius: 8, padding: "6px 11px", display: "inline-flex", alignItems: "center", gap: 5 }}
                      >
                        {lookingUpName ? <Loader2 size={12} className="animate-spin" /> : null}
                        {lookingUpName ? "Searching…" : "Look up name online (uses a search)"}
                      </button>
                    )}
                    {lookupError && <div style={{ marginTop: 6, color: C.primary }}>{lookupError}</div>}
                  </div>
                )}

                {/* Hot / Cold toggle */}
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, letterSpacing: "0.05em", marginBottom: 6 }}>SERVED</div>
                  <div className="flex gap-2">
                    <TempButton
                      active={draft.temperature === "hot"}
                      onClick={() => setDraft({ ...draft, temperature: draft.temperature === "hot" ? null : "hot" })}
                      icon={<Flame size={15} />}
                      label="Hot"
                      color={C.hotText}
                      bg={C.hotBg}
                    />
                    <TempButton
                      active={draft.temperature === "cold"}
                      onClick={() => setDraft({ ...draft, temperature: draft.temperature === "cold" ? null : "cold" })}
                      icon={<Snowflake size={15} />}
                      label="Cold"
                      color={C.coldText}
                      bg={C.coldBg}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 mb-2">
                  <Field label="Brand" value={draft.brand} onChange={(v) => setDraft({ ...draft, brand: v })} />
                  <Field
                    label="Name"
                    value={draft.name_is_generic ? "" : draft.name}
                    onChange={(v) => setDraft({ ...draft, name: v, name_is_generic: false })}
                    placeholder={draft.name_is_generic ? "e.g. printed on the front" : undefined}
                  />
                  <Field label="Size (ml)" value={draft.size_ml} onChange={(v) => setDraft({ ...draft, size_ml: v })} type="number" />
                  <Field
                    label={`Caffeine (mg)${draft.caffeine_is_estimate ? " · est." : ""}`}
                    value={draft.caffeine_mg}
                    onChange={(v) => setDraft({ ...draft, caffeine_mg: v })}
                    type="number"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3 mb-2">
                  <Field label="Calories" value={draft.calories} onChange={(v) => setDraft({ ...draft, calories: v })} type="number" />
                  <Field label="Price (¥)" value={draft.price_yen} onChange={(v) => setDraft({ ...draft, price_yen: v })} type="number" placeholder="what you paid" />
                  <Field label="Carbs (g)" value={draft.carbs_g} onChange={(v) => setDraft({ ...draft, carbs_g: v })} type="number" />
                  <Field label="Protein (g)" value={draft.protein_g} onChange={(v) => setDraft({ ...draft, protein_g: v })} type="number" />
                </div>
                <div className="grid grid-cols-2 gap-3 mb-2">
                  <Field label="Fat (g)" value={draft.fat_g} onChange={(v) => setDraft({ ...draft, fat_g: v })} type="number" />
                  <Field label="Sodium (mg)" value={draft.sodium_mg} onChange={(v) => setDraft({ ...draft, sodium_mg: v })} type="number" />
                </div>

                <div className="flex gap-2 mt-4">
                  <button
                    onClick={saveDraft}
                    disabled={saving}
                    className="flex-1 flex items-center justify-center gap-1.5"
                    style={{ background: C.primary, color: "#fff", borderRadius: 12, padding: "12px 0", fontWeight: 700, fontSize: 14, opacity: saving ? 0.7 : 1 }}
                  >
                    {saving ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />} {saving ? "Saving…" : "Confirm & Log"}
                  </button>
                  <button
                    onClick={resetDraft}
                    className="flex items-center justify-center gap-1.5"
                    style={{ background: C.card, border: `1px solid ${C.border}`, color: C.text, borderRadius: 12, padding: "12px 18px", fontWeight: 700, fontSize: 14 }}
                  >
                    <X size={16} /> Retake
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* HISTORY TAB */}
        {tab === "history" && (
          <div>
            <div className="flex items-start justify-between mb-1">
              <h1 style={{ fontSize: 28, fontWeight: 800, letterSpacing: "-0.02em" }}>History</h1>
              <span style={{ fontSize: 12, fontWeight: 700, color: C.muted, background: C.cell, padding: "6px 13px", borderRadius: 999, marginTop: 4 }}>
                {history.length} Total
              </span>
            </div>
            <p style={{ fontSize: 14, color: C.muted, marginBottom: 20 }}>Every can you&apos;ve logged.</p>

            {history.length === 0 && <EmptyState text="Nothing logged yet. Go scan a can." />}

            {historyGroups.map((group) => (
              <div key={group.heading} className="mb-6">
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", color: C.muted, textTransform: "uppercase", marginBottom: 10 }}>
                  {group.heading}
                </div>
                <div className="flex flex-col gap-3">
                  {group.items.map((e) => (
                    <div
                      key={e.id}
                      className="flex gap-3.5"
                      style={{ background: C.card, borderRadius: 16, border: `1px solid ${C.border}`, padding: 14 }}
                    >
                      {e.image_url ? (
                        <img src={e.image_url} alt="" style={{ width: 64, height: 64, borderRadius: 12, objectFit: "cover", flexShrink: 0 }} />
                      ) : (
                        <div style={{ width: 64, height: 64, borderRadius: 12, background: C.cell, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                          <Coffee size={24} color={C.primary} />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div style={{ fontSize: 13, fontWeight: 700, color: C.blue, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {e.brand}
                        </div>
                        <div style={{ fontSize: 19, fontWeight: 800, letterSpacing: "-0.01em", lineHeight: 1.15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {e.name}
                        </div>
                        <div className="flex items-center gap-2.5" style={{ marginTop: 8 }}>
                          {e.temperature && <TempChip temp={e.temperature} />}
                          {e.price_yen > 0 && (
                            <span style={{ fontSize: 15, fontWeight: 700, color: C.primary }}>¥{e.price_yen}</span>
                          )}
                        </div>
                        <div style={{ fontSize: 11.5, color: C.muted, marginTop: 5 }}>{e.size_ml}ml · {e.caffeine_mg}mg caffeine</div>
                      </div>
                      <div className="flex flex-col items-end justify-between" style={{ flexShrink: 0 }}>
                        <span style={{ fontSize: 13, fontWeight: 500, color: C.muted }}>
                          {new Date(e.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
                        </span>
                        <button onClick={() => deleteEntry(e.id)} style={{ color: "#c9c7d1" }} aria-label="Delete">
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* WRAPPED TAB */}
        {tab === "wrapped" && (
          <div>
            <div className="flex items-center justify-center gap-3 mb-4">
              <button onClick={() => shiftMonth(-1)} style={{ color: C.muted }}><ChevronLeft size={20} /></button>
              <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: C.primary, background: C.primaryFixed, padding: "5px 14px", borderRadius: 999 }}>
                {fmtMonthLabel(wrappedMonth)}
              </span>
              <button onClick={() => shiftMonth(1)} style={{ color: C.muted }}><ChevronRight size={20} /></button>
            </div>
            <h1 style={{ fontSize: 28, fontWeight: 800, letterSpacing: "-0.02em", textAlign: "center", marginBottom: 20 }}>
              Your Coffee Story
            </h1>

            {totalCups === 0 ? (
              <EmptyState text="No coffee logged this month yet." />
            ) : (
              <div className="flex flex-col gap-4">
                {/* Total consumption */}
                <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 18, padding: 20 }}>
                  <div style={{ fontSize: 13, color: C.muted, marginBottom: 4 }}>Total Consumption</div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                    <span style={{ fontSize: 44, fontWeight: 800, color: C.primary, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
                      {totalCups}
                    </span>
                    <span style={{ fontSize: 20, fontWeight: 700 }}>Cups</span>
                  </div>
                </div>

                {/* Spent + Caffeine */}
                <div className="grid grid-cols-2 gap-4">
                  <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 18, padding: 18 }}>
                    <Wallet size={20} color={C.blue} />
                    <div style={{ fontSize: 13, color: C.muted, marginTop: 8 }}>Total Spent</div>
                    <div style={{ fontSize: 22, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>¥{totalSpend.toLocaleString()}</div>
                  </div>
                  <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 18, padding: 18 }}>
                    <Zap size={20} color={C.primary} />
                    <div style={{ fontSize: 13, color: C.muted, marginTop: 8 }}>Caffeine</div>
                    <div style={{ fontSize: 22, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>
                      {(totalCaffeine / 1000).toFixed(1)}g{" "}
                      {monthEntries.some((e) => e.caffeine_is_estimate) && (
                        <span style={{ fontSize: 12, fontWeight: 600, color: C.muted }}>Est.</span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Total volume */}
                <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 18, padding: 18 }}>
                  <div className="flex items-center gap-2" style={{ color: C.muted, fontSize: 13 }}>
                    <Droplet size={16} color={C.blue} /> Total Volume
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 800, marginTop: 6, fontVariantNumeric: "tabular-nums" }}>
                    {(totalMl / 1000).toFixed(1)} L
                  </div>
                </div>

                {/* Most frequented */}
                {favoriteBrand && (
                  <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 18, padding: 20 }}>
                    <div className="flex items-center gap-2 mb-3">
                      <Star size={18} color={C.primary} fill={C.primary} />
                      <span style={{ fontSize: 18, fontWeight: 700 }}>Most Frequented</span>
                    </div>
                    <div className="flex items-center justify-between" style={{ background: C.cell, borderRadius: 12, padding: "12px 16px" }}>
                      <span style={{ fontSize: 16, fontWeight: 700 }}>{favoriteBrand[0]}</span>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 20, fontWeight: 800, color: C.primary, lineHeight: 1 }}>{favoriteBrand[1]}</div>
                        <div style={{ fontSize: 10, fontWeight: 700, color: C.muted, letterSpacing: "0.06em" }}>TIMES</div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Weekly rhythm */}
                <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 18, padding: 20 }}>
                  <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>Weekly Rhythm</div>
                  <div style={{ height: 150 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={weekData}>
                        <XAxis dataKey="label" tick={{ fontSize: 11, fill: C.muted }} axisLine={false} tickLine={false} />
                        <YAxis hide />
                        <Tooltip cursor={{ fill: "rgba(0,0,0,0.04)" }} contentStyle={{ background: C.text, border: "none", borderRadius: 8, fontSize: 11 }} labelStyle={{ color: "#fff" }} itemStyle={{ color: "#fff" }} />
                        <Bar dataKey="cups" radius={[4, 4, 0, 0]}>
                          {weekData.map((d, i) => (
                            <Cell key={i} fill={d.label === peakWeekday.label && peakWeekday.cups > 0 ? C.primary : "#c9c7d1"} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  {peakWeekday.cups > 0 && (
                    <div style={{ fontSize: 13, color: C.muted, textAlign: "center", marginTop: 8 }}>
                      <strong style={{ color: C.text }}>{peakWeekday.label}</strong> is your peak caffeine day.
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Bottom nav */}
      <nav
        className="fixed bottom-0 left-0 w-full z-40 flex justify-around items-center"
        style={{ background: C.bg, borderTop: `1px solid ${C.border}`, padding: "8px 12px", paddingBottom: "max(8px, env(safe-area-inset-bottom))" }}
      >
        <NavItem active={tab === "log"} onClick={() => setTab("log")} icon={<Camera size={22} />} label="Log" />
        <NavItem active={tab === "history"} onClick={() => setTab("history")} icon={<HistoryIcon size={22} />} label="History" />
        <NavItem active={tab === "wrapped"} onClick={() => setTab("wrapped")} icon={<Sparkles size={22} />} label="Wrapped" />
      </nav>
    </div>
  );
}

function Bracket({ pos }: { pos: "tl" | "tr" | "bl" | "br" }) {
  const base: React.CSSProperties = { position: "absolute", width: 26, height: 26, borderColor: C.primary, borderStyle: "solid", borderWidth: 0 };
  const map: Record<string, React.CSSProperties> = {
    tl: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 10 },
    tr: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 10 },
    bl: { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 10 },
    br: { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 10 },
  };
  return <div style={{ ...base, ...map[pos] }} />;
}

function NavItem({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button onClick={onClick} className="flex flex-col items-center gap-1" style={{ padding: "4px 18px", borderRadius: 14, background: active ? C.primaryFixed : "transparent", color: active ? C.primary : C.muted }}>
      {icon}
      <span style={{ fontSize: 11, fontWeight: 700 }}>{label}</span>
    </button>
  );
}

function TempButton({ active, onClick, icon, label, color, bg }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; color: string; bg: string }) {
  return (
    <button
      onClick={onClick}
      className="flex-1 flex items-center justify-center gap-1.5"
      style={{
        height: 40,
        borderRadius: 10,
        fontWeight: 700,
        fontSize: 13,
        background: active ? bg : C.card,
        color: active ? color : C.muted,
        border: `1px solid ${active ? bg : C.border}`,
      }}
    >
      {icon} {label}
    </button>
  );
}

function TempChip({ temp }: { temp: "hot" | "cold" }) {
  const hot = temp === "hot";
  return (
    <span
      style={{
        fontSize: 12,
        fontWeight: 700,
        padding: "3px 11px",
        borderRadius: 999,
        background: hot ? C.hotBg : C.coldBg,
        color: hot ? C.hotText : C.coldText,
      }}
    >
      {hot ? "Hot" : "Cold"}
    </span>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  label: string;
  value: Num;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <div>
      <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, letterSpacing: "0.04em", marginBottom: 4 }}>{label.toUpperCase()}</div>
      <input
        className="canlog-input"
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(type === "number" ? e.target.value.replace(/[^0-9]/g, "") : e.target.value)}
        style={{
          width: "100%",
          background: C.card,
          border: `1px solid ${C.border}`,
          borderRadius: 10,
          padding: "9px 11px",
          fontSize: 14,
          color: C.text,
          fontVariantNumeric: type === "number" ? "tabular-nums" : "normal",
        }}
      />
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div style={{ textAlign: "center", padding: "48px 20px", color: C.muted, fontSize: 14 }}>
      <Coffee size={30} color="#c9c7d1" style={{ margin: "0 auto 12px" }} />
      {text}
    </div>
  );
}
