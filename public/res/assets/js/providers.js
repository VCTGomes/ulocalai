/* U Local AI — the two engines the app can talk to.

   Both hide behind the same tiny contract, which is the shape app.js already
   spoke to Chrome's Prompt API:

     availability()  → "unsupported" | "unavailable" | "downloadable" | "available"
     params()        → { maxTemperature, maxTopK } | null
     checks()        → { <requirement key>: true | false | undefined }
     createSession() → { promptStreaming(text, {signal}), destroy(),
                         inputUsage, inputQuota, addEventListener }

   The Prompt API provider is barely a wrapper: its own session object already
   fits. The WebLLM one has to build that shape by hand on top of an
   OpenAI-style chat completions API.

   Nothing here is loaded eagerly. The WebLLM module is a couple of megabytes
   of JavaScript and WASM on a CDN, so it is imported the first time that
   provider is actually asked to do something — a user who never leaves the
   Prompt API pays nothing for it. */
"use strict";

/* ══ WebLLM catalogue ══════════════════════════════════════════
   A curated slice of MLC's prebuilt list. `size` is what the browser will
   download once, `vram` what the GPU must hold; both are shown in the picker
   because the difference matters on a laptop.
   q4f32 quantisations work on any WebGPU device; q4f16 needs the shader-f16
   feature, which is common but not universal — hence the f32 default. */
const WEBLLM_MODELS = [
  { id: "Llama-3.2-1B-Instruct-q4f32_1-MLC", label: "Llama 3.2 1B", size: "1.1 GB", vram: 1129, f16: false },
  { id: "Llama-3.2-3B-Instruct-q4f32_1-MLC", label: "Llama 3.2 3B", size: "2.9 GB", vram: 2951, f16: false },
  { id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC", label: "Qwen 2.5 1.5B", size: "1.6 GB", vram: 1629, f16: true },
  { id: "Phi-3.5-mini-instruct-q4f16_1-MLC", label: "Phi 3.5 mini", size: "3.7 GB", vram: 3672, f16: true },
  { id: "gemma-2-2b-it-q4f16_1-MLC", label: "Gemma 2 2B", size: "1.9 GB", vram: 1895, f16: true },
  { id: "SmolLM2-360M-Instruct-q4f16_1-MLC", label: "SmolLM2 360M", size: "0.4 GB", vram: 376, f16: true },
];
const WEBLLM_DEFAULT = "Llama-3.2-1B-Instruct-q4f32_1-MLC";
const WEBLLM_CDN = "https://esm.run/@mlc-ai/web-llm";

/* ══ Prompt API ════════════════════════════════════════════════ */
const chromeProvider = {
  id: "chrome",
  supportsTopK: true,
  /** The one-time download is Chrome's, shared by every site. */
  sharedDownload: true,

  checks() {
    return { browser: "LanguageModel" in self, secure: window.isSecureContext };
  },

  async availability() {
    if (!("LanguageModel" in self)) return "unsupported";
    try { return await self.LanguageModel.availability(); }
    catch { return "unavailable"; }
  },

  async params() {
    if (!("LanguageModel" in self)) return null;
    try { return await self.LanguageModel.params(); } catch { return null; }
  },

  /** The Prompt API's own session already implements the contract. */
  createSession({ temperature, topK, system, history, onProgress, signal }) {
    return self.LanguageModel.create({
      temperature,
      topK,
      signal,
      initialPrompts: [{ role: "system", content: system }, ...history],
      monitor(m) {
        m.addEventListener("downloadprogress", (e) => onProgress(e.loaded));
      },
    });
  },
};

/* ══ WebLLM (WebGPU) ═══════════════════════════════════════════ */
const webllmProvider = {
  id: "webllm",
  /* WebLLM samples with temperature and top_p only — there is no top-K knob to
     expose, so the slider hides itself for this engine. */
  supportsTopK: false,
  /* Weights are fetched per browser profile from the HuggingFace CDN, not
     installed system-wide the way Chrome installs Gemini Nano. */
  sharedDownload: false,

  mod: null,          // the imported module, once it has been pulled
  engine: null,       // the live MLC engine, once a model is loaded
  engineModel: null,  // which model that engine holds
  worker: null,       // the worker it lives in, when it got one

  checks() {
    return { webgpu: "gpu" in navigator, secure: window.isSecureContext };
  },

  /** Imported on demand — see the note at the top of the file. */
  async load() {
    if (!this.mod) this.mod = await import(/* webpackIgnore: true */ WEBLLM_CDN);
    return this.mod;
  },

  async availability() {
    if (!("gpu" in navigator)) return "unsupported";
    // A browser can expose navigator.gpu and still have no usable adapter
    // (blocklisted driver, software rendering disabled).
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return "unavailable";
    } catch { return "unavailable"; }

    const model = currentWebllmModel();
    if (this.engine && this.engineModel === model) return "available";

    // Whether the weights are already on disk decides between "ready to chat"
    // and "ready to download". Answering that needs the module, so a failure
    // to reach the CDN is reported as "downloadable" rather than a hard no:
    // the download button is exactly what should be offered next.
    try {
      const webllm = await this.load();
      return (await webllm.hasModelInCache(model)) ? "available" : "downloadable";
    } catch {
      return "downloadable";
    }
  },

  /** WebLLM's temperature is unbounded in practice; 2 matches the slider. */
  async params() { return { maxTemperature: 2, maxTopK: null }; },

  async createSession({ temperature, system, history, onProgress, signal }) {
    const webllm = await this.load();
    const model = currentWebllmModel();

    if (!this.engine || this.engineModel !== model) {
      await this.disposeEngine();
      this.engine = await createEngine(webllm, model, onProgress, signal, this);
      this.engineModel = model;
    }

    return webllmSession(this.engine, {
      temperature,
      system,
      history,
      quota: contextWindow(webllm, model),
    });
  },

  /** Frees the GPU buffers. The downloaded weights stay in the browser cache. */
  async disposeEngine() {
    const e = this.engine;
    const w = this.worker;
    this.engine = null;
    this.engineModel = null;
    this.worker = null;
    if (e) { try { await e.unload(); } catch { /* already gone */ } }
    if (w) w.terminate();
  },

  /** Which catalogue models already have their weights on disk.
      Answering needs the module, so this is only asked once something else has
      already paid for the import — never on its own account. */
  async cachedModels() {
    if (!this.mod) return null;   // unknown, not "none"
    const hits = await Promise.all(
      WEBLLM_MODELS.map((m) => this.mod.hasModelInCache(m.id).catch(() => false)),
    );
    return new Set(WEBLLM_MODELS.filter((_, i) => hits[i]).map((m) => m.id));
  },

  /** Drops a model's weights, config and wasm from the browser cache. If it is
      the one currently loaded, the live engine goes with it — it would
      otherwise keep answering from GPU memory that nothing can reload. */
  async deleteModel(id) {
    const webllm = await this.load();
    if (this.engineModel === id) await this.disposeEngine();
    if (typeof webllm.deleteModelAllInfoInCache === "function") {
      await webllm.deleteModelAllInfoInCache(id);
    } else {
      await webllm.deleteModelInCache(id);
    }
  },

  /** True when a download in flight can actually be stopped, rather than just
      stopped being waited for. Only the worker path can: terminating it kills
      the fetch outright. On the main-thread fallback the bytes keep arriving
      whatever the UI says, so the button that offers it hides itself. */
  canCancelDownload() { return !!this.worker; },
};

