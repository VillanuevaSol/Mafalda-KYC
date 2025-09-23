// background.js — MV3 service worker
// - Guarda CDU/SITE en chrome.storage.* cuando el content detecta.
// - Proxy de IA: recibe {type:"maf:ai_analyze", remoteUrl, text, cdu, site} y
//   ejecuta el fetch a Apps Script con cookies (credentials:"include") y
//   Content-Type "text/plain" para evitar preflight.

function normalizeAppsScriptUrl(u) {
  if (!u) return u;
  return String(u).replace(
    /https:\/\/script\.google\.com\/a\/macros\/[^/]+\/s\//,
    "https://script.google.com/macros/s/"
  );
}

// === Mensajería desde content/popup ===
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // CDU detectado
  if (msg?.type === "maf:set_challenge") {
    try {
      const value = msg?.value ?? null;
      // se guarda en session cuando se pueda y también en local para el popup
      chrome.storage.session?.set?.({ maf_challenge: value });
      chrome.storage.local.set({ maf_challenge: value });
    } catch (_) {}
    sendResponse({ ok: true });
    return; // no async
  }

  // SITE detectado
  if (msg?.type === "maf:set_site") {
    try {
      const value = msg?.value ?? null;
      chrome.storage.session?.set?.({ maf_site: value });
      chrome.storage.local.set({ maf_site: value });
    } catch (_) {}
    sendResponse({ ok: true });
    return; // no async
  }

  // Proxy de IA
  if (msg?.type === "maf:ai_analyze") {
    (async () => {
      try {
        const remote = normalizeAppsScriptUrl(String(msg.remoteUrl || "").trim());
        if (!remote) throw new Error("Remote URL vacío");

        const body = {
          op: "analyze",
          text: msg.text || "",
          cdu: msg.cdu || null,
          site: msg.site || null
        };

        // Importante: text/plain para evitar preflight; credentials para cookies Google
        const resp = await fetch(remote, {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify(body)
        });

        const raw = await resp.text();
        if (!resp.ok) throw new Error(`HTTP ${resp.status} – ${raw.slice(0, 200)}`);

        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          throw new Error("Respuesta no es JSON");
        }

        if (!data || data.ok === false) {
          throw new Error(data?.error || "No se pudo analizar.");
        }

        sendResponse({ ok: true, data });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();

    return true; // keep message channel open (async)
  }
});
