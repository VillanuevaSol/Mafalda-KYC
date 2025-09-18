// background.js — recibe el CDU desde el content script y lo persiste
// Funciona en MV3 (service worker). Guarda en storage.session y
// si no está disponible, cae a storage.local.

chrome.runtime.onInstalled.addListener(() => {
  console.log("Mafalda instalada y lista ✅");
});

/**
 * Guarda el challenge en storage.session (si existe) y si falla,
 * hace fallback a storage.local. Responde al remitente con el área usada.
 */
function saveChallenge(value, sendResponse) {
  const data = { maf_challenge: value || null };

  // Preferimos session (por pestaña/sesión de navegador)
  if (chrome.storage.session && chrome.storage.session.set) {
    chrome.storage.session.set(data, () => {
      if (chrome.runtime.lastError) {
        console.warn("[BG] session.set falló:", chrome.runtime.lastError.message);
        chrome.storage.local.set(data, () => {
          sendResponse({ ok: true, area: "local", value });
        });
      } else {
        sendResponse({ ok: true, area: "session", value });
      }
    });
  } else {
    // Fallback directo a local si session no está disponible
    chrome.storage.local.set(data, () => {
      sendResponse({ ok: true, area: "local", value });
    });
  }
}

/**
 * Mensajería desde content.js:
 *  - type: "maf:set_challenge"
 *  - value: string | null (p.ej. "backoffice_proof_of_life_mismatch")
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  try {
    if (msg && msg.type === "maf:set_challenge") {
      const v = msg.value ? String(msg.value).toLowerCase() : null;
      saveChallenge(v, sendResponse);
      return true; // mantené el canal abierto para el callback async
    }
  } catch (e) {
    console.error("[BG] onMessage error:", e);
    // Aún así respondemos algo para no dejar colgado el remitente
    try { sendResponse({ ok: false, error: String(e) }); } catch (_) {}
  }
});
