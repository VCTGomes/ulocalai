/* U Local AI · Translate — Chrome's Translator and LanguageDetector APIs.

   Same promise as the chat: the text is handed to a model inside the browser
   and never goes anywhere else. The only network traffic is Chrome fetching a
   language pack the first time a pair is used, and that is Chrome's download,
   not this page's.

   Two APIs, same lifecycle shape the chat already uses:
     Translator.availability({sourceLanguage, targetLanguage}) → state
     Translator.create({... , monitor}) → { translate, translateStreaming }
     LanguageDetector.create({monitor}) → detect(text) → [{ detectedLanguage }]

   The page shares i18n.js, the stylesheet and the settings key with the chat,
   so theme and language follow whatever was chosen there. */
"use strict";

const $ = (id) => document.getElementById(id);
const LS_SETTINGS = "miniai.settings";

/* ══ Shared settings (theme + language), read-only here ════════ */
const settings = (() => {
  try { return JSON.parse(localStorage.getItem(LS_SETTINGS)) || {}; }
  catch { return {}; }
})();

function saveSettings() { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); }

let lang = "en";
function resolveLang() {
  if (settings.lang && I18N[settings.lang]) return settings.lang;
  const nav = (navigator.languages || [navigator.language || "en"]).map((l) => l.toLowerCase());
  return nav.some((l) => l.startsWith("pt")) ? "pt" : "en";
}
function t(key) { return I18N[lang]?.[key] ?? I18N.en[key] ?? key; }

function applyTheme() {
  const r = document.documentElement;
  r.classList.remove("dark", "light");
  if (settings.theme) r.classList.add(settings.theme);
}

/* ══ Languages ═════════════════════════════════════════════════
   The catalogue is a list of BCP-47 tags; the names come from Intl, in the
   interface language, so nothing has to be translated by hand and the list
   stays honest in both. */
const LANGS = [
  "en", "pt", "es", "fr", "de", "it", "nl", "pl", "ru", "uk", "tr",
  "ar", "hi", "bn", "ja", "ko", "zh", "zh-Hant", "vi", "th", "id", "sv",
];
const AUTO = "auto";
const MAX_CHARS = 5000;

/** "português (Brasil)" style names, falling back to the raw tag. */
function langName(tag) {
  try { return new Intl.DisplayNames([lang], { type: "language" }).of(tag) || tag; }
  catch { return tag; }
}

/** Sorted by name in the current language, so the picker reads alphabetically
    to whoever is actually looking at it. */
function sortedLangs() {
  return LANGS.map((tag) => ({ tag, name: langName(tag) }))
    .sort((a, b) => a.name.localeCompare(b.name, lang));
}

/* ══ State ═════════════════════════════════════════════════════ */
const state = {
  supported: false,
  translator: null,
  pair: null,        // "<src>|<dst>" the live translator was built for
  detector: null,
  detected: null,    // tag detected for the current text, when src is "auto"
  busy: false,
  seq: 0,            // guards against an older translation landing last
};

/* ══ Small helpers ═════════════════════════════════════════════ */
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

/** The strip under the panes is the page's only status surface: pack
    downloads, failures and nothing else. */
function showStrip({ title, desc, error, progress }) {
  const strip = $("strip");
  strip.classList.remove("hidden");
  strip.classList.toggle("is-err", !!error);
  $("strip-ic").className = error ? "fa-solid fa-triangle-exclamation" : "fa-solid fa-cloud-arrow-down";
  $("strip-title").textContent = title;
  $("strip-desc").textContent = desc || "";
  const on = typeof progress === "number";
  $("dl").classList.toggle("hidden", !on);
  if (on) $("dl-fill").style.width = Math.round(progress * 100) + "%";
}
function hideStrip() { $("strip").classList.add("hidden"); }

/* ══ i18n ══════════════════════════════════════════════════════ */
function applyI18n() {
  lang = resolveLang();
  document.documentElement.lang = t("html.lang");
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-html]")) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of document.querySelectorAll("[data-i18n-ph]")) el.placeholder = t(el.dataset.i18nPh);
  for (const el of document.querySelectorAll("[data-i18n-title]")) el.title = t(el.dataset.i18nTitle);
  for (const el of document.querySelectorAll("[data-i18n-aria]")) el.setAttribute("aria-label", t(el.dataset.i18nAria));
  paintMic();
}

