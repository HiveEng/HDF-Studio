# Writes the user guide's diagrams (public/help/d-*.svg). Run: python3 scripts/help/diagrams.py
import math, os
OUT = os.path.join(os.path.dirname(__file__), "..", "..", "public", "help")
HEAD = '<svg xmlns="http://www.w3.org/2000/svg" font-family="Segoe UI, Arial, sans-serif" font-size="13" viewBox="0 0 {w} {h}" width="{w}" height="{h}">'
DEFS = '''<defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#d91a1a"/></marker>
<marker id="ab" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#0b6fd6"/></marker>
<marker id="ag" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#575859"/></marker>
<style>.lbl{fill:#1e1f20}.mut{fill:#6c6e70;font-size:12px}.ttl{font-weight:600;font-size:14px;fill:#1e1f20}.st{fill:#05C7F2}.stt{fill:#0D0D0D;font-weight:700;font-size:12px}.drw{stroke:#9a9c9e;fill:none;stroke-width:1.2}</style></defs>'''

def svg(name, w, h, body):
    with open(os.path.join(OUT, name), "w") as f:
        f.write(HEAD.format(w=w, h=h) + DEFS + f'<rect width="{w}" height="{h}" fill="#fff"/>' + body + "</svg>\n")

def step(x, y, n):
    return f'<circle class="st" cx="{x}" cy="{y}" r="11"/><text class="stt" x="{x}" y="{y+4}" text-anchor="middle">{n}</text>'

def t(x, y, s, cls="lbl", anchor="start", extra=""):
    return f'<text class="{cls}" x="{x}" y="{y}" text-anchor="{anchor}" {extra}>{s}</text>'

def scallops(pts, r=9, color="#d91a1a", width=1.8, fill="none"):
    """Revision-cloud outline: arcs bulging outward along each edge of a clockwise polygon."""
    d = []
    n = len(pts)
    for i in range(n):
        (x1, y1), (x2, y2) = pts[i], pts[(i + 1) % n]
        L = math.hypot(x2 - x1, y2 - y1)
        k = max(1, round(L / (2 * r)))
        for j in range(k):
            ax, ay = x1 + (x2 - x1) * j / k, y1 + (y2 - y1) * j / k
            bx, by = x1 + (x2 - x1) * (j + 1) / k, y1 + (y2 - y1) * (j + 1) / k
            if not d: d.append(f"M{ax:.1f} {ay:.1f}")
            rr = L / k / 2
            d.append(f"A{rr:.1f} {rr:.1f} 0 0 1 {bx:.1f} {by:.1f}")
    return f'<path d="{" ".join(d)}Z" fill="{fill}" stroke="{color}" stroke-width="{width}"/>'

def plan(x, y, w, h):
    """A scrap of floor plan for context."""
    return (f'<g class="drw"><rect x="{x}" y="{y}" width="{w}" height="{h}"/><rect x="{x+6}" y="{y+6}" width="{w-12}" height="{h-12}"/>'
            f'<line x1="{x+w*0.45}" y1="{y+6}" x2="{x+w*0.45}" y2="{y+h-6}"/><line x1="{x+6}" y1="{y+h*0.55}" x2="{x+w*0.45}" y2="{y+h*0.55}"/></g>')

# ---- callout ----
svg("d-callout.svg", 640, 230,
    plan(30, 110, 200, 100) +
    '<path d="M150 160 L330 72" stroke="#d91a1a" stroke-width="1.6" fill="none" marker-start="url(#ar)"/>'
    '<rect x="330" y="45" width="200" height="52" fill="#fff" stroke="#d91a1a" stroke-width="1.4"/>' +
    t(340, 67, "Confirm door swing", extra='fill="#d91a1a" style="fill:#d91a1a"') + t(340, 86, "with owner", extra='style="fill:#d91a1a"') +
    step(150, 160, 1) + step(330, 45, 2) + step(545, 71, 3) +
    t(30, 28, '<tspan font-weight="700">1</tspan>  Click the point the arrow should touch') +
    t(300, 132, '<tspan font-weight="700">2</tspan>  Click where the text goes') +
    t(300, 152, '<tspan font-weight="700">3</tspan>  Type the text, then Ctrl+Enter'))

