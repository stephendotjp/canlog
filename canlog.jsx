import React, { useState, useEffect, useRef, useCallback } from "react";
import { Camera, Upload, Check, X, Flame, Coffee, Calendar, ChevronLeft, ChevronRight, Loader2, Pencil, Trash2 } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, Cell } from "recharts";

const QUICK_ITEMS = [
  { name: "BOSS Rainbow Mountain", brand: "Suntory", size_ml: 185, caffeine_mg: 90, calories: 30 },
  { name: "Georgia Emerald Mountain", brand: "Coca-Cola", size_ml: 185, caffeine_mg: 95, calories: 40 },
  { name: "Wonda Morning Shot", brand: "Asahi", size_ml: 185, caffeine_mg: 100, calories: 25 },
  { name: "Doutor Blend Coffee", brand: "Doutor", size_ml: 240, caffeine_mg: 130, calories: 5 },
  { name: "Starbucks Iced Coffee", brand: "Starbucks", size_ml: 350, caffeine_mg: 165, calories: 15 },
  { name: "McDonald's Premium Roast", brand: "McDonald's", size_ml: 250, caffeine_mg: 145, calories: 5 },
];

const STORAGE_KEY = "canlog-entries-v1";
const PRODUCT_DB_KEY = "canlog-product-db-v1"; // private cache: { [jan]: productData }

function todayISO() {
  return new Date().toISOString();
}

function monthKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function fmtMonthLabel(key) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

async function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function callClaude(base64, mediaType, prompt, maxTokens = 500) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: maxTokens,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
  });
  const data = await response.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  const raw = (textBlock?.text || "").replace(/```json|```/g, "").trim();
  return JSON.parse(raw);
}

// Stage 1: cheap, narrow call — just try to read the JAN/EAN barcode digits.
// This is the call that runs on every scan, so it's kept small on purpose.
async function extractBarcode(base64, mediaType) {
  const prompt = `Look at this photo of the back of a drink can/bottle. Find the barcode (JAN/EAN-13, usually 13 digits, printed as lines with digits underneath).

Respond with ONLY raw JSON, no markdown fences:
{"jan": string|null, "readable": boolean}

If you cannot clearly read all the digits, set "jan" to null and "readable" to false. Do not guess digits you can't actually see.`;
  return callClaude(base64, mediaType, prompt, 200);
}

// Stage 2: fuller call — only runs on a cache miss. Reads the nutrition facts panel.
async function extractLabelData(base64, mediaType) {
  const prompt = `Look at this photo of the back of a Japanese drink can/bottle label. Read the printed nutrition facts panel (栄養成分表示) and any visible brand name.

Respond with ONLY raw JSON, no markdown fences, in exactly this shape:
{"brand": string, "name": string, "name_is_generic": boolean, "size_ml": number, "calories": number, "carbs_g": number, "protein_g": number, "fat_g": number, "sodium_mg": number, "caffeine_mg": number, "caffeine_is_estimate": boolean, "confidence": "high"|"medium"|"low", "notes": string}

Critical rules — read carefully, these are common mistakes:

1. PER-CONTAINER SCALING: Japanese nutrition panels are very often printed "per 100g" or "per 100ml" (製品100gあたり / 100mlあたり), NOT per whole container. Check which one it says. If it's per-100g/ml, you MUST multiply every value by (container_size / 100) to get the true per-container totals before outputting them. Example: if the label says "100gあたり エネルギー30kcal" and the can is 185g, the real answer for "calories" is 30 × 1.85 = 55.5, not 30. Only skip this scaling if the label explicitly says it's already per-container (1本あたり / 製品1本).

2. SALT-TO-SODIUM CONVERSION: Japanese labels print 食塩相当量 (salt equivalent) in grams, not sodium directly. Convert using: sodium_mg = salt_g × 1000 ÷ 2.54. Do this BEFORE the per-container scaling in step 1, or apply the scaling to the grams first then convert — either order, just don't skip the conversion. Never put the raw salt-gram number into sodium_mg unconverted.

3. PRODUCT NAME: the "名称" field on Japanese labels is a legal food-category label (e.g. "コーヒー", "乳飲料", "清涼飲料水") — it is almost never the actual product name. The real product name is usually only on the front of the can, not visible in a back-label photo. If you can't see a specific branded product name anywhere in the image, set "name" to the category name you found and set "name_is_generic" to true, so the app knows to ask the user to type the real name. Do not guess a plausible-sounding product name.

4. caffeine_mg: Japanese labels are not required to print caffeine, so it's usually absent from the panel. If you recognize the specific product from its branding, use known real caffeine content and set caffeine_is_estimate to false. Otherwise estimate for a typical canned coffee of this size/type and set caffeine_is_estimate to true.

5. size_ml: read the printed content amount (内容量). Note it may be in grams (g) for milk-based drinks — treat that number the same as ml for our purposes.

6. confidence reflects overall label legibility, not the caffeine number specifically.
7. notes: one short sentence on anything unclear, estimated, or scaled.`;
  return callClaude(base64, mediaType, prompt, 800);
}

