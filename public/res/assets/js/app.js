/* Local Mini AI — a ChatGPT-style shell over two on-device engines.
   Everything runs locally: the model lives inside the browser and the
   conversations live in IndexedDB. Chrome's Prompt API (Gemini Nano) is the
   default; WebLLM is the alternative, which downloads open weights once and
   runs them on WebGPU. Either way generation never touches the network.
   This project exists only to exercise those APIs — there is no backend. */
"use strict";

const $ = (id) => document.getElementById(id);
const LS_CHATS = "miniai.chats";
const LS_SETTINGS = "miniai.settings";

/* A small, valid schema so the field is never blank the first time it opens
   and the feature demonstrates itself. */
const DEFAULT_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    title: { type: "string" },
    sentiment: { type: "string", enum: ["positive", "neutral", "negative"] },
    keywords: { type: "array", items: { type: "string" } },
  },
  required: ["title", "sentiment"],
}, null, 2);

/* ══ Persisted state ═══════════════════════════════════════════ */
const settings = Object.assign({
  temperature: 1,
  topK: 3,
  system: null,   // null = follow the language default
  theme: "",      // "" = follow the OS
  sidebarWidth: 270,
  lang: "",       // "" = follow the browser
  provider: "chrome",          // "chrome" (Prompt API) or "webllm" (WebGPU)
  webllmModel: WEBLLM_DEFAULT, // which open model WebLLM should load
  jsonMode: false,             // constrain answers to jsonSchema
  jsonSchema: DEFAULT_SCHEMA,  // the JSON Schema text, when jsonMode is on
}, readJSON(LS_SETTINGS, {}));

/** chats: [{ id, title, updatedAt, messages: [{role:'user'|'assistant'|'error', content}] }] */
let chats = [];
let currentId = null;

function readJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function saveSettings() { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); }
function current() { return chats.find((c) => c.id === currentId) || null; }

/* ══ Storage: IndexedDB ════════════════════════════════════════
   Transcripts grow without bound, so localStorage is the wrong home for them:
   it caps out around 5 MB, is synchronous (every keystroke-sized save blocks
   the main thread) and forces a full re-serialisation of every conversation
   on each write. IndexedDB stores one record per chat, writes only the one
   that changed, and is asynchronous. Settings stay in localStorage — they are
   a handful of bytes and being readable synchronously at boot avoids a flash
   of the wrong theme. */
const DB_NAME = "miniai";
const STORE = "chats";
let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(mode) { return db.transaction(STORE, mode).objectStore(STORE); }
function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Writes a single conversation — the whole point of moving off localStorage. */
async function putChat(chat) {
  if (!db) return;
  try { await wrap(tx("readwrite").put(JSON.parse(JSON.stringify(chat)))); }
  catch (err) { log("indexedDB put failed: " + err.message); }
}
async function removeChat(id) {
  if (!db) return;
  try { await wrap(tx("readwrite").delete(id)); } catch { /* already gone */ }
}
async function clearChats() {
  if (!db) return;
  try { await wrap(tx("readwrite").clear()); } catch { /* nothing to clear */ }
}

async function loadChats() {
  try { db = await openDB(); } catch (err) { log("indexedDB unavailable: " + err.message); }

  if (db) {
    chats = (await wrap(tx("readonly").getAll()).catch(() => [])) || [];

    // One-time migration from the old localStorage layout.
    const legacy = readJSON(LS_CHATS, null);
    if (Array.isArray(legacy) && legacy.length) {
      const known = new Set(chats.map((c) => c.id));
      for (const c of legacy) if (!known.has(c.id)) { chats.push(c); await putChat(c); }
      localStorage.removeItem(LS_CHATS);
      log(`migrated ${legacy.length} conversations from localStorage`);
    }
  } else {
    chats = readJSON(LS_CHATS, []);   // last resort: private mode, blocked storage
  }

  chats.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  currentId = chats[0]?.id || null;
}

/* ══ i18n ══════════════════════════════════════════════════════ */
let lang = "en";

function resolveLang() {
  if (settings.lang && I18N[settings.lang]) return settings.lang;
  const nav = (navigator.languages || [navigator.language || "en"]).map((l) => l.toLowerCase());
  return nav.some((l) => l.startsWith("pt")) ? "pt" : "en";
}

/** Translated string; falls back to English, then to the key itself. */
function t(key) {
  return I18N[lang]?.[key] ?? I18N.en[key] ?? key;
}

/** The effective system prompt: the user's own text, or the language default. */
function systemPrompt() {
  return (settings.system ?? "").trim() || t("sys.default");
}

function applyI18n() {
  lang = resolveLang();
  document.documentElement.lang = t("html.lang");

  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-html]")) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of document.querySelectorAll("[data-i18n-ph]")) el.placeholder = t(el.dataset.i18nPh);
  for (const el of document.querySelectorAll("[data-i18n-title]")) el.title = t(el.dataset.i18nTitle);
  for (const el of document.querySelectorAll("[data-i18n-aria]")) el.setAttribute("aria-label", t(el.dataset.i18nAria));
  for (const el of document.querySelectorAll("[data-i18n-alt]")) el.alt = t(el.dataset.i18nAlt);

  // System prompt box mirrors the language default while it is untouched.
  $("in-system").value = settings.system ?? t("sys.default");
  $("in-system").placeholder = t("sys.default");

  paintStatus();
  paintIncompat();
  renderAll();
  setComposerEnabled(state.availability === "available");
}

/* ══ Runtime state ═════════════════════════════════════════════ */
const state = {
  provider: null,     // the active entry of PROVIDERS
  availability: "unsupported",
  params: null,       // { defaultTemperature, maxTemperature, defaultTopK, maxTopK }
  session: null,
  sessionOf: null,    // which chat id the live session was built from
  busy: false,
  abort: null,      // the running generation
  dlAbort: null,    // the running model download
  cached: null,     // Set of WebLLM ids on disk; null while still unknown
  gpu: null,        // probeGPU() result, once asked for
  lastRun: null,    // timings of the most recent generation
  incompatDismissed: false,
};

/* ══ Small helpers ═════════════════════════════════════════════ */
function log(msg) {
  const line = document.createElement("span");
  const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
  line.innerHTML = `<b>${time}</b> ${esc(msg)}`;
  $("evlog").appendChild(line);
  $("evlog").scrollTop = $("evlog").scrollHeight;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
let toastTimer;
function toast(msg) {
  $("toast").textContent = msg;
  $("toast").classList.add("is-on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("is-on"), 2200);
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

/* Very small markdown subset: fenced code, inline code, bold, italic.
   Everything else stays literal — the container is white-space:pre-wrap. */
function render(text) {
  const blocks = [];
  let out = esc(text).replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang_, code) => {
    blocks.push(`<pre><code>${code.replace(/\n$/, "")}</code></pre>`);
    return ` ${blocks.length - 1} `;
  });
  out = out
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|\s)\*([^*\n]+)\*/g, "$1<em>$2</em>");
  return out.replace(/ (\d+) /g, (_, i) => blocks[i]);
}

/** Pretty-prints a JSON answer into a fenced block, so the markdown renderer
    shows it formatted. If the model broke its own constraint and returned
    something unparseable, it is left exactly as it came. */
function prettyJson(text) {
  try { return "```json\n" + JSON.stringify(JSON.parse(text), null, 2) + "\n```"; }
  catch { return text; }
}

/* ══ Model status ══════════════════════════════════════════════ */
const TONE = {
  unsupported: { ic: "fa-plug-circle-xmark", tone: "is-err" },
  unavailable: { ic: "fa-triangle-exclamation", tone: "is-err" },
  downloadable: { ic: "fa-cloud-arrow-down", tone: "is-warn" },
  downloading: { ic: "fa-cloud-arrow-down", tone: "is-busy" },
  available: { ic: "fa-circle-check", tone: "is-ok" },
};

/** Status copy is per engine: "Chrome is fetching it in the background" and
    "1.1 GB from the HuggingFace CDN" are not the same sentence. Keys are
    looked up as status.<provider>.<state>.* first, then the shared fallback. */
function statusText(kind) {
  const scoped = `status.${settings.provider}.${state.availability}.${kind}`;
  const shared = `status.${state.availability}.${kind}`;
  return I18N[lang]?.[scoped] ?? I18N.en[scoped] ?? t(shared);
}

