/** content.js — FOSXpress v3.7.5 (FULL: Storage Fix + Focus Fix + Site/Challenge)
 * - Incluye parche para evitar bloqueo de storage.
 * - Incluye 'refindContext' para no perder el lugar de inserción tras el modal.
 * - Incluye lógica completa de Site, Challenge y Panel Mafalda.
 */

console.log("[FOSXpress] content script v3.7.5 FULL loaded");

/* ================ Silenciar errores de contexto invalidado ================= */
function isContextInvalidatedMsg(msg){
  return /Extension context invalidated/i.test(String(msg || ""));
}
addEventListener("unhandledrejection", (e) => {
  if (isContextInvalidatedMsg(e?.reason?.message || e?.reason)) {
    e.preventDefault();
  }
});
addEventListener("error", (e) => {
  if (isContextInvalidatedMsg(e?.message)) {
    e.preventDefault();
  }
});

/* ========================== Helpers de contexto ========================== */
function extAlive(){
  try { return !!(chrome && chrome.runtime && chrome.runtime.id); }
  catch { return false; }
}

/* ========================== Cache de snippets ========================== */
let snippetsCache = {};
let snipIndex = new Map();
let snipKeysOriginal = [];

function rebuildSnipIndex(){
  snipIndex.clear();
  snipKeysOriginal = [];
  try {
    for (const k in snippetsCache) {
      if (!Object.prototype.hasOwnProperty.call(snippetsCache, k)) continue;
      const key = String(k).trim();
      if (!key.startsWith("/")) continue;
      snipIndex.set(key.toLowerCase(), snippetsCache[k]);
      snipKeysOriginal.push(key);
    }
    snipKeysOriginal.sort((a,b)=> a.localeCompare(b));
  } catch(_){}
}

try {
  chrome.storage?.local?.get({ snippets: {} }, (r) => {
    if (chrome.runtime?.lastError) return;
    snippetsCache = r?.snippets || {};
    rebuildSnipIndex();
  });
  chrome.storage?.onChanged?.addListener((c, area) => {
    if (area === "local" && c?.snippets) {
      snippetsCache = c.snippets.newValue || {};
      rebuildSnipIndex();
    }
  });
} catch (_) { snippetsCache = {}; rebuildSnipIndex(); }

/* ========================== Utilidades ========================== */
function expandStaticMacros(t) {
  const now = new Date();
  const fmtDate = (d) => d.toISOString().slice(0,10);
  let out = String(t).replace(/\{\{date(?:([+-]\d+))?\}\}/g, (_, off) => {
    if (!off) return fmtDate(now);
    const n = parseInt(off, 10) || 0;
    const d = new Date(now);
    d.setDate(d.getDate() + n);
    return fmtDate(d);
  });
  out = out.replace(/\{\{time\}\}/g, now.toTimeString().slice(0,5));
  return out;
}

const RE_SHORTCUT_NEAR_CARET = /(?<![:/])\/[a-zA-Z0-9_-]+(?=\s|$)/g;

