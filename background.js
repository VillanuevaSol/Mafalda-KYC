// background.js — MV3 (type: module)
// Usa pdf.min.js / pdf.worker.min.js / tesseract.min.js / tesseract.worker.min.js / tesseract-core.wasm desde libs/

const URLS = {
  pdfjs: chrome.runtime.getURL("libs/pdf.min.js"),
  pdfWorker: chrome.runtime.getURL("libs/pdf.worker.min.js"),
  tessMain: chrome.runtime.getURL("libs/tesseract.min.js"),
  tessWorker: chrome.runtime.getURL("libs/tesseract.worker.min.js"),
  tessCore: chrome.runtime.getURL("libs/tesseract-core.wasm")
};

// ---------- PDF.js ----------
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

// ---------- Tesseract.js ----------
let TESS_READY = null;
async function ensureTesseract() {
  if (TESS_READY) return TESS_READY;
  TESS_READY = (async () => {
    const mod = await import(URLS.tessMain);
    const Tesseract = mod.default || mod;
    Tesseract.setLogging && Tesseract.setLogging(false);
    return Tesseract;
  })();
  return TESS_READY;
}

// ---------- Helpers ----------
function normalizeAppsScriptUrl(u) {
  if (!u) return "";
  return String(u).replace(
    /https:\/\/script\.google\.com\/a\/macros\/[^/]+\/s\//,
    "https://script.google.com/macros/s/"
  );
}

async function postPlain(url, body) {
  const r = await fetch(url, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(body || {})
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} – ${txt.slice(0, 300)}`);
  try { return JSON.parse(txt); } catch { throw new Error("Respuesta no es JSON"); }
}

function isPDF(url) { return /\.pdf(\?|$)/i.test(url); }
function isImage(url) { return /\.(png|jpe?g|bmp|webp|tif?f)(\?|$)/i.test(url); }

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

// ---------- Extractores ----------
async function pdfArrayBufferToText(ab) {
  const pdfjsLib = await ensurePDFJS();
  const loadingTask = pdfjsLib.getDocument({ data: ab });
  const pdf = await loadingTask.promise;
  let out = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const line = content.items.map(i => i.str).join(" ");
    out.push(line);
  }
  return out.join("\n");
}

async function imageBlobToOCRText(blob) {
  const Tesseract = await ensureTesseract();
  const worker = await Tesseract.createWorker({
    workerPath: URLS.tessWorker,
    corePath: URLS.tessCore
  });
  try {
    await worker.loadLanguage("spa+por+eng");
    await worker.initialize("spa+por+eng");
    const { data } = await worker.recognize(blob);
    return (data && data.text) ? String(data.text) : "";
  } finally {
    await worker.terminate();
  }
}

async function extractFromUrl(url) {
  try {
    if (isPDF(url)) {
      const ab = await fetchAsArrayBuffer(url);
      return { url, kind: "pdf", text: (await pdfArrayBufferToText(ab)) || "" };
    }
    if (isImage(url)) {
      const b = await fetchAsBlob(url);
      return { url, kind: "image", text: (await imageBlobToOCRText(b)) || "" };
    }
  } catch (e) {
    return { url, kind: "unknown", text: "", error: String(e?.message || e) };
  }
  return { url, kind: "unknown", text: "" };
}

// ---------- Mensajería ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  // 0) Persistencia de SITE/CDU detectados desde el content script
  if (msg.type === "maf:set_challenge") {
    const v = (msg.value || "").toString().trim();
    Promise.all([
      chrome.storage.session.set({ maf_challenge: v }),
      chrome.storage.local.set({ maf_challenge: v })
    ]).then(() => sendResponse({ ok: true }))
     .catch(e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === "maf:set_site") {
    const v = (msg.value || "").toString().trim();
    Promise.all([
      chrome.storage.session.set({ maf_site: v }),
      chrome.storage.local.set({ maf_site: v })
    ]).then(() => sendResponse({ ok: true }))
     .catch(e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  // 1) Análisis con OCR
  if (msg.type === "maf:ai_analyze_with_docs") {
    (async () => {
      try {
        const remote = normalizeAppsScriptUrl(msg.remoteUrl || "");
        if (!remote) throw new Error("URL remota vacía");

        const urls = Array.isArray(msg.docUrls) ? msg.docUrls.slice(0, 6) : [];
        const results = [];
        for (const u of urls) {
          results.push(await extractFromUrl(u));
        }
        const ocrText = results.map(r => `--- ${r.url}\n${r.text}`).filter(Boolean).join("\n\n");

        const payload = {
          op: "analyze",
          text: String(msg.text || ""),
          cdu: msg.cdu ?? null,
          site: msg.site ?? null,
          caseId: msg.caseId ?? null,
          ocrText,
          docMeta: results
        };
        const data = await postPlain(remote, payload);
        if (!data || data.ok === false) throw new Error(data?.error || "Falló Apps Script");
        sendResponse({ ok: true, data });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }

  // 2) Proxy simple (sin OCR)
  if (msg.type === "maf:ai_analyze") {
    (async () => {
      try {
        const remote = normalizeAppsScriptUrl(msg.remoteUrl || "");
        if (!remote) throw new Error("URL remota vacía");
        const data = await postPlain(remote, {
          op: "analyze",
          text: String(msg.text || ""),
          cdu: msg.cdu ?? null,
          site: msg.site ?? null,
          caseId: msg.caseId ?? null,
          ocrText: String(msg.ocrText || ""),
          docMeta: []
        });
        if (!data || data.ok === false) throw new Error(data?.error || "Falló Apps Script");
        sendResponse({ ok: true, data });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }
});