function paintStatus(extraDesc) {
  const key = state.availability;
  const s = TONE[key] || TONE.unavailable;

  for (const id of ["setup-ic", "m-ic"]) {
    $(id).className = "setup__ic " + s.tone;
    $(id).innerHTML = `<i class="fa-solid ${s.ic}"></i>`;
  }
  const title = statusText("title");
  const desc = extraDesc || statusText("desc");
  $("setup-title").textContent = title;
  $("setup-desc").innerHTML = desc;
  $("m-title").textContent = title;
  $("m-desc").innerHTML = desc;

  $("sb-dot").className = "badge-dot " + s.tone;
  $("sb-model-label").textContent = statusText("short");
  $("kv-avail").textContent = key;
  $("kv-engine").textContent = engineLabel();

  const ready = key === "available";
  const canDownload = !ready && key !== "unsupported" && key !== "unavailable";
  $("btn-download").classList.toggle("hidden", !canDownload);
  $("btn-download-set").classList.toggle("hidden", !canDownload);
  $("suggs").classList.toggle("hidden", !ready);
  setComposerEnabled(ready);
}

function setComposerEnabled(on) {
  $("in-msg").disabled = !on;
  $("btn-send").disabled = !on || !$("in-msg").value.trim();
  $("in-msg").placeholder = on ? t("composer.placeholder") : t("composer.blocked");
  paintMic();
}

/* ══ Incompatibility modal ═════════════════════════════════════ */
/** Shown whenever the model can never run here (no API, or hardware refused).
    It is informative, not a hard wall: "look around anyway" dismisses it. */
function paintIncompat() {
  const key = state.availability;
  const blocking = key === "unsupported" || key === "unavailable";
  if (!blocking) { $("modal-incompat").classList.add("hidden"); return; }

  const kind = key === "unsupported" ? "unsupported" : "unavailable";
  $("ic-title").textContent = t(`incompat.title.${settings.provider}.${kind}`);
  $("ic-lead").textContent = t(`incompat.lead.${settings.provider}.${kind}`);
  $("ic-note").innerHTML = t(`incompat.note.${settings.provider}`);
  $("ic-details-label").textContent = t(`incompat.details.${settings.provider}`);

  // The dead end is only a dead end for this engine. If the other one could
  // plausibly work here, the modal stops apologising and starts offering:
  // the download leads, the diagnosis folds away, and the icon drops the
  // "nothing works" red for something that reads as a next step.
  const alt = settings.provider === "chrome" ? "webllm" : "chrome";
  const altPossible = settings.provider === "chrome"
    ? "gpu" in navigator
    : "LanguageModel" in self;

  $("ic-offer").classList.toggle("hidden", !altPossible);
  $("ic-details").open = !altPossible;
  $("ic-ic").className = "incompat__ic" + (altPossible ? " is-offer" : "");
  $("ic-ic").innerHTML = altPossible
    ? '<i class="fa-solid fa-lightbulb"></i>'
    : '<i class="fa-solid fa-plug-circle-xmark"></i>';

  if (altPossible) {
    $("ic-offer-title").textContent = t(`incompat.offer.${alt}.title`);
    $("ic-offer-lead").textContent = t(`incompat.offer.${alt}.lead`);
    $("ic-offer-note").innerHTML = t(`incompat.offer.${alt}.note`);
    $("ic-go-label").textContent = t(`incompat.offer.${alt}.cta`);
    // Only WebLLM has weights to choose; the Prompt API hands you Nano.
    $("ic-model-field").classList.toggle("hidden", alt !== "webllm");
    if (alt === "webllm") $("ic-model").value = settings.webllmModel;
  }

  // Only the checks the page can actually verify get a verdict; the rest stay
  // neutral, since a browser cannot read disk space or VRAM.
  const verdicts = state.provider ? state.provider.checks() : {};
  const list = $("ic-reqs");
  list.innerHTML = "";
  for (const r of REQUIREMENTS[settings.provider]) {
    const v = verdicts[r.key];
    const tone = v === true ? "is-ok" : v === false ? "is-err" : "";
    const icon = v === true ? "fa-solid fa-check" : v === false ? "fa-solid fa-xmark"
      : (r.brand ? "fa-brands " + r.icon : "fa-solid " + r.icon);
    const row = document.createElement("div");
    row.className = "req";
    row.innerHTML = `<div class="req__ic ${tone}"><i class="${icon}"></i></div>
      <div class="req__txt"><b></b><span></span></div>`;
    row.querySelector("b").textContent = t(`req.${r.key}.title`);
    row.querySelector("span").innerHTML = t(`req.${r.key}.desc`);
    list.appendChild(row);
  }

  $("modal-incompat").classList.toggle("hidden", state.incompatDismissed);
}

/* ══ Engines ═══════════════════════════════════════════════════ */
/** Human name of the active engine, model included for WebLLM — with two
    engines on offer, "on-device" alone no longer says which one answered. */
function engineLabel() {
  if (settings.provider !== "webllm") return t("engine.chrome.short");
  const m = WEBLLM_MODELS.find((x) => x.id === settings.webllmModel);
  return m ? m.label : t("engine.webllm.short");
}

/** Switching engine tears down whatever the old one had running: a session
    belongs to one engine and means nothing to the other. */
async function setProvider(id) {
  if (settings.provider === id) return;
  invalidateSession();
  await PROVIDERS.webllm.disposeEngine();
  settings.provider = id;
  saveSettings();
  state.incompatDismissed = false;
  hideProgress();
  paintEngine();
  log("engine → " + id);
  await refresh();
}

/** Everything in the UI that depends on which engine is selected. */
function paintEngine() {
  for (const b of $("seg-engine").children) b.classList.toggle("is-active", b.dataset.engine === settings.provider);
  $("engine-model").classList.toggle("hidden", settings.provider !== "webllm");
  $("in-model").value = settings.webllmModel;
  // WebLLM samples with temperature and top_p; there is no top-K to offer.
  $("ctl-topk").classList.toggle("hidden", !PROVIDERS[settings.provider].supportsTopK);
  $("kv-box-maxtopk").classList.toggle("hidden", !PROVIDERS[settings.provider].supportsTopK);
}

/* ══ Availability + session ════════════════════════════════════ */
async function refresh() {
  state.provider = PROVIDERS[settings.provider] || PROVIDERS.chrome;

  try {
    state.availability = await state.provider.availability();
  } catch (err) {
    state.availability = "unavailable";
    log("availability() failed: " + err.message);
  }
  log(`availability() → ${state.availability} (${settings.provider})`);

  try {
    state.params = await state.provider.params();
    if (state.params) applyParamLimits(state.params);
  } catch { /* not every state exposes params */ }

  paintStatus();
  paintIncompat();
  // The picker has to know about shader-f16 before it is next built, so the
  // probe happens here rather than waiting for the About panel to be opened.
  if (settings.provider === "webllm" && !state.gpu) state.gpu = await probeGPU();
  // availability() is what pulls the WebLLM module in, so by here the cache
  // can finally be inspected for free.
  await refreshCache();
}

function applyParamLimits(p) {
  $("kv-maxtemp").textContent = p.maxTemperature ?? "-";
  $("kv-maxtopk").textContent = p.maxTopK ?? "-";
  if (p.maxTemperature) $("in-temp").max = p.maxTemperature;
  if (p.maxTopK) $("in-topk").max = p.maxTopK;
}

/** Builds a session for the active chat, replaying its history as initialPrompts.
    Lazy, so switching chats is instant and costs nothing. */
