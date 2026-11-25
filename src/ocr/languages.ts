// OCR languages. English ships with the app; the others are downloaded once from the jsDelivr CDN
// (Tesseract's 4.0.0_best_int data, Apache-2.0) and cached, then work offline.
export const OCR_LANGUAGES: [code: string, name: string][] = [
  ["eng", "English"], ["fra", "French"], ["deu", "German"], ["spa", "Spanish"], ["ita", "Italian"], ["por", "Portuguese"],
  ["nld", "Dutch"], ["gle", "Irish"], ["pol", "Polish"], ["ces", "Czech"], ["slk", "Slovak"], ["hun", "Hungarian"],
  ["ron", "Romanian"], ["swe", "Swedish"], ["dan", "Danish"], ["nor", "Norwegian"], ["fin", "Finnish"], ["est", "Estonian"],
  ["lav", "Latvian"], ["lit", "Lithuanian"], ["slv", "Slovenian"], ["hrv", "Croatian"], ["srp", "Serbian (Cyrillic)"],
  ["bul", "Bulgarian"], ["ell", "Greek"], ["tur", "Turkish"], ["rus", "Russian"], ["ukr", "Ukrainian"], ["ara", "Arabic"],
  ["heb", "Hebrew"], ["fas", "Persian"], ["urd", "Urdu"], ["hin", "Hindi"], ["ben", "Bengali"], ["tam", "Tamil"],
  ["tha", "Thai"], ["vie", "Vietnamese"], ["ind", "Indonesian"], ["msa", "Malay"], ["fil", "Filipino"],
  ["chi_sim", "Chinese (Simplified)"], ["chi_tra", "Chinese (Traditional)"], ["jpn", "Japanese"], ["kor", "Korean"],
];

export const BUNDLED_LANGS = new Set(["eng"]);

/** Where Tesseract should load "eng+fra"-style language data from: bundled files when possible. */
export function langSource(langs: string, bundledPath: string): { langPath: string | undefined; needsDownload: boolean } {
  const list = langs.split("+").filter(Boolean);
  const needsDownload = list.some((l) => !BUNDLED_LANGS.has(l));
  // One langPath serves every language in a worker. Left unset, Tesseract fetches each language
  // from its own package on the CDN; each file is cached after its first download, so later runs
  // (including English) load from the cache and work offline.
  return { langPath: needsDownload ? undefined : bundledPath, needsDownload };
}
