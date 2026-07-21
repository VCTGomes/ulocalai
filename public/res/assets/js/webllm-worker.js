/* U Local AI — WebLLM's decoding loop, off the main thread.

   This file exists only so the engine has a worker to live in: WebLLM ships
   the handler, we just have to give it a same-origin module script to be
   instantiated from. Everything the page asks for (load the model, stream a
   completion, interrupt it) arrives as a message and is answered by the
   handler; there is nothing app-specific here.

   The import is the same CDN module the page uses, so the browser serves it
   from its own HTTP cache the second time around. */
import { WebWorkerMLCEngineHandler } from "https://esm.run/@mlc-ai/web-llm";

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg) => handler.onmessage(msg);