async function ensureSession(signal) {
  if (state.session && state.sessionOf === currentId) return state.session;
  if (state.session) { state.session.destroy(); state.session = null; }

  // Past turns that carried an image are replayed as multimodal prompts, so a
  // follow-up like "what colour is it?" still has the picture in context. The
  // image is stored as a data URL and turned back into a blob only here.
  const past = (current()?.messages || [])
    .filter((m) => m.role === "user" || m.role === "assistant");
  const anyImage = past.some((m) => m.image);
  const multimodal = settings.provider === "chrome" && anyImage
    && await PROVIDERS.chrome.imageSupported();

  const history = [];
  for (const m of past) {
    if (multimodal && m.image) {
      const blob = await dataUrlToBlob(m.image).catch(() => null);
      history.push(blob
        ? { role: m.role, content: [{ type: "text", value: m.content }, { type: "image", value: blob }] }
        : { role: m.role, content: m.content });
    } else {
      history.push({ role: m.role, content: m.content });
    }
  }

  // Loading cached weights onto the GPU takes seconds, and the progress bar
  // lives on the welcome screen, which is gone once a conversation starts —
  // so a message that triggers the load gets a toast instead of silence.
  if (settings.provider === "webllm" && PROVIDERS.webllm.engineModel !== settings.webllmModel) {
    toast(t("toast.loadingModel"));
  }

  log(`create({ temperature: ${settings.temperature}, topK: ${settings.topK} }) · ${history.length} past turns`);
  state.session = await state.provider.createSession({
    temperature: settings.temperature,
    topK: settings.topK,
    system: systemPrompt(),
    history,
    onProgress: showProgress,
    signal,
    multimodal,
  });
  state.sessionOf = currentId;

  // Fired when the history outgrows the context window and the head is dropped.
  state.session.addEventListener?.("quotaoverflow", () => log("quotaoverflow: start of history dropped"));
  updateQuota();
  $("kv-session").textContent = t("kv.active");
  return state.session;
}

/** Explicit "Download model" button: forces creation so the download starts. */
async function downloadModel() {
  if (!state.provider || state.busy) return;
  state.busy = true;
  $("btn-download").disabled = true;
  $("btn-download-set").disabled = true;
  state.availability = "downloading";
  paintStatus();
  showProgress(0);
  log("download requested");

  state.dlAbort = new AbortController();
  for (const id of DL_BARS) $(`${id}-cancel`).disabled = false;
  paintCancel();

  try {
    await ensureSession(state.dlAbort.signal);
    state.availability = "available";
    hideProgress();
    paintStatus(t("status.sessionActive"));
    log("model ready, session created");
    toast(t("toast.modelReady"));
    paintIncompat();
    await refreshCache();
  } catch (err) {
    hideProgress();
    if (err.name === "AbortError") {
      // Nothing broke, the user just changed their mind: go back to asking
      // the engine where it stands rather than declaring it unavailable.
      log("download cancelled by the user");
      toast(t("toast.downloadCancelled"));
      await refresh();
    } else {
      state.availability = "unavailable";
      paintStatus(t("status.createFailed") + esc(err.message));
      paintIncompat();
      log("create() failed: " + err.message);
    }
  } finally {
    state.dlAbort = null;
    state.busy = false;
    $("btn-download").disabled = false;
    $("btn-download-set").disabled = false;
  }
}

/* The same download can be started from the welcome card, the settings modal
   or the incompatibility modal, and any of them can be the one on screen while
   it runs. All three bars are driven together rather than guessing. */
const DL_BARS = ["dl", "dl-set", "dl-ic"];

/** `note` only ever arrives from WebLLM, which narrates each shard it fetches;
    the Prompt API reports a bare fraction, so the generic label stands in. */
function showProgress(loaded, note) {
  const pct = Math.round((loaded || 0) * 100);
  const label = note || (pct >= 100 ? t("dl.finishing") : t("dl.downloading"));
  for (const id of DL_BARS) {
    $(id).classList.remove("hidden");
    $(`${id}-fill`).style.width = pct + "%";
    $(`${id}-pct`).textContent = pct + "%";
    $(`${id}-label`).textContent = label;
  }
  paintCancel();
}

function hideProgress() {
  for (const id of DL_BARS) $(id).classList.add("hidden");
}

/** The cancel buttons only make sense while a download is actually running,
    and only when the engine can really stop it — see canCancelDownload(). */
function paintCancel() {
  const stoppable = !!state.dlAbort
    && (settings.provider !== "webllm" || PROVIDERS.webllm.canCancelDownload());
  for (const id of DL_BARS) $(`${id}-cancel`).classList.toggle("hidden", !stoppable);
}

function cancelDownload() {
  if (!state.dlAbort) return;
  state.dlAbort.abort();
  for (const id of DL_BARS) $(`${id}-cancel`).disabled = true;
}

function destroySession() {
  if (!state.session) { toast(t("toast.noSession")); return; }
  state.session.destroy();
  state.session = null;
  state.sessionOf = null;
  $("kv-session").textContent = t("kv.none");
  $("kv-quota").textContent = "-";
  log("session.destroy()");
  toast(t("toast.sessionDestroyed"));
}

function updateQuota() {
  const s = state.session;
  if (!s || s.inputQuota == null) return;
  const pct = Math.round((s.inputUsage / s.inputQuota) * 100);
  $("kv-quota").textContent = `${s.inputUsage.toLocaleString()} / ${s.inputQuota.toLocaleString()} (${pct}%)`;
}

/* ══ Routing ═══════════════════════════════════════════════════
   Two routes, the way Claude does it: /new is the blank slate and
   /chat/<id> is one conversation. The URL is the source of truth on load and
   on back/forward; everywhere else the UI drives it. */
function routeId() {
  const m = /^\/chat\/([A-Za-z0-9_-]+)\/?$/.exec(location.pathname);
  return m ? m[1] : null;
}

function go(path, replace) {
  if (location.pathname === path) return;
  history[replace ? "replaceState" : "pushState"]({ path }, "", path);
}

/** Back/forward: follow whatever the URL now says. */
window.addEventListener("popstate", () => {
  const id = routeId();
  if (id && chats.some((c) => c.id === id)) { currentId = id; renderAll(); return; }
  // /new, / or a conversation that no longer exists.
  const blank = chats.find((c) => c.messages.length === 0);
  if (blank) { currentId = blank.id; renderAll(); } else newChat();
});

/* ══ Conversations ═════════════════════════════════════════════ */
function newChat() {
  // Reuse the current chat if it is already empty — no point stacking blanks.
  const c = current();
  if (c && c.messages.length === 0) { go("/new"); renderAll(); closeDrawer(); $("in-msg").focus(); return; }
  const chat = { id: uid(), title: t("chat.untitled"), updatedAt: Date.now(), messages: [] };
  chats.unshift(chat);
  currentId = chat.id;
  putChat(chat);
  go("/new");
  renderAll();
  closeDrawer();
  $("in-msg").focus();
}

function selectChat(id) {
  currentId = id;
  const c = current();
  go(c && c.messages.length ? `/chat/${id}` : "/new");
  renderAll();
  closeDrawer();
}

function deleteChat(id) {
  chats = chats.filter((c) => c.id !== id);
  if (currentId === id) {
    currentId = chats[0]?.id || null;
    if (state.session) { state.session.destroy(); state.session = null; state.sessionOf = null; }
  }
  removeChat(id);
  if (!chats.length) { newChat(); return; }
  const c = current();
  go(c && c.messages.length ? `/chat/${c.id}` : "/new", true);
  renderAll();
}

function touch(chat) {
  chat.updatedAt = Date.now();
  chats = [chat, ...chats.filter((c) => c.id !== chat.id)];
  putChat(chat);
}

/* ══ Rendering ═════════════════════════════════════════════════ */
function renderAll() { renderSidebar(); renderChat(); }

/** Search matches the title and the message bodies, so an old conversation is
    findable by something said inside it, not just by its first line. */
function matches(chat, needle) {
  if (!needle) return true;
  if (chat.title.toLowerCase().includes(needle)) return true;
  return chat.messages.some((m) => m.content.toLowerCase().includes(needle));
}

function highlight(text, needle) {
  if (!needle) return esc(text);
  const i = text.toLowerCase().indexOf(needle);
  if (i < 0) return esc(text);
  return esc(text.slice(0, i)) + "<mark>" + esc(text.slice(i, i + needle.length)) + "</mark>" + esc(text.slice(i + needle.length));
}