function parsePlaceholders(tpl){
  const tokens=[]; const re=/\{\{(select:([^}|]+)\|([^}]+)|input:([^}|]+)(?:\|[^}]*)?)\}\}/g; let m;
  while((m=re.exec(tpl))){
    if(m[4]) tokens.push({ type:"input", label:m[4].trim(), def:(m[5]??"").trim(), raw:m[0] });
    else tokens.push({ type:"select", label:m[2].trim(), options:m[3].split("|").map(s=>s.trim()).filter(Boolean), raw:m[0] });
  }
  return tokens;
}
function hasPlaceholders(tpl){ return /\{\{(select:|input:)/.test(tpl); }
function isMailSnippet(value){
  return value && typeof value === "object" && (value.subject || value.body);
}
function escapeHTML(s){
  return String(s)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");
}
function renderFilled(tpl, valueMap, {highlight=false} = {}){
  const src = expandStaticMacros(tpl);
  const re = /\{\{(select:([^}|]+)\|[^}]+|input:([^}|]+)(?:\|[^}]*)?)\}\}/g;
  let plain = "", html = "";
  let lastIndex = 0, m;
  while ((m = re.exec(src))) {
    const before = src.slice(lastIndex, m.index);
    plain += before;
    html  += escapeHTML(before);
    const label = (m[2] || m[3] || "").trim();
    const val = valueMap[label] ?? "";
    plain += val;
    html  += highlight ? `<span class="hl" data-label="${escapeHTML(label)}">${escapeHTML(val)}</span>` : escapeHTML(val);
    lastIndex = re.lastIndex;
  }
  const tail = src.slice(lastIndex);
  plain += tail;
  html  += escapeHTML(tail);
  plain = plain.replace(/\s+([,.;:!?])/g, "$1");
  html  = html.replace(/\s+([,.;:!?])(?![^<]*>)/g, "$1");
  return { plain, html };
}
function emitInputLike(el){
  try {
    if (typeof InputEvent !== "undefined") {
      const bi = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: "" });
      el.dispatchEvent(bi);
    }
  } catch(_){}
  try {
    if (typeof InputEvent !== "undefined") {
      const ie = new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: "" });
      el.dispatchEvent(ie);
    } else {
      const ev = new Event("input", { bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
    }
  } catch(_) {
    try {
      const ev = new Event("input", { bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
    } catch(__) {}
  }
  try {
    const ce = new Event("change", { bubbles: true, cancelable: true });
    el.dispatchEvent(ce);
  } catch(_){}
}
function getEditableRootFromNode(node){
  let el = (node && node.nodeType === Node.ELEMENT_NODE) ? node : node?.parentElement;
  while (el && !el.isContentEditable) el = el.parentElement;
  return el || document.activeElement || document.body;
}

// --- LOGICA DE BÚSQUEDA ---
function findShortcutInInput(el){
  const start=el.selectionStart, end=el.selectionEnd, text=el.value;
  const left=text.slice(0,start).replace(/\s+$/,"");
  let last=null,m; while((m=RE_SHORTCUT_NEAR_CARET.exec(left))!==null) last=m; RE_SHORTCUT_NEAR_CARET.lastIndex=0;
  if(!last) return null;
  return { kind:"input", el, original:text, right:text.slice(end), from:last.index, to:last.index+last[0].length, shortcut:last[0] };
}

/** NUEVO: Búsqueda de respaldo si se perdió el foco (Smart Refind) */
function findShortcutInInputFallback(el, shortcutText) {
  if (el.value === undefined) return null;
  const val = String(el.value);
  // Buscamos la última ocurrencia del atajo (asumiendo que es el que acabas de escribir)
  const idx = val.lastIndexOf(shortcutText); 
  if (idx === -1) return null;
  
  return {
    kind: "input",
    el: el,
    original: val,
    from: idx,
    to: idx + shortcutText.length,
    right: val.slice(idx + shortcutText.length),
    shortcut: shortcutText
  };
}

/** Helper robusto para encontrar el contexto (usa fallback si es necesario) */
function refindContext(el, expectedShortcut) {
    if (el.value !== undefined) {
        // Intento 1: Donde está el cursor actualmente
        let c = findShortcutInInput(el);
        if (c && c.shortcut === expectedShortcut) return c;
        // Intento 2: Buscar el texto explicitamente (Fallback)
        return findShortcutInInputFallback(el, expectedShortcut);
    } else {
        // En contenteditable es más complejo, usamos el estándar
        return findShortcutInEditable();
    }
}

function insertAtInput(ctx, finalText){
  const before=ctx.original.slice(0,ctx.from), after=ctx.original.slice(ctx.to)+ctx.right;
  ctx.el.value = before + finalText + after;
  const caret=(before+finalText).length; 
  try { ctx.el.setSelectionRange(caret,caret); ctx.el.focus(); } catch(_){}
  emitInputLike(ctx.el);
}

function findShortcutInEditable(){
  const sel=window.getSelection(); if(!sel||!sel.rangeCount) return null;
  const caret=sel.getRangeAt(0), probe=caret.cloneRange(); probe.collapse(true); probe.setStart(probe.startContainer,0);
  const left=probe.toString().replace(/\s+$/,"");
  let last=null,m; while((m=RE_SHORTCUT_NEAR_CARET.exec(left))!==null) last=m; RE_SHORTCUT_NEAR_CARET.lastIndex=0;
  if(!last) return null;
  const shortcut=last[0], del=caret.cloneRange(); let node=caret.startContainer, off=caret.startOffset, remain=shortcut.length;
  function prevTextNodeIter(n){
    function prev(x){
      if(!x) return null;
      if(x.previousSibling){
        x = x.previousSibling;
        while(x && x.lastChild) x = x.lastChild;
        return x;
      }
      return prev(x.parentNode);
    }
    let p = prev(n);
    while(p && p.nodeType!==Node.TEXT_NODE) p = prev(p);
    return p;
  }
  while(remain>0 && node){
    if(node.nodeType===Node.TEXT_NODE){
      const take=Math.min(off,remain);
      del.setStart(node,off-take);
      remain-=take; if(remain===0) break;
    }
    const prev=prevTextNodeIter(node); if(!prev) break; node=prev; off=node.textContent.length;
  }
  return { kind:"editable", sel, del, shortcut };
}

function insertAtEditable(ctx, finalText){
  try {
    ctx.del.deleteContents();
    const tn=document.createTextNode(finalText);
    ctx.del.insertNode(tn);
    ctx.sel.removeAllRanges();
    const r=document.createRange();
    r.setStart(tn,finalText.length); r.setEnd(tn,finalText.length);
    ctx.sel.addRange(r);
    const root = getEditableRootFromNode(tn);
    emitInputLike(root);
  } catch(e) { console.warn("Error insertando editable", e); }
}

function replaceBeforeCaret(ctx, finalText){
  try{
    if (ctx && ctx.kind === "input" && ctx.el) {
      const el = ctx.el;
      const caret = Number(el.selectionStart || 0);
      const after = String(el.value || "").slice(caret);
      el.value = String(finalText) + after;
      const pos = String(finalText).length;
      try { el.setSelectionRange(pos, pos); } catch(_){}
      emitInputLike(el);
      return;
    }
  }catch(_){}
  try{
    if (!ctx || ctx.kind !== "editable" || !ctx.del) return;
    const root = getEditableRootFromNode(ctx.del.startContainer) || document.activeElement || document.body;
    if (!root.contains(ctx.del.startContainer)) return;
    const marker = document.createElement("span");
    marker.setAttribute("data-maf-anchor","1");
    marker.style.cssText = "display:inline-block;width:0;height:0;overflow:hidden;";
    try { ctx.del.insertNode(marker); } catch(_){ return; }
    const wipe = document.createRange();
    wipe.setStart(root, 0);
    try { wipe.setEndBefore(marker); } catch(_){ wipe.setEnd(root, 0); }
    wipe.deleteContents();
    const tn = document.createTextNode(String(finalText));
    marker.replaceWith(tn);
    const sel = window.getSelection();
    if (sel) {
      const r = document.createRange();
      r.setStart(tn, tn.length); r.setEnd(tn, tn.length);
      sel.removeAllRanges(); sel.addRange(r);
    }
    emitInputLike(root);
  }catch(_){}
}

/* ================== DIALOG & UI ================== */
const ML={yellow:"#FFE600",blue:"#3483FA",border:"#E6E6E6",dark:"#333"};
let shadowHost=null, dialogOpen=false;

function ensureDialog(){
  if(shadowHost) return shadowHost;
  shadowHost=document.createElement("div");
  shadowHost.style.position="fixed"; shadowHost.style.inset="0"; shadowHost.style.zIndex="2147483647";
  const shadow=shadowHost.attachShadow({mode:"open"}); document.documentElement.appendChild(shadowHost);
  shadow.innerHTML=`
    <style>
      :host { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; }
      dialog{ border:none; border-radius:16px; padding:16px; width:min(780px,94vw); }
      dialog::backdrop{ background:rgba(0,0,0,.25); }
      .hdr{ display:flex; align-items:center; gap:10px; margin-bottom:10px }
      .pill{ width:12px; height:28px; border-radius:8px; background:${ML.yellow}; box-shadow:0 0 0 3px rgba(255,230,0,.35) }
      h3{ margin:0; font-size:16px; font-weight:800; color:${ML.dark} }
      .wrap{ display:grid; grid-template-columns:280px 1fr; gap:14px }
      .left{ border:1px solid ${ML.border}; border-radius:12px; padding:10px; max-height:70vh; overflow:auto; background:#fff }
      .field{ display:flex; flex-direction:column; gap:6px; margin-bottom:10px }
      label{ font-size:12px; color:#555 }
      input, select{ padding:10px 12px; border:1px solid ${ML.border}; border-radius:10px; font-size:14px; outline:none; background:#fff }
      input:focus, select:focus{ border-color:${ML.blue}; box-shadow:0 0 0 3px rgba(52,131,250,.12) }
      .prevCard{ border:1px solid ${ML.border}; border-radius:12px; padding:10px; background:#fff; display:flex; flex-direction:column; gap:8px }
      .prev{ white-space:pre-wrap; overflow:auto; min-height:180px; max-height:44vh }
      .prev .hl{ background: #FFF59D; border-radius:4px; padding:0 2px; }
      .actions{ display:flex; justify-content:space-between; align-items:center; gap:8px; margin-top:12px }
      .btnRow{ display:flex; gap:8px }
      .btn{ border-radius:10px; padding:9px 14px; font-weight:800; cursor:pointer; font-size:13px }
      .btn:focus-visible{ outline:2px solid ${ML.blue}; outline-offset:2px }
      .ok{ background:${ML.blue}; color:#fff; border:none }
      .cancel{ background:#fff; color:${ML.blue}; border:1px solid ${ML.blue} }
      .ghost{ background:#fff; color:#333; border:1px solid ${ML.border} }
      .hint{ font-size:12px; color:#666 }
      @media (max-width:640px){ .wrap{ grid-template-columns:1fr } }
      .toast{ position:fixed; bottom:18px; right:18px; background:#1f2937; color:#fff; padding:10px 14px; border-radius:10px; font-size:13px; opacity:.98 }
    </style>
    <dialog role="dialog" aria-modal="true" aria-label="Completar plantilla">
      <div class="hdr"><div class="pill"></div><h3>Completar plantilla</h3></div>
      <div class="wrap">
        <div class="left" id="fields"></div>
        <div class="prevCard">
          <div class="prev" id="prev" contenteditable="true"></div>
          <div class="actions">
            <span class="hint">Podés editar la vista previa antes de insertar.</span>
            <div class="btnRow">
              <button class="btn ghost" id="copy">Copiar</button>
              <button class="btn cancel" id="cancel">Cancelar</button>
              <button class="btn ok" id="ok">Insertar</button>
            </div>
          </div>
        </div>
      </div>
    </dialog>
    <div id="toast" class="toast" style="display:none"></div>
  `;
  return shadowHost;
}
function showToast(msg){
  const t = shadowHost.shadowRoot.querySelector("#toast");
  t.textContent = msg; t.style.display="block";
  clearTimeout(showToast._t); showToast._t = setTimeout(()=>{ t.style.display="none"; }, 1600);
}

function storageGetLocal(key, def=null){
  return new Promise(resolve=>{
    try{
      chrome.storage?.local?.get({[key]: def}, obj => {
        if (chrome.runtime?.lastError) { resolve(def); return; }
        resolve(obj?.[key] ?? def);
      });
    }catch(_){ resolve(def); }
  });
}

/** FIX: storageSetLocal con try-catch y silenciador de errores */
function storageSetLocal(obj){
  try{
    if(chrome.storage && chrome.storage.local) {
      chrome.storage.local.set(obj, ()=>{
        const _ign = chrome.runtime.lastError; // Leemos el error para silenciarlo
      });
    }
  }catch(_){}
}

async function getLastValues(shortcut){
  return storageGetLocal(`fx:last:${shortcut}`, null);
}
function setLastValues(shortcut, values){
  storageSetLocal({[`fx:last:${shortcut}`]: values});
}

async function openDialog(tpl, shortcut){
  ensureDialog();
  const sh = shadowHost.shadowRoot;
  const dlg = sh.querySelector("dialog");
  const fields = sh.querySelector("#fields");
  const prev = sh.querySelector("#prev");
  const ok = sh.querySelector("#ok");
  const cancel = sh.querySelector("#cancel");
  const copyBtn = sh.querySelector("#copy");
  
  const tokens = parsePlaceholders(tpl);
  const last = await getLastValues(shortcut);
  const seen = new Map();
  const state = [];
  
  for (const t of tokens) {
    const key = `${t.type}::${t.label}`;
    if (seen.has(key)) continue;
    const value = (last && last[t.label] !== undefined)
      ? last[t.label]
      : (t.type==="select" ? (t.options?.[0] || "") : (t.def || ""));
    state.push({ type: t.type, label: t.label, options: t.options, raw: t.raw, value });
    seen.set(key, true);
  }
  
  function renderPrev(){
    const valueMap = {};
    for (const s of state) valueMap[s.label] = s.value ?? "";
    const { plain, html } = renderFilled(tpl, valueMap, {highlight:true});
    if (!prev.hasAttribute("data-manual")) {
      prev.innerHTML = html;
      prev.dataset.plain = plain;
    }
  }
  
  fields.innerHTML="";
  state.forEach(s=>{
    const w=document.createElement("div"); w.className="field";
    const lab=document.createElement("label"); lab.textContent=s.label; w.appendChild(lab);
    if(s.type==="select"){
      const sel=document.createElement("select");
      (s.options||[]).forEach(o=>{ const op=document.createElement("option"); op.value=o; op.textContent=o; sel.appendChild(op); });
      sel.value=s.value;
      const onSel = ()=>{ s.value=sel.value; prev.removeAttribute("data-manual"); renderPrev(); };
      sel.addEventListener("input", onSel);
      sel.addEventListener("change", onSel);
      w.appendChild(sel);
    }else{
      const inp=document.createElement("input"); inp.type="text"; inp.placeholder=s.label; inp.value=s.value||"";
      inp.addEventListener("input",()=>{ s.value=inp.value; prev.removeAttribute("data-manual"); renderPrev(); });
      w.appendChild(inp);
    }
    fields.appendChild(w);
  });
  
  prev.textContent=""; prev.removeAttribute("data-manual");
  prev.addEventListener("input",()=>prev.setAttribute("data-manual","1"));
  renderPrev();
  
  let resolvePromise;
  let internalClose = false;
  const ac = new AbortController();
  const { signal } = ac;
  const done = (val)=>{
    try { internalClose = true; dlg.close(); } catch(_){}
    if (shadowHost?.isConnected) shadowHost.style.display="none";
    dialogOpen=false;
    ac.abort();
    resolvePromise?.(val);
  };
  
  copyBtn.onclick = async ()=>{
    const plain = prev.dataset.plain || prev.textContent || "";
    try { await navigator.clipboard.writeText(plain); showToast("Copiado ✅"); done(null); }
    catch(_){ 
       try{ 
         const ta=document.createElement("textarea"); ta.value=plain; ta.style.position="fixed"; ta.style.opacity="0"; 
         document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); 
         showToast("Copiado ✅"); done(null);
       } catch(__){ showToast("No se pudo copiar"); } 
    }
  };
  
  ok.onclick = ()=> {
    const map = {}; state.forEach(s=> map[s.label]=s.value);
    try { setLastValues(shortcut, map); } catch(e){} // No falla si storage está bloqueado
    const plain = prev.dataset.plain || prev.textContent || "";
    done(plain);
  };
  
  cancel.onclick = ()=> done(null);
  shadowHost.style.display="block"; dialogOpen=true;
  dlg.showModal();
  
  const focusables = sh.querySelectorAll("button, [href], input, select, [contenteditable='true']");
  (focusables[0] || ok).focus();
  
  return new Promise(res => (resolvePromise = res));
}

let taHost = null; let taOpen = false; let taSelIdx = -1; let taItems = []; let taTarget = null; let taCtxLast = null;
function ensureTypeahead(){
  if (taHost) return taHost;
  taHost = document.createElement("div"); taHost.style.position = "fixed"; taHost.style.zIndex = "2147483646";
  const sh = taHost.attachShadow({mode:"open"});
  sh.innerHTML = `<style>.box{min-width: 220px; max-width: 360px;background: #fff;border: 1px solid #E6E6E6; border-radius: 10px;box-shadow: 0 8px 24px rgba(0,0,0,.08);font: 13px/1.35 system-ui, sans-serif;overflow: hidden;}.item{ padding: 8px 10px; cursor: pointer; display:flex; gap:8px; align-items:center; }.item:hover, .item.active{ background: #F2F6FF; }.kbd{ font-size:11px; color:#999; }.empty{ padding:8px 10px; color:#777; }</style><div class="box" id="box" hidden></div>`;
  document.documentElement.appendChild(taHost); return taHost;
}
function hideTypeahead(){ if (!taHost) return; taHost.shadowRoot.getElementById("box").hidden = true; taOpen = false; taSelIdx = -1; taItems = []; taTarget = null; }
function renderTypeahead(items, anchorRect){
  ensureTypeahead(); const sh = taHost.shadowRoot; const box = sh.getElementById("box");
  const top = Math.round((anchorRect.bottom || (anchorRect.top + 20)) + 6 + scrollY);
  const left = Math.round((anchorRect.left || 16) + scrollX);
  taHost.style.top = `${top}px`; taHost.style.left = `${left}px`; box.innerHTML = "";
  if (!items.length) { box.innerHTML = `<div class="empty">Sin resultados</div>`; } 
  else {
    items.forEach((k, i) => {
      const div = document.createElement("div"); div.className = "item" + (i === taSelIdx ? " active" : "");
      div.innerHTML = `<span class="kbd">${i<9 ? (i+1)+'.' : '&bull;'}</span> <span>${k}</span>`;
      const handler = (ev) => { ev.preventDefault(); ev.stopPropagation(); selectTypeahead(i); };
      div.addEventListener("pointerdown", handler); div.addEventListener("mousedown", handler); div.addEventListener("click", handler);
      box.appendChild(div);
    });
  }
  box.hidden = false; taOpen = true;
}
function filterSnippets(prefix){
  const q = String(prefix).toLowerCase();
  const starts = snipKeysOriginal.filter(k => k.toLowerCase().startsWith(q));
  const contains = snipKeysOriginal.filter(k => !k.toLowerCase().startsWith(q) && k.toLowerCase().includes(q));
  return [...starts, ...contains].slice(0,7);
}
function currentAnchorRect(target){
  try { if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return target.getBoundingClientRect();
    const sel = window.getSelection(); if (sel && sel.rangeCount) { const r = sel.getRangeAt(0).cloneRange(); const rect = r.getClientRects()[0] || r.getBoundingClientRect(); if (rect && rect.width) return rect; }
  } catch(_) {} return (target?.getBoundingClientRect?.()) || { top: 20, bottom: 40, left: 20 };
}
function selectTypeahead(idx){
  if (!taOpen || idx<0 || idx>=taItems.length) return;
  const chosen = taItems[idx]; const t = taTarget;
  if (!t) { hideTypeahead(); return; }
  const ctx = taCtxLast || ((t.value!==undefined) ? findShortcutInInput(t) : findShortcutInEditable());
  if (!ctx) { hideTypeahead(); return; }
  const finalText = chosen;
  if (ctx.kind === "input") {
    const before=ctx.original.slice(0,ctx.from), after=ctx.original.slice(ctx.to)+ctx.right;
    t.value = before + finalText + after;
    const caret=(before+finalText).length; t.setSelectionRange(caret,caret);
  } else {
    ctx.del.deleteContents(); const tn=document.createTextNode(finalText); ctx.del.insertNode(tn);
    ctx.sel.removeAllRanges(); const r=document.createRange(); r.setStart(tn,finalText.length); r.setEnd(tn,finalText.length); ctx.sel.addRange(r);
  }
  try { const ev = new Event("input", { bubbles:true, cancelable:true }); t.dispatchEvent(ev); } catch(_){}
  taCtxLast = null; hideTypeahead();
}
function handleTypeaheadKey(e){
  if (!taOpen) return false;
  if (e.key === "ArrowDown") { taSelIdx = Math.min(taSelIdx+1, taItems.length-1); }
  else if (e.key === "ArrowUp") { taSelIdx = Math.max(taSelIdx-1, 0); }
  else if (e.key === "Enter" || e.key === "Tab") { selectTypeahead(taSelIdx>=0?taSelIdx:0); return true; }
  else if (e.key >= "1" && e <= "9") { const i = parseInt(e.key,10)-1; if (i < taItems.length) { selectTypeahead(i); return true; } }
  else if (e.key === "Escape") { hideTypeahead(); return true; }
  renderTypeahead(taItems, currentAnchorRect(taTarget));
  return ["ArrowDown","ArrowUp","Enter","Tab","Escape"].includes(e.key) || (/^[1-9]$/.test(e.key));
}
function isEditableTarget(t){
  if(!t) return false; if (t.tagName === "TEXTAREA") return true;
  if (t.tagName === "INPUT") { const ok = new Set(["text","search","url","email","tel","password"]); return ok.has(t.type || "text"); }
  return t.isContentEditable;
}
function shouldTrigger(e){
  if (e.isComposing) return false; if (e.type === "keydown" && e.repeat) return false;
  if (e.type==="keydown" && e.ctrlKey && e.key===" ") return true;
  return e.key===" " || e.key==="Enter" || e.key==="Tab" || e.type==="input";
}
/**
 * Detecta si estamos en una ventana de respuesta/reenvío en Gmail
 * Gmail usa "Re:", "Fwd:", "RV:", "RE:", etc. como prefijos de asunto en respuestas
 */
function isGmailReplyContext(subjectEl) {
  if (!subjectEl) return false;
  const currentSubject = ('value' in subjectEl) ? subjectEl.value : (subjectEl.textContent || '');
  // Detectar prefijos típicos de respuesta/reenvío en múltiples idiomas
  const replyPrefixes = /^(Re|Fwd|Fw|RV|RE|FW|Rép|AW|SV|VS|Antw|Odp|R|I):\s*/i;
  return replyPrefixes.test(currentSubject.trim());
}

/**
 * Detecta si el campo de asunto está visible/editable en la UI de Gmail
 * En respuestas inline, el campo de asunto suele estar oculto o colapsado
 */
function isSubjectFieldVisible(subjectEl) {
  if (!subjectEl) return false;
  const style = window.getComputedStyle(subjectEl);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  // Verificar si el elemento tiene dimensiones visibles
  const rect = subjectEl.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * Verifica si un elemento es visible y está en el viewport
 */
function isElementVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * Detecta si estamos en contexto de composición inline (respuesta) vs ventana nueva
 * Gmail usa clases específicas para la ventana de respuesta inline
 */
function isGmailInlineReply() {
  // Buscar indicadores de respuesta inline en Gmail
  const replyContainer = document.querySelector('.ip.iq') || 
                         document.querySelector('[data-message-id]') || 
                         document.querySelector('.adn.ads');
  
  // También verificar si hay un hilo visible (múltiples mensajes)
  const threadMessages = document.querySelectorAll('[data-message-id], .gs');
  const hasThread = threadMessages.length > 1;
  
  return !!(replyContainer || hasThread);
}

/**
 * Encuentra el editor de respuesta ACTIVO dentro de un hilo de Gmail.
 * CRÍTICO: Gmail puede tener múltiples editores (compose new, reply inline, etc.)
 * Debemos encontrar el que está ACTIVO y VISIBLE en el contexto del hilo.
 */
function findActiveGmailReplyEditor() {
  const d = document;
  
  // Selectores específicos para el editor de respuesta en Gmail (varios idiomas)
  const gmailBodySelectors = [
    // Editor de respuesta inline en hilo - selector más específico
    'div[role="textbox"][aria-label*="Mensaje"][contenteditable="true"]',
    'div[role="textbox"][aria-label*="Message"][contenteditable="true"]',
    'div[role="textbox"][aria-label="Cuerpo del mensaje"][contenteditable="true"]',
    'div[role="textbox"][aria-label="Message Body"][contenteditable="true"]',
    // Editores con g_editable (Gmail específico)
    'div[role="textbox"][g_editable="true"][contenteditable="true"]',
    // Fallback más genérico
    'div[aria-label*="essage"][contenteditable="true"]',
    'div[aria-label*="ensaje"][contenteditable="true"]',
  ];
  
  // Buscar TODOS los editores que coincidan
  let allEditors = [];
  for (const selector of gmailBodySelectors) {
    const found = d.querySelectorAll(selector);
    found.forEach(el => {
      if (!allEditors.includes(el)) allEditors.push(el);
    });
  }
  
  console.log(`[Mafalda] Encontrados ${allEditors.length} editores de Gmail`);
  
  if (allEditors.length === 0) return null;
  if (allEditors.length === 1) return allEditors[0];
  
  // Si hay múltiples editores, priorizar por:
  // 1. El que tiene el foco actualmente
  // 2. El que está dentro de un contenedor de respuesta inline visible
  // 3. El más cercano al final del DOM (típicamente el reply activo)
  
  // Opción 1: Verificar si alguno tiene el foco
  const focused = d.activeElement;
  for (const editor of allEditors) {
    if (editor === focused || editor.contains(focused)) {
      console.log("[Mafalda] Editor seleccionado: tiene el foco");
      return editor;
    }
  }
  
  // Opción 2: Buscar el editor dentro del contenedor de respuesta inline visible
  // Gmail usa contenedores con clases específicas para el área de respuesta
  const replyContainerSelectors = [
    '.ip.iq',           // Contenedor de respuesta inline
    '.adn.ads',         // Área de respuesta expandida  
    '.Am.aO9',          // Contenedor alternativo de respuesta
    '.M9',              // Otro contenedor de composición
    '.aoP',             // Área de composición general
  ];
  
  for (const containerSel of replyContainerSelectors) {
    const containers = d.querySelectorAll(containerSel);
    for (const container of containers) {
      if (!isElementVisible(container)) continue;
      
      for (const editor of allEditors) {
        if (container.contains(editor) && isElementVisible(editor)) {
          console.log(`[Mafalda] Editor seleccionado: dentro de ${containerSel}`);
          return editor;
        }
      }
    }
  }
  
  // Opción 3: Filtrar solo los visibles y tomar el último (más reciente/activo)
  const visibleEditors = allEditors.filter(isElementVisible);
  if (visibleEditors.length > 0) {
    // Priorizar el que está más abajo en la página (típicamente el reply activo)
    visibleEditors.sort((a, b) => {
      const rectA = a.getBoundingClientRect();
      const rectB = b.getBoundingClientRect();
      return rectB.top - rectA.top; // El de más abajo primero
    });
    console.log(`[Mafalda] Editor seleccionado: el más abajo de ${visibleEditors.length} visibles`);
    return visibleEditors[0];
  }
  
  // Fallback: el primero disponible
  console.log("[Mafalda] Editor seleccionado: fallback al primero");
  return allEditors[0];
}

/**
 * Encuentra el campo de asunto asociado a un editor específico de Gmail
 */
function findSubjectForEditor(editor) {
  if (!editor) return null;
  
  const d = document;
  
  // Buscar el contenedor padre del editor (form de composición)
  let container = editor.closest('form') || 
                  editor.closest('.M9') || 
                  editor.closest('.aoP') ||
                  editor.closest('.ip');
  
  if (container) {
    // Buscar el campo de asunto dentro del mismo contenedor
    const subject = container.querySelector('input[name="subjectbox"]') ||
                    container.querySelector('input[aria-label="Subject"]') ||
                    container.querySelector('input[aria-label="Asunto"]');
    if (subject) return subject;
  }
  
  // Fallback: buscar globalmente (para compatibilidad)
  return d.querySelector('input[name="subjectbox"]') || 
         d.querySelector('input[aria-label="Subject"]') ||
         d.querySelector('input[aria-label="Asunto"]');
}

function findEmailFields() {
  const d = document;
  
  // GMAIL: Usar la nueva lógica inteligente para encontrar el editor correcto
  const isGmail = location.hostname.includes('mail.google.com');
  
  let gmailBody = null;
  let gmailSubject = null;
  
  if (isGmail) {
    // Usar la función especializada para Gmail
    gmailBody = findActiveGmailReplyEditor();
    gmailSubject = findSubjectForEditor(gmailBody);
    console.log("[Mafalda] Gmail detectado. Body encontrado:", !!gmailBody, "Subject encontrado:", !!gmailSubject);
  } else {
    // Fallback para otros clientes o Gmail no detectado
    gmailSubject = d.querySelector('input[name="subjectbox"]') || 
                   d.querySelector('input[aria-label="Subject"]') || 
                   d.querySelector('textarea[aria-label="Subject"]') || 
                   d.querySelector('input[aria-label="Asunto"]') || 
                   d.querySelector('textarea[aria-label="Asunto"]');
    
    gmailBody = d.querySelector('div[aria-label="Message Body"]') || 
                d.querySelector('div[aria-label="Cuerpo del mensaje"]') || 
                d.querySelector('div[role="textbox"][g_editable="true"]') ||
                d.querySelector('div[contenteditable="true"][aria-label*="essage"]') ||
                d.querySelector('div[contenteditable="true"][aria-label*="ensaje"]');
  }
  
  // Outlook selectors
  const outlookSubject = d.querySelector('input[aria-label="Add a subject"]') || 
                         d.querySelector('input[aria-label="Asunto"]');
  const outlookBody = d.querySelector('div[aria-label="Message body"]') || 
                      d.querySelector('div[aria-label="Cuerpo del mensaje"]') || 
                      d.querySelector('div[role="textbox"][contenteditable="true"]');
  
  const subjectEl = gmailSubject || outlookSubject || null;
  const bodyEl = gmailBody || outlookBody || null;
  
  // Determinar el contexto de email
  const isReply = isGmailReplyContext(subjectEl) || isGmailInlineReply();
  const subjectVisible = isSubjectFieldVisible(subjectEl);
  
  return { 
    subjectEl, 
    bodyEl, 
    isReply,           // true si es una respuesta/reenvío
    subjectVisible     // true si el campo de asunto está visible
  };
}

function setInputValue(el, value, appendMode = false) {
  if (!el) return;
  
  // Asegurar que el elemento tenga foco
  el.focus();
  
  if ('value' in el) {
    // Input/textarea
    if (appendMode) {
      el.value = el.value + value;
    } else {
      el.value = value;
    }
    emitInputLike(el);
  } else {
    // ContentEditable (como el body de Gmail)
    // Convertir saltos de línea a <br> para HTML
    const htmlValue = String(value).replace(/\n/g, '<br>');
    
    if (appendMode) {
      // Insertar al final del contenido existente
      const br = document.createElement('br');
      el.appendChild(br);
      el.insertAdjacentHTML('beforeend', htmlValue);
    } else {
      // Reemplazar todo el contenido
      el.innerHTML = htmlValue;
    }
    
    // Mover el cursor al final del contenido
    moveCursorToEnd(el);
    
    // Emitir eventos para que Gmail detecte los cambios
    emitInputLike(el);
    
    // Gmail a veces necesita eventos adicionales
    try {
      el.dispatchEvent(new Event('focus', { bubbles: true }));
      el.dispatchEvent(new Event('keyup', { bubbles: true }));
    } catch(_) {}
  }
}

/**
 * Mueve el cursor al final del contenido de un elemento contenteditable
 */
function moveCursorToEnd(el) {
  if (!el) return;
  try {
    el.focus();
    const range = document.createRange();
    const sel = window.getSelection();
    range.selectNodeContents(el);
    range.collapse(false); // false = colapsar al final
    sel.removeAllRanges();
    sel.addRange(range);
  } catch(_) {}
}

/**
 * Verifica si un elemento es un editor de email (Gmail, Outlook, etc.)
 */
function isEmailEditor(el) {
  if (!el) return false;
  // Verificar atributos típicos de editores de email
  const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
  const role = el.getAttribute('role');
  const isContentEditable = el.isContentEditable || el.contentEditable === 'true';
  
  // Gmail patterns
  if (ariaLabel.includes('message') || ariaLabel.includes('mensaje') || 
      ariaLabel.includes('body') || ariaLabel.includes('cuerpo')) {
    return true;
  }
  if (el.hasAttribute('g_editable')) return true;
  if (role === 'textbox' && isContentEditable) return true;
  
  return false;
}

/**
 * Rellena los campos de email de forma inteligente:
 * - En respuestas: NO modifica el asunto (para mantener el hilo)
 * - En correos nuevos: Rellena asunto y body normalmente
 * 
 * @param {string} subjectText - Texto del asunto
 * @param {string} bodyText - Texto del cuerpo
 * @param {HTMLElement} [targetEditor] - Editor donde insertar (opcional, si ya tenemos referencia)
 * @returns {Object|false} - false si no se encontraron campos, o un objeto con info del resultado
 */
function tryFillEmail(subjectText, bodyText, targetEditor = null) {
  let { subjectEl, bodyEl, isReply, subjectVisible } = findEmailFields();
  
  // Si se proporcionó un editor específico y es válido, usarlo
  // Esto asegura que insertemos en el editor donde el usuario estaba escribiendo
  if (targetEditor && isEmailEditor(targetEditor)) {
    console.log("[Mafalda] Usando editor proporcionado en lugar del detectado automáticamente");
    bodyEl = targetEditor;
    
    // También actualizar el subject asociado a este editor
    const associatedSubject = findSubjectForEditor(targetEditor);
    if (associatedSubject) {
      subjectEl = associatedSubject;
      subjectVisible = isSubjectFieldVisible(associatedSubject);
      isReply = isGmailReplyContext(associatedSubject) || isGmailInlineReply();
    }
  }
  
  if (!subjectEl && !bodyEl) return false;
  
  // Lógica de asunto:
  // - Si es una respuesta (Re:, Fwd:, etc.) → NO modificar el asunto para mantener el hilo
  // - Si el asunto no está visible → NO modificar (Gmail lo maneja automáticamente)
  // - Si es un correo nuevo con asunto visible → Sí establecer el asunto del snippet
  const shouldSetSubject = subjectEl && 
                           subjectVisible && 
                           !isReply && 
                           subjectText && 
                           subjectText.trim().length > 0;
  
  if (shouldSetSubject) {
    setInputValue(subjectEl, subjectText);
    console.log("[Mafalda] Asunto establecido (correo nuevo):", subjectText);
  } else if (isReply) {
    console.log("[Mafalda] Contexto de respuesta detectado - asunto preservado para mantener el hilo");
  }
  
  // El body siempre se inserta (es el contenido principal del snippet)
  if (bodyEl) {
    setInputValue(bodyEl, bodyText);
    console.log("[Mafalda] Body insertado en:", bodyEl);
  }
  
  return {
    filled: true,
    isReply: isReply,
    subjectSet: shouldSetSubject,
    bodySet: !!bodyEl
  };
}

document.addEventListener("keydown", onEvent, true);
document.addEventListener("keyup", onEvent, true);
document.addEventListener("input", onEvent, true);

async function onEvent(e){
  if(dialogOpen) return;
  if (taOpen) { const consumed = handleTypeaheadKey(e); if (consumed) { e.preventDefault?.(); e.stopPropagation?.(); return; } }
  const t=e.target; if(!isEditableTarget(t)) return;
  if(!shouldTrigger(e)) return;
  if (e.key === " " || e.key === "Enter" || e.key === "Tab" || (e.type==="keydown" && e.ctrlKey && e.key===" ")) {
    if (typeof maybeHandleMaf === "function" && maybeHandleMaf(e)) { e.preventDefault?.(); e.stopPropagation?.(); return; }
  }
  const ctx = (t.value!==undefined) ? findShortcutInInput(t) : findShortcutInEditable();
  if(!ctx) { hideTypeahead(); return; }
  if (!dialogOpen && ctx && ctx.shortcut) {
    const prefix = String(ctx.shortcut); taTarget = t;
    if (!prefix.startsWith("/") || prefix.length < 2) { hideTypeahead(); } else {
      const matches = filterSnippets(prefix.toLowerCase()); taItems = matches;
      if (matches.length) { taSelIdx = 0; taCtxLast = ctx; renderTypeahead(matches, currentAnchorRect(t)); } 
      else { hideTypeahead(); }
    }
  }
  if(e.key===" "||e.key==="Enter"||e.key==="Tab"){ e.preventDefault?.(); e.stopPropagation?.(); }
  
  const tplRaw = snipIndex.get(String(ctx.shortcut).toLowerCase());
  if(!tplRaw) return;
  hideTypeahead();

  // --- LOGIC START ---
  if (isMailSnippet(tplRaw) || hasPlaceholders(String(tplRaw))) {
    let composite = tplRaw;
    let isMail = isMailSnippet(tplRaw);
    if(isMail) {
      composite = (tplRaw.subject||"") + "\n<<<__MAILSEP__>>>\n" + (tplRaw.body||"");
    }
    
    // Abrir Diálogo
    const finalText = await openDialog(composite, ctx.shortcut);
    if(finalText == null) return;
    
    // FIX DE FOCO: Reencontramos el atajo aunque hayamos perdido el foco
    t.focus();
    const ctx2 = refindContext(t, ctx.shortcut);
    
    if(!ctx2) { 
       console.warn("No pude encontrar el atajo original para reemplazar."); return; 
    }
    
    if (isMail) {
      const parts = String(finalText).split("\n<<<__MAILSEP__>>>\n");
      const sFinal = (parts[0]||"").trim(); const bFinal = (parts.slice(1).join("\n")||"").trim();
      
      // Primero eliminar el atajo del editor antes de insertar el snippet
      if(ctx2.kind==="input") {
        // Para inputs, limpiar el atajo
        const before = ctx2.original.slice(0, ctx2.from);
        const after = ctx2.original.slice(ctx2.to) + ctx2.right;
        ctx2.el.value = before + after;
        emitInputLike(ctx2.el);
      } else if(ctx2.kind === "editable") {
        // Para contenteditable, eliminar el atajo
        try {
          ctx2.del.deleteContents();
        } catch(_) {}
      }
      
      // Pasar el elemento target (t) para asegurar que usamos el editor correcto
      const result = tryFillEmail(sFinal, bFinal, t);
      if(!result) {
        const fallback = `ASUNTO: ${sFinal}\n\n${bFinal}`;
        if(ctx2.kind==="input") insertAtInput(ctx2, fallback); else insertAtEditable(ctx2, fallback);
        toastQuick("Snippet insertado ✅");
      } else {
        // Mensaje contextual según el tipo de operación
        if (result.isReply) {
          toastQuick("Respuesta en hilo ✅");
        } else {
          toastQuick("Mail completado ✅");
        }
      }
    } else {
      // Normal placeholder replacement
      if(ctx2.kind==="input") insertAtInput(ctx2, finalText); else insertAtEditable(ctx2, finalText);
      toastQuick("Snippet insertado ✅");
    }
    return;
  }
  
  // Static Snippet (No dialog)
  const final = expandStaticMacros(tplRaw);
  const ctx2 = (t.value!==undefined) ? findShortcutInInput(t) : findShortcutInEditable();
  if(ctx2?.kind==="input") insertAtInput(ctx2, final); else if(ctx2) insertAtEditable(ctx2, final);
  toastQuick("Snippet insertado ✅");
}

function toastQuick(msg){
  try{ const d=document.createElement("div");
    d.textContent=msg; d.style.cssText="position:fixed;bottom:18px;right:18px;background:#1f2937;color:#fff;padding:10px 14px;border-radius:10px;font-size:13px;z-index:2147483647;opacity:.98";
    document.body.appendChild(d); setTimeout(()=>d.remove(),1500);
  }catch(_){}
}
function cleanupAll(){ hideTypeahead(); if (shadowHost?.isConnected) { try { shadowHost.remove(); } catch(_) {} } dialogOpen = false; }
addEventListener("pagehide", cleanupAll);
function attachCoreListeners(){ document.addEventListener("keydown", onEvent, true); document.addEventListener("keyup", onEvent, true); document.addEventListener("input", onEvent, true); }
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") attachCoreListeners(); });
addEventListener("pageshow", () => { attachCoreListeners(); dialogOpen = false; });
addEventListener("popstate", attachCoreListeners); addEventListener("hashchange", attachCoreListeners); addEventListener("focus", attachCoreListeners);

/* =================== Detección de "Nombre del challenge" ==============*/
const RE_CHALLENGE = /\b(backoffice_[a-z0-9_]+)(?=$|\s|[^\w])/i;
function cleanChallengeToken(val){ return val ? String(val).trim().replace(/fecha$/i, '') : val; }
function publishDetectedChallenge(value){
  const v = value ? String(value).toLowerCase() : null;
  try { chrome.runtime?.sendMessage?.({ type: "maf:set_challenge", value: v }); console.log("[Mafalda] challenge detectado:", v); }
  catch(e){ console.warn("[Mafalda] no pude enviar a background:", e); }
}
let mafChallengeObserver=null, mafScanTimer=null, mafCurrentChallenge=null;
function findLabelNode() {
  const nodes = document.querySelectorAll("span,div,p,strong,h1,h2,h3,label");
  for (const el of nodes) {
    const t = el.textContent || "";
    if (t && /nombre\s+del\s+challenge|challenge\s*name/i.test(t)) return el;
  }
  return null;
}
function extractFromNode(el) {
  if (!el) return null;
  let m = (el.textContent || "").match(RE_CHALLENGE); if (m) return cleanChallengeToken(m[1]);
  const bold = el.querySelector("strong,b"); if (bold){ m = (bold.textContent || "").match(RE_CHALLENGE); if (m) return cleanChallengeToken(m[1]); }
  let sib = el.nextElementSibling;
  for (let i=0;i<3 && sib;i++, sib=sib.nextElementSibling){ m = (sib.textContent || "").match(RE_CHALLENGE); if (m) return cleanChallengeToken(m[1]); }
  const box = el.closest(".challenge-infos, .challenge-main-infos, section, article, div") || el;
  m = (box.innerText || "").match(RE_CHALLENGE); if (m) return cleanChallengeToken(m[1]);
  return null;
}
function fallbackScan() {
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
  while (tw.nextNode()) {
    const t = tw.currentNode.nodeValue;
    const m = t && t.match(RE_CHALLENGE);
    if (m) return cleanChallengeToken(m[1]);
  }
  return null;
}
function findChallengeOnce(){ const labelEl = findLabelNode(); return extractFromNode(labelEl) || fallbackScan(); }
function updateChallenge(){
  try{
    const found = findChallengeOnce();
    if (found && found !== mafCurrentChallenge){
      mafCurrentChallenge = found.toLowerCase();
      publishDetectedChallenge(mafCurrentChallenge);
    }
  }catch(_){}
}
function ensureChallengeObserver(){
  if (mafChallengeObserver) return;
  updateChallenge();
  mafChallengeObserver = new MutationObserver(() => {
    clearTimeout(mafScanTimer);
    mafScanTimer = setTimeout(updateChallenge, 200);
  });
  mafChallengeObserver.observe(document.documentElement, { subtree:true, childList:true, characterData:true });
  addEventListener("hashchange", updateChallenge);
  addEventListener("popstate", updateChallenge);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") updateChallenge();
  });
}
ensureChallengeObserver();

