// Task-based ribbon: the top-level tabs name what the user wants to do (Comment, Organize,
// Protect…), and each tab groups the tools for that job. Every button runs a palette command,
// so the ribbon, keyboard shortcuts and Ctrl+K always do exactly the same thing.
import {
  createElement, type IconNode,
  FolderOpen, Save, SavePen, FilePlus, Hand, TextCursor, Undo2, Redo2, Highlighter, Underline, Strikethrough,
  StickyNote, Type, Square, Circle, MoveUpRight, PenTool, MessagesSquare, Layers, SquarePen, CaseSensitive,
  ImagePlus, Replace, ImageDown, Stamp, FileInput, FilePlus2, Copy, Trash2, RotateCcw, RotateCw, ArrowUpDown,
  LayoutGrid, Merge, FileOutput, Scissors, Signature, PenLine, BadgeCheck, FileKey, ShieldCheck, Sheet,
  FileSpreadsheet, Eraser, SquareDashed, ScanSearch, Shredder, Lock, LockOpen, File, FileDown, Workflow, ListChecks,
  MoveHorizontal, Maximize, PanelLeft, Search, ScanText, ScanLine, GitCompare, FolderSync, ClipboardCheck, Archive, Languages, Users, Printer, FormInput, WandSparkles, Accessibility, Images,
  Cloud, MessageSquareQuote, Spline, Pentagon, Ruler, RulerDimensionLine, DraftingCompass, Hash, Scaling, Crosshair, Waypoints, LandPlot, Settings,
} from "lucide";

export function icon(node: IconNode, size = 18): SVGElement {
  return createElement(node, { width: size, height: size, "stroke-width": 1.75, "aria-hidden": "true" });
}

type Btn = { cmd: string; label: string; icon: IconNode; tool?: string; big?: boolean; hint?: string };
type Item = Btn | { el: string };
interface Group { label: string; items: Item[] }
export interface Task { id: string; label: string; groups: Group[] }