function renderSidebar() {
  const list = $("chat-list");
  const needle = $("in-search").value.trim().toLowerCase();
  list.innerHTML = "";
  $("btn-search-clear").classList.toggle("hidden", !needle);

  const shown = chats.filter((c) => matches(c, needle));
  if (!shown.length) {
    const p = document.createElement("p");
    p.className = "sb__empty";
    p.textContent = needle ? t("sb.noResults") : t("sb.empty");
    list.appendChild(p);
    return;
  }

  for (const c of shown) {
    const row = document.createElement("div");
    row.className = "conv" + (c.id === currentId ? " is-active" : "");
    row.innerHTML = `<i class="fa-regular fa-message" style="font-size:.75rem"></i>
      <span class="conv__title"></span>
      <button class="conv__del" type="button"><i class="fa-solid fa-trash"></i></button>`;
    // Only the matched slice is markup; both sides of it go through esc().
    row.querySelector(".conv__title").innerHTML = highlight(c.title, needle);
    row.querySelector(".conv__del").title = t("a11y.delete");
    row.addEventListener("click", () => selectChat(c.id));
    row.querySelector(".conv__del").addEventListener("click", (e) => { e.stopPropagation(); deleteChat(c.id); });
    list.appendChild(row);
  }
}

function renderChat() {
  const c = current();
  const msgs = $("msgs");
  msgs.innerHTML = "";
  $("chat-title").textContent = c?.title || t("chat.untitled");

  // Summarising needs at least a full exchange and a browser that can do it.
  const canSummarise = summarizer.available()
    && (c?.messages.filter((m) => m.role === "user" || m.role === "assistant").length || 0) >= 2;
  $("btn-summarize").classList.toggle("hidden", !canSummarise);

  const empty = !c || c.messages.length === 0;
  $("welcome").classList.toggle("hidden", !empty);
  msgs.classList.toggle("hidden", empty);
  if (empty) return;

  for (const m of c.messages) appendMsg(m.role, m.content);
  scrollDown(true);
}

function appendMsg(role, content) {
  const who = role === "user" ? "user" : role === "error" ? "err" : "ai";
  const el = document.createElement("div");
  el.className = "msg msg--" + who;
  const name = who === "user" ? t("msg.you") : who === "err" ? t("msg.error") : t("msg.ai");
  const mark = who === "user" ? '<i class="fa-solid fa-user"></i>'
    : who === "err" ? '<i class="fa-solid fa-circle-exclamation"></i>'
    : '<span class="brainmark"></span>';
  el.innerHTML = `<div class="msg__ic">${mark}</div>
    <div class="msg__body">
      <div class="msg__who"></div>
      <div class="msg__text"></div>
      <div class="msg__tools"></div>
    </div>`;
  el.querySelector(".msg__who").textContent = name;
  const body = el.querySelector(".msg__text");
  body.innerHTML = render(content);

  if (who !== "err") {
    const copy = document.createElement("button");
    copy.className = "msg__tool";
    copy.type = "button";
    copy.innerHTML = `<i class="fa-regular fa-copy"></i> <span>${esc(t("msg.copy"))}</span>`;
    copy.addEventListener("click", () => {
      navigator.clipboard.writeText(body.textContent).then(() => toast(t("msg.copied")));
    });
    el.querySelector(".msg__tools").appendChild(copy);
  }

  $("msgs").appendChild(el);
  return body;
}

function scrollDown(instant) {
  const s = $("scroll");
  s.scrollTo({ top: s.scrollHeight, behavior: instant ? "auto" : "smooth" });
}

/* ══ Notifications ═════════════════════════════════════════════
   Purely local: no push service, no subscription, no server. The tab itself
   fires the notification when an answer lands while the tab is in the
   background. Permission is asked at most once, from the send click, because
   Chrome only allows the prompt during a user gesture. */
const LS_NOTIFY_ASKED = "miniai.notify-asked";

/* The browser prompt is never opened on its own: it would land on top of the
   very first answer, before the user has any reason to want it. Instead a
   toast offers it, and the click on "Enable" is the gesture Chrome needs. */
function offerNotifications() {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "default") return;
  if (localStorage.getItem(LS_NOTIFY_ASKED)) return;         // never nag twice
  $("toast-notify").classList.add("is-on");
}

function dismissNotifyToast() {
  $("toast-notify").classList.remove("is-on");
  localStorage.setItem(LS_NOTIFY_ASKED, "1");
}

async function notifyAnswer(text) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (!document.hidden) return;                 // the user is already looking

  const body = text.replace(/\s+/g, " ").trim().slice(0, 140) || t("msg.empty");
  const opts = {
    body,
    icon: "/res/icon-192.png",
    badge: "/res/icon-192.png",
    tag: "miniai-answer",                       // a new answer replaces the old one
    lang: t("html.lang"),
  };
  try {
    // The service worker path is the only one that works on Android Chrome,
    // and it is what makes the click able to focus this tab.
    const reg = await navigator.serviceWorker?.ready;
    if (reg) { await reg.showNotification(t("notif.title"), opts); return; }
    const n = new Notification(t("notif.title"), opts);
    n.addEventListener("click", () => { window.focus(); n.close(); });
  } catch (err) {
    log("notification failed: " + err.message);
  }
}

/* ══ Sending ═══════════════════════════════════════════════════ */
async function send(text) {
  text = text.trim();
  if (!text || state.busy || state.availability !== "available") return;

  offerNotifications();    // a toast, not the browser prompt — see below

  let chat = current();
  if (!chat) { newChat(); chat = current(); }

  // The first user line becomes the conversation title, and the blank /new URL
  // is replaced by this chat's own address, so a reload lands back on it. The
  // truncated line is only a placeholder now: once the answer lands, the
  // Summarizer replaces it with a real title, when the browser has one.
  const firstTurn = chat.messages.length === 0;
  if (firstTurn) {
    chat.title = text.length > 42 ? text.slice(0, 42).trim() + "…" : text;
    $("chat-title").textContent = chat.title;
    go(`/chat/${chat.id}`, true);
  }

  $("welcome").classList.add("hidden");
  $("msgs").classList.remove("hidden");

  chat.messages.push({ role: "user", content: text });
  appendMsg("user", text);
  touch(chat);
  renderSidebar();

  $("in-msg").value = "";
  autoGrow();
  scrollDown();

  const out = appendMsg("assistant", "");
  out.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  scrollDown();

  state.busy = true;
  state.abort = new AbortController();
  toggleSend(true);

  let acc = "";
  const t0 = performance.now();
  let tFirst = null;
  try {
    const session = await ensureSession();
    log(`promptStreaming(${text.length} chars)`);
    // Each chunk is a delta of the answer — concatenate as they arrive.
    const constraint = activeConstraint();
    if (constraint) log("responseConstraint active");
    const stream = session.promptStreaming(text, {
      signal: state.abort.signal,
      ...(constraint ? { responseConstraint: constraint } : {}),
    });
    const atBottom = () => { const s = $("scroll"); return s.scrollHeight - s.scrollTop - s.clientHeight < 120; };
    for await (const chunk of stream) {
      const stick = atBottom();
      if (tFirst === null) tFirst = performance.now();
      acc += chunk;
      out.innerHTML = render(acc);
      if (stick) scrollDown(true);
    }
    if (!acc) acc = t("msg.empty");
    if (constraint) acc = prettyJson(acc);
    out.innerHTML = render(acc);
    chat.messages.push({ role: "assistant", content: acc });
    log("answer complete");
    notifyAnswer(acc);
    // A constrained answer is not prose to name a chat from; keep the
    // truncated first line rather than summarising raw JSON.
    if (firstTurn && !constraint) autoTitle(chat, text, acc);
  } catch (err) {
    if (err.name === "AbortError") {
      acc = (acc || "").trim() + " ⏹";
      out.innerHTML = render(acc);
      chat.messages.push({ role: "assistant", content: acc });
      log("generation stopped by the user");
    } else {
      out.closest(".msg").className = "msg msg--err";
      out.textContent = err.message;
      chat.messages.push({ role: "error", content: err.message });
      log("prompt failed: " + err.message);
    }
  } finally {
    // Measured even on abort: a stopped answer still says how fast it was
    // going. The session is asked for a token count; only WebLLM keeps one.
    if (tFirst !== null) {
      state.lastRun = {
        ttft: tFirst - t0,
        ms: performance.now() - tFirst,
        chars: acc.length,
        tokens: state.session?.lastCompletionTokens || null,
      };
    }
    touch(chat);
    state.busy = false;
    state.abort = null;
    toggleSend(false);
    updateQuota();
    $("in-msg").focus();
  }
}

/* ══ Summaries ═════════════════════════════════════════════════
   Both jobs run through the Summarizer API when the browser has it, and are
   plain no-ops when it does not — the truncated first line simply stays. */

