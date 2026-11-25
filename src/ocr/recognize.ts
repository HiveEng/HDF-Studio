// Tesseract (Apache-2.0) wrapper shared by the app and the CLI. Runs in its own worker thread.
import { createWorker, OEM, type WorkerOptions } from "tesseract.js";
import { linesFromTesseract, type OcrLine, type TesseractBlock } from "../engine/ocr";

export interface Recognizer {
  recognize(png: Uint8Array, scale: number): Promise<OcrLine[]>;
  terminate(): Promise<void>;
}

/**
 * @param langs Tesseract language codes joined with "+", e.g. "eng" or "eng+fra".
 * @param options Where to find the worker, core and language data (bundled, so OCR works offline).
 * @param onProgress Fraction 0..1 of the current page.
 */
export async function createRecognizer(langs: string, options: Partial<WorkerOptions>, onProgress?: (f: number) => void): Promise<Recognizer> {
  const worker = await createWorker(langs, OEM.LSTM_ONLY, {
    ...options,
    logger: (m) => m.status === "recognizing text" && onProgress?.(m.progress),
  });
  await worker.setParameters({ preserve_interword_spaces: "1" });
  return {
    async recognize(png, scale) {
      const image = typeof Blob !== "undefined" && typeof window !== "undefined" ? new Blob([png as BlobPart], { type: "image/png" }) : (png as unknown as Buffer);
      await worker.setParameters({ user_defined_dpi: String(Math.round(scale * 72)) });
      const { data } = await worker.recognize(image, {}, { blocks: true });
      return linesFromTesseract(data.blocks as unknown as TesseractBlock[], scale);
    },
    terminate: async () => void (await worker.terminate()),
  };
}