/* ══ Language pickers ══════════════════════════════════════════ */
function fillPickers() {
  const langs = sortedLangs();

  const src = $("src-lang");
  src.innerHTML = "";
  const auto = document.createElement("option");
  auto.value = AUTO;
  auto.textContent = t("tr.detect");
  src.appendChild(auto);

  const dst = $("dst-lang");
  dst.innerHTML = "";
  for (const l of langs) {
    const a = document.createElement("option");
    a.value = l.tag; a.textContent = l.name;
    src.appendChild(a);
    const b = document.createElement("option");
    b.value = l.tag; b.textContent = l.name;
    dst.appendChild(b);
  }

  // Sensible defaults: detect on the left, and on the right whichever of the
  // interface language or English is *not* what the user most likely typed.
  src.value = AUTO;
  dst.value = lang === "pt" ? "en" : "pt";
}

/* ══ Detection ═════════════════════════════════════════════════ */
async function ensureDetector() {
  if (state.detector) return state.detector;
  if (!("LanguageDetector" in self)) return null;
  try {
    state.detector = await LanguageDetector.create({
      monitor(m) {
        m.addEventListener("downloadprogress", (e) => showStrip({
          title: t("tr.dl.detector"), desc: t("tr.dl.once"), progress: e.loaded,
        }));
      },
    });
    hideStrip();
    return state.detector;
  } catch {
    return null;   // detection is a convenience; translation still works
  }
}

/** The source language actually in force: either the explicit pick or the
    detector's best guess. */
async function effectiveSource(text) {
  if ($("src-lang").value !== AUTO) return $("src-lang").value;

  const det = await ensureDetector();
  if (!det) return null;
  try {
    const results = await det.detect(text);
    const best = results?.[0];
    // A low-confidence guess is worse than none: translating from the wrong
    // language produces confident nonsense.
    if (!best || best.confidence < 0.5) return null;
    state.detected = best.detectedLanguage;
    $("detected").textContent = t("tr.detected").replace("{lang}", langName(best.detectedLanguage));
    return best.detectedLanguage;
  } catch {
    return null;
  }
}

/* ══ Translation ═══════════════════════════════════════════════ */
/** Builds (or reuses) a translator for one language pair, downloading the
    pack if this is the first time the pair is asked for. */
async function ensureTranslator(src, dst) {
  const pair = `${src}|${dst}`;
  if (state.translator && state.pair === pair) return state.translator;

  if (state.translator) { state.translator.destroy?.(); state.translator = null; state.pair = null; }

  const avail = await Translator.availability({ sourceLanguage: src, targetLanguage: dst });
  if (avail === "unavailable") {
    const err = new Error("pair-unavailable");
    err.pair = pair;
    throw err;
  }
  if (avail !== "available") {
    showStrip({
      title: t("tr.dl.pack").replace("{pair}", `${langName(src)} → ${langName(dst)}`),
      desc: t("tr.dl.once"),
      progress: 0,
    });
  }

  state.translator = await Translator.create({
    sourceLanguage: src,
    targetLanguage: dst,
    monitor(m) {
      m.addEventListener("downloadprogress", (e) => showStrip({
        title: t("tr.dl.pack").replace("{pair}", `${langName(src)} → ${langName(dst)}`),
        desc: t("tr.dl.once"),
        progress: e.loaded,
      }));
    },
  });
  state.pair = pair;
  hideStrip();
  return state.translator;
}

/** The whole pipeline for the text currently in the box. Every run takes a
    ticket: a slow translation that finishes after a newer one must not
    overwrite it. */