# ---- text box grips ----
g = '<g fill="#fff" stroke="#05C7F2" stroke-width="1.5">' + "".join(f'<rect x="{x-5}" y="{y-5}" width="10" height="10"/>' for x, y in [(200,80),(420,80),(200,150),(420,150),(310,150),(200,115),(420,115),(310,80)]) + "</g>"
svg("d-textbox-grips.svg", 640, 232,
    '<rect x="200" y="80" width="220" height="70" fill="none" stroke="#05C7F2" stroke-width="1.5" stroke-dasharray="5 3"/>' +
    t(212, 109, "VERIFY HEADER SIZE", extra='font-size="15"') + t(212, 131, "AT GRID B/3", extra='font-size="15"') + g +
    '<line x1="310" y1="75" x2="310" y2="48" stroke="#05C7F2" stroke-width="1.5"/><circle cx="310" cy="40" r="8" fill="#fff" stroke="#05C7F2" stroke-width="1.5"/>'
    '<g stroke="#575859" fill="none" stroke-width="1.2"><path d="M324 37 L455 30" marker-end="url(#ag)"/><path d="M428 157 L478 186" marker-end="url(#ag)"/><path d="M193 117 L168 124" marker-end="url(#ag)"/><path d="M285 115 L255 190" marker-end="url(#ag)"/></g>' +
    t(462, 34, "Round knob: turn") + t(462, 51, "Hold Shift for 15° steps", "mut") +
    t(484, 196, "Corner grip: resize") +
    t(10, 124, "Side grip: width") + t(10, 141, "the text re-wraps", "mut") +
    t(180, 206, "Drag inside: move") + t(180, 222, "Double-click: edit the text", "mut"))

# ---- leader ----
svg("d-leader.svg", 690, 255,
    t(20, 26, "Leaders from a text box (multileader)", "ttl") +
    '<rect x="30" y="50" width="150" height="44" fill="#fff" stroke="#d91a1a" stroke-width="1.4"/>' + t(42, 77, "TYP. ALL DOORS", extra='style="fill:#d91a1a"') +
    '<g stroke="#d91a1a" stroke-width="1.5" fill="none"><path d="M90 94 L70 196" marker-end="url(#ar)"/><path d="M130 94 L190 196" marker-end="url(#ar)"/><path d="M180 84 L300 186" marker-end="url(#ar)"/></g>' +
    step(70, 211, 1) + step(190, 211, 2) + step(300, 201, 3) +
    t(20, 245, "Select the box, Leader (Shift+L), click each tip, then Esc", "mut") +
    '<line x1="365" y1="20" x2="365" y2="240" stroke="#e1e3e4"/>' +
    t(390, 26, "A free leader", "ttl") +
    '<path d="M440 190 L610 80" stroke="#d91a1a" stroke-width="1.5" fill="none" marker-start="url(#ar)"/>' +
    step(440, 190, 1) + step(610, 80, 2) +
    t(458, 212, '<tspan font-weight="700">1</tspan>  Click the arrow tip') + t(470, 62, '<tspan font-weight="700">2</tspan>  Click where it starts') +
    t(390, 245, "Leader with nothing selected", "mut"))

# ---- cloud ----
poly = [(120, 60), (360, 60), (360, 120), (470, 120), (470, 175), (120, 175)]
svg("d-cloud.svg", 660, 222,
    '<g class="drw"><path d="M40 212h440M40 40h580M300 40v172"/></g>' + scallops(poly, 10, fill="rgba(217,26,26,.05)") +
    "".join(step(x, y, i + 1) for i, (x, y) in enumerate(poly)) +
    t(492, 180, "Right-click to finish") + t(492, 197, "or double-click, or Enter", "mut") +
    t(120, 28, "Click each corner around the change", "mut"))

# ---- window / crossing ----
def marks(ox):
    return (f'<rect x="{ox+40}" y="70" width="60" height="40" fill="none" stroke="#d91a1a" stroke-width="2"/>'
            f'<ellipse cx="{ox+150}" cy="150" rx="34" ry="22" fill="none" stroke="#d91a1a" stroke-width="2"/>'
            f'<path d="M{ox+210} 70 l60 50" stroke="#d91a1a" stroke-width="2" marker-end="url(#ar)"/>')
