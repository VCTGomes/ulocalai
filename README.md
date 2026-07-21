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
public/res/assets/js/   app.js, i18n.js
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
