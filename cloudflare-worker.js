// Cloudflare Worker untuk analisis AI Gemini
// Cara pakai:
// 1. Buat Worker di Cloudflare
// 2. Upload file ini sebagai script Worker
// 3. Tambahkan secret: GEMINI_API_KEY
// 4. Ganti ALLOWED_ORIGIN dengan domain web Anda (misal https://tanahsehat.example.com)
// 5. Frontend cukup fetch ke URL Worker

const MODEL = "gemini-3.5-flash-lite";
const ALLOWED_ORIGINS = new Set([
  "http://localhost:8000",
  "http://localhost:8123",
  "http://localhost:8132",
  "http://127.0.0.1:8132",
  "https://panjaluarmy.github.io",
  "https://localhost",      // Capacitor Android
  "capacitor://localhost",  // Capacitor iOS
]); // ganti dengan origin situs Anda setelah dipublikasikan
const KEYS = ["moist", "ph", "temp"];
const CROP_RANGES = {
  Padi: { moist: [60, 80], ph: [5.5, 6.5], temp: [25, 37] },
  Cabai: { moist: [50, 70], ph: [6, 6.8], temp: [18, 30] },
  Jagung: { moist: [50, 75], ph: [5.8, 7], temp: [20, 32] },
};
const EVIDENCE = {
  "soil-ph-general": {
    parameters: ["ph"], crops: ["Padi", "Cabai", "Jagung"],
    page: 2, excerpt: "In general, nutrients will be easily absorbed by plants at pH 6-7, because most of nutrients will easily dissolve in water in that pH.",
  },
  "soil-moisture-categories": {
    parameters: ["moist"], crops: ["Padi", "Cabai", "Jagung"],
    page: 5, excerpt: "Wet + = Kelembaban tinggi; Wet = Lembab; Nor = Normal.",
  },
  "rice-site-table": {
    parameters: ["ph", "temp"], crops: ["Padi"],
    page: 4, excerpt: "Tabel 1 (lokasi penelitian): temperatur tanah 25°C; nilai pH pada unit lahan yang diteliti berkisar sekitar 5,79-7,00. Ini hasil lokasi penelitian, bukan ambang ideal universal.",
  },
  "chili-suitability": {
    parameters: ["ph", "temp"], crops: ["Cabai"],
    page: 3, excerpt: "Tabel 3, kelas S1 cabai rawit: temperatur rata-rata tahunan 24-28°C; pH H2O 6,0-7,5.",
  },
  "chili-lab-methods": {
    parameters: ["ph"], crops: ["Cabai"],
    page: 3, excerpt: "Tabel 1: pH tanah diukur dengan pH meter.",
  },
  "maize-suitability": {
    parameters: ["ph", "temp"], crops: ["Jagung"],
    page: 3, excerpt: "Tabel 1, kelas S1: temperatur rerata 20-26°C; pH H2O 5,8-7,8.",
  },
};
const CROPS = Object.keys(CROP_RANGES);

