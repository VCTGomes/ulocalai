/* U Local AI · Benchmark — a scored run against whichever engine is selected.

   The honest problem with "grade an LLM" in a page with no backend is that
   there is nothing to grade *against*. Asking the model to judge itself is the
   usual shortcut and it is a bad one here: the judge would be the same 1B model
   that just answered, and a small model is a poor and self-flattering critic.

   So this page only asks questions whose answers a few lines of JavaScript can
   verify — a number, a name, a JSON object, an exact word. Every task carries
   its own checker, the whole suite runs locally, and the score is nothing more
   mysterious than the share of checkers that returned true.

   Two things are measured, and they are kept apart on purpose:
     · correctness — the score, from the checkers
     · speed       — load time, time to first token, tokens per second

   Both come from the provider contract already in providers.js, so the same
   suite runs against Chrome's Prompt API and against any WebLLM model. */
"use strict";

const $ = (id) => document.getElementById(id);
const LS_SETTINGS = "miniai.settings";
const LS_RUNS = "miniai.bench";

/* Answers are capped and timed out: one rambling model must not be able to
   stall a run that has fourteen more tasks behind it. A capped answer is still
   graded — the checkers only ever look for something near the start. */
const MAX_OUT = 400;
const TASK_TIMEOUT = 45000;
const MAX_RUNS = 12;

/* Kept deliberately terse. Every model gets the same instruction, and short
   answers are what the checkers are written for. */
const SYSTEM = "You are being benchmarked. Answer in as few words as possible. "
  + "Give the answer only — no explanation, no preamble, no pleasantries.";

/* ══ Shared settings ═══════════════════════════════════════════
   The same key the chat and the translator write, so the engine picked here is
   the engine picked everywhere. providers.js reads `settings.webllmModel` off
   this global by name. */
const settings = (() => {
  try { return JSON.parse(localStorage.getItem(LS_SETTINGS)) || {}; }
  catch { return {}; }
})();
if (!settings.provider) settings.provider = "chrome";

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

/* ══ Grading helpers ═══════════════════════════════════════════
   Everything a checker needs to look past the wrapping a model puts around an
   answer, without becoming so forgiving that a wrong answer slips through. */