export const TASKS: Task[] = [
  {
    id: "home", label: "Home",
    groups: [
      { label: "File", items: [
        { cmd: "open", label: "Open", icon: FolderOpen, big: true },
        { cmd: "save", label: "Save", icon: Save, big: true },
        { cmd: "print", label: "Print", icon: Printer, big: true },
        { cmd: "saveAs", label: "Save as", icon: SavePen },
        { cmd: "createPdf", label: "Create PDF", icon: FilePlus },
        { cmd: "compare", label: "Compare", icon: GitCompare },
        { cmd: "settings", label: "Settings", icon: Settings },
      ] },
      { label: "Tools", items: [
        { cmd: "tool-hand", tool: "hand", label: "Hand", icon: Hand, big: true },
        { cmd: "tool-select", tool: "select", label: "Select", icon: TextCursor, big: true },
        { cmd: "tool-highlight", tool: "highlight", label: "Highlight", icon: Highlighter, big: true },
        { cmd: "tool-edit", tool: "edit", label: "Edit", icon: SquarePen, big: true },
        { cmd: "tool-sign", tool: "sign", label: "Sign", icon: Signature, big: true },
      ] },
      { label: "History", items: [
        { cmd: "undo", label: "Undo", icon: Undo2 },
        { cmd: "redo", label: "Redo", icon: Redo2 },
      ] },
      { label: "View", items: [
        { cmd: "fitWidth", label: "Fit width", icon: MoveHorizontal },
        { cmd: "fitPage", label: "Fit page", icon: Maximize },
        { cmd: "toggleSidebar", label: "Sidebar", icon: PanelLeft },
        { cmd: "find", label: "Find", icon: Search },
      ] },
    ],
  },
  {
    id: "comment", label: "Comment",
    groups: [
      { label: "Text markup", items: [
        { cmd: "tool-highlight", tool: "highlight", label: "Highlight", icon: Highlighter, big: true },
        { cmd: "tool-underline", tool: "underline", label: "Underline", icon: Underline },
        { cmd: "tool-strike", tool: "strike", label: "Strike out", icon: Strikethrough },
      ] },
      { label: "Notes", items: [
        { cmd: "tool-note", tool: "note", label: "Sticky note", icon: StickyNote, big: true },
        { cmd: "tool-text", tool: "text", label: "Text box", icon: Type, big: true },
      ] },
      { label: "Draw", items: [
        { cmd: "tool-ink", tool: "ink", label: "Pen", icon: PenTool, big: true },
        { cmd: "tool-rect", tool: "rect", label: "Rectangle", icon: Square },
        { cmd: "tool-ellipse", tool: "ellipse", label: "Ellipse", icon: Circle },
        { cmd: "tool-arrow", tool: "arrow", label: "Arrow", icon: MoveUpRight },
      ] },
      { label: "Engineering", items: [
        { cmd: "tool-cloud", tool: "cloud", label: "Cloud", icon: Cloud, big: true, hint: "Revision cloud: drag a box around the change" },
        { cmd: "tool-callout", tool: "callout", label: "Callout", icon: MessageSquareQuote, big: true },
        { cmd: "tool-stamp", tool: "stamp", label: "Stamp", icon: Stamp, big: true, hint: "Review stamps such as Approved as Noted" },
        { cmd: "tool-cloudpoly", tool: "cloudpoly", label: "Cloud shape", icon: Cloud },
        { cmd: "tool-dimension", tool: "dimension", label: "Dimension", icon: RulerDimensionLine },
        { cmd: "tool-polyline", tool: "polyline", label: "Polyline", icon: Spline },
        { cmd: "tool-polygon", tool: "polygon", label: "Polygon", icon: Pentagon },
      ] },
      { label: "Colour", items: [{ el: "color" }] },
      { label: "Review", items: [
        { cmd: "showComments", label: "Comments", icon: MessagesSquare, big: true },
        { cmd: "mergeReviews", label: "Merge reviews", icon: Users, big: true, hint: "Bring in comments from reviewers' copies or XFDF files" },
        { cmd: "compare", label: "Compare files", icon: GitCompare, big: true, hint: "Find every change between two versions" },
        { cmd: "flatten", label: "Flatten", icon: Layers },
      ] },
    ],
  },
  {
    id: "measure", label: "Measure",
    groups: [
      { label: "Scale", items: [
        { cmd: "setScale", label: "Set scale", icon: Scaling, big: true, hint: "Pick the drawing scale, e.g. 1/4\" = 1'-0\"" },
        { cmd: "tool-m-calibrate", tool: "m-calibrate", label: "Calibrate", icon: Crosshair, big: true, hint: "Click both ends of a known dimension" },
      ] },
      { label: "Measure", items: [
        { cmd: "tool-m-length", tool: "m-length", label: "Length", icon: Ruler, big: true },
        { cmd: "tool-m-area", tool: "m-area", label: "Area", icon: LandPlot, big: true },
        { cmd: "tool-m-polylength", tool: "m-polylength", label: "Polylength", icon: Waypoints },
        { cmd: "tool-m-perimeter", tool: "m-perimeter", label: "Perimeter", icon: Pentagon },
        { cmd: "tool-m-angle", tool: "m-angle", label: "Angle", icon: DraftingCompass },
        { cmd: "tool-m-count", tool: "m-count", label: "Count", icon: Hash },
      ] },
    ],
  },
  {
    id: "edit", label: "Edit",
    groups: [
      { label: "Content", items: [
        { cmd: "tool-edit", tool: "edit", label: "Edit text & images", icon: SquarePen, big: true },
        { cmd: "textStyle", label: "Text style", icon: CaseSensitive },
      ] },
      { label: "Images", items: [
        { cmd: "insertImage", label: "Insert image", icon: ImagePlus, big: true },
        { cmd: "replaceImage", label: "Replace", icon: Replace },
        { cmd: "saveImage", label: "Save image", icon: ImageDown },
      ] },
      { label: "Scans", items: [
        { cmd: "ocr", label: "Recognize text", icon: ScanText, big: true, hint: "OCR: make scanned pages searchable and copyable" },
        { cmd: "ocrPage", label: "This page", icon: ScanLine },
      ] },
      { label: "Page marks", items: [
        { cmd: "recipeCurrent", label: "Watermark, numbers & Bates", icon: Stamp, big: true },
      ] },
    ],
  },
  {
    id: "organize", label: "Organize",
    groups: [
      { label: "Insert", items: [
        { cmd: "insertFile", label: "From file", icon: FileInput, big: true },
        { cmd: "insertBlank", label: "Blank page", icon: FilePlus2 },
        { cmd: "duplicateSelected", label: "Duplicate", icon: Copy },
      ] },
      { label: "Pages", items: [
        { cmd: "deleteSelected", label: "Delete", icon: Trash2, big: true },
        { cmd: "rotateLeft", label: "Rotate left", icon: RotateCcw },
        { cmd: "rotateRight", label: "Rotate right", icon: RotateCw },
        { cmd: "reversePages", label: "Reverse order", icon: ArrowUpDown },
        { cmd: "selectAll", label: "Select all", icon: LayoutGrid },
      ] },
      { label: "Combine & split", items: [
        { cmd: "mergeFiles", label: "Merge files", icon: Merge, big: true },
        { cmd: "extractPages", label: "Extract", icon: FileOutput, big: true },
        { cmd: "splitDoc", label: "Split", icon: Scissors, big: true },
      ] },
    ],
  },
  {
    id: "sign", label: "Fill & Sign",
    groups: [
      { label: "Signature", items: [
        { cmd: "tool-sign", tool: "sign", label: "Sign", icon: Signature, big: true },
        { cmd: "newSignature", label: "New signature", icon: PenLine },
      ] },
      { label: "Digital ID", items: [
        { cmd: "signCert", label: "Certify", icon: FileKey, big: true },
        { cmd: "verifySigs", label: "Validate", icon: BadgeCheck },
        { cmd: "makeCert", label: "New digital ID", icon: ShieldCheck },
      ] },
      { label: "Prepare", items: [
        { cmd: "prepareForm", label: "Prepare form", icon: FormInput, big: true, hint: "Add, move and edit form fields" },
        { cmd: "detectFields", label: "Detect fields", icon: WandSparkles, big: true, hint: "Make a flat form fillable automatically" },
      ] },
      { label: "Forms", items: [
        { cmd: "fillCsv", label: "Fill from CSV", icon: FileSpreadsheet, big: true },
        { cmd: "exportForm", label: "Export data", icon: Sheet },
        { cmd: "clearForm", label: "Clear fields", icon: Eraser },
        { cmd: "flatten", label: "Flatten", icon: Layers },
      ] },
    ],
  },
  {
    id: "protect", label: "Protect",
    groups: [
      { label: "Redact", items: [
        { cmd: "tool-redact", tool: "redact", label: "Mark area", icon: SquareDashed, big: true },
        { cmd: "findRedact", label: "Find & redact", icon: ScanSearch, big: true },
        { cmd: "applyRedactions", label: "Apply", icon: ShieldCheck, big: true },
      ] },
      { label: "Compliance", items: [
        { cmd: "checkDoc", label: "Check document", icon: ClipboardCheck, big: true, hint: "PDF/A, accessibility and security" },
        { cmd: "saveAsPdfa", label: "Save as PDF/A", icon: Archive, big: true, hint: "For long-term archiving (needs Ghostscript)" },
        { cmd: "fixProps", label: "Title & language", icon: Languages },
      ] },
      { label: "Accessibility", items: [
        { cmd: "autoTag", label: "Make accessible", icon: Accessibility, big: true, hint: "Tag headings, lists, tables and images for screen readers" },
        { cmd: "altText", label: "Describe images", icon: Images, big: true, hint: "Alt text for every image" },
      ] },
      { label: "Security", items: [
        { cmd: "protect", label: "Password", icon: Lock, big: true },
        { cmd: "unprotect", label: "Remove password", icon: LockOpen },
        { cmd: "sanitize", label: "Remove hidden data", icon: Shredder },
      ] },
    ],
  },
  {
    id: "convert", label: "Convert",
    groups: [
      { label: "Create", items: [
        { cmd: "createPdf", label: "From files", icon: FilePlus, big: true, hint: "Word, Excel, PowerPoint, images, HTML, text" },
        { cmd: "newBlank", label: "Blank PDF", icon: File, big: true },
        { cmd: "mergeFiles", label: "Combine files", icon: Merge, big: true },
      ] },
      { label: "Scans", items: [
        { cmd: "ocr", label: "Recognize text", icon: ScanText, big: true, hint: "OCR: make scanned pages searchable and copyable" },
      ] },
      { label: "Archive", items: [
        { cmd: "saveAsPdfa", label: "PDF/A", icon: Archive, big: true, hint: "For long-term archiving (needs Ghostscript)" },
      ] },
      { label: "Export", items: [
        { cmd: "exportAs", label: "Export", icon: FileDown, big: true, hint: "Word, PNG/JPEG images, HTML, text or SVG" },
      ] },
    ],
  },
  {
    id: "automate", label: "Automate",
    groups: [
      { label: "Batch", items: [
        { cmd: "batch", label: "Batch process", icon: Workflow, big: true },
        { cmd: "recipeCurrent", label: "Run on this file", icon: ListChecks, big: true },
      ] },
      { label: "Automatic", items: [
        { cmd: "watchFolders", label: "Watch folders", icon: FolderSync, big: true, hint: "Process every PDF dropped into a folder" },
      ] },
    ],
  },
];