/* ======= START: DETECCIÓN DE SITE ======= */
const RE_SITE = /\b(?:MLA|MLB|MLM|MLC|MCO|MPE|MLU|MLV)\b/i;

function persistSiteToStorage(v) {
  try {
    if (chrome.storage && chrome.storage.session && typeof chrome.storage.session.set === "function") {
      chrome.storage.session.set({ maf_site: v }, () => {});
    } else if (chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ maf_site: v }, () => {});
    }
  } catch (e) {
    console.warn("[Mafalda] no pude persistir maf_site en storage:", e);
  }
}

function publishDetectedSite(value){
  const v = value ? String(value).toUpperCase() : null;
  try {
    chrome.runtime?.sendMessage?.({ type: "maf:set_site", value: v });
  } catch(e) {
    console.warn("[Mafalda] no pude enviar site a background:", e);
  }
  persistSiteToStorage(v);
  console.log("[Mafalda] site detectado (publish & persist):", v);
}

let mafSiteObserver = null, mafSiteScanTimer = null, mafCurrentSite = null;

function findSiteOnce(){
  const nodes = document.querySelectorAll("h1,h2,h3,.page-title,.header,header,nav,div,span,strong");
  for (const el of nodes) {
    const txt = el.textContent || "";
    const m = txt.match(RE_SITE);
    if (m) return (m[0] || "").toUpperCase();
  }
  try {
    const meta = document.querySelector('meta[name="site"]') || document.querySelector('meta[property="og:site"]');
    if (meta && meta.content) {
      const mm = meta.content.match(RE_SITE);
      if (mm) return (mm[0] || "").toUpperCase();
    }
  } catch(_) {}
  try {
    const u = location.pathname + (location.search || "");
    const mu = u.match(RE_SITE);
    if (mu) return (mu[0] || "").toUpperCase();
  } catch(_) {}
  return null;
}