/** Replaces the placeholder title with a generated one, once per chat. Never
    blocks sending: it runs after the answer, and any failure is swallowed so
    the chat keeps the line it already had. */
async function autoTitle(chat, question, answer) {
  if (!summarizer.available()) return;
  try {
    // Named from the exchange, not just the question — the answer often makes
    // the topic clearer than the prompt did.
    const source = `${question}\n\n${answer}`.slice(0, 4000);
    const title = await summarizer.title(source);
    if (!title) return;
    chat.title = title.length > 60 ? title.slice(0, 60).trim() + "…" : title;
    if (currentId === chat.id) $("chat-title").textContent = chat.title;
    putChat(chat);
    renderSidebar();
    log("title summarised");
  } catch (err) {
    log("auto-title skipped: " + err.message);
  }
}

/** The "summarise this conversation" button: a tl;dr posted back into the
    transcript as an assistant message, so it is copyable and saved like any
    other. */
async function summariseChat() {
  const chat = current();
  if (!chat || state.busy) return;
  const turns = chat.messages.filter((m) => m.role === "user" || m.role === "assistant");
  if (turns.length < 2) { toast(t("toast.tooShort")); return; }
  if (!summarizer.available()) { toast(t("toast.noSummarizer")); return; }

  state.busy = true;
  toggleSend(true);
  const out = appendMsg("assistant", "");
  out.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  scrollDown();

  try {
    const transcript = turns
      .map((m) => `${m.role === "user" ? t("msg.you") : t("msg.ai")}: ${m.content}`)
      .join("\n\n");
    log("summarize(tldr)");
    const digest = await summarizer.digest(transcript.slice(0, 12000), showProgress);
    hideProgress();
    const text = `**${t("summary.heading")}**\n\n${digest}`;
    out.innerHTML = render(text);
    chat.messages.push({ role: "assistant", content: text });
    touch(chat);
    log("summary complete");
  } catch (err) {
    hideProgress();
    out.closest(".msg").className = "msg msg--err";
    out.textContent = err.message;
    log("summary failed: " + err.message);
  } finally {
    state.busy = false;
    toggleSend(false);
    scrollDown();
  }
}

function toggleSend(generating) {
  const b = $("btn-send");
  b.classList.toggle("is-stop", generating);
  b.innerHTML = generating ? '<i class="fa-solid fa-stop"></i>' : '<i class="fa-solid fa-arrow-up"></i>';
  b.title = generating ? t("composer.stop") : t("composer.send");
  b.disabled = false;
  $("in-msg").disabled = generating;
  paintMic();
}

/* ══ Drawer (mobile) ═══════════════════════════════════════════ */
function openDrawer() { $("sb").classList.add("is-open"); $("sb-scrim").classList.add("is-on"); }
function closeDrawer() { $("sb").classList.remove("is-open"); $("sb-scrim").classList.remove("is-on"); }
function toggleSidebar() {
  if (window.matchMedia("(max-width:900px)").matches) {
    $("sb").classList.contains("is-open") ? closeDrawer() : openDrawer();
  } else {
    $("sb").classList.toggle("is-collapsed");
  }
}

/* ══ Resizable sidebar ═════════════════════════════════════════
   Drag the right edge, like Claude's web app. The width is a CSS variable so
   the collapsed offset follows it, and it is remembered across reloads.
   Double-clicking the handle restores the default. */
const SB_MIN = 200, SB_MAX = 480, SB_DEFAULT = 270;

function applySidebarWidth(px) {
  const w = Math.round(Math.min(SB_MAX, Math.max(SB_MIN, px)));
  document.documentElement.style.setProperty("--sb-w", w + "px");
  return w;
}

(function initResizer() {
  const handle = $("sb-resizer");
  const sb = $("sb");
  applySidebarWidth(settings.sidebarWidth || SB_DEFAULT);

  let dragging = false;

  handle.addEventListener("pointerdown", (e) => {
    if (window.matchMedia("(max-width:900px)").matches) return;
    dragging = true;
    handle.setPointerCapture(e.pointerId);
    sb.classList.add("is-resizing");
    document.body.classList.add("is-resizing");
    e.preventDefault();
  });

  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    // The sidebar starts at the viewport's left edge, so the pointer's x is
    // the width outright.
    applySidebarWidth(e.clientX);
  });

  const stop = (e) => {
    if (!dragging) return;
    dragging = false;
    handle.releasePointerCapture?.(e.pointerId);
    sb.classList.remove("is-resizing");
    document.body.classList.remove("is-resizing");
    settings.sidebarWidth = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--sb-w"), 10);
    saveSettings();
  };
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);

  handle.addEventListener("dblclick", () => {
    settings.sidebarWidth = applySidebarWidth(SB_DEFAULT);
    saveSettings();
  });
})();

/* ══ Settings modal ════════════════════════════════════════════ */
function openModal() {
  $("in-temp").value = settings.temperature;
  $("in-topk").value = settings.topK;
  $("in-system").value = settings.system ?? t("sys.default");
  syncLabels();
  paintSegments();
  paintEngine();
  paintCacheList();
  paintJson();
  $("modal").classList.remove("hidden");
  closeDrawer();
}

/* ══ Advanced panel ════════════════════════════════════════════
   Capabilities and ceilings, never utilisation — see probeGPU(). Every row is
   built the same way so a value the browser refuses to give reads as an
   explicit "not exposed" instead of quietly vanishing. */
function advRow(icon, label, value) {
  const row = document.createElement("div");
  row.className = "abt-sync";
  row.innerHTML = `<span class="abt-sync__l"><i class="fa-solid ${icon}"></i> <span></span></span>
    <span class="abt-sync__v"></span>`;
  row.querySelector(".abt-sync__l span").textContent = label;
  const v = row.querySelector(".abt-sync__v");
  v.textContent = value ?? t("adv.unknown");
  if (value == null) v.style.opacity = ".6";
  return row;
}

const gb = (n) => (n / 1e9).toFixed(1) + " GB";
const mb = (n) => Math.round(n / 1e6) + " MB";

async function paintAdvanced() {
  const grid = $("adv-grid");
  grid.innerHTML = "";

  if (!state.gpu && "gpu" in navigator) state.gpu = await probeGPU();
  const g = state.gpu;

  // ── GPU ──
  const name = g && (g.description || [g.vendor, g.architecture].filter(Boolean).join(" ") || g.device);
  grid.appendChild(advRow("fa-microchip", t("adv.gpu"), name || null));
  grid.appendChild(advRow("fa-code", t("adv.f16"),
    g ? t(g.f16 ? "adv.yes" : "adv.no") : null));
  grid.appendChild(advRow("fa-database", t("adv.maxBuffer"),
    g?.maxBufferSize ? mb(g.maxBufferSize) : null));

  // ── Machine ──
  grid.appendChild(advRow("fa-memory", t("adv.ram"),
    navigator.deviceMemory ? `≥ ${navigator.deviceMemory} GB` : null));
  grid.appendChild(advRow("fa-gauge-high", t("adv.cores"),
    navigator.hardwareConcurrency || null));

  // ── Storage ──
  let est = null;
  try { est = await navigator.storage?.estimate?.(); } catch { /* blocked */ }
  grid.appendChild(advRow("fa-hard-drive", t("adv.storage"),
    est ? `${gb(est.usage)} / ${gb(est.quota)}` : null));

  const persisted = await navigator.storage?.persisted?.().catch(() => null);
  grid.appendChild(advRow("fa-shield-halved", t("adv.persisted"),
    persisted == null ? null : t(persisted ? "adv.persistOn" : "adv.persistOff")));
  // Asking again once it is granted would be noise.
  $("btn-persist").classList.toggle("hidden", persisted !== false);

  // ── Last generation ──
  const r = state.lastRun;
  grid.appendChild(advRow("fa-stopwatch", t("adv.ttft"), r ? `${Math.round(r.ttft)} ms` : null));
  grid.appendChild(advRow("fa-bolt", t("adv.speed"), r ? advSpeed(r) : null));
}

/** Tokens per second when the engine counts them, characters per second when
    it does not — the Prompt API reports no token count for its output. */