/** The ribbon task a command lives on (Home only if nowhere else), for labels in the palette. */
export function taskOf(cmd: string) {
  const has = (t: Task) => t.groups.some((g) => g.items.some((i) => "cmd" in i && i.cmd === cmd));
  return ([...TASKS.slice(1), TASKS[0]].find(has)?.label) ?? "";
}

export interface RibbonDeps {
  run(cmd: string): void;
  /** Title and shortcut of a command, for tooltips. */
  describe(cmd: string): { title: string; keys?: string } | undefined;
  /** Elements placed by name, e.g. the colour picker. */
  slots: Record<string, HTMLElement>;
}

export function setupRibbon(tabsEl: HTMLElement, ribbonEl: HTMLElement, d: RibbonDeps) {
  const panels = new Map<string, HTMLElement>();
  let current = localStorage.getItem("hdfstudio.task") ?? "home";
  if (!TASKS.some((t) => t.id === current)) current = "home";

  const button = (b: Btn) => {
    const el = document.createElement("button");
    el.className = b.big ? "rb big" : "rb";
    el.dataset.cmd = b.cmd;
    if (b.tool) el.dataset.tool = b.tool;
    const info = d.describe(b.cmd);
    el.title = [info?.title ?? b.label, b.hint, info?.keys && `(${info.keys})`].filter(Boolean).join(" ");
    el.append(icon(b.icon, b.big ? 22 : 16), Object.assign(document.createElement("span"), { textContent: b.label }));
    el.onclick = () => d.run(b.cmd);
    return el;
  };

  for (const task of TASKS) {
    const tab = document.createElement("button");
    tab.className = "task";
    tab.dataset.task = task.id;
    tab.textContent = task.label;
    tab.setAttribute("role", "tab");
    tab.onclick = () => show(task.id);
    tabsEl.append(tab);

    const panel = document.createElement("div");
    panel.className = "ribbon-panel";
    panel.setAttribute("role", "toolbar");
    panel.setAttribute("aria-label", task.label);
    for (const g of task.groups) {
      const group = document.createElement("div");
      group.className = "rgroup";
      const body = document.createElement("div");
      body.className = "rgroup-body";
      // Small buttons stack in columns of three beside the big ones.
      let stack: HTMLElement | null = null;
      for (const it of g.items) {
        if ("el" in it) {
          const slot = d.slots[it.el];
          if (slot) body.append(slot);
          stack = null;
        } else if (it.big) {
          body.append(button(it));
          stack = null;
        } else {
          if (!stack || stack.childElementCount >= 3) body.append((stack = Object.assign(document.createElement("div"), { className: "rstack" })));
          stack.append(button(it));
        }
      }
      group.append(body, Object.assign(document.createElement("div"), { className: "rgroup-label", textContent: g.label }));
      panel.append(group);
    }
    panels.set(task.id, panel);
    ribbonEl.append(panel);
  }

  function show(id: string) {
    current = id;
    localStorage.setItem("hdfstudio.task", id);
    tabsEl.querySelectorAll<HTMLElement>(".task").forEach((t) => {
      t.classList.toggle("active", t.dataset.task === id);
      t.setAttribute("aria-selected", String(t.dataset.task === id));
    });
    for (const [k, p] of panels) p.classList.toggle("hidden", k !== id);
  }

  /** Bring up the task that owns a tool, unless the current one already has it. */
  function revealTool(tool: string) {
    if (panels.get(current)?.querySelector(`[data-tool="${tool}"]`)) return;
    // Prefer the specialised task (Comment, Protect…) over Home's shortcuts.
    const owner = [...TASKS.slice(1), TASKS[0]].find((t) => t.groups.some((g) => g.items.some((i) => "tool" in i && i.tool === tool)));
    if (owner) show(owner.id);
  }

  show(current);
  return { show, revealTool, get current() { return current; } };
}