function updateSite(){
  try{
    const found = findSiteOnce();
    if (found && found !== mafCurrentSite){
      mafCurrentSite = found;
      publishDetectedSite(mafCurrentSite);
    }
    else if (!found && mafCurrentSite){
      mafCurrentSite = null;
      publishDetectedSite(null);
    }
  }catch(_){}
}

function ensureSiteObserver(){
  if (mafSiteObserver) return;
  updateSite();
  mafSiteObserver = new MutationObserver(() => {
    clearTimeout(mafSiteScanTimer);
    mafSiteScanTimer = setTimeout(updateSite, 200);
  });
  mafSiteObserver.observe(document.documentElement, { subtree:true, childList:true, characterData:true });
  addEventListener("hashchange", updateSite);
  addEventListener("popstate", updateSite);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") updateSite();
  });
}
ensureSiteObserver();

/* ============ MAFALDA PANEL BUTTON & LOGIC ============ */

const MAX_DOCS = 3;

function findMafInInput(el){
  const s = el.selectionStart, e = el.selectionEnd, txt = el.value;
  const left = txt.slice(0, s).replace(/\s+$/,"");
  let last = null, m; const re = /\bmaf(?=\s|$)/ig;
  while((m = re.exec(left)) !== null) last = m;
  if(!last) return null;
  return {
    kind: "input",
    el,
    original: txt,
    right: txt.slice(e),
    from: last.index,
    to: last.index + 3, // "maf"
    beforeText: txt.slice(0, last.index).trim()
  };
}

