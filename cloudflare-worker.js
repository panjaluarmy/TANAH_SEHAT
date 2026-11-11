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

const SYSTEM = `Anda asisten agronomi untuk alat pemantau tanah berbasis sensor ESP32.
Tugas: menafsirkan pembacaan sensor dan memberi saran yang praktis dalam bahasa Indonesia.
Aturan:
- Ringkas dan jelas, maksimal sekitar 180 kata, format: Ringkasan, Masalah utama, Tindakan yang disarankan.
- Gunakan hanya data yang diberikan. Jangan mengarang angka atau penyebab pasti.
- Jika data tampak janggal (misalnya kelembapan di luar 0-100%, suhu di luar rentang wajar, atau pH di luar 3-9), sebut kemungkinan sensor perlu dikalibrasi atau diperiksa.
- Bila ada riwayat, jelaskan tren (naik, turun, stabil).
- Jangan membuat rekomendasi pemupukan karena sistem ini hanya mengukur kelembapan, pH, dan suhu tanah.`;

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

    const crop = String(body.crop || "tidak disebutkan").slice(0, 30);
    const history = (Array.isArray(body.history) ? body.history : []).filter(ok).slice(-12);
    const pick = (o) => Object.fromEntries(KEYS.map((k) => [k, o[k]]));

    const prompt =
      `Tanaman: ${crop}\n` +
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

    return reply({ analysis: text });
  },
};
