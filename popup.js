// popup.js — muestra títulos sin romper el flujo actual

const els = {
  url:   document.getElementById("remoteUrl"),
  load:  document.getElementById("loadUrl"),
  save:  document.getElementById("saveUrl"),
  edit:  document.getElementById("editUrl"),
  open:  document.getElementById("openUrl"),
  list:  document.getElementById("snippets"),
  empty: document.getElementById("empty"),
  search:document.getElementById("search"),
  toast: document.getElementById("toast"),
};

let allSnippets = {};
let allTitles   = {};   // NUEVO

function showToast(msg, type="ok"){
  if (!els.toast){ console.log(msg); return; }
  els.toast.textContent = msg;
  els.toast.className = "toast " + (type || "ok");
  els.toast.style.display = "block";
  setTimeout(()=> els.toast && (els.toast.style.display="none"), 2200);
}

async function copyText(text){
  try { await navigator.clipboard.writeText(text); showToast("Copiado","ok"); }
  catch { showToast("No se pudo copiar","err"); }
}

/* ---------- helpers para títulos ---------- */
function cleanForTitle(s){
  return String(s || "").replace(/\{\{[^}]+\}\}/g,"").replace(/\s+/g," ").trim();
}
function inferTitleFromSnippet(body){
  const clean = cleanForTitle(body);
  const firstLine = (clean.split(/\n/)[0] || clean);
  const firstSentence = firstLine.split(/(?<=\.)\s/)[0] || firstLine;
  const t = firstSentence || "(sin título)";
  return t.length > 120 ? (t.slice(0,117)+"…") : t;
}

/* ---------- helper: comparación profunda (ignora orden de claves) ---------- */
function deepEqualMap(a = {}, b = {}){
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++){
    const k = ka[i];
    if (k !== kb[i]) return false;
    const va = a[k];
    const vb = b[k];
    const ta = typeof va, tb = typeof vb;
    if (ta !== tb) return false;
    if (va && tb === "object"){
      if (JSON.stringify(va) !== JSON.stringify(vb)) return false;
    } else {
      if (String(va) !== String(vb)) return false;
    }
  }
  return true;
}

/* ---------- render ---------- */
function render(snips){
  const keys = Object.keys(snips);
  els.list.innerHTML = "";
  els.empty.style.display = keys.length ? "none" : "block";
  keys.forEach((shortcut)=>{
    const item = document.createElement("div");
    item.className = "item";

    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = shortcut;

    const text = document.createElement("div");
    text.className = "text";
    const title = allTitles[shortcut] || inferTitleFromSnippet(snips[shortcut]);
    text.textContent = title;
    text.title = typeof snips[shortcut] === "string"
      ? snips[shortcut]
      : JSON.stringify(snips[shortcut], null, 2); // si fuera objeto (mail), tooltip legible

    const actions = document.createElement("div");
    const btnCopy = document.createElement("button");
    btnCopy.className = "ghost";
    btnCopy.textContent = "Copiar";
    btnCopy.addEventListener("click", ()=> copyText(
      typeof snips[shortcut] === "string" ? snips[shortcut] : (snips[shortcut].body || "")
    ));
    actions.appendChild(btnCopy);

    item.appendChild(badge); item.appendChild(text); item.appendChild(actions);
    els.list.appendChild(item);
  });
}

/* ---------- búsqueda ---------- */
function applySearch(){
  const q = (els.search.value || "").toLowerCase();
  const out = {};
  for (const [k,v] of Object.entries(allSnippets)){
    const raw = (typeof v === "string") ? v : (JSON.stringify(v) || "");
    const t = (allTitles[k] || inferTitleFromSnippet(raw) || "").toLowerCase();
    if (k.toLowerCase().includes(q) || raw.toLowerCase().includes(q) || t.includes(q)){
      out[k]=v;
    }
  }
  render(out);
}

/* ---------- carga remota (silenciosa por defecto + toast solo si cambió) ---------- */
async function loadFromUrl(opts = {}){
  // opts: { silent?: boolean, onlyOnChange?: boolean }
  const { silent = false, onlyOnChange = true } = opts;

  const url = els.url.value.trim();
  if (!url){ if(!silent) showToast("Pegá una URL válida","err"); return; }
  try{
    const res = await fetch(url, { cache:"no-store" });
    const data = await res.json();

    // Retrocompatibilidad: puede venir {snippets, titles} o un objeto plano (solo snippets)
    const snips  = (data && typeof data === "object" && data.snippets) ? data.snippets : data;
    const titles = (data && typeof data === "object" && data.titles)   ? data.titles   : {};

    if (!snips || typeof snips !== "object") throw new Error("Formato inválido");

    // comparar con lo que ya está en memoria para decidir si mostrar toast
    const prevSnips  = allSnippets || {};
    const prevTitles = allTitles   || {};
    const changed = !deepEqualMap(prevSnips, snips) || !deepEqualMap(prevTitles, titles);

    chrome.storage.local.set({ snippets: snips, titles: titles }, ()=> {
      allSnippets = snips; allTitles = titles || {};
      render(allSnippets);

      if (!silent && (!onlyOnChange || changed)) {
        showToast("Fragmentos actualizados","ok");
      }
    });
  }catch(e){
    console.error(e);
    if (!silent) showToast("Error al cargar","err");
  }
}

/* ---------- guardar / editar URL ---------- */
function saveUrl(){
  const url = els.url.value.trim();
  if (!url){ showToast("No hay URL","err"); return; }
  chrome.storage.local.set({ remoteUrl:url }, ()=>{
    els.url.setAttribute("readonly",true);
    els.save.style.display="none";
    els.edit.style.display="inline-block";
    showToast("URL guardada","ok");
  });
}
function enableEdit(){
  els.url.removeAttribute("readonly");
  els.save.style.display="inline-block";
  els.edit.style.display="none";
}

/* ---------- init ---------- */
(function init(){
  chrome.storage.local.get({ remoteUrl:"", snippets:{}, titles:{} }, (res)=>{
    els.url.value = res.remoteUrl || "";
    if (res.remoteUrl){
      els.url.setAttribute("readonly",true);
      els.save.style.display="none";
      els.edit.style.display="inline-block";
    }
    allSnippets = res.snippets || {};
    allTitles   = res.titles   || {};
    render(allSnippets);

    // refrescar automáticamente si hay URL (SILENCIOSO + toast solo si cambió)
    if (els.url.value.trim()){
      setTimeout(() => loadFromUrl({ silent: true, onlyOnChange: true }), 150);
    }
  });

  // listeners (con ids que ya existen en tu HTML)
  els.load.addEventListener("click",  () => loadFromUrl({ silent: false, onlyOnChange: true }));
  els.save.addEventListener("click",  saveUrl);
  els.edit.addEventListener("click",  enableEdit);
  els.open.addEventListener("click",  ()=> { if(els.url.value) chrome.tabs.create({ url: els.url.value }); });
  els.search.addEventListener("input", applySearch);
})();
