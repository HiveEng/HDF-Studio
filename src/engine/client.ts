// Promise-based proxy to the engine worker. Every Engine method becomes async.
import type { Engine } from "./core";

type Async<T> = { [K in keyof T]: T[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<R> : never };

export function createEngine(): Async<Engine> & { ready: Promise<void> } {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  let seq = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let markReady!: () => void;
  const ready = new Promise<void>((r) => (markReady = r));

  worker.onmessage = (e) => {
    if (e.data.ready) return markReady();
    const p = pending.get(e.data.seq);
    if (!p) return;
    pending.delete(e.data.seq);
    if ("error" in e.data) p.reject(new Error(e.data.error));
    else p.resolve(e.data.result);
  };

  return new Proxy({ ready } as Record<string, unknown>, {
    get(target, method: string) {
      if (method in target) return target[method];
      return (...args: unknown[]) =>
        new Promise((resolve, reject) => {
          const id = ++seq;
          pending.set(id, { resolve, reject });
          const transfer = args.filter((a): a is Uint8Array => a instanceof Uint8Array).map((a) => a.buffer as ArrayBuffer);
          worker.postMessage({ seq: id, method, args }, transfer);
        });
    },
  }) as Async<Engine> & { ready: Promise<void> };
}