async function translateNow() {
  const text = $("src-text").value.trim();
  const ticket = ++state.seq;

  if (!text) { setOutput("", true); hideStrip(); $("detected").textContent = ""; return; }
  if (text.length > MAX_CHARS) return;

  const dst = $("dst-lang").value;
  const src = await effectiveSource(text);
  if (ticket !== state.seq) return;

  if (!src) {
    $("detected").textContent = "";
    setOutput(t("tr.cantDetect"), true);
    return;
  }
  if (src === dst) { setOutput(text); return; }

  $("out").classList.add("is-working");
  try {
    const translator = await ensureTranslator(src, dst);
    if (ticket !== state.seq) return;

    // Streaming keeps a long paragraph from sitting blank until the end.
    if (typeof translator.translateStreaming === "function") {
      let acc = "";
      for await (const chunk of translator.translateStreaming(text)) {
        if (ticket !== state.seq) return;
        acc += chunk;
        setOutput(acc);
      }
      if (!acc) setOutput(await translator.translate(text));
    } else {
      const out = await translator.translate(text);
      if (ticket !== state.seq) return;
      setOutput(out);
    }
  } catch (err) {
    if (ticket !== state.seq) return;
    setOutput("", true);
    showStrip({
      error: true,
      title: err.message === "pair-unavailable" ? t("tr.err.pair") : t("tr.err.failed"),
      desc: err.message === "pair-unavailable"
        ? t("tr.err.pairDesc").replace("{pair}", `${langName(src)} → ${langName(dst)}`)
        : err.message,
    });
  } finally {
    $("out").classList.remove("is-working");
  }
}

function setOutput(text, muted) {
  const out = $("out");
  out.textContent = text;
  out.classList.toggle("is-empty", !!muted || !text);
  const has = !!text && !muted;
  $("btn-copy").disabled = !has;
  $("btn-speak").disabled = !has || !("speechSynthesis" in window);
}

/* Typing should not fire a translation per keystroke, and should not wait for
   a blur either. A short idle window is the compromise. */
let typingTimer;
function scheduleTranslate() {
  clearTimeout(typingTimer);
  typingTimer = setTimeout(translateNow, 420);
}

/* ══ Dictation ═════════════════════════════════════════════════
   The same on-device-only rule as the chat: without processLocally the audio
   would be streamed to a server, which this page promises never to do, so the
   button hides rather than offering it. */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const micSupported = !!SR && "processLocally" in SR.prototype;
const dict = { rec: null, live: false, base: "" };

function paintMic() {
  const b = $("btn-mic");
  b.classList.toggle("hidden", !micSupported);
  b.classList.toggle("is-live", dict.live);
  const label = t(dict.live ? "mic.stop" : "mic.start");
  b.title = label;
  b.setAttribute("aria-label", label);
  b.innerHTML = `<i class="fa-solid fa-microphone${dict.live ? "-lines" : ""}"></i>`;
}

/** Dictation follows the source language when one is chosen, and the interface
    language while it is still on "detect". */
function micLang() {
  const picked = $("src-lang").value;
  if (picked !== AUTO) return picked;
  return lang === "pt" ? "pt-BR" : "en-US";
}

async function startDictation() {
  if (!micSupported || dict.live) return;
  const code = micLang();
  if (typeof SR.availableOnDevice === "function") {
    const status = await SR.availableOnDevice(code).catch(() => "unavailable");
    if (status === "unavailable") { toast(t("mic.noLang")); return; }
    if (status !== "available") {
      toast(t("mic.downloading"));
      const ok = await SR.installOnDevice(code).catch(() => false);
      if (!ok) { toast(t("mic.noLang")); return; }
    }
  }

  const rec = new SR();
  rec.lang = code;
  rec.processLocally = true;
  rec.continuous = true;
  rec.interimResults = true;
  dict.base = $("src-text").value.trim();
  let final = "";

  rec.onstart = () => { dict.live = true; paintMic(); };
  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const chunk = e.results[i][0].transcript;
      if (e.results[i].isFinal) final += chunk; else interim += chunk;
    }
    $("src-text").value = [dict.base, (final + interim).trim()].filter(Boolean).join(" ");
    paintCount();
    scheduleTranslate();
  };
  rec.onerror = (e) => {
    if (e.error === "aborted") return;
    toast(t({
      "not-allowed": "mic.denied",
      "service-not-allowed": "mic.denied",
      "language-not-supported": "mic.noLang",
      "no-speech": "mic.noSpeech",
    }[e.error] || "mic.error"));
  };
  rec.onend = () => { dict.live = false; dict.rec = null; paintMic(); };

  dict.rec = rec;
  try { rec.start(); } catch { dict.live = false; paintMic(); }
}

/* ══ Settings ══════════════════════════════════════════════════
   Only the genuinely global choices live here; generation parameters stay in
   the chat, which is the only place they mean anything. Everything written
   lands in the key the chat reads, and the chat listens for the change. */