/* ══ Hardware probe ════════════════════════════════════════════
   What a browser will actually tell you about the machine, which is far less
   than a task manager: capabilities and ceilings, never utilisation. There is
   no API for "GPU is 60% busy" or "3 GB of VRAM free", by design — those would
   be fingerprinting vectors. So this reports what is knowable and the panel
   says plainly why the rest is missing. */
async function probeGPU() {
  if (!("gpu" in navigator)) return null;
  let adapter;
  try { adapter = await navigator.gpu.requestAdapter(); } catch { return null; }
  if (!adapter) return null;

  // GPUAdapter.info is the current shape; requestAdapterInfo() was the older
  // spelling and is still what some builds ship.
  let info = adapter.info;
  if (!info && typeof adapter.requestAdapterInfo === "function") {
    info = await adapter.requestAdapterInfo().catch(() => null);
  }

  return {
    vendor: info?.vendor || null,
    architecture: info?.architecture || null,
    device: info?.device || null,
    description: info?.description || null,
    // shader-f16 is the one that decides whether half the catalogue can run.
    f16: adapter.features?.has?.("shader-f16") ?? false,
    features: adapter.features ? [...adapter.features] : [],
    maxBufferSize: adapter.limits?.maxBufferSize ?? null,
    maxStorageBufferBindingSize: adapter.limits?.maxStorageBufferBindingSize ?? null,
  };
}

/** Reads the model the user picked; app.js owns the setting. */
function currentWebllmModel() {
  return (typeof settings === "object" && settings.webllmModel) || WEBLLM_DEFAULT;
}

/** Off the main thread when possible: decoding is a tight loop and would
    otherwise freeze the composer, the sidebar and the progress bar it is
    supposed to be driving. A worker needs a module script of our own plus a
    working import from the CDN inside it, so failure falls back to the main
    thread rather than to nothing. */
