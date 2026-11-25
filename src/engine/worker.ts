// Web Worker hosting the MuPDF engine so rendering never blocks the UI.
import { Engine } from "./core";

const engine = new Engine();
type Req = { seq: number; method: keyof Engine; args: unknown[] };

self.onmessage = (e: MessageEvent<Req>) => {
  const { seq, method, args } = e.data;
  try {
    const fn = engine[method] as (...a: unknown[]) => unknown;
    let result = fn.apply(engine, args);
    // A view into WASM memory can't be transferred: send a copy of just those bytes.
    if (result instanceof Uint8Array && result.byteLength !== result.buffer.byteLength) result = result.slice();
    const transfer: Transferable[] = [];
    if (result && typeof result === "object") {
      const r = result as { pixels?: Uint8ClampedArray };
      if (r.pixels) transfer.push(r.pixels.buffer as ArrayBuffer);
      if (result instanceof Uint8Array) transfer.push(result.buffer as ArrayBuffer);
    }
    (self as unknown as Worker).postMessage({ seq, result }, transfer);
  } catch (err) {
    (self as unknown as Worker).postMessage({ seq, error: String((err as Error)?.message ?? err) });
  }
};
(self as unknown as Worker).postMessage({ ready: true });
