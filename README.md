# U Local AI

A little project for playing with Chrome's **Prompt API** — the one that runs Gemini Nano
right inside the browser, with no server in the middle.

It's basically a ChatGPT-style chat, except everything happens on your machine: the model is
local, conversations live in IndexedDB, and no network request is ever made. It's not a
product — no backend, no accounts, no analytics. Just a toy to exercise the API end to end.

## What it exercises

- **Model lifecycle** — `availability()`, `params()` and the download monitor with live
  progress.
- **Sessions** — `create()` with a system prompt, `temperature` and `topK`, replayed history
  and `destroy()`.
- **Generation** — `promptStreaming()` token by token, with an abort button.
- **Limits** — context usage against `inputQuota` and the `quotaoverflow` event.

As a bonus it's a PWA with a service worker (works offline), has light/dark themes, pt/en
i18n, and an event log so you can watch what the API is actually doing.

## Benchmark

`/benchmark` scores whichever engine is selected. There is no backend and no judge model, so
it only asks questions a few lines of JavaScript can verify: a number that must match, a JSON
object with the right keys, an exact word. The score is the share of checkers that returned
true, and speed is reported beside it, never folded into it.

Twenty-one tasks in two tiers. The fifteen quick ones are a few tokens in and a few out. The
six heavy ones are what actually separate models:

- a password buried in a ~1,800-token log (sized to fit a 1B model's 4k window)
- the numbers 1 to 100 in order, which catches a model that drifts or repeats
- a JSON object pulled out of a messy complaint that contains two amounts and two references
- a function that is **executed against test cases** in a sandboxed worker: code that throws,
  hangs or returns the wrong value fails

Each task runs in a fresh session at temperature 0, so no task sees another's answer and a
re-run gives the same score. Results are kept per model in localStorage, filed under the suite
they ran, so a quick score is never compared against a full one.

## Running

```bash
node server.js        # http://localhost:3140
```

The server is a ~50-line static file server with zero dependencies. All you need is Node.

## Requirements

Chrome with the Prompt API enabled:

1. Turn on `chrome://flags/#prompt-api-for-gemini-nano`
2. Watch the model download at `chrome://on-device-internals`

Without it the app shows a screen explaining what's missing — it checks
`"LanguageModel" in self` and the secure context before anything else.

## Structure

```
server.js               static server (no deps)
public/index.html       the whole app (single page)
public/translate/       the translator page
public/benchmark/       the benchmark page
public/res/assets/js/   app.js, providers.js, i18n.js, translate.js, benchmark.js
public/sw.js            service worker (network-first)
```

## Heads up

Answers come from a small model running on your device. They can be wrong, incomplete, or
just plain weird — and there's no fallback to a hosted model. That's part of the fun.

## License

MIT © Vitor Gomes

Permission is hereby granted, free of charge, to any person obtaining a copy of this
software and associated documentation files (the "Software"), to deal in the Software
without restriction, including without limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons
to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