function findMafInEditable(){
  const sel = window.getSelection(); if(!sel || !sel.rangeCount) return null;
  const caret = sel.getRangeAt(0);
  const probe = caret.cloneRange(); probe.collapse(true); probe.setStart(probe.startContainer, 0);
  const left = probe.toString().replace(/\s+$/,"");
  const idx = left.toLowerCase().lastIndexOf("maf");
  if (idx < 0 || !/\bmaf$/i.test(left.slice(0, idx + 3))) return null;

  const del = caret.cloneRange();
  let node = caret.startContainer, off = caret.startOffset, remain = 3;

  function prevTextNodeIter(n){
    function prev(x){ if(!x) return null; if(x.previousSibling){ x = x.previousSibling; while(x && x.lastChild) x = x.lastChild; return x; } return prev(x.parentNode); }
    let p = prev(n); while(p && p.nodeType !== Node.TEXT_NODE) p = prev(p); return p;
  }

  while(remain > 0 && node){
    if(node.nodeType === Node.TEXT_NODE){
      const take = Math.min(off, remain);
      del.setStart(node, off - take);
      remain -= take;
      if(remain === 0) break;
    }
    const prev = prevTextNodeIter(node); if(!prev) break;
    node = prev; off = node.textContent.length;
  }
  const beforeText = left.slice(0, idx).trim();
  return { kind:"editable", sel, del, beforeText };
}

