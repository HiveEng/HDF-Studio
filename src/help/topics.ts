// The user guide's topics, bundled with the app (src/help/topics/*.md) so help works offline.
import { parseTopic, type Topic } from "./markdown";

/** Product name used throughout the guide. */
export const APP_NAME = "HDS";
export const APP_FULL_NAME = "Hive Document Studio";

const files = import.meta.glob("./topics/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** Section order in the contents. */
export const SECTIONS = [
  "Getting started",
  "Viewing",
  "Markup and review",
  "Measuring",
  "Editing",
  "Pages",
  "Fill and sign",
  "Protect",
  "Convert",
  "Automate",
  "Microsoft 365",
  "Reference",
];

export const TOPICS: Topic[] = Object.entries(files)
  .map(([path, src]) => parseTopic(path.replace(/^.*\/|\.md$/g, ""), src.replace(/\{\{app\}\}/g, APP_NAME)))
  .sort((a, b) => {
    const sa = SECTIONS.indexOf(a.section), sb = SECTIONS.indexOf(b.section);
    return (sa < 0 ? 99 : sa) - (sb < 0 ? 99 : sb) || a.order - b.order || a.title.localeCompare(b.title);
  });

/** Guide images live in public/help. */
export const helpImage = (file: string) => (/^(https?:|data:|\/)/.test(file) ? file : `/help/${file}`);

/** The topic F1 should open for a ribbon tab ("tab:comment") or a tool ("tool:cloud"). */
export function topicForContext(keys: string[]): Topic | undefined {
  for (const k of keys) {
    const t = TOPICS.find((x) => x.context.includes(k));
    if (t) return t;
  }
  return undefined;
}
