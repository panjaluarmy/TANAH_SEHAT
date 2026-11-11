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
  Jagung: { moist: [50, 75], ph: [5.8, 7], temp: [20, 32] },
  Cabai: { moist: [50, 70], ph: [6, 6.8], temp: [18, 30] },
};
const CROP_CITATIONS = {
  Padi: ["rice-acid-soil"],
  Jagung: ["maize-water-deficit"],
  Cabai: ["chili-water-stress"],
};

const SYSTEM = `Anda asisten agronomi untuk alat pemantau tanah berbasis sensor ESP32.
Tugas: menilai kondisi tanah dari data sensor dan rentang ideal yang diberikan, lalu memberi saran praktis dalam bahasa Indonesia.
Aturan:
- Ringkas dan jelas, maksimal sekitar 180 kata.
- Bandingkan kelembapan, pH, dan suhu satu per satu dengan rentang ideal tanaman. Nyatakan mana yang sudah cocok, terlalu rendah, atau terlalu tinggi.
- Pada mode analisis umum, sebutkan kandidat tanaman yang dihitung sistem dan jelaskan kecocokan setiap parameter terhadap kandidat itu. Kandidat tersebut hanya yang paling mendekati dari rentang yang tercantum, bukan jaminan tanaman akan tumbuh baik.
- Untuk tanaman pilihan, bandingkan semua parameter dengan rentang yang diberikan.
- Beri saran tindakan hanya untuk parameter yang bermasalah: misalnya atur penyiraman/drainase untuk kelembapan, atau koreksi pH secara bertahap berdasarkan hasil uji tanah. Untuk suhu, sarankan pengelolaan lingkungan seperti mulsa atau naungan; jangan menyarankan bahan tambahan yang tidak didukung data.
- Gunakan hanya data yang diberikan. Jangan mengarang angka atau penyebab pasti, dan jangan menyimpulkan kandungan hara.
- Jika data tampak janggal (misalnya kelembapan di luar 0-100%, suhu di luar rentang wajar, atau pH di luar 3-9), sebut kemungkinan sensor perlu dikalibrasi atau diperiksa.
- Bila ada riwayat, jelaskan tren (naik, turun, stabil).
- Jangan menulis sitasi atau menyebut sumber jurnal. Dashboard melampirkan sitasi yang sudah diverifikasi secara terpisah.
- Jangan merekomendasikan pemupukan karena sistem ini hanya mengukur kelembapan, pH, dan suhu tanah.`;

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

    const general = body.mode === "general";
    const cropName = typeof body.crop === "string"
      ? body.crop.replace(/[^a-zA-Z0-9 -]/g, "").trim().slice(0, 30)
      : "";
    const crop = general ? "Semua tanaman" : cropName || "Tanaman pilihan";
    const history = (Array.isArray(body.history) ? body.history : []).filter(ok).slice(-12);
    const pick = (o) => Object.fromEntries(KEYS.map((k) => [k, o[k]]));
    const validRanges = (candidate) => candidate && KEYS.every((key) => {
      const range = candidate[key];
      const limits = { moist: [0, 100], ph: [0, 14], temp: [-10, 60] }[key];
      return Array.isArray(range) &&
        range.length === 2 &&
        range.every((value) => typeof value === "number" && Number.isFinite(value)) &&
        range[0] >= limits[0] &&
        range[1] <= limits[1] &&
        range[0] < range[1];
    });
    const isKnownCrop = Object.prototype.hasOwnProperty.call(CROP_RANGES, crop);
    const ranges = isKnownCrop ? CROP_RANGES[crop] : body.idealRanges;
    if (!general && !validRanges(ranges)) {
      return reply({ error: "Rentang ideal tanaman belum tersedia atau tidak valid" }, 400);
    }
    const cropDistances = general
      ? Object.keys(CROP_CITATIONS).map((name) => {
        const distance = KEYS.reduce((total, key) => {
          const [min, max] = CROP_RANGES[name][key];
          const value = body.latest[key];
          const outside = value < min ? min - value : value > max ? value - max : 0;
          return total + outside / (max - min);
        }, 0) / KEYS.length;
        return { name, distance };
      })
      : [];
    const bestDistance = cropDistances.length
      ? Math.min(...cropDistances.map((item) => item.distance))
      : null;
    const recommendedCrops = cropDistances
      .filter((item) => Math.abs(item.distance - bestDistance) < 1e-9)
      .map((item) => item.name);
    const recommendedCrop = recommendedCrops[0] || null;

    const prompt =
      (general
        ? `Mode: analisis umum. Bandingkan data hanya dengan tanaman berikut; jangan menambah kandidat di luar daftar. Kandidat terdekat menurut jarak rata-rata ternormalisasi dari tiga parameter sensor: ${recommendedCrops.join(", ")}. Jika ada beberapa kandidat, jelaskan bahwa kecocokannya setara. Tegaskan bahwa hasil ini hanya kecocokan relatif dari parameter yang diukur, bukan kepastian agronomis.\nRentang ideal tanaman: ${Object.entries(CROP_RANGES).map(([name, range]) => `${name}: kelembapan ${range.moist[0]}-${range.moist[1]}%, pH ${range.ph[0]}-${range.ph[1]}, suhu ${range.temp[0]}-${range.temp[1]}°C`).join("; ")}\n`
        : `Tanaman: ${crop}\nRentang ideal untuk tanaman ini: kelembapan ${ranges.moist[0]}-${ranges.moist[1]}%, pH ${ranges.ph[0]}-${ranges.ph[1]}, suhu ${ranges.temp[0]}-${ranges.temp[1]}°C\n`) +
      `Pembacaan terbaru: ${JSON.stringify(pick(body.latest))}\n` +
      `Satuan: moist=%, ph=pH, temp=derajat Celsius\n` +
      (typeof body.stress === "number" ? `Indeks stres tanah (hitungan aturan, 0-100): ${Math.round(body.stress)}\n` : "") +
      (history.length ? `Riwayat terakhir (lama ke baru): ${JSON.stringify(history.map(pick))}\n` : "") +
      `Tolong analisis kondisi tanah ini.`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
    const requestBody = JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 1500, temperature: 0.4 },
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
      return reply({ error: "Gemini tidak mengembalikan teks (mungkin diblokir atau melewati batas token)" }, 502);
    }

    const citations = general
      ? Object.values(CROP_CITATIONS).flat()
      : CROP_CITATIONS[crop] || [];
    return reply({
      analysis: text,
      recommendedCrop,
      recommendedCrops,
      citations,
    });
  },
};