svg("d-window-crossing.svg", 720, 260,
    t(20, 26, "Left to right: window", "ttl") + t(20, 44, "selects what is fully inside", "mut") + marks(0) +
    '<rect x="25" y="58" width="180" height="125" fill="rgba(5,120,242,.10)" stroke="#0578f2" stroke-width="1.5"/>' +
    '<path d="M25 200 L205 200" stroke="#0578f2" stroke-width="1.5" marker-end="url(#ab)"/>' +
    t(20, 230, "Selected: rectangle and ellipse") + t(20, 247, "The arrow sticks out, so it isn't", "mut") +
    '<line x1="360" y1="20" x2="360" y2="250" stroke="#e1e3e4"/>' +
    t(380, 26, "Right to left: crossing", "ttl") + t(380, 44, "selects anything the box touches", "mut") + marks(360) +
    '<rect x="470" y="100" width="150" height="70" fill="rgba(26,160,60,.10)" stroke="#1aa03c" stroke-width="1.5" stroke-dasharray="6 4"/>' +
    '<path d="M620 200 L470 200" stroke="#1aa03c" stroke-width="1.5" marker-end="url(#ag)"/>' +
    t(380, 230, "Selected: ellipse and arrow") + t(380, 247, "Both touch the box", "mut"))

# ---- calibrate ----
svg("d-calibrate.svg", 660, 210,
    '<g class="drw"><line x1="80" y1="60" x2="80" y2="170"/><line x1="440" y1="60" x2="440" y2="170"/><line x1="70" y1="140" x2="450" y2="140"/></g>'
    '<circle cx="80" cy="50" r="12" fill="none" stroke="#9a9c9e"/><text x="80" y="55" text-anchor="middle" fill="#6c6e70" font-weight="700">2</text>'
    '<circle cx="440" cy="50" r="12" fill="none" stroke="#9a9c9e"/><text x="440" y="55" text-anchor="middle" fill="#6c6e70" font-weight="700">3</text>' +
    t(260, 133, "18'-0\"", "mut", "middle") +
    '<line x1="80" y1="105" x2="440" y2="105" stroke="#0b6fd6" stroke-width="2"/>' + step(80, 105, 1) + step(440, 105, 2) +
    '<rect x="470" y="80" width="170" height="52" rx="6" fill="#f8f9f9" stroke="#cfd2d3"/>' + t(480, 99, "Real length", "mut") +
    '<rect x="480" y="105" width="150" height="20" rx="3" fill="#fff" stroke="#05C7F2"/>' + t(486, 120, "18'") +
    step(470, 80, 3) +
    t(80, 196, '<tspan font-weight="700">1</tspan> and <tspan font-weight="700">2</tspan>  Click both ends of a dimension you know      <tspan font-weight="700">3</tspan>  Type its real length'))

# ---- measure tools ----
cells = []
def cell(x, y, title, body, note):
    cells.append(f'<g transform="translate({x},{y})"><rect width="200" height="130" rx="8" fill="#f8f9f9" stroke="#e1e3e4"/>{t(12, 22, title, "ttl")}{body}{t(12, 120, note, "mut")}</g>')
B = 'stroke="#0b6fd6" stroke-width="2" fill="none"'
dot = lambda x, y: f'<circle cx="{x}" cy="{y}" r="3.5" fill="#0b6fd6"/>'
cell(10, 10, "Length (M)", f'<line x1="20" y1="70" x2="180" y2="70" {B} marker-start="url(#ab)" marker-end="url(#ab)"/>' + t(100, 62, "18'-0\"", "lbl", "middle"), "Click both ends")
cell(220, 10, "Polylength", f'<polyline points="20,90 70,45 120,80 180,40" {B}/>' + "".join(dot(*p) for p in [(20,90),(70,45),(120,80),(180,40)]), "Click points, right-click")
cell(430, 10, "Area / Perimeter", f'<polygon points="30,40 170,40 170,95 90,95 90,75 30,75" stroke="#0b6fd6" stroke-width="2" fill="rgba(11,111,214,.12)"/>' + t(110, 66, "272 sq ft", "lbl", "middle"), "Click corners, right-click")
cell(10, 150, "Angle", f'<polyline points="180,90 40,90 140,40" {B}/>' + '<path d="M80 90 A40 40 0 0 0 76 72" stroke="#0b6fd6" fill="none"/>' + t(95, 82, "27°", "lbl") + step(140, 40, 1) + step(40, 90, 2) + step(180, 90, 3), "Leg, corner, leg")
cell(220, 150, "Count", "".join(f'<circle cx="{x}" cy="70" r="10" fill="#d91a1a"/><text x="{x}" y="74" text-anchor="middle" fill="#fff" font-size="11" font-weight="700">{i+1}</text>' for i, x in enumerate([40, 80, 120, 160])), "Click each item")
cell(430, 150, "Dimension", '<g stroke="#1e1f20" stroke-width="1.2"><line x1="25" y1="85" x2="25" y2="55"/><line x1="175" y1="85" x2="175" y2="55"/><line x1="25" y1="65" x2="175" y2="65"/><line x1="20" y1="70" x2="30" y2="60"/><line x1="170" y1="70" x2="180" y2="60"/></g>' + t(100, 58, "12'-6\"", "lbl", "middle"), "Click both ends")
svg("d-measure.svg", 640, 290, "".join(cells))