function openModal() {
  paintSegments();
  fillEngineModels();
  $("modal").classList.remove("hidden");
}
function closeModal() { $("modal").classList.add("hidden"); }

function paintSegments() {
  for (const b of $("seg-theme").children) b.classList.toggle("is-active", b.dataset.theme === (settings.theme || ""));
  for (const b of $("seg-lang").children) b.classList.toggle("is-active", b.dataset.lang === (settings.lang || ""));
  const engine = settings.provider || "chrome";
  for (const b of $("seg-engine").children) b.classList.toggle("is-active", b.dataset.engine === engine);
  $("engine-model").classList.toggle("hidden", engine !== "webllm");
}

function fillEngineModels() {
  const sel = $("in-model");
  if (sel.options.length) { sel.value = settings.webllmModel || WEBLLM_DEFAULT; return; }
  for (const m of WEBLLM_MODELS) {
    const o = document.createElement("option");
    o.value = m.id;
    o.textContent = `${m.label} · ${m.size}`;
    sel.appendChild(o);
  }
  sel.value = settings.webllmModel || WEBLLM_DEFAULT;
}

$("btn-settings").addEventListener("click", openModal);
$("btn-modal-close").addEventListener("click", closeModal);
$("modal").addEventListener("click", (e) => { if (e.target === $("modal")) closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

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
  // Language names and their ordering are in the interface language, so the
  // pickers have to be rebuilt — keeping the current choices.
  const src = $("src-lang").value, dst = $("dst-lang").value;
  fillPickers();
  $("src-lang").value = src; $("dst-lang").value = dst;
  paintSegments();
  translateNow();
});

$("seg-engine").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-engine]");
  if (!b) return;
  settings.provider = b.dataset.engine;
  saveSettings(); paintSegments();
  toast(t("tr.set.saved"));
});

$("in-model").addEventListener("change", () => {
  settings.webllmModel = $("in-model").value;
  saveSettings();
  toast(t("tr.set.saved"));
});

/* ══ Wiring ════════════════════════════════════════════════════ */
function paintCount() {
  const n = $("src-text").value.length;
  $("count").textContent = `${n} / ${MAX_CHARS}`;
  $("count").classList.toggle("is-over", n > MAX_CHARS);
}

$("src-text").addEventListener("input", () => { paintCount(); scheduleTranslate(); });
$("src-lang").addEventListener("change", () => {
  $("detected").textContent = "";
  translateNow();
});
$("dst-lang").addEventListener("change", translateNow);

$("btn-clear").addEventListener("click", () => {
  $("src-text").value = "";
  $("detected").textContent = "";
  paintCount();
  setOutput("", true);
  hideStrip();
  $("src-text").focus();
});

/** Swapping with "detect" on the left uses whatever was detected, so the
    button does something sensible instead of nothing. */
$("btn-swap").addEventListener("click", () => {
  const src = $("src-lang").value === AUTO ? state.detected : $("src-lang").value;
  if (!src) { toast(t("tr.cantSwap")); return; }
  const dst = $("dst-lang").value;
  const translated = $("out").classList.contains("is-empty") ? "" : $("out").textContent;

  $("src-lang").value = dst;
  $("dst-lang").value = src;
  if (translated) $("src-text").value = translated;
  $("detected").textContent = "";
  paintCount();
  translateNow();
});

$("btn-copy").addEventListener("click", () => {
  navigator.clipboard.writeText($("out").textContent).then(() => toast(t("tr.copied")));
});

/* Reading the result aloud is the browser's own voice, chosen for the target
   language — no model and no network involved. */
$("btn-speak").addEventListener("click", () => {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance($("out").textContent);
  u.lang = $("dst-lang").value;
  speechSynthesis.speak(u);
});

$("btn-mic").addEventListener("click", () => (dict.live ? dict.rec?.stop() : startDictation()));

/* ══ Boot ══════════════════════════════════════════════════════ */
(function boot() {
  applyTheme();
  lang = resolveLang();

  state.supported = "Translator" in self;
  $("blocked").classList.toggle("hidden", state.supported);
  $("ui").classList.toggle("hidden", !state.supported);

  fillPickers();
  applyI18n();
  paintCount();
  setOutput("", true);
})();