async function createEngine(webllm, model, onProgress, signal, provider) {
  const opts = { initProgressCallback: (r) => onProgress(r.progress ?? 0, r.text) };
  try {
    const worker = new Worker("/res/assets/js/webllm-worker.js", { type: "module" });
    provider.worker = worker;
    // WebLLM exposes no abort for a load in progress, but killing the worker
    // takes the whole fetch down with it. The race is what makes that visible
    // to the caller: a terminated worker simply stops answering, so awaiting
    // the creation promise on its own would hang forever.
    try {
      return await Promise.race([
        webllm.CreateWebWorkerMLCEngine(worker, model, opts),
        abortSignalPromise(signal),
      ]);
    } catch (err) {
      worker.terminate();
      provider.worker = null;
      throw err;
    }
  } catch (err) {
    if (err.name === "AbortError") throw err;
    // No worker to terminate on this path, so the download cannot be stopped
    // once started — canCancelDownload() reports that honestly.
    if (typeof log === "function") log("webllm worker unavailable, using the main thread: " + err.message);
    return await Promise.race([
      webllm.CreateMLCEngine(model, opts),
      abortSignalPromise(signal),
    ]);
  }
}

/** A promise that only ever rejects, when the signal aborts. Without a signal
    it never settles, so it is inert inside a Promise.race. */
function abortSignalPromise(signal) {
  return new Promise((_, reject) => {
    if (!signal) return;
    if (signal.aborted) return reject(new DOMException("Download cancelled", "AbortError"));
    signal.addEventListener("abort", () => reject(new DOMException("Download cancelled", "AbortError")), { once: true });
  });
}

/** The model's context window, when the prebuilt config declares one. */
function contextWindow(webllm, model) {
  const entry = webllm.prebuiltAppConfig?.model_list?.find((m) => m.model_id === model);
  return entry?.overrides?.context_window_size ?? null;
}

/** Wraps the engine in the session shape app.js expects.
    The transcript is kept here because chat.completions is stateless: every
    turn resends the whole conversation, so the array *is* the session. */
function webllmSession(engine, { temperature, system, history, quota }) {
  const messages = [{ role: "system", content: system }, ...history];

  return {
    inputUsage: 0,
    inputQuota: quota,
    lastCompletionTokens: null,   // filled from usage, for the tok/s readout
    // No quotaoverflow equivalent; the contract only ever optional-calls this.
    addEventListener() {},
    destroy() { engine.interruptGenerate?.(); },

    promptStreaming(text, { signal } = {}) {
      const session = this;
      messages.push({ role: "user", content: text });
      this.lastCompletionTokens = null;
      let acc = "";

      return (async function* () {
        // interruptGenerate is cooperative: it ends the stream cleanly, so the
        // AbortError the caller expects has to be raised here by hand.
        const stop = () => engine.interruptGenerate();
        signal?.addEventListener("abort", stop);
        try {
          const stream = await engine.chat.completions.create({
            messages,
            temperature,
            stream: true,
            stream_options: { include_usage: true },
          });
          for await (const chunk of stream) {
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) { acc += delta; yield delta; }
            if (chunk.usage) {
              session.inputUsage = chunk.usage.prompt_tokens ?? session.inputUsage;
              session.lastCompletionTokens = chunk.usage.completion_tokens ?? null;
            }
          }
          if (signal?.aborted) throw new DOMException("Generation stopped", "AbortError");
        } finally {
          signal?.removeEventListener("abort", stop);
          // Whatever was produced stays in the transcript, so a stopped answer
          // is still context for the next turn — same as the Prompt API.
          messages.push({ role: "assistant", content: acc });
        }
      })();
    },
  };
}

const PROVIDERS = { chrome: chromeProvider, webllm: webllmProvider };

/* ══ Summarizer ════════════════════════════════════════════════
   A sibling of the Prompt API with the same lifecycle. Used for two things:
   naming a conversation from its content, and the "summarise this chat"
   button. It is optional everywhere it is called — a browser without it just
   falls back to the old behaviour, never an error.

   A single instance is reused: create() can trigger a download, so building
   one per call would be wasteful. Different tasks (a short title vs a longer
   digest) need different options, so the live one is keyed by its config. */
const summarizer = {
  inst: null,
  key: null,

  available() { return "Summarizer" in self; },

  async get(opts, onProgress) {
    const key = JSON.stringify(opts);
    if (this.inst && this.key === key) return this.inst;
    if (this.inst) { this.inst.destroy?.(); this.inst = null; }
    this.inst = await Summarizer.create({
      ...opts,
      monitor(m) {
        m.addEventListener("downloadprogress", (e) => onProgress?.(e.loaded));
      },
    });
    this.key = key;
    return this.inst;
  },

  /** One short line naming a conversation — the "headline" type with a word
      cap is as close as the API gets to a title. */
  async title(text, onProgress) {
    const s = await this.get(
      { type: "headline", format: "plain-text", length: "short" },
      onProgress,
    );
    const out = (await s.summarize(text)).trim().replace(/^["']|["']$/g, "");
    return out.split("\n")[0];
  },

  /** A tl;dr of the whole transcript, for the button. */
  async digest(text, onProgress) {
    const s = await this.get(
      { type: "tldr", format: "plain-text", length: "medium" },
      onProgress,
    );
    return (await s.summarize(text)).trim();
  },
};