/** Lowercased, unaccented, unpunctuated, single-spaced — for comparing words. */
function norm(s) {
  return String(s).toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[*_`"'.,!?;:()[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every number in the text, thousands separators and trailing dots removed. */
function numbers(s) {
  return (String(s).match(/-?\d[\d.,]*/g) || [])
    .map((raw) => parseFloat(raw.replace(/,(?=\d{3}\b)/g, "").replace(/[.,]+$/, "").replace(",", ".")))
    .filter((n) => !Number.isNaN(n));
}

/** The last number in the answer. Models that show their working put the
    result at the end ("17 + 25 = 42"), so the last one is the claim being
    made — checking "contains 42 anywhere" would pass on arithmetic that
    happened to mention it in passing. */
function lastNumber(s) {
  const all = numbers(s);
  return all.length ? all[all.length - 1] : null;
}

/** The first JSON object in the answer, or null. Models fence it in ```json
    blocks or bracket it with prose; both are tolerated because the *shape* is
    what this task is about, not the packaging. */
function parseJson(s) {
  const m = String(s).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/** Splits a list answer into clean lines, dropping bullets and numbering. */
function lines(s) {
  return String(s).trim().split(/\r?\n+/)
    .map((l) => norm(l.replace(/^[\s\-*•\d.)]+/, "")))
    .filter(Boolean);
}

/* ══ The suite ═════════════════════════════════════════════════
   Fifteen tasks, equally weighted, five categories. The prompts are fixed and
   in English: they are part of the measurement, so translating them per user
   would mean two different benchmarks wearing one score. The interface around
   them is translated; these are not.

   `strict` marks the tasks where the *form* of the answer is what is being
   tested — those compare the whole output. Everywhere else the checker looks
   for the right content and forgives the wrapping. The chip in the UI says
   which is which, so a score is never a black box. */
const TASKS = [
  /* ── Arithmetic and simple quantitative reasoning ── */
  {
    id: "add", cat: "math", expect: "42",
    prompt: "What is 17 + 25? Reply with just the number.",
    check: (o) => lastNumber(o) === 42,
  },
  {
    id: "mult", cat: "math", expect: "92",
    prompt: "What is 23 * 4? Reply with just the number.",
    check: (o) => lastNumber(o) === 92,
  },
  {
    id: "discount", cat: "math", expect: "15",
    prompt: "A shirt costs 20 dollars and is on sale at 25% off. What is the final price in dollars? Reply with just the number.",
    check: (o) => lastNumber(o) === 15,
  },
  {
    id: "sequence", cat: "math", expect: "42",
    prompt: "Continue the sequence with the next number: 2, 6, 12, 20, 30, ... Reply with just the number.",
    check: (o) => lastNumber(o) === 42,
  },

  /* ── Following the requested output format, to the letter ── */
  {
    id: "json", cat: "format", strict: true, expect: '{"city":"Paris","country":"France"}',
    prompt: 'Reply with only a JSON object, no explanation, with exactly the keys "city" and "country" for where the Eiffel Tower is.',
    check: (o) => {
      const j = parseJson(o);
      return !!j && norm(j.city) === "paris" && norm(j.country) === "france";
    },
  },
  {
    id: "oneword", cat: "format", strict: true, expect: "Tokyo",
    prompt: "Answer with exactly one word: what is the capital of Japan?",
    check: (o) => norm(o) === "tokyo",
  },
  {
    id: "upper", cat: "format", strict: true, expect: "BENCHMARK",
    prompt: "Reply with only the word BENCHMARK in capital letters. Nothing else.",
    check: (o) => o.trim() === "BENCHMARK",
  },
  {
    id: "list", cat: "format", strict: true, expect: "3 lines",
    prompt: "List exactly three primary colours, one per line, with no other text.",
    check: (o) => {
      // Painters say red/yellow/blue, screens say red/green/blue; both are
      // right, so both are accepted. What is being tested is "exactly three,
      // one per line, nothing else".
      const ls = lines(o);
      const ok = new Set(["red", "yellow", "blue", "green"]);
      return ls.length === 3 && ls.every((l) => ok.has(l)) && new Set(ls).size === 3;
    },
  },

  /* ── Pulling one field out of a sentence that contains others ── */
  {
    id: "email", cat: "extract", expect: "ana.silva@example.com",
    prompt: "Extract only the e-mail address from this text and reply with just it: "
      + "\"Please send the report to ana.silva@example.com before Friday, or call 555-0134.\"",
    check: (o) => (o.match(/[\w.+-]+@[\w-]+\.[\w.]+/) || [])[0] === "ana.silva@example.com",
  },
  {
    id: "year", cat: "extract", expect: "1969",
    prompt: "In what year did the event in this sentence happen? Reply with just the year: "
      + "\"Apollo 11 landed on the Moon in July 1969, four years after the mission was announced.\"",
    check: (o) => lastNumber(o) === 1969,
  },

  /* ── Small chains of reasoning, one step past recall ── */
  {
    id: "order", cat: "reason", expect: "Carol",
    prompt: "Alice is taller than Bob. Bob is taller than Carol. Who is the shortest? Reply with just the name.",
    check: (o) => norm(o).includes("carol"),
  },
  {
    id: "letters", cat: "reason", expect: "3",
    prompt: "How many times does the letter 'r' appear in the word 'strawberry'? Reply with just the number.",
    check: (o) => lastNumber(o) === 3,
  },
  {
    id: "weekday", cat: "reason", expect: "Thursday",
    prompt: "If today is Monday, what day of the week will it be in three days? Reply with just the day name.",
    check: (o) => norm(o).includes("thursday"),
  },

  /* ── Language: the one place a small model usually gives itself away ── */
  {
    id: "translate", cat: "lang", expect: "O livro está na mesa",
    prompt: "Translate to Brazilian Portuguese and reply with only the translation: \"The book is on the table.\"",
    check: (o) => { const n = norm(o); return n.includes("livro") && n.includes("mesa"); },
  },
  {
    id: "analogy", cat: "lang", expect: "Japan",
    prompt: "Complete with one word only: Paris is to France as Tokyo is to ___",
    check: (o) => norm(o).includes("japan"),
  },
];

/* ══ State ═════════════════════════════════════════════════════ */
const state = {
  running: false,
  abort: null,
  results: [],        // one entry per task, in suite order
  loadMs: null,       // how long the first session took to come up
  needsDownload: false, // whether the weights had to come down the wire first
  exactParams: true,  // whether temperature 0 / topK 1 was accepted
};

/* ══ Small helpers ═════════════════════════════════════════════ */
let toastTimer;
function toast(msg) {
  $("toast").textContent = msg;
  $("toast").classList.add("is-on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("is-on"), 2200);
}

function fmtMs(ms) {
  if (ms == null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)} s` : `${Math.round(ms)} ms`;
}

/** The label a run is filed under: the engine, and for WebLLM the model, since
    "WebLLM" on its own says nothing about what was actually measured. */
function engineLabel() {
  if (settings.provider !== "webllm") return "Gemini Nano";
  const m = WEBLLM_MODELS.find((x) => x.id === (settings.webllmModel || WEBLLM_DEFAULT));
  return m ? m.label : (settings.webllmModel || WEBLLM_DEFAULT);
}

function showStrip({ title, desc, error, progress, network }) {
  const strip = $("strip");
  strip.classList.remove("hidden");
  strip.classList.toggle("is-err", !!error);
  // The icon carries the same distinction as the wording: a cloud only when
  // something is actually coming down the wire.
  $("strip-ic").className = error ? "fa-solid fa-triangle-exclamation"
    : network ? "fa-solid fa-cloud-arrow-down"
    : "fa-solid fa-spinner fa-spin";
  $("strip-title").textContent = title;
  $("strip-desc").textContent = desc || "";
  const on = typeof progress === "number";
  $("dl").classList.toggle("hidden", !on);
  if (on) $("dl-fill").style.width = Math.round(progress * 100) + "%";
}
function hideStrip() { $("strip").classList.add("hidden"); }

/** Two different waits wear this same progress bar, and calling both of them
    "downloading" is simply wrong. Weights that are already on disk are not
    being fetched — they are being decompressed into RAM and uploaded to the
    GPU, which is seconds rather than minutes and says nothing about the
    network. Which one it is was settled by availability() before the run, and
    WebLLM's own note ("Loading model from cache…") rides along as the detail. */
function loadStrip(progress, note) {
  showStrip({
    title: state.needsDownload ? t("bm.dl.model") : t("bm.load.mem"),
    desc: note || (state.needsDownload ? t("bm.dl.once") : t("bm.load.desc")),
    progress,
    // A cloud icon only when bytes really are coming down the wire.
    network: state.needsDownload,
  });
}

/* ══ i18n ══════════════════════════════════════════════════════ */
function applyI18n() {
  lang = resolveLang();
  document.documentElement.lang = t("html.lang");
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-html]")) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of document.querySelectorAll("[data-i18n-title]")) el.title = t(el.dataset.i18nTitle);
  for (const el of document.querySelectorAll("[data-i18n-aria]")) el.setAttribute("aria-label", t(el.dataset.i18nAria));
}

/* ══ The run ═══════════════════════════════════════════════════ */

/** One session per task, never one for the suite.
    A shared session would carry every previous answer into the next prompt's
    context: task 10 would be graded on a model that had already seen nine
    questions and its own answers to them, which is a different — and easier —
    test than task 1 got. Fifteen fresh sessions is the only way the tasks stay
    comparable to each other and across engines. */
async function newSession(provider, signal) {
  const opts = {
    system: SYSTEM,
    history: [],
    onProgress: (loaded, note) => loadStrip(loaded || 0, note),
    signal,
  };
  // Greedy decoding, so a re-run of the same model gives the same score rather
  // than a different one every time. Not every build accepts temperature 0, so
  // a refusal falls back to the app's defaults and the report says so — a
  // silent fallback would make two incomparable runs look identical.
  if (state.exactParams) {
    try { return await provider.createSession({ ...opts, temperature: 0, topK: 1 }); }
    catch (err) {
      if (err.name === "AbortError") throw err;
      state.exactParams = false;
    }
  }
  return provider.createSession({ ...opts, temperature: settings.temperature ?? 1, topK: settings.topK ?? 3 });
}

/** Runs one task end to end and grades it. Never throws for a model's sake:
    a task that errors is a failed task, not a failed run. */
async function runTask(task, provider) {
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  state.abort.signal.addEventListener("abort", stop);
  const timer = setTimeout(() => ctl.abort(), TASK_TIMEOUT);

  const res = {
    task, pass: false, out: "", ttft: null, genMs: null,
    tokens: null, capped: false, error: null,
  };

  try {
    const t0 = performance.now();
    const session = await newSession(provider, ctl.signal);
    const ready = performance.now();
    // Only the first session pays for loading the weights; the rest are cheap,
    // so this is the number worth reporting as "load".
    if (state.loadMs === null) { state.loadMs = ready - t0; hideStrip(); }

    let first = null;
    try {
      const stream = session.promptStreaming(task.prompt, { signal: ctl.signal });
      for await (const chunk of stream) {
        if (first === null) first = performance.now();
        res.out += chunk;
        if (res.out.length >= MAX_OUT) { res.capped = true; ctl.abort(); break; }
      }
    } catch (err) {
      // A cap or a timeout lands here on some engines. Whatever arrived before
      // it is still an answer, and still gets graded.
      if (err.name !== "AbortError") throw err;
    }

    if (first !== null) {
      res.ttft = first - ready;
      res.genMs = performance.now() - first;
    }
    res.tokens = session.lastCompletionTokens ?? null;
    session.destroy?.();

    if (state.abort.signal.aborted) res.error = "stopped";
    else if (!res.out.trim()) res.error = "empty";
    else { try { res.pass = !!task.check(res.out); } catch { res.pass = false; } }
  } catch (err) {
    res.error = err.name === "AbortError" ? "stopped" : err.message;
  } finally {
    clearTimeout(timer);
    state.abort.signal.removeEventListener("abort", stop);
  }
  return res;
}

async function runSuite() {
  if (state.running) return;

  const provider = PROVIDERS[settings.provider];
  state.running = true;
  state.abort = new AbortController();
  state.results = [];
  state.loadMs = null;
  state.exactParams = true;

  paintRunning();
  buildRows();
  $("score").classList.add("hidden");

  // Asked once, before anything is created: it is the only honest way to know
  // whether the wait ahead is a download or a load from disk, and the answer
  // labels the strip, the icon and the "model load" figure afterwards.
  state.needsDownload = (await provider.availability().catch(() => "downloadable")) === "downloadable";
  loadStrip();

  try {
    for (let i = 0; i < TASKS.length; i++) {
      if (state.abort.signal.aborted) break;
      paintProgress(i);
      markRow(i, "running");
      const res = await runTask(TASKS[i], provider);
      state.results.push(res);
      paintRow(i, res);
      paintScore();     // the score builds as it goes, rather than at the end
      $("score").classList.remove("hidden");
    }

    const done = state.results.length === TASKS.length && !state.abort.signal.aborted;
    if (done) { saveRun(); toast(t("bm.toast.done")); }
    hideStrip();
    paintProgress(state.results.length);
  } catch (err) {
    showStrip({ error: true, title: t("bm.err.failed"), desc: err.message });
  } finally {
    state.running = false;
    state.abort = null;
    paintRunning();
    paintHistory();
  }
}

/* ══ Aggregates ════════════════════════════════════════════════ */
function summary() {
  const done = state.results.filter((r) => r.error !== "stopped");
  const passed = done.filter((r) => r.pass).length;
  const timed = done.filter((r) => r.ttft !== null);

  const ttft = timed.length ? timed.reduce((a, r) => a + r.ttft, 0) / timed.length : null;

  // Tokens are only reported by WebLLM. Rather than leave the figure blank for
  // Gemini Nano, characters are converted at the usual ~4 per token and the
  // number is marked as an estimate wherever it is shown.
  let tokens = 0, genMs = 0, estimated = false;
  for (const r of timed) {
    if (r.tokens != null) tokens += r.tokens;
    else { tokens += r.out.length / 4; estimated = true; }
    genMs += r.genMs || 0;
  }
  const tps = genMs > 0 ? tokens / (genMs / 1000) : null;

  return { passed, total: done.length, ttft, tps, estimated };
}

/** 0–100, the share of checkers that returned true. Nothing else feeds it —
    speed is reported beside the score, never folded into it. */
function scoreOf(passed, total) {
  return total ? Math.round((passed / total) * 100) : 0;
}

function gradeOf(score) {
  if (score >= 90) return "a";
  if (score >= 75) return "b";
  if (score >= 60) return "c";
  if (score >= 40) return "d";
  return "e";
}

/* ══ Painting ══════════════════════════════════════════════════ */
function paintRunning() {
  $("btn-run").classList.toggle("hidden", state.running);
  $("btn-stop").classList.toggle("hidden", !state.running);
  $("engine-pick").classList.toggle("is-locked", state.running);
  $("in-model").disabled = state.running;
  for (const b of $("seg-engine").children) b.disabled = state.running;
}

function paintProgress(done) {
  const pct = Math.round((done / TASKS.length) * 100);
  $("run-bar").classList.toggle("hidden", !state.running && done === 0);
  $("run-fill").style.width = pct + "%";
  $("run-count").textContent = `${done} / ${TASKS.length}`;
}

/** The rows are laid out once, empty, so the list does not jump around as
    answers land — every task is visible from the start, greyed until its turn. */
function buildRows() {
  const list = $("tasks");
  list.innerHTML = "";
  TASKS.forEach((task, i) => {
    const row = document.createElement("details");
    row.className = "row is-pending";
    row.id = `row-${i}`;
    row.innerHTML = `
      <summary class="row__head">
        <span class="row__st" aria-hidden="true"><i class="fa-regular fa-circle"></i></span>
        <span class="row__body">
          <span class="row__prompt"></span>
          <span class="row__meta">
            <span class="chip chip--cat"></span>
            <span class="chip chip--strict hidden">${esc(t("bm.strict"))}</span>
            <span class="row__expect"></span>
          </span>
        </span>
        <span class="row__verdict"></span>
        <span class="row__ms"></span>
      </summary>
      <div class="row__out"><pre class="out"></pre></div>`;
    row.querySelector(".row__prompt").textContent = task.prompt;
    row.querySelector(".chip--cat").textContent = t(`bm.cat.${task.cat}`);
    row.querySelector(".row__expect").textContent = t("bm.expect").replace("{v}", task.expect);
    if (task.strict) row.querySelector(".chip--strict").classList.remove("hidden");
    list.appendChild(row);
  });
  $("tasks-card").classList.remove("hidden");
}

function markRow(i, kind) {
  const row = $(`row-${i}`);
  if (!row) return;
  row.className = `row is-${kind}`;
  if (kind === "running") {
    row.querySelector(".row__st").innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    row.querySelector(".row__verdict").textContent = t("bm.state.running");
  }
}

function paintRow(i, res) {
  const row = $(`row-${i}`);
  if (!row) return;
  const kind = res.error === "stopped" ? "skipped" : res.pass ? "pass" : "fail";
  row.className = `row is-${kind}`;
  // Never colour alone: the icon and the word carry the verdict too, so it
  // survives colour blindness, a screenshot in greyscale and forced-colours.
  row.querySelector(".row__st").innerHTML = {
    pass: '<i class="fa-solid fa-circle-check"></i>',
    fail: '<i class="fa-solid fa-circle-xmark"></i>',
    skipped: '<i class="fa-solid fa-circle-minus"></i>',
  }[kind];
  row.querySelector(".row__verdict").textContent = t(`bm.state.${kind}`);
  row.querySelector(".row__ms").textContent = res.ttft !== null
    ? fmtMs((res.ttft || 0) + (res.genMs || 0)) : "";
  const pre = row.querySelector(".out");
  pre.textContent = res.error && res.error !== "stopped" && !res.out
    ? t("bm.err.task").replace("{msg}", res.error)
    : (res.out || t("bm.err.empty")) + (res.capped ? ` … ${t("bm.capped")}` : "");
}

function paintScore() {
  const s = summary();
  const score = scoreOf(s.passed, s.total);
  $("score-value").textContent = score;
  $("score-frac").textContent = t("bm.scoreFrac")
    .replace("{p}", s.passed).replace("{n}", s.total);
  $("score-grade").textContent = t(`bm.grade.${gradeOf(score)}`);
  $("score-grade").className = `grade is-${gradeOf(score)}`;
  $("score-engine").textContent = engineLabel();

  $("kpi-load").textContent = fmtMs(state.loadMs);
  $("kpi-load-note").textContent = state.needsDownload ? t("bm.kpi.loadDl") : t("bm.kpi.loadCache");
  $("kpi-ttft").textContent = fmtMs(s.ttft);
  $("kpi-tps").textContent = s.tps ? `${s.tps.toFixed(1)}` : "—";
  $("kpi-tps-note").textContent = s.estimated ? t("bm.kpi.tpsEst") : t("bm.kpi.tpsReal");
  $("params-note").classList.toggle("hidden", state.exactParams);
}

/* ══ History ═══════════════════════════════════════════════════
   The point of a benchmark is the comparison, and comparing means keeping the
   last run of each model around. Stored locally like everything else here. */
function readRuns() {
  try { return JSON.parse(localStorage.getItem(LS_RUNS)) || []; }
  catch { return []; }
}

function saveRun() {
  const s = summary();
  const runs = readRuns().filter((r) => r.label !== engineLabel());
  runs.unshift({
    label: engineLabel(),
    engine: settings.provider,
    score: scoreOf(s.passed, s.total),
    passed: s.passed,
    total: s.total,
    ttft: s.ttft,
    tps: s.tps,
    estimated: s.estimated,
    loadMs: state.loadMs,
    at: new Date().toISOString(),
  });
  localStorage.setItem(LS_RUNS, JSON.stringify(runs.slice(0, MAX_RUNS)));
}

function paintHistory() {
  const runs = readRuns().sort((a, b) => b.score - a.score);
  $("history-card").classList.toggle("hidden", !runs.length);
  const body = $("history-body");
  body.innerHTML = "";
  for (const r of runs) {
    const tr = document.createElement("tr");
    const when = new Date(r.at);
    tr.innerHTML = `
      <td class="hcell hcell--model"><b></b><small></small></td>
      <td class="hcell"><span class="hscore"></span></td>
      <td class="hcell hcell--num"></td>
      <td class="hcell hcell--num"></td>`;
    tr.querySelector("b").textContent = r.label;
    tr.querySelector("small").textContent = when.toLocaleDateString(lang === "pt" ? "pt-BR" : "en-US");
    const sc = tr.querySelector(".hscore");
    sc.textContent = `${r.score}%`;
    sc.className = `hscore is-${gradeOf(r.score)}`;
    tr.children[2].textContent = fmtMs(r.ttft);
    tr.children[3].textContent = r.tps ? (r.estimated ? `~${r.tps.toFixed(1)}` : r.tps.toFixed(1)) : "—";
    body.appendChild(tr);
  }
}

/** A markdown table, which is what these numbers usually end up pasted into. */
function copyResults() {
  const s = summary();
  const head = `**U Local AI · benchmark** — ${engineLabel()}\n\n`
    + `Score: **${scoreOf(s.passed, s.total)}%** (${s.passed}/${s.total})  ·  `
    + `TTFT: ${fmtMs(s.ttft)}  ·  ${s.estimated ? "~" : ""}${s.tps ? s.tps.toFixed(1) : "—"} tok/s  ·  `
    + `load: ${fmtMs(state.loadMs)}\n\n`
    + `| Task | Category | Result |\n|---|---|---|\n`;
  const rows = state.results
    .map((r) => `| ${r.task.id} | ${r.task.cat} | ${r.pass ? "pass" : "fail"} |`)
    .join("\n");
  navigator.clipboard.writeText(head + rows).then(() => toast(t("bm.toast.copied")));
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ══ Engine picker ═════════════════════════════════════════════ */
function fillModels() {
  const sel = $("in-model");
  if (!sel.options.length) {
    for (const m of WEBLLM_MODELS) {
      const o = document.createElement("option");
      o.value = m.id;
      o.textContent = `${m.label} · ${m.size}`;
      sel.appendChild(o);
    }
  }
  sel.value = settings.webllmModel || WEBLLM_DEFAULT;
}

function paintEngine() {
  for (const b of $("seg-engine").children) {
    b.classList.toggle("is-active", b.dataset.engine === settings.provider);
  }
  $("model-field").classList.toggle("hidden", settings.provider !== "webllm");
  paintSegments();
}

/** What this engine cannot do here, said before the Run button is pressed
    rather than as a failure fifteen tasks in. */
async function paintSupport() {
  const provider = PROVIDERS[settings.provider];
  const checks = provider.checks();
  const missing = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  const ok = !missing.length;

  $("blocked").classList.toggle("hidden", ok);
  $("btn-run").disabled = !ok;
  if (!ok) {
    $("blocked-lead").innerHTML = t(`bm.blocked.${settings.provider}`);
    return;
  }

  const avail = await provider.availability().catch(() => "unavailable");
  $("engine-note").textContent = avail === "downloadable"
    ? t("bm.note.willDownload") : t("bm.note.ready");
}

/* ══ Settings modal (theme + language, shared with the other pages) ══ */
function paintSegments() {
  for (const b of $("seg-theme").children) b.classList.toggle("is-active", b.dataset.theme === (settings.theme || ""));
  for (const b of $("seg-lang").children) b.classList.toggle("is-active", b.dataset.lang === (settings.lang || ""));
}

/* ══ Wiring ════════════════════════════════════════════════════ */
$("btn-run").addEventListener("click", runSuite);
$("btn-stop").addEventListener("click", () => {
  state.abort?.abort();
  toast(t("bm.toast.stopping"));
});
$("btn-copy").addEventListener("click", copyResults);
$("btn-clear-history").addEventListener("click", () => {
  localStorage.removeItem(LS_RUNS);
  paintHistory();
  toast(t("bm.toast.cleared"));
});

$("seg-engine").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-engine]");
  if (!b || state.running) return;
  settings.provider = b.dataset.engine;
  saveSettings();
  paintEngine();
  paintSupport();
});

$("in-model").addEventListener("change", () => {
  settings.webllmModel = $("in-model").value;
  saveSettings();
  paintSupport();
});

$("btn-settings").addEventListener("click", () => {
  paintSegments();
  $("modal").classList.remove("hidden");
});
$("btn-modal-close").addEventListener("click", () => $("modal").classList.add("hidden"));
$("modal").addEventListener("click", (e) => { if (e.target === $("modal")) $("modal").classList.add("hidden"); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("modal").classList.add("hidden"); });

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
  // Category chips, verdicts and dates are all in the interface language, so
  // anything already on screen has to be repainted rather than left stale.
  if (state.results.length) {
    buildRows();
    state.results.forEach((r, i) => paintRow(i, r));
    paintScore();
  }
  paintHistory();
  paintSegments();
});

/* A run in flight is real work with a downloaded model behind it; leaving by
   accident and losing it would be a poor trade for a confirm dialog. */
window.addEventListener("beforeunload", (e) => {
  if (!state.running) return;
  e.preventDefault();
  e.returnValue = "";
});

/* ══ Boot ══════════════════════════════════════════════════════ */
(function boot() {
  applyTheme();
  lang = resolveLang();
  applyI18n();
  fillModels();
  paintEngine();
  paintHistory();
  paintProgress(0);
  paintSupport();
})();