function advSpeed(r) {
  const secs = r.ms / 1000;
  if (!secs) return null;
  if (r.tokens) return `${(r.tokens / secs).toFixed(1)} tok/s`;
  return `≈ ${Math.round(r.chars / secs)} ${t("adv.charsPerSec")}`;
}

$("btn-persist").addEventListener("click", async () => {
  try {
    const ok = await navigator.storage.persist();
    log("storage.persist() → " + ok);
    toast(t(ok ? "adv.persistGranted" : "adv.persistDenied"));
    paintAdvanced();
  } catch (err) {
    log("persist failed: " + err.message);
  }
});

/* ══ Cached weights ════════════════════════════════════════════
   Gigabytes of model land in the browser's storage, and the app that put them
   there is the only thing that knows what they are — so it has to be able to
   show them and throw them away. */

/** Refreshes the "which models are on disk" view of the world, then repaints
    everything that depends on it. Cheap when the WebLLM module is already
    loaded, and a no-op when it is not: it never triggers the import itself. */
async function refreshCache() {
  state.cached = await PROVIDERS.webllm.cachedModels().catch(() => null);
  fillModelPicker();
  paintCacheList();
}

/** A human size for the whole cache. Per-model figures are not available —
    the browser reports one number for the origin — so the catalogue's own
    sizes stand in per row, and this is the real total next to them. */
async function paintCacheTotal() {
  const el = $("cache-total");
  if (!navigator.storage?.estimate) { el.textContent = ""; return; }
  try {
    const { usage, quota } = await navigator.storage.estimate();
    const gb = (n) => (n / 1e9).toFixed(1) + " GB";
    el.textContent = `${t("set.cacheTotal")} ${gb(usage)} / ${gb(quota)}`;
  } catch { el.textContent = ""; }
}

function paintCacheList() {
  const sec = $("cache-sec");
  const list = $("cache-list");
  // Nothing to say about the cache while the Prompt API is the active engine:
  // Chrome owns that model and manages it at chrome://on-device-internals.
  const relevant = settings.provider === "webllm" && state.cached;
  sec.classList.toggle("hidden", !relevant);
  if (!relevant) return;

  list.innerHTML = "";
  const downloaded = WEBLLM_MODELS.filter((m) => state.cached.has(m.id));
  if (!downloaded.length) {
    const p = document.createElement("p");
    p.className = "cache-empty";
    p.textContent = t("set.cacheEmpty");
    list.appendChild(p);
    paintCacheTotal();
    return;
  }

  for (const m of downloaded) {
    const row = document.createElement("div");
    row.className = "cache-row";
    row.innerHTML = `<i class="fa-solid fa-circle-check cache-row__ic"></i>
      <span class="cache-row__t"><b></b><small></small></span>
      <button class="cache-row__del" type="button"></button>`;
    row.querySelector("b").textContent = m.label;
    row.querySelector("small").textContent = m.id === settings.webllmModel
      ? `${m.size} · ${t("set.cacheInUse")}`
      : m.size;
    const del = row.querySelector("button");
    del.textContent = t("set.cacheDelete");
    del.addEventListener("click", () => deleteCachedModel(m, del));
    list.appendChild(row);
  }
  paintCacheTotal();
}

async function deleteCachedModel(m, btn) {
  if (!confirm(t("confirm.deleteModel").replace("{model}", m.label))) return;
  btn.disabled = true;
  try {
    // Deleting the model in use tears down the live engine with it, so the
    // session built on top of it is gone too.
    if (m.id === settings.webllmModel) invalidateSession();
    await PROVIDERS.webllm.deleteModel(m.id);
    log("deleted from cache: " + m.id);
    toast(t("toast.modelDeleted"));
    await refreshCache();
    await refresh();
  } catch (err) {
    btn.disabled = false;
    log("delete failed: " + err.message);
    toast(t("toast.deleteFailed"));
  }
}

/** Both model pickers — settings and the offer in the incompatibility modal —
    are built from the catalogue in providers.js, so the list and the sizes
    shown next to it can never drift apart. */
function fillModelPicker() {
  // A stored id that is no longer in the catalogue would leave the select with
  // no selection at all, so it falls back to the default.
  if (!WEBLLM_MODELS.some((m) => m.id === settings.webllmModel)) {
    settings.webllmModel = WEBLLM_DEFAULT;
  }
  for (const id of ["in-model", "ic-model"]) {
    const sel = $(id);
    sel.innerHTML = "";
    for (const m of WEBLLM_MODELS) {
      const o = document.createElement("option");
      o.value = m.id;
      // state.cached is null until the WebLLM module has been loaded by
      // something else, and an unknown cache must not read as an empty one.
      const badge = state.cached?.has(m.id) ? ` · ${t("set.downloaded")}` : "";
      // A q4f16 model on a GPU without shader-f16 downloads in full and then
      // fails to load, so it is disabled rather than merely discouraged.
      // state.gpu null means "not probed yet", which must not disable anything.
      const blocked = m.f16 && state.gpu && !state.gpu.f16;
      o.disabled = !!blocked;
      o.textContent = `${m.label} · ${m.size}${badge}${blocked ? ` · ${t("set.needsF16")}` : ""}`;
      sel.appendChild(o);
    }
    sel.value = settings.webllmModel;
  }
}
function closeModal() { $("modal").classList.add("hidden"); }

/* ══ About modal ═══════════════════════════════════════════════ */
function openAbout() {
  // The live figures are read at open time, so the panel never shows a stale
  // snapshot of the model state.
  $("about-engine").textContent = engineLabel();
  $("about-avail").textContent = state.availability;
  $("about-session").textContent = state.session ? t("kv.active") : t("kv.none");
  $("about-quota").textContent = $("kv-quota").textContent;
  $("about-storage").textContent = `${db ? "IndexedDB" : "localStorage"} · ${chats.length} ${t("about.chats")}`;

  const sw = "serviceWorker" in navigator && navigator.serviceWorker.controller;
  const standalone = matchMedia("(display-mode: standalone)").matches;
  $("about-pwa").textContent = (sw ? t("about.swOn") : t("about.swOff")) + (standalone ? ` · ${t("about.installed")}` : "");

  paintAdvanced();
  $("modal-about").classList.remove("hidden");
  closeDrawer();
}
function closeAbout() { $("modal-about").classList.add("hidden"); }

function syncLabels() {
  $("lbl-temp").textContent = Number($("in-temp").value).toFixed(1);
  $("lbl-topk").textContent = $("in-topk").value;
}

/** Any generation setting change invalidates the live session; it is rebuilt
    (with the same history) on the next message. */
function invalidateSession() {
  if (state.session) { state.session.destroy(); state.session = null; state.sessionOf = null; }
  $("kv-session").textContent = t("kv.none");
}

function applyTheme() {
  const r = document.documentElement;
  r.classList.remove("dark", "light");
  if (settings.theme) r.classList.add(settings.theme);
}
function paintSegments() {
  for (const b of $("seg-theme").children) b.classList.toggle("is-active", b.dataset.theme === settings.theme);
  for (const b of $("seg-lang").children) b.classList.toggle("is-active", b.dataset.lang === settings.lang);
}

/* ══ Structured output ═════════════════════════════════════════
   The one schema drives both engines: responseConstraint on the Prompt API,
   response_format on WebLLM. Held as text so a half-typed schema is not lost
   on every keystroke; parsed only when it is actually used or shown. */
function parsedSchema() {
  try {
    const o = JSON.parse(settings.jsonSchema);
    return (o && typeof o === "object") ? o : null;
  } catch { return null; }
}

/** The live constraint for the next message, or null when the feature is off
    or the schema does not parse — a broken schema silently falls back to a
    normal answer rather than blocking the send. */
function activeConstraint() {
  return settings.jsonMode ? parsedSchema() : null;
}

function paintJson() {
  $("in-json").checked = settings.jsonMode;
  $("json-field").classList.toggle("hidden", !settings.jsonMode);
  $("in-schema").value = settings.jsonSchema;
  validateSchema();
}

function validateSchema() {
  const el = $("json-status");
  if (!settings.jsonMode) { el.textContent = ""; el.className = "m3-body-small"; return; }
  const ok = !!parsedSchema();
  el.textContent = ok ? t("set.jsonValid") : t("set.jsonInvalid");
  el.className = "m3-body-small " + (ok ? "is-ok" : "is-err");
}