# ---- stacked fraction ----
svg("d-fraction.svg", 460, 120,
    '<line x1="30" y1="70" x2="300" y2="70" stroke="#0b6fd6" stroke-width="2" marker-start="url(#ab)" marker-end="url(#ab)"/>'
    '<rect x="100" y="38" width="128" height="40" fill="#fff"/>'
    '<text x="104" y="68" font-size="24" fill="#0b6fd6">12\'-6</text>'
    '<text x="183" y="54" font-size="13" fill="#0b6fd6">3</text><line x1="180" y1="58" x2="194" y2="58" stroke="#0b6fd6"/><text x="183" y="72" font-size="13" fill="#0b6fd6">8</text>'
    '<text x="198" y="68" font-size="24" fill="#0b6fd6">"</text>' +
    t(320, 60, "Fractions are drawn") + t(320, 78, "stacked, as on CAD", "lbl") + t(320, 96, "drawings", "lbl"))

# ---- compare overlay ----
svg("d-compare.svg", 680, 210,
    t(20, 26, "Older (red)", "ttl") + '<g stroke="#d91a1a" stroke-width="2" fill="none"><rect x="30" y="45" width="150" height="110"/><line x1="110" y1="45" x2="110" y2="155"/></g>' +
    t(215, 105, "+", "ttl", "middle", 'font-size="28"') +
    t(250, 26, "Newer (blue)", "ttl") + '<g stroke="#0b6fd6" stroke-width="2" fill="none"><rect x="250" y="45" width="150" height="110"/><line x1="310" y1="45" x2="310" y2="155"/><path d="M250 125 h22 a22 22 0 0 1 -22 -22"/></g>' +
    t(435, 105, "=", "ttl", "middle", 'font-size="28"') +
    t(470, 26, "Overlay", "ttl") + '<rect x="470" y="45" width="150" height="110" fill="none" stroke="#1e1f20" stroke-width="2"/><line x1="550" y1="45" x2="550" y2="155" stroke="#d91a1a" stroke-width="2"/><line x1="530" y1="45" x2="530" y2="155" stroke="#0b6fd6" stroke-width="2"/><path d="M470 125 h22 a22 22 0 0 1 -22 -22" stroke="#0b6fd6" stroke-width="2" fill="none"/>' +
    t(470, 178, "Black: the same in both", "mut") + t(470, 194, "Red: removed   Blue: added or moved", "mut"))

# ---- extract area ----
svg("d-extract.svg", 620, 200, plan(30, 30, 300, 150) +
    '<rect x="150" y="50" width="140" height="90" fill="rgba(5,199,242,.12)" stroke="#05C7F2" stroke-width="1.6" stroke-dasharray="6 3"/>' +
    '<path d="M300 95 L400 95" stroke="#575859" stroke-width="1.4" marker-end="url(#ag)"/>' +
    '<rect x="410" y="50" width="160" height="100" fill="#fff" stroke="#cfd2d3"/><g class="drw"><line x1="440" y1="50" x2="440" y2="150"/><line x1="410" y1="110" x2="440" y2="110"/></g>' +
    t(490, 170, "area.png, 300 dpi", "mut", "middle") + t(150, 196, "Drag a box around any part of the page", "mut"))

# ---- insert pages ----
def pages(x, y, labels, hl=()):
    out = ""
    for i, l in enumerate(labels):
        c = "#C5D932" if i in hl else "#fff"
        out += f'<rect x="{x+i*46}" y="{y}" width="38" height="50" rx="3" fill="{c}" stroke="#9a9c9e"/>' + t(x + i * 46 + 19, y + 30, l, "lbl", "middle")
    return out
