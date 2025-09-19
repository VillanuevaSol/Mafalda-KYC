// Mantiene la extensión activa y lista + persiste CDU/SITE
chrome.runtime.onInstalled.addListener(() => {
  console.log("Completa textos instalada y lista.");
});

// Guarda la clave pedida en storage.session, con fallback a storage.local
function saveKey(key, value, sendResponse) {
  const data = { [key]: value ?? null };

  if (chrome.storage.session && chrome.storage.session.set) {
    chrome.storage.session.set(data, () => {
      if (chrome.runtime.lastError) {
        console.warn(`[BG] session.set falló (${key}):`, chrome.runtime.lastError.message);
        chrome.storage.local.set(data, () => sendResponse?.({ ok: true, area: "local", key, value }));
      } else {
        sendResponse?.({ ok: true, area: "session", key, value });
      }
    });
  } else {
    chrome.storage.local.set(data, () => {
      sendResponse?.({ ok: true, area: "local", key, value });
    });
  }
}

// Recibe desde content.js valores detectados y los persiste
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  try {
    if (!msg || !msg.type) return;

    if (msg.type === "maf:set_challenge") {
      const v = msg.value ? String(msg.value).toLowerCase() : null;
      saveKey("maf_challenge", v, sendResponse);
      return true; // async
    }

    if (msg.type === "maf:set_site") {
      const v = msg.value ? String(msg.value).toUpperCase() : null;
      saveKey("maf_site", v, sendResponse);
      return true; // async
    }
  } catch (e) {
    console.error("[BG] onMessage error:", e);
    try { sendResponse({ ok: false, error: String(e) }); } catch(_) {}
  }
});