/* ══ Composer sizing ═══════════════════════════════════════════ */
function autoGrow() {
  const el = $("in-msg");
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 180) + "px";
}

/* ══ Dictation: speech recognition on the device ═══════════════
   Chrome 138+ can run the Web Speech API without touching the network. The
   default path streams the microphone to Google's servers, which this project
   promises never to do, so processLocally is not an optimisation here — it is
   the only acceptable mode. With the flag set a missing local model fails as
   `language-not-supported` instead of quietly falling back to the cloud, and
   that loud failure is what makes the promise auditable.
   Desktop only: Android and iOS do not expose it, hence the button hides
   itself rather than offering something that cannot work. */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const micSupported = !!SR && "processLocally" in SR.prototype;

const dict = { rec: null, live: false, installing: false, base: "", final: "" };

/** BCP-47 tag for the recogniser, following the interface language. */
function micLang() { return lang === "pt" ? "pt-BR" : "en-US"; }

/** The button carries no data-i18n attributes: its label flips with the state,
    so applyI18n would fight this function over it. */
function paintMic() {
  const b = $("btn-mic");
  b.classList.toggle("hidden", !micSupported);
  b.classList.toggle("is-live", dict.live);
  b.disabled = dict.installing || (!dict.live && $("in-msg").disabled);
  b.innerHTML = dict.installing
    ? '<i class="fa-solid fa-spinner fa-spin"></i>'
    : `<i class="fa-solid fa-microphone${dict.live ? "-lines" : ""}"></i>`;
  const label = t(dict.live ? "mic.stop" : "mic.start");
  b.title = label;
  b.setAttribute("aria-label", label);
}

/** Writes into the composer as if the user had typed it. */
function setComposerText(text) {
  $("in-msg").value = text;
  autoGrow();
  if (!state.busy) $("btn-send").disabled = !text.trim() || state.availability !== "available";
}

/** Resolves once the language pack is on disk, false if it can never be. */
async function ensureMicModel() {
  const code = micLang();
  // Early 138 builds shipped processLocally without the install API; there the
  // pack either exists already or start() reports language-not-supported.
  if (typeof SR.availableOnDevice !== "function") return true;

  const status = await SR.availableOnDevice(code).catch(() => "unavailable");
  if (status === "available") return true;
  if (status === "unavailable") { toast(t("mic.noLang")); return false; }

  dict.installing = true;
  paintMic();
  toast(t("mic.downloading"));
  log(`speech model download: ${code}`);
  try {
    const ok = await SR.installOnDevice(code);
    if (!ok) { toast(t("mic.noLang")); return false; }
    log(`speech model ready: ${code}`);
    toast(t("mic.ready"));
    return true;
  } catch {
    toast(t("mic.noLang"));
    return false;
  } finally {
    dict.installing = false;
    paintMic();
  }
}

async function startDictation() {
  if (!micSupported || dict.live || dict.installing) return;
  if (!(await ensureMicModel())) return;

  const rec = new SR();
  rec.lang = micLang();
  rec.processLocally = true;
  rec.continuous = true;
  rec.interimResults = true;

  // Anything already typed stays put; speech is appended after it. Finalised
  // text accumulates separately because the interim tail is rewritten on every
  // event until the decoder commits it.
  dict.base = $("in-msg").value.trim();
  dict.final = "";

  rec.onstart = () => { dict.live = true; paintMic(); log("dictation started"); };
  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const chunk = e.results[i][0].transcript;
      if (e.results[i].isFinal) dict.final += chunk; else interim += chunk;
    }
    setComposerText([dict.base, (dict.final + interim).trim()].filter(Boolean).join(" "));
  };
  rec.onerror = (e) => {
    if (e.error === "aborted") return;   // our own stop() on send
    toast(t({
      "not-allowed": "mic.denied",
      "service-not-allowed": "mic.denied",
      "language-not-supported": "mic.noLang",
      "no-speech": "mic.noSpeech",
    }[e.error] || "mic.error"));
    log(`dictation error: ${e.error}`);
  };
  rec.onend = () => { dict.live = false; dict.rec = null; paintMic(); $("in-msg").focus(); };

  dict.rec = rec;
  try {
    rec.start();
  } catch {
    dict.live = false; dict.rec = null; paintMic();
  }
}

function stopDictation() { dict.rec?.stop(); }

/* ══ Wiring ════════════════════════════════════════════════════ */
$("btn-menu").addEventListener("click", toggleSidebar);
$("btn-sb-close").addEventListener("click", closeDrawer);
$("sb-scrim").addEventListener("click", closeDrawer);
$("btn-new").addEventListener("click", newChat);
$("btn-new-top").addEventListener("click", newChat);
$("btn-summarize").addEventListener("click", summariseChat);

$("btn-settings").addEventListener("click", openModal);
$("btn-settings-sb").addEventListener("click", openModal);
$("btn-settings-sb2").addEventListener("click", openModal);
$("btn-tune").addEventListener("click", openModal);
$("btn-modal-close").addEventListener("click", closeModal);
$("modal").addEventListener("click", (e) => { if (e.target === $("modal")) closeModal(); });

$("btn-about-sb").addEventListener("click", openAbout);
$("btn-about-from-settings").addEventListener("click", () => { closeModal(); openAbout(); });
$("btn-about-settings").addEventListener("click", () => { closeAbout(); openModal(); });
$("btn-about-close").addEventListener("click", closeAbout);
$("modal-about").addEventListener("click", (e) => { if (e.target === $("modal-about")) closeAbout(); });

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeAbout(); closeModal(); closeDrawer(); }
});

$("ic-retry").addEventListener("click", () => refresh().then(() => toast(t("toast.rechecked"))));
$("ic-dismiss").addEventListener("click", () => {
  state.incompatDismissed = true;
  $("modal-incompat").classList.add("hidden");
});
/* The offer's one button does the whole thing: switch engine, then start the
   download without a second trip through the UI. Switching is enough to clear
   the blocking state, so the modal closes on its own and the download carries
   on behind it, on the welcome card's copy of the progress bar. */
$("ic-go").addEventListener("click", async () => {
  const btn = $("ic-go");
  btn.disabled = true;
  try {
    await setProvider(settings.provider === "chrome" ? "webllm" : "chrome");
    if (state.availability === "downloadable") await downloadModel();
  } finally {
    btn.disabled = false;
  }
});

/* Picking a model from inside the offer, before anything is downloaded. */
$("ic-model").addEventListener("change", () => {
  settings.webllmModel = $("ic-model").value;
  saveSettings();
  $("in-model").value = settings.webllmModel;
  log("webllm model → " + settings.webllmModel);
});

$("seg-engine").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-engine]");
  if (b) setProvider(b.dataset.engine);
});

$("in-model").addEventListener("change", async () => {
  settings.webllmModel = $("in-model").value;
  saveSettings();
  $("ic-model").value = settings.webllmModel;
  paintCacheList();   // the "in use" marker moved
  invalidateSession();
  // The weights the old engine holds are the wrong ones now, and they are the
  // single biggest thing in GPU memory — drop them before touching the new.
  await PROVIDERS.webllm.disposeEngine();
  hideProgress();
  log("webllm model → " + settings.webllmModel);
  await refresh();
});

$("btn-download").addEventListener("click", downloadModel);
$("btn-download-set").addEventListener("click", downloadModel);
for (const id of DL_BARS) $(`${id}-cancel`).addEventListener("click", cancelDownload);
$("btn-refresh").addEventListener("click", () => refresh().then(() => toast(t("toast.rechecked"))));
$("btn-destroy").addEventListener("click", destroySession);

$("in-temp").addEventListener("input", syncLabels);
$("in-topk").addEventListener("input", syncLabels);
$("in-temp").addEventListener("change", () => { settings.temperature = Number($("in-temp").value); saveSettings(); invalidateSession(); });
$("in-topk").addEventListener("change", () => { settings.topK = Number($("in-topk").value); saveSettings(); invalidateSession(); });
$("in-json").addEventListener("change", () => {
  settings.jsonMode = $("in-json").checked;
  saveSettings();
  $("json-field").classList.toggle("hidden", !settings.jsonMode);
  validateSchema();
});
$("in-schema").addEventListener("input", () => {
  settings.jsonSchema = $("in-schema").value;
  saveSettings();
  validateSchema();
});