// Optional, user-triggered only (never automatic) — looks up the real product name
// by JAN code using server-side web search, so there's no CORS issue and no cost
// unless the person explicitly asks for it.
async function lookupNameByJan(jan) {
  const prompt = `Search for the Japanese drink product with JAN/barcode code ${jan}. This is likely a Japanese vending-machine can coffee or similar drink. Find the manufacturer's own product page if possible.

Respond with ONLY raw JSON, no markdown fences:
{"name": string|null, "brand": string|null, "found": boolean, "source_note": string}

If you can't confidently find this exact JAN code, set "found" to false and "name" to null rather than guessing a plausible-sounding name.`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 600,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    }),
  });
  const data = await response.json();
  const textBlocks = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const raw = textBlocks.replace(/```json|```/g, "").trim();
  return JSON.parse(raw);
}

export default function CanLog() {
  const [entries, setEntries] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState("log");
  const [photoPreview, setPhotoPreview] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [draft, setDraft] = useState(null); // pending entry awaiting confirm
  const [analyzeError, setAnalyzeError] = useState(null);
  const [manualMode, setManualMode] = useState(false);
  const [wrappedMonth, setWrappedMonth] = useState(monthKey(todayISO()));
  const [productDB, setProductDB] = useState({});
  const [stage, setStage] = useState(null); // null | "barcode" | "label" | "cache-hit"
  const [lookingUpName, setLookingUpName] = useState(false);
  const [lookupError, setLookupError] = useState(null);
  const [lastFile, setLastFile] = useState(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get(STORAGE_KEY, false);
        if (res?.value) setEntries(JSON.parse(res.value));
      } catch (e) {
        // no existing data yet
      }
      try {
        const dbRes = await window.storage.get(PRODUCT_DB_KEY, false);
        if (dbRes?.value) setProductDB(JSON.parse(dbRes.value));
      } catch (e) {
        // no cache yet
      }
      setLoaded(true);
    })();
  }, []);

  const persist = useCallback(async (next) => {
    setEntries(next);
    try {
      await window.storage.set(STORAGE_KEY, JSON.stringify(next), false);
    } catch (e) {
      console.error("storage error", e);
    }
  }, []);

  const persistProductDB = useCallback(async (next) => {
    setProductDB(next);
    try {
      await window.storage.set(PRODUCT_DB_KEY, JSON.stringify(next), false);
    } catch (e) {
      console.error("storage error", e);
    }
  }, []);

  // Price is never guessed — it varies machine to machine, store to store, so it's
  // always a deliberate manual entry. Left blank/0 by default rather than pre-filled,
  // so it's obvious it needs the user's input rather than looking already-answered.
  

  const handleFile = async (file, { skipCache = false } = {}) => {
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
      const base64 = await fileToBase64(file);
      const mediaType = file.type || "image/jpeg";

      // Stage 1: try to read the barcode (cheap call, runs every time)
      const barcodeResult = await extractBarcode(base64, mediaType);
      const jan = barcodeResult?.readable ? barcodeResult.jan : null;

      // Cache check — if we've seen this JAN before, skip the expensive call entirely
      if (!skipCache && jan && productDB[jan]) {
        setStage("cache-hit");
        setDraft({ ...productDB[jan], jan, image: previewUrl, fromCache: true, price_yen: "", notes: "Loaded from your saved products — no scan needed." });
        setAnalyzing(false);
        return;
      }

      // Stage 2: cache miss (or unreadable barcode, or forced rescan) — do the fuller label read
      setStage("label");
      const labelResult = await extractLabelData(base64, mediaType);
      const draftData = { ...labelResult, jan, image: previewUrl, fromCache: false, price_yen: "" };
      setDraft(draftData);
      // Note: we don't cache here — caching happens on saveDraft, using the
      // user-corrected values (e.g. the real name, since the label only had
      // the generic category name).
    } catch (e) {
      console.error(e);
      setAnalyzeError("Couldn't read that label clearly. You can enter it manually below.");
      setDraft({ brand: "", name: "", size_ml: 250, caffeine_mg: 90, calories: 20, carbs_g: 0, protein_g: 0, fat_g: 0, sodium_mg: 0, caffeine_is_estimate: true, confidence: "low", notes: "", jan: null, image: previewUrl });
      setManualMode(true);
    } finally {
      setAnalyzing(false);
      setStage(null);
    }
  };

  const forceRescan = () => {
    if (lastFile) handleFile(lastFile, { skipCache: true });
  };

  const clearProductCache = async () => {
    await persistProductDB({});
  };

  const tryLookupName = async () => {
    if (!draft?.jan) return;
    setLookingUpName(true);
    setLookupError(null);
    try {
      const result = await lookupNameByJan(draft.jan);
      if (result.found && result.name) {
        setDraft({ ...draft, name: result.name, name_is_generic: false, brand: draft.brand || result.brand || "" });
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

  const startManual = (prefill) => {
    setPhotoPreview(null);
    setAnalyzeError(null);
    setManualMode(true);
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
      image: null,
    });
  };

  const saveDraft = async () => {
    if (!draft) return;
    const entry = {
      id: `${Date.now()}`,
      timestamp: todayISO(),
      jan: draft.jan || null,
      brand: draft.brand || "Unknown",
      name: draft.name || "Coffee",
      size_ml: Number(draft.size_ml) || 0,
      caffeine_mg: Number(draft.caffeine_mg) || 0,
      caffeine_is_estimate: !!draft.caffeine_is_estimate,
      calories: Number(draft.calories) || 0,
      carbs_g: Number(draft.carbs_g) || 0,
      protein_g: Number(draft.protein_g) || 0,
      fat_g: Number(draft.fat_g) || 0,
      sodium_mg: Number(draft.sodium_mg) || 0,
      price_yen: Number(draft.price_yen) || 0,
      image: draft.image || null,
    };
    await persist([entry, ...entries]);

    // Cache this product (using the corrected values) so future scans of the
    // same barcode skip Stage 2 entirely.
    if (entry.jan) {
      await persistProductDB({
        ...productDB,
        [entry.jan]: {
          brand: entry.brand,
          name: entry.name,
          name_is_generic: false,
          size_ml: entry.size_ml,
          calories: entry.calories,
          carbs_g: entry.carbs_g,
          protein_g: entry.protein_g,
          fat_g: entry.fat_g,
          sodium_mg: entry.sodium_mg,
          caffeine_mg: entry.caffeine_mg,
          caffeine_is_estimate: entry.caffeine_is_estimate,
          confidence: draft.confidence || "manual",
        },
      });
    }

    setDraft(null);
    setPhotoPreview(null);
    setManualMode(false);
    setAnalyzeError(null);
  };

  const cancelDraft = () => {
    setDraft(null);
    setPhotoPreview(null);
    setManualMode(false);
    setAnalyzeError(null);
  };

  const deleteEntry = async (id) => {
    await persist(entries.filter((e) => e.id !== id));
  };

  const months = Array.from(new Set(entries.map((e) => monthKey(e.timestamp)))).sort();
  if (!months.includes(wrappedMonth) && months.length) {
    // keep as-is; user can navigate
  }
  const monthEntries = entries.filter((e) => monthKey(e.timestamp) === wrappedMonth);
  const totalCups = monthEntries.length;
  const totalCaffeine = monthEntries.reduce((s, e) => s + e.caffeine_mg, 0);
  const totalMl = monthEntries.reduce((s, e) => s + e.size_ml, 0);
  const totalCalories = monthEntries.reduce((s, e) => s + e.calories, 0);
  const totalSpend = monthEntries.reduce((s, e) => s + (e.price_yen || 0), 0);
  const brandCounts = {};
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

  const shiftMonth = (dir) => {
    const [y, m] = wrappedMonth.split("-").map(Number);
    const d = new Date(y, m - 1 + dir, 1);
    setWrappedMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };

  const history = [...entries].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  return (
    <div
      style={{
        fontFamily: "'Noto Sans JP', sans-serif",
        background: "#1B2430",
        minHeight: "100%",
        color: "#F1E8D8",
      }}
      className="w-full min-h-screen flex flex-col"
    >
      <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Noto+Sans+JP:wght@400;500;700&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet" />

      {/* Header */}
      <div className="px-5 pt-6 pb-4 flex items-center justify-between" style={{ borderBottom: "1px solid #333d4d" }}>
        <div className="flex items-center gap-2">
          <div
            className="w-9 h-9 rounded-lg flex items-center justify-center"
            style={{ background: "#E8A33D" }}
          >
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
          {[
            ["log", "Log"],
            ["history", "History"],
            ["wrapped", "Wrapped"],
          ].map(([key, label]) => (
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
                  style={{
                    border: "2px dashed #465065",
                    borderRadius: 16,
                    padding: "36px 20px",
                    textAlign: "center",
                    cursor: "pointer",
                    background: "#212a38",
                  }}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    style={{ display: "none" }}
                    onChange={(e) => handleFile(e.target.files?.[0])}
                  />
                  <div
                    className="mx-auto mb-3 flex items-center justify-center"
                    style={{ width: 52, height: 52, borderRadius: "50%", background: "#2d3849" }}
                  >
                    <Camera size={24} color="#E8A33D" />
                  </div>
                  <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 15 }}>
                    Snap the BACK of the can
                  </div>
                  <div style={{ fontSize: 12.5, color: "#8B95A1", marginTop: 4 }}>
                    Get the barcode and nutrition table in frame
                  </div>
                </div>

                {analyzing && (
                  <div className="flex items-center gap-2 justify-center mt-4" style={{ color: "#8B95A1", fontSize: 13 }}>
                    <Loader2 size={16} className="animate-spin" />
                    {stage === "barcode" && "Reading barcode…"}
                    {stage === "label" && "New product — reading nutrition label…"}
                    {stage === "cache-hit" && "Found it in your saved products…"}
                  </div>
                )}
                {photoPreview && analyzing && (
                  <img src={photoPreview} alt="preview" style={{ width: 96, height: 96, objectFit: "cover", borderRadius: 10, margin: "12px auto 0", display: "block" }} />
                )}

                <div className="mt-6">
                  <div style={{ fontSize: 11, color: "#8B95A1", letterSpacing: "0.06em", marginBottom: 8 }}>
                    NO PHOTO? QUICK-ADD A COMMON ONE
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {QUICK_ITEMS.map((item) => (
                      <button
                        key={item.name}
                        onClick={() => startManual(item)}
                        style={{
                          background: "#212a38",
                          border: "1px solid #333d4d",
                          borderRadius: 10,
                          padding: "10px 12px",
                          textAlign: "left",
                        }}
                      >
                        <div style={{ fontSize: 12.5, fontWeight: 500 }}>{item.name}</div>
                        <div style={{ fontSize: 10.5, color: "#8B95A1", marginTop: 2 }}>{item.brand} · {item.size_ml}ml</div>
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={() => startManual(null)}
                    style={{ fontSize: 12.5, color: "#E8A33D", marginTop: 10, fontWeight: 500 }}
                  >
                    + Enter something else manually
                  </button>
                </div>

                {Object.keys(productDB).length > 0 && (
                  <div style={{ marginTop: 20, textAlign: "center" }}>
                    <button onClick={clearProductCache} style={{ fontSize: 10.5, color: "#465065", textDecoration: "underline" }}>
                      Clear saved product cache ({Object.keys(productDB).length} product{Object.keys(productDB).length === 1 ? "" : "s"})
                    </button>
                  </div>
                )}
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
                      <span style={{ fontSize: 10, background: "#5B3A29", color: "#F1E8D8", padding: "2px 8px", borderRadius: 6, fontWeight: 700 }}>
                        FROM CACHE
                      </span>
                    )}
                    {draft.confidence === "low" && !manualMode && (
                      <span style={{ fontSize: 10, background: "#C1432B", color: "#F1E8D8", padding: "2px 8px", borderRadius: 6, fontWeight: 700 }}>
                        LOW CONFIDENCE
                      </span>
                    )}
                  </div>
                </div>

                {analyzeError && (
                  <div style={{ fontSize: 12, color: "#C1432B", marginBottom: 10 }}>{analyzeError}</div>
                )}
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

                {draft.image && (
                  <img src={draft.image} alt="scanned" style={{ width: "100%", maxHeight: 140, objectFit: "cover", borderRadius: 10, marginBottom: 12 }} />
                )}

                {draft.jan && (
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "#8B95A1", marginBottom: 10 }}>
                    JAN {draft.jan}
                  </div>
                )}

                {draft.name_is_generic && !manualMode && (
                  <div style={{ fontSize: 11.5, background: "#5B3A29", color: "#F1E8D8", borderRadius: 8, padding: "8px 10px", marginBottom: 10 }}>
                    <div style={{ marginBottom: draft.jan ? 8 : 0 }}>
                      The label only shows "{draft.name}" — that's the food-category label, not the product name.
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
                    placeholder={draft.name_is_generic ? `e.g. printed on the front` : undefined}
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
                    className="flex-1 flex items-center justify-center gap-1.5"
                    style={{ background: "#1B2430", color: "#F1E8D8", borderRadius: 10, padding: "10px 0", fontWeight: 700, fontSize: 13 }}
                  >
                    <Check size={15} /> Log it
                  </button>
                  <button
                    onClick={cancelDraft}
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
            {history.length === 0 && (
              <EmptyState text="Nothing logged yet. Go scan a can." />
            )}
            <div className="flex flex-col gap-2">
              {history.map((e) => (
                <div
                  key={e.id}
                  className="flex items-center gap-3"
                  style={{ background: "#212a38", borderRadius: 12, padding: 10 }}
                >
                  {e.image ? (
                    <img src={e.image} alt="" style={{ width: 44, height: 44, borderRadius: 8, objectFit: "cover" }} />
                  ) : (
                    <div style={{ width: 44, height: 44, borderRadius: 8, background: "#2d3849", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <Coffee size={18} color="#E8A33D" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {e.name}
                    </div>
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
              <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 14 }}>
                {fmtMonthLabel(wrappedMonth)}
              </div>
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

                <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 12, letterSpacing: "0.1em", color: "#5B3A29" }}>
                  CAFFEINE FACTS
                </div>
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
                    <span style={{ fontSize: 12 }}>
                      Favorite: <strong>{favoriteBrand[0]}</strong> ({favoriteBrand[1]}×)
                    </span>
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
                      <Tooltip
                        cursor={{ fill: "rgba(0,0,0,0.05)" }}
                        contentStyle={{ background: "#1B2430", border: "none", borderRadius: 8, fontSize: 11 }}
                        labelStyle={{ color: "#F1E8D8" }}
                      />
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

function Field({ label, value, onChange, type = "text", placeholder }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: "#5B3A29", fontWeight: 700, letterSpacing: "0.04em", marginBottom: 3 }}>
        {label.toUpperCase()}
      </div>
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

function Stat({ big, unit, label }) {
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

function EmptyState({ text }) {
  return (
    <div style={{ textAlign: "center", padding: "40px 20px", color: "#8B95A1", fontSize: 13 }}>
      <Coffee size={28} color="#465065" style={{ margin: "0 auto 10px" }} />
      {text}
    </div>
  );
}
