// A small sRGB ICC (v2) display profile, generated in code so no third-party profile file has to be
// shipped. Used as the PDF/A output intent.

function s15f16(v: number) {
  return Math.round(v * 65536) | 0;
}

export function srgbIcc(): Uint8Array {
  const desc = "sRGB (HDF Studio)";
  const cprt = "No copyright, use freely";
  // sRGB tone curve, sampled.
  const curve = Array.from({ length: 1024 }, (_, i) => {
    const c = i / 1023;
    return Math.round((c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) * 65535);
  });
  type Tag = [string, Uint8Array];
  const xyz = (x: number, y: number, z: number) => {
    const b = new DataView(new ArrayBuffer(20));
    b.setUint32(0, 0x58595a20); // 'XYZ '
    b.setInt32(8, s15f16(x));
    b.setInt32(12, s15f16(y));
    b.setInt32(16, s15f16(z));
    return new Uint8Array(b.buffer);
  };
  const curv = () => {
    const b = new DataView(new ArrayBuffer(12 + curve.length * 2));
    b.setUint32(0, 0x63757276); // 'curv'
    b.setUint32(8, curve.length);
    curve.forEach((v, i) => b.setUint16(12 + i * 2, v));
    return new Uint8Array(b.buffer);
  };
  const descTag = (s: string) => {
    // textDescriptionType: ASCII part, empty Unicode and ScriptCode parts.
    const n = s.length + 1;
    const b = new DataView(new ArrayBuffer(12 + n + 4 + 4 + 2 + 1 + 67));
    b.setUint32(0, 0x64657363); // 'desc'
    b.setUint32(8, n);
    for (let i = 0; i < s.length; i++) b.setUint8(12 + i, s.charCodeAt(i));
    return new Uint8Array(b.buffer);
  };
  const text = (s: string) => {
    const b = new DataView(new ArrayBuffer(8 + s.length + 1));
    b.setUint32(0, 0x74657874); // 'text'
    for (let i = 0; i < s.length; i++) b.setUint8(8 + i, s.charCodeAt(i));
    return new Uint8Array(b.buffer);
  };
  const trc = curv();
  const tags: Tag[] = [
    ["desc", descTag(desc)],
    ["cprt", text(cprt)],
    ["wtpt", xyz(0.9642, 1.0, 0.8249)],
    // sRGB primaries adapted to D50 (Bradford), as in the standard profile.
    ["rXYZ", xyz(0.4361, 0.2225, 0.0139)],
    ["gXYZ", xyz(0.3851, 0.7169, 0.0971)],
    ["bXYZ", xyz(0.1431, 0.0606, 0.7141)],
    ["rTRC", trc],
    ["gTRC", trc],
    ["bTRC", trc],
  ];
  const pad = (n: number) => (n + 3) & ~3;
  const headerLen = 128, tableLen = 4 + tags.length * 12;
  // Identical TRC data is stored once and shared by the three tags.
  const offsets = new Map<Uint8Array, number>();
  let off = headerLen + tableLen;
  for (const [, data] of tags) if (!offsets.has(data)) (offsets.set(data, off), (off += pad(data.length)));
  const size = off;
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, size);
  dv.setUint32(8, 0x02100000); // version 2.1
  dv.setUint32(12, 0x6d6e7472); // 'mntr' display device
  dv.setUint32(16, 0x52474220); // 'RGB '
  dv.setUint32(20, 0x58595a20); // PCS 'XYZ '
  dv.setUint16(24, 2026); dv.setUint16(26, 1); dv.setUint16(28, 1);
  dv.setUint32(36, 0x61637370); // 'acsp'
  dv.setInt32(68, s15f16(0.9642)); dv.setInt32(72, s15f16(1)); dv.setInt32(76, s15f16(0.8249)); // D50 illuminant
  dv.setUint32(128, tags.length);
  tags.forEach(([sig, data], i) => {
    const e = 132 + i * 12;
    for (let k = 0; k < 4; k++) buf[e + k] = sig.charCodeAt(k);
    dv.setUint32(e + 4, offsets.get(data)!);
    dv.setUint32(e + 8, data.length);
  });
  for (const [data, o] of offsets) buf.set(data, o);
  return buf;
}