const SYSTEM = `Anda asisten agronomi. Gunakan hanya nilai sensor, rentang dashboard, dan kutipan sumber yang diberikan. Jawab hanya JSON valid dengan properti tingkat atas "analysis".
Aturan:
- Untuk mode general, schema: {"analysis":{"summary":[{"parameter":"nama parameter","statement":"...","evidenceIds":[]}],"suitableCrops":[{"crop":"nama tanaman","parameter":"nama parameter","reason":"...","evidenceIds":[]}],"attention":[{"parameter":"nama parameter","statement":"...","evidenceIds":[]}]}}. Parameter harus tepat moist, ph, atau temp; ringkasan harus punya satu per parameter. Tanaman hanya boleh Padi, Cabai, atau Jagung. Urutkan dari paling sesuai berdasarkan nilai dan rentang ilustratif. Jangan menyatakan rentang ilustratif sebagai ambang jurnal atau jaminan panen.
- Untuk mode crop, schema: {"analysis":{"statements":[{"parameter":"nama parameter","statement":"...","evidenceIds":[]}],"conclusion":{"statement":"...","evidenceIds":[]}}}. Parameter harus tepat moist, ph, atau temp; beri tepat satu pernyataan per parameter dan satu kesimpulan.
- Gunakan ID sitasi hanya dari daftar yang diberikan dan hanya bila kutipan mendukung konteks parameter pada pernyataan itu. Untuk setiap pernyataan yang memiliki bukti relevan, sertakan minimal satu ID. Jangan mengarang jurnal, kutipan, atau halaman.
- Kelembapan jurnal adalah kategori kualitatif, bukan persen sensor; jelaskan bahwa angka sensor tidak dapat dibandingkan langsung dengan kategori itu.
- Suhu pada sumber cabai/jagung adalah suhu rata-rata tahunan/iklim; jangan samakan dengan suhu tanah sensor. Untuk padi, tabelnya adalah hasil lokasi tertentu, bukan rentang universal.
- Rentang tanaman di dashboard hanya untuk penyaringan awal dan tidak otomatis dibuktikan oleh kutipan.
- Beri saran bertahap yang aman, bukan dosis pupuk. Untuk keputusan lahan, sebut keterbatasan tiga sensor dan anjurkan uji tanah bila perlu.
- Teks harus ringkas dalam bahasa Indonesia.`;

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin");
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "null",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };

    const reply = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { ...cors, "Content-Type": "application/json" },
      });

    // Tolak request dari origin tak terdaftar (curl/skrip tanpa Origin juga ditolak)
    if (!ALLOWED_ORIGINS.has(origin)) {
      return reply({ error: "Origin tidak diizinkan" }, 403);
    }

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    if (req.method !== "POST") {
      return reply({ error: "Gunakan metode POST" }, 405);
    }

    if (!env.GEMINI_API_KEY) {
      return reply({ error: "Secret GEMINI_API_KEY belum diisi di Cloudflare" }, 500);
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return reply({ error: "JSON tidak valid" }, 400);
    }

    const ok = (o) => o && KEYS.every((k) => typeof o[k] === "number" && Number.isFinite(o[k]));

    if (!ok(body.latest)) {
      return reply({ error: "Data sensor tidak lengkap" }, 400);
    }

    if (body.mode !== "general" && body.mode !== "crop") {
      return reply({ error: "Mode analisis tidak dikenal" }, 400);
    }
    const mode = body.mode;
    const crop = String(body.crop || "").trim().slice(0, 30);
    const knownCrop = Object.prototype.hasOwnProperty.call(CROP_RANGES, crop);
    const isCustomCrop = mode === "crop" && !knownCrop;
    const customRanges = body.idealRanges;
    const rangeLimits = { moist: [0, 100], ph: [0, 14], temp: [-10, 60] };
    const validRanges = customRanges && KEYS.every((key) =>
      Array.isArray(customRanges[key]) &&
      customRanges[key].length === 2 &&
      customRanges[key].every((value) => typeof value === "number" && Number.isFinite(value)) &&
      customRanges[key][0] >= rangeLimits[key][0] &&
      customRanges[key][1] <= rangeLimits[key][1] &&
      customRanges[key][0] < customRanges[key][1]
    );
    if (mode === "crop" && (!crop || (!knownCrop && !validRanges))) {
      return reply({ error: "Tanaman pilihan atau rentang pembanding tidak valid" }, 400);
    }
    const ranges = mode === "general" ? null : knownCrop ? CROP_RANGES[crop] : customRanges;
    const history = (Array.isArray(body.history) ? body.history : []).filter(ok).slice(-12);
    const pick = (o) => Object.fromEntries(KEYS.map((k) => [k, o[k]]));

    const evidenceIdsFor = (cropName, parameter) => Object.keys(EVIDENCE).filter((id) =>
      EVIDENCE[id].parameters.includes(parameter) &&
      (cropName
        ? EVIDENCE[id].crops.includes(cropName) || (isCustomCrop && EVIDENCE[id].crops.length === CROPS.length)
        : EVIDENCE[id].crops.length === CROPS.length)
    );
    const evidenceText = Object.fromEntries(Object.entries(EVIDENCE).map(([id, evidence]) => [
      id, { excerpt: evidence.excerpt, page: evidence.page, crops: evidence.crops, parameters: evidence.parameters },
    ]));
    const generalEvidence = Object.fromEntries(KEYS.map((key) => [key, evidenceIdsFor(null, key)]));
    const commonPrompt =
      `Mode analisis: ${mode}\n` +
      `Pembacaan terbaru: ${JSON.stringify(pick(body.latest))}\n` +
      `Satuan: kelembapan sensor=%, pH=pH, suhu sensor=°C\n` +
      (history.length ? `Riwayat terakhir (lama ke baru): ${JSON.stringify(history.map(pick))}\n` : "") +
      `Kutipan dan halaman jurnal yang tersedia: ${JSON.stringify(evidenceText)}\n`;
    const prompt = mode === "general"
      ? commonPrompt +
        `Bandingkan hanya tiga tanaman berikut secara berurutan memakai rentang pembanding ilustratif: ${JSON.stringify(CROP_RANGES)}\n` +
        `ID bukti yang boleh dipakai untuk ringkasan/perhatian per parameter: ${JSON.stringify(generalEvidence)}\n` +
        `ID bukti per tanaman dan parameter: ${JSON.stringify(Object.fromEntries(CROPS.map((name) => [
          name, Object.fromEntries(KEYS.map((key) => [key, evidenceIdsFor(name, key)])),
        ])))}\n` +
        "Pilih tanaman paling sesuai dari Padi, Cabai, dan Jagung; sebutkan tanaman lain hanya bila juga cukup sesuai. Jelaskan alasan dan hal yang perlu diperbaiki secara ringkas."
      : commonPrompt +
        `Tanaman pilihan: ${crop}\n` +
        `Rentang pembanding: ${JSON.stringify(ranges)} (ilustratif, bukan standar universal)\n` +
        (typeof body.stress === "number" ? `Indeks stres tanah dashboard (0-100): ${Math.round(body.stress)}\n` : "") +
        `ID bukti yang boleh dipakai per parameter: ${JSON.stringify(Object.fromEntries(KEYS.map((key) => [
          key, evidenceIdsFor(crop, key),
        ])))}; kesimpulan boleh memakai: ${JSON.stringify(Object.keys(EVIDENCE).filter((id) =>
          EVIDENCE[id].crops.includes(crop) || (isCustomCrop && EVIDENCE[id].crops.length === CROPS.length)
        ))}\n` +
        "Berikan satu pernyataan berbasis data untuk tiap parameter dan kesimpulan untuk tanaman tersebut.";

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
    const requestBody = JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 1800, temperature: 0.2, responseMimeType: "application/json" },
    });
    const retryable = new Set([429, 500, 502, 503, 504]);
    let r;
    for (let attempt = 0; ; attempt++) {
      r = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY,
        },
        body: requestBody,
      });
      if (!retryable.has(r.status) || attempt >= 2) break;

      const retryAfter = Number(r.headers.get("Retry-After"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 5000)
        : 1000 * (2 ** attempt);
      await r.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    let d;
    try {
      d = await r.json();
    } catch {
      return reply({ error: `Respons Gemini tidak valid (kode ${r.status})` }, 502);
    }
    if (!r.ok) {
      return reply({ error: d.error?.message || `Panggilan ke Gemini gagal (kode ${r.status})` }, 502);
    }
    const parts = (d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || [];
    const text = parts.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("\n");

    if (!text) {
      return reply({ error: "Gemini tidak mengembalikan analisis terstruktur" }, 502);
    }

    let result;
    try {
      result = JSON.parse(text);
    } catch {
      return reply({ error: "Format analisis Gemini tidak valid; silakan ulangi analisis" }, 502);
    }
    const analysis = result && result.analysis;
    const validStatement = (item) =>
      item &&
      typeof item.statement === "string" &&
      Boolean(item.statement.trim()) &&
      Array.isArray(item.evidenceIds);
    const validEvidence = (ids, allowed, required) =>
      Array.isArray(ids) &&
      (!required || !allowed.length || ids.length > 0) &&
      ids.every((id) => allowed.includes(id));

    if (!analysis || typeof analysis !== "object") {
      return reply({ error: "Struktur analisis Gemini tidak lengkap" }, 502);
    }

    if (mode === "general") {
      const summaryParameters = new Set(KEYS);
      if (
        !Array.isArray(analysis.summary) ||
        analysis.summary.length !== KEYS.length ||
        !Array.isArray(analysis.suitableCrops) ||
        analysis.suitableCrops.length < 1 ||
        analysis.suitableCrops.length > CROPS.length ||
        !Array.isArray(analysis.attention)
      ) {
        return reply({ error: "Analisis tanaman yang cocok tidak lengkap" }, 502);
      }
      for (const statement of analysis.summary) {
        const parameter = statement && statement.parameter;
        const allowed = KEYS.includes(parameter) ? evidenceIdsFor(null, parameter) : [];
        if (
          !KEYS.includes(parameter) ||
          !summaryParameters.delete(parameter) ||
          !validStatement(statement) ||
          !validEvidence(statement.evidenceIds, allowed, true)
        ) {
          return reply({ error: "Ringkasan parameter atau sitasinya tidak valid" }, 502);
        }
      }
      const seenCrops = new Set();
      for (const item of analysis.suitableCrops) {
        const cropEvidence = item && KEYS.includes(item.parameter)
          ? evidenceIdsFor(item.crop, item.parameter)
          : [];
        if (
          !item ||
          !CROPS.includes(item.crop) ||
          !KEYS.includes(item.parameter) ||
          seenCrops.has(item.crop) ||
          typeof item.reason !== "string" ||
          !item.reason.trim() ||
          !validEvidence(item.evidenceIds, cropEvidence, true)
        ) {
          return reply({ error: "Rekomendasi tanaman atau sitasinya tidak valid" }, 502);
        }
        seenCrops.add(item.crop);
      }
      if (analysis.attention.some((item) =>
        !item ||
        !KEYS.includes(item.parameter) ||
        !validStatement(item) ||
        !validEvidence(item.evidenceIds, evidenceIdsFor(null, item.parameter), true)
      )) {
        return reply({ error: "Pernyataan perhatian atau sitasinya tidak valid" }, 502);
      }
      if (summaryParameters.size) {
        return reply({ error: "Ringkasan AI belum membahas semua parameter" }, 502);
      }
      return reply({ analysis });
    }

    if (
      !Array.isArray(analysis.statements) ||
      analysis.statements.length !== KEYS.length ||
      !validStatement(analysis.conclusion)
    ) {
      return reply({ error: "Analisis tanaman belum memuat semua parameter dan kesimpulan" }, 502);
    }
    const seenParameters = new Set();
    for (const statement of analysis.statements) {
      const parameter = statement && statement.parameter;
      const allowed = KEYS.includes(parameter) ? evidenceIdsFor(crop, parameter) : [];
      if (
        !KEYS.includes(parameter) ||
        seenParameters.has(parameter) ||
        !validStatement(statement) ||
        !validEvidence(statement.evidenceIds, allowed, true)
      ) {
        return reply({ error: "Analisis parameter atau sitasinya tidak valid" }, 502);
      }
      seenParameters.add(parameter);
    }
    const conclusionEvidence = Object.keys(EVIDENCE).filter((id) =>
      EVIDENCE[id].crops.includes(crop) || (isCustomCrop && EVIDENCE[id].crops.length === CROPS.length)
    );
    if (seenParameters.size !== KEYS.length ||
        !validEvidence(analysis.conclusion.evidenceIds, conclusionEvidence, true)) {
      return reply({ error: "Kesimpulan analisis atau sitasinya tidak valid" }, 502);
    }

    return reply({ analysis });
  },
};
