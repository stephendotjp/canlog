"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Camera,
  Check,
  X,
  Flame,
  Coffee,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Trash2,
} from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, Cell } from "recharts";
import { getDeviceId } from "@/lib/deviceId";
import type { Entry } from "@/lib/types";

const QUICK_ITEMS = [
  { name: "BOSS Rainbow Mountain", brand: "Suntory", size_ml: 185, caffeine_mg: 90, calories: 30 },
  { name: "Georgia Emerald Mountain", brand: "Coca-Cola", size_ml: 185, caffeine_mg: 95, calories: 40 },
  { name: "Wonda Morning Shot", brand: "Asahi", size_ml: 185, caffeine_mg: 100, calories: 25 },
  { name: "Doutor Blend Coffee", brand: "Doutor", size_ml: 240, caffeine_mg: 130, calories: 5 },
  { name: "Starbucks Iced Coffee", brand: "Starbucks", size_ml: 350, caffeine_mg: 165, calories: 15 },
  { name: "McDonald's Premium Roast", brand: "McDonald's", size_ml: 250, caffeine_mg: 145, calories: 5 },
];

type Num = number | string;

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
            notes: "Loaded from saved products — no scan needed.",
          });
          return;
        }
      }

      // Stage 2: label read (cache miss / unreadable / forced rescan).
      setStage("label");
      const label = await postJson("/api/scan/label", { imageBase64: base64, mediaType });
      if (label?.error) throw new Error(label.error);
      setDraft({ ...label, jan, previewUrl, fromCache: false, price_yen: "" });
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

  const daysInMonth = (() => {
    const [y, m] = wrappedMonth.split("-").map(Number);
    return new Date(y, m, 0).getDate();
  })();
  const dayData = Array.from({ length: daysInMonth }, (_, i) => {
    const day = i + 1;
    const cups = monthEntries.filter((e) => new Date(e.timestamp).getDate() === day).length;
    return { day, cups };
  });
  const peakDay = dayData.reduce((max, d) => (d.cups > max.cups ? d : max), { day: 0, cups: 0 });

  const shiftMonth = (dir: number) => {
    const [y, m] = wrappedMonth.split("-").map(Number);
    const d = new Date(y, m - 1 + dir, 1);
    setWrappedMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };

  const history = [...entries].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  return (
    <div
      style={{ fontFamily: "'Noto Sans JP', sans-serif", background: "#1B2430", minHeight: "100%", color: "#F1E8D8" }}
      className="w-full min-h-screen flex flex-col"
    >
      {/* Header */}
      <div className="px-5 pt-6 pb-4 flex items-center justify-between" style={{ borderBottom: "1px solid #333d4d" }}>
        <div className="flex items-center gap-2">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: "#E8A33D" }}>
            <Coffee size={18} color="#1B2430" strokeWidth={2.5} />
          </div>
          <div>
            <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 18, letterSpacing: "-0.02em" }}>
              CANLOG
            </div>
            <div style={{ fontSize: 10, color: "#8B95A1", letterSpacing: "0.08em" }}>CAN COFFEE LOG</div>
          </div>
        </div>
        <div className="flex gap-1" style={{ background: "#252e3d", borderRadius: 10, padding: 3 }}>
          {([
            ["log", "Log"],
            ["history", "History"],
            ["wrapped", "Wrapped"],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              style={{
                fontFamily: "'Space Grotesk', sans-serif",
                fontSize: 12,
                fontWeight: 700,
                padding: "6px 12px",
                borderRadius: 7,
                background: tab === key ? "#E8A33D" : "transparent",
                color: tab === key ? "#1B2430" : "#8B95A1",
                transition: "all 0.15s",
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 px-5 py-5" style={{ maxWidth: 560, margin: "0 auto", width: "100%" }}>
        {/* LOG TAB */}
        {tab === "log" && (
          <div>
            {!draft && (
              <div>
                <div
                  onClick={() => fileInputRef.current?.click()}
                  style={{ border: "2px dashed #465065", borderRadius: 16, padding: "36px 20px", textAlign: "center", cursor: "pointer", background: "#212a38" }}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    style={{ display: "none" }}
                    onChange={(e) => handleFile(e.target.files?.[0])}
                  />
                  <div className="mx-auto mb-3 flex items-center justify-center" style={{ width: 52, height: 52, borderRadius: "50%", background: "#2d3849" }}>
                    <Camera size={24} color="#E8A33D" />
                  </div>
                  <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 15 }}>Snap the BACK of the can</div>
                  <div style={{ fontSize: 12.5, color: "#8B95A1", marginTop: 4 }}>Get the barcode and nutrition table in frame</div>
                </div>

                {analyzing && (
                  <div className="flex items-center gap-2 justify-center mt-4" style={{ color: "#8B95A1", fontSize: 13 }}>
                    <Loader2 size={16} className="animate-spin" />
                    {stage === "barcode" && "Reading barcode…"}
                    {stage === "label" && "New product — reading nutrition label…"}
                    {stage === "cache-hit" && "Found it in saved products…"}
                  </div>
                )}
                {photoPreview && analyzing && (
                  <img src={photoPreview} alt="preview" style={{ width: 96, height: 96, objectFit: "cover", borderRadius: 10, margin: "12px auto 0", display: "block" }} />
                )}

                <div className="mt-6">
                  <div style={{ fontSize: 11, color: "#8B95A1", letterSpacing: "0.06em", marginBottom: 8 }}>NO PHOTO? QUICK-ADD A COMMON ONE</div>
                  <div className="grid grid-cols-2 gap-2">
                    {QUICK_ITEMS.map((item) => (
                      <button
                        key={item.name}
                        onClick={() => startManual(item)}
                        style={{ background: "#212a38", border: "1px solid #333d4d", borderRadius: 10, padding: "10px 12px", textAlign: "left" }}
                      >
                        <div style={{ fontSize: 12.5, fontWeight: 500 }}>{item.name}</div>
                        <div style={{ fontSize: 10.5, color: "#8B95A1", marginTop: 2 }}>{item.brand} · {item.size_ml}ml</div>
                      </button>
                    ))}
                  </div>
                  <button onClick={() => startManual(null)} style={{ fontSize: 12.5, color: "#E8A33D", marginTop: 10, fontWeight: 500 }}>
                    + Enter something else manually
                  </button>
                </div>
              </div>
            )}

            {/* Draft confirm card */}
            {draft && (
              <div style={{ background: "#F1E8D8", color: "#1B2430", borderRadius: 16, padding: 20 }}>
                <div className="flex items-center justify-between mb-3">
                  <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 14 }}>
                    {manualMode ? "Add manually" : "Does this look right?"}
                  </div>
                  <div className="flex gap-1.5">
                    {draft.fromCache && (
                      <span style={{ fontSize: 10, background: "#5B3A29", color: "#F1E8D8", padding: "2px 8px", borderRadius: 6, fontWeight: 700 }}>FROM CACHE</span>
                    )}
                    {draft.confidence === "low" && !manualMode && (
                      <span style={{ fontSize: 10, background: "#C1432B", color: "#F1E8D8", padding: "2px 8px", borderRadius: 6, fontWeight: 700 }}>LOW CONFIDENCE</span>
                    )}
                  </div>
                </div>

                {analyzeError && <div style={{ fontSize: 12, color: "#C1432B", marginBottom: 10 }}>{analyzeError}</div>}
                {draft.fromCache && (
                  <button onClick={forceRescan} style={{ fontSize: 11, color: "#5B3A29", textDecoration: "underline", marginBottom: 10, display: "block" }}>
                    Not right? Ignore cache and rescan the photo
                  </button>
                )}
                {draft.notes && !manualMode && (
                  <details style={{ fontSize: 11, color: "#8B95A1", marginBottom: 10 }}>
                    <summary style={{ cursor: "pointer" }}>Scan details</summary>
                    <div style={{ marginTop: 4, fontStyle: "italic" }}>{draft.notes}</div>
                  </details>
                )}

                {draft.previewUrl && (
                  <img src={draft.previewUrl} alt="scanned" style={{ width: "100%", maxHeight: 140, objectFit: "cover", borderRadius: 10, marginBottom: 12 }} />
                )}

                {draft.jan && (
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "#8B95A1", marginBottom: 10 }}>JAN {draft.jan}</div>
                )}

                {draft.name_is_generic && !manualMode && (
                  <div style={{ fontSize: 11.5, background: "#5B3A29", color: "#F1E8D8", borderRadius: 8, padding: "8px 10px", marginBottom: 10 }}>
                    <div style={{ marginBottom: draft.jan ? 8 : 0 }}>
                      The label only shows &quot;{draft.name}&quot; — that&apos;s the food-category label, not the product name.
                    </div>
                    {draft.jan && (
                      <button
                        onClick={tryLookupName}
                        disabled={lookingUpName}
                        style={{ background: "#E8A33D", color: "#1B2430", fontWeight: 700, fontSize: 11, borderRadius: 6, padding: "5px 10px", display: "inline-flex", alignItems: "center", gap: 5 }}
                      >
                        {lookingUpName ? <Loader2 size={12} className="animate-spin" /> : null}
                        {lookingUpName ? "Searching…" : "Look up name online (uses a search)"}
                      </button>
                    )}
                    {lookupError && <div style={{ marginTop: 6, color: "#F1C08A" }}>{lookupError}</div>}
                  </div>
                )}

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
                    style={{ background: "#1B2430", color: "#F1E8D8", borderRadius: 10, padding: "10px 0", fontWeight: 700, fontSize: 13, opacity: saving ? 0.7 : 1 }}
                  >
                    {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} {saving ? "Saving…" : "Log it"}
                  </button>
                  <button
                    onClick={resetDraft}
                    className="flex items-center justify-center gap-1.5"
                    style={{ background: "transparent", border: "1px solid #5B3A29", color: "#5B3A29", borderRadius: 10, padding: "10px 16px", fontWeight: 700, fontSize: 13 }}
                  >
                    <X size={15} /> Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* HISTORY TAB */}
        {tab === "history" && (
          <div>
            {history.length === 0 && <EmptyState text="Nothing logged yet. Go scan a can." />}
            <div className="flex flex-col gap-2">
              {history.map((e) => (
                <div key={e.id} className="flex items-center gap-3" style={{ background: "#212a38", borderRadius: 12, padding: 10 }}>
                  {e.image_url ? (
                    <img src={e.image_url} alt="" style={{ width: 44, height: 44, borderRadius: 8, objectFit: "cover" }} />
                  ) : (
                    <div style={{ width: 44, height: 44, borderRadius: 8, background: "#2d3849", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <Coffee size={18} color="#E8A33D" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.name}</div>
                    <div style={{ fontSize: 11, color: "#8B95A1" }}>
                      {e.brand} · {e.size_ml}ml · {e.caffeine_mg}mg caffeine
                    </div>
                  </div>
                  <div style={{ fontSize: 10.5, color: "#8B95A1", textAlign: "right", marginRight: 4 }}>
                    <div>{new Date(e.timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</div>
                    {e.price_yen > 0 && <div style={{ fontFamily: "'JetBrains Mono', monospace", marginTop: 2 }}>¥{e.price_yen}</div>}
                  </div>
                  <button onClick={() => deleteEntry(e.id)} style={{ color: "#8B95A1" }}>
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* WRAPPED TAB */}
        {tab === "wrapped" && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <button onClick={() => shiftMonth(-1)} style={{ color: "#8B95A1" }}><ChevronLeft size={20} /></button>
              <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 14 }}>{fmtMonthLabel(wrappedMonth)}</div>
              <button onClick={() => shiftMonth(1)} style={{ color: "#8B95A1" }}><ChevronRight size={20} /></button>
            </div>

            {totalCups === 0 ? (
              <EmptyState text="No coffee logged this month yet." />
            ) : (
              <div
                style={{
                  background: "linear-gradient(180deg, #F1E8D8 0%, #ECE0CB 100%)",
                  borderRadius: 20,
                  padding: "24px 20px",
                  color: "#1B2430",
                  boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.05), 0 8px 24px rgba(0,0,0,0.25)",
                  position: "relative",
                  overflow: "hidden",
                }}
              >
                <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 10, background: "rgba(0,0,0,0.06)" }} />
                <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 10, background: "rgba(0,0,0,0.06)" }} />

                <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 12, letterSpacing: "0.1em", color: "#5B3A29" }}>CAFFEINE FACTS</div>
                <div style={{ height: 1, background: "#1B2430", margin: "8px 0 14px" }} />

                <div className="grid grid-cols-2 gap-y-4 gap-x-3">
                  <Stat big={totalCups} label="cups logged" />
                  <Stat big={`¥${totalSpend.toLocaleString()}`} label="total spent" />
                  <Stat big={`${totalCaffeine}`} unit="mg" label="total caffeine" />
                  <Stat big={`${(totalMl / 1000).toFixed(1)}`} unit="L" label="total volume" />
                </div>

                <div style={{ height: 1, background: "#1B2430", margin: "14px 0" }} />

                <div className="flex items-center gap-2 mb-1">
                  <Flame size={14} color="#C1432B" />
                  <span style={{ fontSize: 12 }}>
                    Biggest day: <strong>{peakDay.cups > 0 ? `${fmtMonthLabel(wrappedMonth).split(" ")[0]} ${peakDay.day} (${peakDay.cups} cups)` : "—"}</strong>
                  </span>
                </div>
                {favoriteBrand && (
                  <div className="flex items-center gap-2 mb-1">
                    <Coffee size={14} color="#5B3A29" />
                    <span style={{ fontSize: 12 }}>Favorite: <strong>{favoriteBrand[0]}</strong> ({favoriteBrand[1]}×)</span>
                  </div>
                )}
                {totalCups > 0 && (
                  <div className="flex items-center gap-2 mb-3" style={{ fontSize: 12 }}>
                    <span style={{ width: 14, textAlign: "center" }}>¥</span>
                    Avg per cup: <strong>¥{Math.round(totalSpend / totalCups).toLocaleString()}</strong>
                  </div>
                )}

                <div style={{ height: 140, marginTop: 8 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={dayData}>
                      <XAxis dataKey="day" tick={{ fontSize: 9, fill: "#5B3A29" }} interval={2} axisLine={{ stroke: "#5B3A29" }} tickLine={false} />
                      <YAxis hide />
                      <Tooltip cursor={{ fill: "rgba(0,0,0,0.05)" }} contentStyle={{ background: "#1B2430", border: "none", borderRadius: 8, fontSize: 11 }} labelStyle={{ color: "#F1E8D8" }} />
                      <Bar dataKey="cups" radius={[3, 3, 0, 0]}>
                        {dayData.map((d, i) => (
                          <Cell key={i} fill={d.day === peakDay.day && peakDay.cups > 0 ? "#C1432B" : "#5B3A29"} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div style={{ fontSize: 9.5, color: "#8B95A1", textAlign: "center", marginTop: 4 }}>cups per day</div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
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
      <div style={{ fontSize: 10, color: "#5B3A29", fontWeight: 700, letterSpacing: "0.04em", marginBottom: 3 }}>{label.toUpperCase()}</div>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(type === "number" ? e.target.value.replace(/[^0-9]/g, "") : e.target.value)}
        style={{
          width: "100%",
          background: "#fff",
          border: "1px solid #d8cbb0",
          borderRadius: 8,
          padding: "7px 9px",
          fontSize: 13,
          fontFamily: type === "number" ? "'JetBrains Mono', monospace" : "inherit",
          color: "#1B2430",
        }}
      />
    </div>
  );
}

function Stat({ big, unit, label }: { big: React.ReactNode; unit?: string; label: string }) {
  return (
    <div>
      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: 26, lineHeight: 1 }}>
        {big}
        {unit && <span style={{ fontSize: 13, marginLeft: 3, fontWeight: 500 }}>{unit}</span>}
      </div>
      <div style={{ fontSize: 11, color: "#5B3A29", marginTop: 2 }}>{label}</div>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div style={{ textAlign: "center", padding: "40px 20px", color: "#8B95A1", fontSize: 13 }}>
      <Coffee size={28} color="#465065" style={{ margin: "0 auto 10px" }} />
      {text}
    </div>
  );
}
