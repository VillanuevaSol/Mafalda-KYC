// popup.js — MV3. UI v1 + normalización de Apps Script + carga de snippets
(() => {
  const $ = (sel) => document.querySelector(sel);

  // Refs
  const cduEl   = $("#cduTag");
  let   siteEl  = $("#siteTag");
  const urlInp  = $("#remoteUrl");
  const btnLoad = $("#loadUrl");
  const btnSave = $("#saveUrl");
  const btnEdit = $("#editUrl");
  const btnOpen = $("#openUrl");
  const search  = $("#search");
  const listEl  = $("#snippets");
  const emptyEl = $("#empty");
  const toastEl = $("#toast");

  let SNIPPETS   = {};
  let TITLES     = {};
  let REMOTE_URL = "";

  /* -------------------- helpers UI -------------------- */
  function toast(msg, kind = "ok") {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.remove("ok", "err");
    toastEl.classList.add(kind === "err" ? "err" : "ok");
    toastEl.style.display = "block";
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (toastEl.style.display = "none"), 1700);
  }
  function setCDUBadge(val) {
    if (!cduEl) return;
    cduEl.textContent = val || "—";
    cduEl.title = val ? "CDU detectado en la pestaña actual" : "Sin detección";
  }
  function ensureSiteSection() {
    if (siteEl) return siteEl;
    const cduCard = $("#cardCdu");
    const sec = document.createElement("section");
    sec.className = "card";
    sec.style.marginBottom = "12px";
    sec.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;">
        <div style="font-weight:700;">Site detectado</div>
        <span id="siteTag" class="badge">—</span>
      </div>`;
    (cduCard?.parentNode || document.body).insertBefore(sec, cduCard || null);
    siteEl = $("#siteTag");
    return siteEl;
  }
  function setSiteBadge(val) {
    ensureSiteSection();
    siteEl.textContent = val || "—";
    siteEl.title = val ? "Site detectado en la pestaña actual" : "Sin detección";
  }
  function setUrlReadonly(ro) {
    urlInp.readOnly = !!ro;
    btnEdit.style.display = ro && urlInp.value ? "inline-block" : "none";
  }
  const escapeHtml=(s)=>String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");
  const escapeAttr=(s)=>String(s).replace(/"/g,"&quot;");

  function renderSnippets(filter = "") {
    listEl.innerHTML = "";
    const keys = Object.keys(SNIPPETS);
    const q = filter.trim().toLowerCase();
    const filtered = q
      ? keys.filter((k) => {
          const title = TITLES[k] || "";
          return (
            k.toLowerCase().includes(q) ||
            title.toLowerCase().includes(q) ||
            (typeof SNIPPETS[k] === "string" && SNIPPETS[k].toLowerCase().includes(q))
          );
        })
      : keys;

    if (!filtered.length) { emptyEl.style.display = "block"; return; }
    emptyEl.style.display = "none";

    filtered.sort((a,b)=>a.localeCompare(b)).forEach((k) => {
      const title = TITLES[k] || "";
      const div = document.createElement("div");
      div.className = "item";
      div.innerHTML = `
        <span class="badge">${escapeHtml(k)}</span>
        <div class="text">${escapeHtml(title || (typeof SNIPPETS[k] === "string" ? SNIPPETS[k].slice(0,140) : ""))}</div>
        <button class="ghost" data-k="${escapeAttr(k)}" title="Copiar atajo">Copiar</button>
      `;
      div.querySelector("button").addEventListener("click", async (ev) => {
        ev.preventDefault();
        try { await navigator.clipboard.writeText(k); toast("Atajo copiado ✅"); }
        catch { toast("No se pudo copiar","err"); }
      });
      listEl.appendChild(div);
    });
  }

  /* -------------------------- Storage helpers -------------------------- */
  function getLocal(keys, defaults = {}) {
    return new Promise((resolve) => {
      try { chrome.storage.local.get(keys, (res) => resolve({ ...defaults, ...(res || {}) })); }
      catch { resolve({ ...defaults }); }
    });
  }
  function setLocal(obj){ try{ chrome.storage.local.set(obj,()=>{});}catch{} }
  function getSession(keys, defaults = {}) {
    return new Promise((resolve) => {
      try { chrome.storage.session.get(keys, (res) => resolve({ ...defaults, ...(res || {}) })); }
      catch { resolve({ ...defaults }); }
    });
  }

  /* -------------------------- URL normalizer -------------------------- */
  function normalizeAppsScriptUrl(u){
    if (!u) return u;
    return String(u).replace(
      /https:\/\/script\.google\.com\/a\/macros\/[^/]+\/s\//,
      "https://script.google.com/macros/s/"
    );
  }

  /* -------------------------- Remote fetch (sin/cons cookies) -------------------------- */
  async function fetchJsonFromUrl(url) {
    const normalized = normalizeAppsScriptUrl((url || "").trim());
    if (!normalized) throw new Error("URL vacía");

    // 1) intento sin cookies (WebApps públicos)
    try {
      const r1 = await fetch(normalized, { credentials: "omit", cache: "no-store" });
      const t1 = await r1.text();
      try { return JSON.parse(t1); } catch { /* sigue */ }
    } catch { /* sigue */ }

    // 2) reintento con cookies (WebApps internos /a/macros → ya normalizados)
    const r2 = await fetch(normalized, { credentials: "include", cache: "no-store" });
    const t2 = await r2.text();
    try { return JSON.parse(t2); }
    catch {
      const looksHtml = /<html|<body|<!doctype html/i.test(t2);
      const hint = looksHtml
        ? "La URL requiere login o devuelve HTML. Abrila con 'Abrir' y verificá que muestre JSON."
        : "La respuesta no es JSON válido.";
      throw new Error(hint);
    }
  }

  async function loadFromRemote(url) {
    const data = await fetchJsonFromUrl(url);
    if (!data || typeof data !== "object" || !data.snippets) {
      throw new Error("Estructura inválida: falta 'snippets'");
    }
    const snippets = data.snippets;
    const titles   = data.titles || {};
    setLocal({ remote_url:url, snippets, titles, last_sync: Date.now() });
    SNIPPETS = snippets; TITLES = titles; REMOTE_URL = url;
    renderSnippets(search.value);
    toast("Fuente actualizada ✅");
  }

  /* -------------------------- Init -------------------------- */
  async function init() {
    // Badges SITE/CDU desde storage (session > local)
    try {
      const s1 = await getSession(["maf_challenge","maf_site"]);
      const s2 = await getLocal(["maf_challenge","maf_site"]);
      setCDUBadge(s1.maf_challenge || s2.maf_challenge || null);
      setSiteBadge(s1.maf_site || s2.maf_site || null);
    } catch {}

    // Config/snippets guardados
    const { remote_url="", snippets={}, titles={} } = await getLocal(["remote_url","snippets","titles"]);
    REMOTE_URL = remote_url || ""; SNIPPETS = snippets || {}; TITLES = titles || {};
    urlInp.value = REMOTE_URL; setUrlReadonly(!!REMOTE_URL);
    renderSnippets("");

    // Botones
    btnEdit.addEventListener("click", () => setUrlReadonly(false));

    btnOpen.addEventListener("click", () => {
      const u = normalizeAppsScriptUrl((urlInp.value || REMOTE_URL || "").trim());
      if (!u) return;
      try { chrome.tabs.create({ url: u }); } catch { window.open(u, "_blank"); }
    });

    btnSave.addEventListener("click", () => {
      // ⬇⬇ NORMALIZA Y REFLEJA EN UI ⬇⬇
      let val = (urlInp.value || "").trim();
      val = normalizeAppsScriptUrl(val);
      setLocal({ remote_url: val });
      REMOTE_URL = val;
      urlInp.value = val; // que el usuario vea la versión /macros/s/
      setUrlReadonly(!!val);
      toast("URL guardada ✅");
    });

    btnLoad.addEventListener("click", async () => {
      let val = (urlInp.value || REMOTE_URL || "").trim();
      val = normalizeAppsScriptUrl(val); // aseguro normalización previa al fetch
      if (!val) { toast("Pegá una URL primero","err"); return; }
      btnLoad.disabled = true;
      try { await loadFromRemote(val); } catch(e){ console.error(e); toast(String(e.message||e),"err"); }
      finally { btnLoad.disabled = false; }
    });

    search.addEventListener("input", () => renderSnippets(search.value));

    // Live updates desde storage
    chrome.storage.onChanged.addListener((changes, area) => {
      try{
        if ((area==="session"||area==="local") && changes?.maf_challenge) {
          setCDUBadge(changes.maf_challenge.newValue || null);
        }
        if ((area==="session"||area==="local") && changes?.maf_site) {
          setSiteBadge(changes.maf_site.newValue || null);
        }
        if (area==="local" && (changes?.snippets || changes?.titles)) {
          SNIPPETS = (changes.snippets && changes.snippets.newValue) || SNIPPETS;
          TITLES   = (changes.titles   && changes.titles.newValue)   || TITLES;
          renderSnippets(search.value);
        }
        if (area==="local" && changes?.remote_url) {
          REMOTE_URL = changes.remote_url.newValue || "";
          urlInp.value = REMOTE_URL; setUrlReadonly(!!REMOTE_URL);
        }
      }catch{}
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();