function removeMafToken(ctx){
  if(ctx.kind === "input"){
    const before = ctx.original.slice(0, ctx.from);
    const after  = ctx.original.slice(ctx.to) + ctx.right;
    ctx.el.value = before + after;
    const caret = before.length;
    ctx.el.setSelectionRange(caret, caret);
    emitInputLike(ctx.el);
  } else {
    ctx.del.deleteContents();
    const tn = document.createTextNode("");
    ctx.del.insertNode(tn);
    ctx.sel.removeAllRanges();
    const r = document.createRange();
    r.setStart(tn, 0); r.setEnd(tn, 0);
    ctx.sel.addRange(r);
    emitInputLike(getEditableRootFromNode(tn));
  }
}

function normalizeAppsScriptUrl(u){
  if (!u) return u;
  return String(u).replace(
    /https:\/\/script\.google\.com\/a\/macros\/[^/]+\/s\//,
    "https://script.google.com/macros/s/"
  );
}

const isPDF = (u) => /\.pdf(\?|$)/i.test(u || "");
const isIMG = (u) => /\.(png|jpe?g|bmp|webp|tif?f)(\?|$)/i.test(u || "");
const isDocUrl = (u) => isPDF(u) || isIMG(u);

function collectUrlsHere() {
  const urls = new Set();
  document.querySelectorAll('a[href], img[src], source[src], track[src], embed[src], object[data], iframe[src]').forEach(el => {
    const urlAttr = el.getAttribute('href') || el.getAttribute('src') || el.getAttribute('data');
    if (!urlAttr) return;
    try {
      const abs = new URL(urlAttr, location.href).href;
      if (isDocUrl(abs)) urls.add(abs);
    } catch {}
  });
  document.querySelectorAll('[data-src], [data-url]').forEach(el => {
    const u = el.getAttribute('data-src') || el.getAttribute('data-url');
    if (!u) return;
    try {
      const abs = new URL(u, location.href).href;
      if (isDocUrl(abs)) urls.add(abs);
    } catch {}
  });
  document.querySelectorAll('[style*="background-image"]').forEach(el => {
    const m = String(el.getAttribute('style') || "").match(/background-image\s*:\s*url\((["']?)(.*?)\1\)/i);
    const u = m && m[2];
    if (!u) return;
    try {
      const abs = new URL(u, location.href).href;
      if (isDocUrl(abs)) urls.add(abs);
    } catch {}
  });
  const arr = Array.from(urls);
  const seen = new Set();
  const clean = [];
  for (const u of arr) {
    const key = u.replace(/[?#].*$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push(u);
    if (clean.length >= MAX_DOCS) break;
  }
  console.log(`[Mafalda] ${clean.length} documentos detectados para análisis:`, clean);
  return clean;
}

async function analyzeWithAI(freeText, docUrls){
  const cdu  = await storageGetLocal("maf_challenge", null) || mafCurrentChallenge;
  const site = await storageGetLocal("maf_site", null) || mafCurrentSite;
  const remoteRaw = await storageGetLocal("remote_url", "");
  const remote = normalizeAppsScriptUrl(remoteRaw || "");
  if(!remote) throw new Error('Falta configurar la "Fuente remota" en el popup');

  return await new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(
        { type: "maf:ai_analyze_with_docs", remoteUrl: remote, text: freeText, cdu: cdu || null, site: site || null, docUrls },
        (res) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!res || res.ok === false) return reject(new Error(res?.error || "No se pudo analizar el texto."));
          resolve(res.data);
        }
      );
    } catch (e) { reject(e); }
  });
}

function openMafPanel(freeText, ctxForInsert, docUrls){
  const host = document.createElement("div");
  host.style.position="fixed"; host.style.inset="0"; host.style.zIndex="2147483647";
  const sh = host.attachShadow({mode:"open"});
  document.documentElement.appendChild(host);

  sh.innerHTML = `<style>
      @import url('https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;700;800&display=swap');
      :root{ --azul:#283277; --meli:#FFC800; --ink:#333333; --azul-12: rgba(40,50,119,.12); --azul-18: rgba(40,50,119,.18); --azul-30: rgba(40,50,119,.30); }
      :host{ font-family:'Rubik',system-ui,-apple-system,Segoe UI,Roboto,Arial; color:var(--ink); }
      dialog{ border:none; border-radius:18px; width:min(800px, 96vw); padding:0; }
      dialog::backdrop{ background:rgba(0,0,0,.3) }
      .shell{ border-radius:18px; background:#fff; box-shadow:0 12px 34px rgba(0,0,0,.14); overflow:hidden; display:flex; flex-direction:column; max-height:84vh; }
      .head{ background:#283277; color:#fff; padding:10px 16px; display:flex; align-items:center; gap:10px; }
      .brand{ display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; border-radius:8px; background:linear-gradient(180deg, rgba(255,200,0,.16), rgba(255,200,0,.07)); box-shadow:inset 0 0 0 1px rgba(255,255,255,.25) }
      .title{ font-size:16px; font-weight:800; margin:0 }
      .content{ display:grid; grid-template-columns: 230px 1fr; flex:1; overflow:hidden; background:#fff; }
      .left{ border-right:1px solid var(--azul-18); display:flex; flex-direction:column; overflow:auto; }
      .cell{ padding:14px 16px; }
      .cell + .cell{ border-top:1px solid var(--azul-18); }
      h3.h{ margin:0 0 8px 0; font-size:18px; font-weight:800; color:#283277 }
      .muted{ color:#657084; font-size:12px; font-weight:400 }
      .box{ background:linear-gradient(180deg,#fff,#fafafa); border:1px solid var(--azul-18); border-radius:14px; padding:12px; color:#0f172a; white-space:pre-wrap; }
      .case{ min-height:80px; }
      .det  { min-height:80px; }
      .final{ min-height:180px; max-height:calc(66vh - 140px); overflow:auto; }
      .right{ display:flex; flex-direction:column; overflow:hidden; }
      .right-inner{ padding:16px; display:flex; flex-direction:column; height:100%; }
      .row-actions{ display:flex; gap:12px; justify-content:flex-end; padding-top:12px; }
      .btn{ display:inline-flex; align-items:center; gap:8px; font-weight:800; font-size:14px; border-radius:14px; padding:10px 16px; cursor:pointer; }
      .btn.copy{ color:#283277; background:#fff; border:1px solid var(--azul-30); }
      .btn.insert{ color:#fff !important; background:#283277 !important; border:1px solid #283277 !important; box-shadow:0 1px 0 rgba(0,0,0,.05); }
      .close{ position:absolute; right:12px; top:12px; border:none; background:#fff; border-radius:10px; padding:6px 9px; cursor:pointer; box-shadow:0 2px 10px rgba(0,0,0,.06) }
      .spinner{ display:inline-block; width:14px; height:14px; border:2px solid var(--azul-18); border-top-color:#283277; border-radius:50%; animation:sp 1s linear infinite; margin-right:6px }
      @keyframes sp{ to{ transform:rotate(360deg) } }
    </style>
    <dialog>
      <button class="close" title="Cerrar">✕</button>
      <section class="shell" role="dialog" aria-label="Mafalda">
        <header class="head">
          <span class="brand" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M4 11c0-4.4 3.6-8 8-8s8 3.6 8 8v3H4v-3z" fill="#333"/>
              <g transform="translate(12 6)"><circle cx="0" cy="0" r="1" fill="#E94B4B"/><path d="M-1 0c-1.2-.2-2 .7-2 1.6 0 .7.6 1.4 1.3 1.2L0 .6z" fill="#E94B4B"/><path d="M1 0c1.2-.2 2 .7 2 1.6 0 .7-.6 1.4-1.3 1.2L0 .6z" fill="#E94B4B"/></g>
            </svg>
          </span>
          <h2 class="title">Mafalda</h2>
        </header>

        <div class="content">
          <div class="left">
            <div class="cell">
              <h3 class="h">Texto del caso <span id="docCount" class="muted"></span></h3>
              <div id="case" class="box case"></div>
            </div>
            <div class="cell">
              <h3 class="h">Casuística detectada</h3>
              <div id="detected" class="box det"><span class="spinner"></span>Analizando…</div>
            </div>
          </div>
          <div class="right">
            <div class="right-inner">
              <div style="padding-bottom:8px">
                <h3 class="h">Mensaje final al usuario</h3>
              </div>
              <div id="final" class="box final" contenteditable="true"><span class="spinner"></span>Generando…</div>
              <div class="row-actions">
                <button id="copy" class="btn copy">📋 copiar</button>
                <button id="insert" class="btn insert">✉️ enviar</button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </dialog>`;

  const dlg       = sh.querySelector("dialog");
  const btnClose  = sh.querySelector(".close");
  const btnCopy   = sh.querySelector("#copy");
  const btnIns    = sh.querySelector("#insert");
  const caseEl    = sh.querySelector("#case");
  const detEl     = sh.querySelector("#detected");
  const finalEl   = sh.querySelector("#final");
  const docCountEl= sh.querySelector("#docCount");

  caseEl.textContent = freeText || "(vacío)";
  docCountEl.textContent = `${docUrls.length} documento(s) candidato(s)`;

  function close(){ try{ dlg.close(); }catch(_){ } host.remove(); }
  btnClose.onclick = close;
  btnCopy.onclick  = async ()=>{ try{ await navigator.clipboard.writeText(finalEl.innerText || ""); }catch(_){ } };
  btnIns.onclick   = () => { const clean = (finalEl.innerText || "").trim(); if (!clean) return; replaceBeforeCaret(ctxForInsert, clean); close(); };
  dlg.addEventListener("cancel", e=>e.preventDefault());
  dlg.showModal();

  (async ()=> {
    try {
      const res = await analyzeWithAI(freeText, docUrls);
      const count = Number(res.docCount || (res.docMeta?.length || 0));
      docCountEl.textContent = `${count} documento(s) analizado(s)`;

      const items = Array.isArray(res.detected) ? res.detected : (res.detected ? [res.detected] : []);
      detEl.innerHTML = `<div>${items.length ? items.map(x=>`• ${escapeHTML(String(x))}`).join("<br>") : "—"}</div>`;
      if (res.improved) finalEl.textContent = res.improved;
      finalEl.focus();
    } catch (e) {
      detEl.innerHTML = `<span style="color:#b00020;">No se pudo analizar (${escapeHTML(String(e.message||e))})</span>`;
      finalEl.textContent = "No pude generar la recomendación en este momento. Revisá la guía y redactá el mensaje para el usuario.";
    }
  })();
}

function maybeHandleMaf(e){
  const t = e.target;
  if (!isEditableTarget(t)) return false;

  const ctx = (t.value !== undefined) ? findMafInInput(t) : findMafInEditable();
  if (!ctx) return false;

  const freeText = ctx.beforeText || "";
  removeMafToken(ctx);
  const docUrls = collectUrlsHere();
  openMafPanel(freeText, ctx, docUrls);
  return true;
}