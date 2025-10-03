// background.js — VERSIÓN CORREGIDA (dynamic import, OCR/PDF, contador real + docMeta)

/* Rutas de assets dentro del paquete */
const URLS = {
  pdfjs:      chrome.runtime.getURL("libs/pdf.min.js"),
  pdfWorker:  chrome.runtime.getURL("libs/pdf.worker.min.js"),
  tessMain:   chrome.runtime.getURL("libs/tesseract.min.js"),
  tessWorker: chrome.runtime.getURL("libs/tesseract.worker.min.js"),
  tessCore:   chrome.runtime.getURL("libs/tesseract-core.wasm"),
};

/* ------------------------ PDF.js (carga dinámica) ------------------------ */
let PDFJS_READY = null;
async function ensurePDFJS() {
  if (PDFJS_READY) return PDFJS_READY;
  PDFJS_READY = (async () => {
    const mod = await import(URLS.pdfjs);
    const pdfjsLib = mod.default || mod;
    if (pdfjsLib.GlobalWorkerOptions) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = URLS.pdfWorker;
    }
    return pdfjsLib;
  })();
  return PDFJS_READY;
}

/* ----------------------- Tesseract.js (dinámico) ------------------------- */
const OCR_LANG = "spa+por+eng";
let OCR_WORKER = null;
let OCR_BOOT = null;
const OCR_CACHE = new Map();

async function ensureOCRWorker() {
  if (OCR_BOOT) return OCR_WORKER ?? (await OCR_BOOT, OCR_WORKER);

  OCR_BOOT = (async () => {
    const mod = await import(URLS.tessMain);
    const Tesseract = mod.default || mod; // UMD/ESM safe

    const w = await Tesseract.createWorker({
      workerPath: URLS.tessWorker,
      corePath: URLS.tessCore,
      logger: (m) =>
        console.log(`[Tesseract] ${m.status}: ${((m.progress || 0) * 100).toFixed(2)}%`),
    });
    await w.loadLanguage(OCR_LANG);
    await w.initialize(OCR_LANG);
    await w.setParameters({
      tessedit_pageseg_mode: Tesseract.PSM.AUTO_OSD,
      tessjs_image_quality: 0.8,
    });
    OCR_WORKER = w;
    console.log("[Tesseract] Worker listo.");
  })();

  await OCR_BOOT;
  return OCR_WORKER;
}

/* ------------------------------ Helpers --------------------------------- */
const isPDF   = (u) => /\.pdf(\?|$)/i.test(String(u || ""));
const isImage = (u) => /\.(png|jpe?g|bmp|webp|tif?f)(\?|$)/i.test(String(u || ""));
const cleanUrlKey = (u) => String(u || "").replace(/[?#].*$/, "");

async function fetchAsArrayBuffer(url) {
  const resp = await fetch(url, { credentials: "include", cache: "no-store" });
  if (!resp.ok) throw new Error(`No pude descargar (${resp.status})`);
  return await resp.arrayBuffer();
}
async function fetchAsBlob(url) {
  const resp = await fetch(url, { credentials: "include", cache: "no-store" });
  if (!resp.ok) throw new Error(`No pude descargar (${resp.status})`);
  return await resp.blob();
}

function normalizeAppsScriptUrl(u) {
  if (!u) return "";
  return String(u).replace(
    /https:\/\/script\.google\.com\/a\/macros\/[^/]+\/s\//,
    "https://script.google.com/macros/s/"
  );
}
async function postJSON(url, body) {
  const r = await fetch(url, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} – ${txt.slice(0, 300)}`);
  try { return JSON.parse(txt); } catch { throw new Error("Respuesta no es JSON"); }
}
async function mapWithLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); }
      catch (e) { out[idx] = { url: items[idx], kind: "unknown", text: "", error: String(e?.message || e) }; }
    }
  });
  await Promise.all(runners);
  return out;
}

/* --------------------------- Extractores -------------------------------- */
async function pdfArrayBufferToText(ab) {
  const lib = await ensurePDFJS();
  const loadingTask = lib.getDocument({ data: ab });
  const pdf = await loadingTask.promise;
  const out = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    out.push(content.items.map(i => i.str).join(" "));
  }
  return out.join("\n");
}

async function imageBlobToOCRText_fast(blob, urlKey) {
  const k = cleanUrlKey(urlKey);
  if (k && OCR_CACHE.has(k)) return OCR_CACHE.get(k);

  const w = await ensureOCRWorker();
  let src = blob;

  try {
    const bmp = await createImageBitmap(blob);
    const maxSide = 1600;
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    if (scale < 1 && globalThis.OffscreenCanvas) {
      const c = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
      const ctx = c.getContext("2d");
      ctx.filter = "grayscale(1) contrast(1.5)";
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
      src = await c.convertToBlob({ type: "image/jpeg", quality: 0.85 });
    }
  } catch(_) {}

  const { data } = await w.recognize(src);
  const txt = (data && data.text) ? String(data.text) : "";
  if (k) OCR_CACHE.set(k, txt);
  return txt;
}

async function extractFromUrl(url) {
  try {
    if (isPDF(url)) {
      const ab = await fetchAsArrayBuffer(url);
      const text = await pdfArrayBufferToText(ab);
      return { url, kind: "pdf", text: text || "" };
    }
    if (isImage(url)) {
      const b = await fetchAsBlob(url);
      const text = await imageBlobToOCRText_fast(b, url);
      return { url, kind: "image", text: text || "" };
    }
  } catch (e) {
    return { url, kind: "unknown", text: "", error: String(e?.message || e) };
  }
  return { url, kind: "unknown", text: "" };
}

/* ----------------------------- Mensajería ------------------------------- */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  // NEW: persist site/challenge so popup can render badges
  if (msg.type === "maf:set_site") {
    try { chrome.storage.session.set({ maf_site: msg.value || null }); } catch {}
    try { chrome.storage.local.set({ maf_site: msg.value || null }); } catch {}
    return; // no async response
  }
  if (msg.type === "maf:set_challenge") {
    try { chrome.storage.session.set({ maf_challenge: msg.value || null }); } catch {}
    try { chrome.storage.local.set({ maf_challenge: msg.value || null }); } catch {}
    return;
  }

  if (msg.type === "maf:ai_analyze_with_docs") {
    (async () => {
      try {
        let remote = normalizeAppsScriptUrl(msg.remoteUrl || "");
        if (!remote) {
          const storage = await chrome.storage.local.get("remote_url");
          remote = normalizeAppsScriptUrl(storage.remote_url || "");
        }
        if (!remote) throw new Error("URL remota vacía");

        const urls = Array.isArray(msg.docUrls) ? msg.docUrls : [];
        const results = await mapWithLimit(urls, 2, (u) => extractFromUrl(u));

        const ocrText = results
          .map(r => r && r.text ? `--- ${r.url}\n${r.text}` : "")
          .filter(Boolean)
          .join("\n\n");

        const payload = {
          op: "analyze",
          text: String(msg.text || ""),
          cdu: msg.cdu ?? null,
          site: msg.site ?? null,
          ocrText,
          docMeta: results.map(r => ({ url: r.url, kind: r.kind, error: r.error || null })),
        };

        const data = await postJSON(remote, payload);
        if (!data || data.ok === false) throw new Error(data?.error || "Falló Apps Script");

        const responseData = {
          ...data,
          docMeta: payload.docMeta,
          docCount: payload.docMeta.length,
        };
        console.log("[Mafalda] Documentos procesados:", responseData.docMeta);
        sendResponse({ ok: true, data: responseData });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true; // respuesta async
  }
});