$("in-system").addEventListener("change", () => {
  const v = $("in-system").value.trim();
  // Matching the language default means "not customised", so switching the
  // language keeps moving the prompt along with it.
  settings.system = (!v || v === t("sys.default")) ? null : v;
  saveSettings(); invalidateSession();
});

$("seg-theme").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-theme]");
  if (!b) return;
  settings.theme = b.dataset.theme;
  saveSettings(); applyTheme(); paintSegments();
});

$("seg-lang").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-lang]");
  if (!b) return;
  settings.lang = b.dataset.lang;
  saveSettings();
  applyI18n();
  paintSegments();
  invalidateSession();   // the system prompt may have changed with the language
});

$("btn-export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(chats, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "local-mini-ai-chats.json";
  a.click();
  URL.revokeObjectURL(a.href);
  toast(t("toast.exported"));
});

$("btn-wipe").addEventListener("click", async () => {
  if (!confirm(t("confirm.wipe"))) return;
  chats = []; currentId = null;
  await clearChats();
  invalidateSession();
  $("in-search").value = "";
  newChat(); closeModal(); toast(t("toast.wiped"));
});

$("in-search").addEventListener("input", renderSidebar);
$("in-search").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.stopPropagation(); $("in-search").value = ""; renderSidebar(); }
});
$("btn-search-clear").addEventListener("click", () => {
  $("in-search").value = "";
  renderSidebar();
  $("in-search").focus();
});

$("in-msg").addEventListener("input", () => {
  autoGrow();
  if (!state.busy) $("btn-send").disabled = !$("in-msg").value.trim() || state.availability !== "available";
});
$("in-msg").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("composer").requestSubmit(); }
});
$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  if (state.busy) { state.abort?.abort(); return; }   // the button turns into "stop" while streaming
  stopDictation();   // sending ends the utterance, whatever the decoder still holds
  send($("in-msg").value);
});

$("btn-mic").addEventListener("click", () => (dict.live ? stopDictation() : startDictation()));

// Suggestion cards carry a translation key, so their prompt follows the language.
document.querySelectorAll("[data-sugg]").forEach((b) => {
  b.addEventListener("click", () => send(t(b.dataset.sugg)));
});

// Elevate the top bar once the transcript scrolls under it.
$("scroll").addEventListener("scroll", () => {
  $("topbar").classList.toggle("is-scrolled", $("scroll").scrollTop > 4);
});

/* ══ PWA: install prompt + service worker ══════════════════════ */
let installPrompt = null;

// Chrome only fires this when the app is actually installable (manifest +
// service worker + secure context), so the button stays hidden otherwise.
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  $("btn-install").classList.remove("hidden");
  log("app is installable");
});

$("btn-install").addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  log("install prompt → " + outcome);
  if (outcome === "accepted") $("btn-install").classList.add("hidden");
  installPrompt = null;   // the event is single-use
});

$("btn-notify-on").addEventListener("click", async () => {
  dismissNotifyToast();
  const p = await Notification.requestPermission();
  log("notification permission → " + p);
  if (p === "granted") toast(t("notif.on"));
});

$("btn-notify-no").addEventListener("click", dismissNotifyToast);

window.addEventListener("appinstalled", () => {
  $("btn-install").classList.add("hidden");
  toast(t("toast.installed"));
  log("app installed");
});

/* ══ Window Controls Overlay ═══════════════════════════════════
   Only ever true in the installed desktop app, and the user can toggle it at
   runtime from the app menu, so both the media query and the overlay's own
   geometrychange event have to be watched. */
function initWCO() {
  const wco = navigator.windowControlsOverlay;
  const mq = matchMedia("(display-mode: window-controls-overlay)");

  // getTitlebarAreaRect() is the strip Chrome left free; whatever falls
  // outside it, on either side, is covered by the window buttons. Each element
  // of the top row is pushed by however much of it those buttons actually
  // cover, so a collapsed sidebar or a resized one stays correct.
  const measure = () => {
    const root = document.documentElement.style;
    const free = wco?.getTitlebarAreaRect?.();
    // An empty rect means the geometry is not published yet (it is routinely
    // still zero during boot). The vars are left alone so the env() fallbacks
    // in the stylesheet keep the corners clear until a real rect shows up.
    if (!free || !free.width) { log("wco geometry not ready yet"); return; }
    const freeRight = free.x + free.width;
    const tb = $("topbar").getBoundingClientRect();
    const head = $("sb").getBoundingClientRect();

    root.setProperty("--wco-left", Math.max(0, free.x - tb.left) + "px");
    root.setProperty("--wco-right", Math.max(0, tb.right - freeRight) + "px");
    // The sidebar head has nowhere to go sideways: if the buttons reach into
    // it at all, the whole head drops below them.
    const hit = free.x > head.left && head.width > 0;
    root.setProperty("--wco-head", hit ? free.height + "px" : "0px");

    log(`wco free=[x${Math.round(free.x)} w${Math.round(free.width)} h${Math.round(free.height)}] `
      + `topbar=[${Math.round(tb.left)}→${Math.round(tb.right)}] `
      + `pad=[L${Math.round(Math.max(0, free.x - tb.left))} R${Math.round(Math.max(0, tb.right - freeRight))}] `
      + `head=${hit ? "pushed" : "clear"}`);
  };

  const sync = () => {
    const on = mq.matches || !!wco?.visible;
    document.documentElement.classList.toggle("is-wco", on);
    if (on) measure();
    return on;
  };

  mq.addEventListener("change", () => log("window controls overlay → " + (sync() ? "on" : "off")));
  // Fires when the window is resized or the overlay is toggled: the env vars
  // update on their own, this is only here to keep the class honest.
  wco?.addEventListener("geometrychange", sync);
  window.addEventListener("resize", () => { if (mq.matches) measure(); });
  // Collapsing or dragging the sidebar moves the top bar's left edge, which
  // changes how much of it the buttons cover. Only the sidebar is observed:
  // measure() writes to the top bar, so watching it would feed itself.
  new ResizeObserver(() => { if (mq.matches) measure(); }).observe($("sb"));

  if (sync()) {
    log("window controls overlay active");
    // Boot is too early for the geometry: it is published after the first
    // paint, and nothing fires an event for it. Re-measure on the next frame
    // and once more after load, then let geometrychange take over.
    requestAnimationFrame(measure);
    window.addEventListener("load", measure, { once: true });
  }
}

function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js")
    .then(() => log("service worker registered (network-first)"))
    .catch((err) => log("service worker failed: " + err.message));
}

/* ══ Settings changed elsewhere ════════════════════════════════
   The translator is a separate document writing the same key, so a change made
   there has to reach an already-open chat tab. The event only fires in tabs
   other than the one that wrote, which is exactly the case worth handling. */
window.addEventListener("storage", async (e) => {
  if (e.key !== LS_SETTINGS || !e.newValue) return;
  let incoming;
  try { incoming = JSON.parse(e.newValue); } catch { return; }

  const engineChanged = incoming.provider !== settings.provider
    || incoming.webllmModel !== settings.webllmModel;
  Object.assign(settings, incoming);

  applyTheme();
  applyI18n();
  paintSegments();
  paintEngine();
  log("settings changed in another tab");

  // A live session belongs to the engine that built it, so a swap has to tear
  // it down and ask the new one where it stands.
  if (engineChanged) {
    invalidateSession();
    await PROVIDERS.webllm.disposeEngine();
    hideProgress();
    await refresh();
  }
});

/* ══ Boot ══════════════════════════════════════════════════════ */
(async function boot() {
  applyTheme();
  await loadChats();

  // The URL decides which conversation opens; anything unrecognised lands on
  // a blank /new, which is also what "/" means.
  const wanted = routeId();
  if (wanted && chats.some((c) => c.id === wanted)) {
    currentId = wanted;
  } else {
    const blank = chats.find((c) => c.messages.length === 0);
    currentId = blank ? blank.id : null;
    go("/new", true);
  }

  fillModelPicker();
  applyI18n();               // also renders the sidebar and the transcript
  if (!currentId) newChat();
  syncLabels();
  paintSegments();
  paintEngine();
  refresh();
  initWCO();
  registerSW();
})();