svg("d-insert.svg", 640, 230,
    t(20, 26, "Your document", "ttl") + pages(20, 38, ["1", "2", "3", "4"]) +
    t(250, 26, "Pages 1-2 of another file", "ttl") + pages(250, 38, ["A", "B"], (0, 1)) +
    t(20, 122, "At the beginning", "mut") + pages(20, 130, ["A", "B", "1", "2", "3", "4"], (0, 1)) +
    t(330, 122, "After page 2", "mut") + pages(330, 130, ["1", "2", "A", "B", "3", "4"], (2, 3)))

# ---- redact flow ----
def box(x, y, w, n, title, sub):
    return (f'<rect x="{x}" y="{y}" width="{w}" height="78" rx="8" fill="#f8f9f9" stroke="#e1e3e4"/>' + step(x + 18, y + 20, n) +
            t(x + 36, y + 25, title, "ttl") + t(x + 12, y + 50, sub[0], "mut") + t(x + 12, y + 66, sub[1], "mut"))
arrow = lambda x: f'<path d="M{x} 60 l26 0" stroke="#575859" stroke-width="1.4" marker-end="url(#ag)"/>'
svg("d-redact.svg", 690, 110,
    box(10, 20, 140, 1, "Mark", ("Mark area (D) or", "Find &amp; redact")) + arrow(155) +
    box(186, 20, 140, 2, "Review", ("Check marks in the", "Comments panel")) + arrow(331) +
    box(362, 20, 140, 3, "Apply", ("Content removed,", "black boxes added")) + arrow(507) +
    box(538, 20, 140, 4, "Save", ("Now permanent;", "Ctrl+Z until then")))

# ---- OCR ----
svg("d-ocr.svg", 660, 200,
    t(20, 24, "Scanned page (a picture)", "ttl") +
    '<rect x="20" y="36" width="190" height="130" fill="#f3f1ea" stroke="#cfd2d3"/>' +
    "".join(f'<rect x="36" y="{56+i*22}" width="{150 - (i % 2) * 40}" height="9" fill="#6b6b6b" opacity=".75"/>' for i in range(5)) +
    t(250, 105, "+", "ttl", "middle", 'font-size="28"') +
    t(285, 24, "Invisible text layer", "ttl") +
    '<rect x="285" y="36" width="190" height="130" fill="none" stroke="#05C7F2" stroke-dasharray="5 3"/>' +
    "".join(t(300, 66 + i * 22, w, "lbl", "start", 'style="fill:#0389a8" font-size="12"') for i, w in enumerate(["GENERAL NOTES", "1. ALL DIMENSIONS", "2. VERIFY ON SITE", "3. NEW PARTITIONS", "4. DOORS: 915 x 2135"])) +
    t(515, 105, "=", "ttl", "middle", 'font-size="28"') +
    t(545, 70, "Looks the same,") + t(545, 88, "but searchable") + t(545, 106, "and copyable"))

# ---- batch ----
svg("d-batch.svg", 680, 170,
    "".join(f'<rect x="{20+i*8}" y="{40+i*8}" width="70" height="90" rx="3" fill="#fff" stroke="#9a9c9e"/>' for i in range(3)) + t(55, 160, "Your PDFs", "mut", "middle") +
    '<path d="M120 95 l40 0" stroke="#575859" stroke-width="1.4" marker-end="url(#ag)"/>' +
    '<rect x="170" y="30" width="300" height="120" rx="8" fill="#f8f9f9" stroke="#e1e3e4"/>' + t(185, 52, "Recipe", "ttl") +
    "".join(step(196, 76 + i * 24, i + 1) + t(214, 81 + i * 24, s) for i, s in enumerate(["Recognize text (OCR)", "Stamp Page {page} of {pages}", "Compress"])) +
    '<path d="M480 95 l40 0" stroke="#575859" stroke-width="1.4" marker-end="url(#ag)"/>' +
    "".join(f'<rect x="{535+i*8}" y="{40+i*8}" width="70" height="90" rx="3" fill="#f1f6d3" stroke="#C5D932"/>' for i in range(3)) + t(585, 160, "Processed copies", "mut", "middle"))
print("diagrams written")
