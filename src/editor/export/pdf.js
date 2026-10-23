// Minimal PDF writer for the capture report (§8): standard Helvetica fonts (WinAnsi), JPEG images
// (DCTDecode), URI link annotations, automatic pagination. No dependencies; runs in Node for tests.

const PAGE_SIZES = { letter: [612, 792], a4: [595.28, 841.89] };
const MARGIN = 50;

// Helvetica advance widths (1/1000 em) for ASCII 32..126.
const HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556,
  556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const WINANSI = {
  '€': 0x80, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99,
  '×': 0xd7, '·': 0xb7, '→': null,
};

/** Map a JS string to WinAnsi single-byte chars (as a binary string). */
export function toWinAnsi(str) {
  let out = '';
  for (const ch of String(str)) {
    const code = ch.codePointAt(0);
    if (ch === '→') out += '->';
    else if (Object.prototype.hasOwnProperty.call(WINANSI, ch) && WINANSI[ch] !== null) out += String.fromCharCode(WINANSI[ch]);
    else if (code === 9) out += '    ';
    else if (code === 10) out += '\n';
    else if (code === 13) continue;
    else if (code >= 32 && code <= 126) out += ch;
    else if (code >= 0xa0 && code <= 0xff) out += ch;
    else out += '?';
  }
  return out;
}

export function textWidth(winAnsi, size, bold = false) {
  let w = 0;
  for (let i = 0; i < winAnsi.length; i++) {
    const c = winAnsi.charCodeAt(i);
    w += c >= 32 && c <= 126 ? HELV[c - 32] : 556;
  }
  return (w / 1000) * size * (bold ? 1.06 : 1);
}

export function wrapText(text, size, maxWidth, bold = false) {
  const lines = [];
  for (const para of toWinAnsi(text).split(/\r?\n/)) {
    const words = para.split(/ +/);
    let line = '';
    for (let word of words) {
      // Break words longer than the line.
      while (textWidth(word, size, bold) > maxWidth) {
        let cut = word.length - 1;
        while (cut > 1 && textWidth(word.slice(0, cut), size, bold) > maxWidth) cut--;
        if (line) { lines.push(line); line = ''; }
        lines.push(word.slice(0, cut));
        word = word.slice(cut);
      }
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate, size, bold) <= maxWidth) line = candidate;
      else { lines.push(line); line = word; }
    }
    lines.push(line);
  }
  return lines;
}

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/\r/g, '\\r');
const n = (v) => (Math.round(v * 100) / 100).toString();

function pdfDate(d) {
  const p = (x) => String(x).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function binaryStringToBytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/**
 * blocks: Array of
 *   { type: 'title', text }
 *   { type: 'meta', text }                     small grey line(s)
 *   { type: 'field', label, text }
 *   { type: 'list', label, items: string[] }   numbered
 *   { type: 'link', label, url }
 *   { type: 'image', jpeg: Uint8Array, width, height, caption? }
 * Returns Uint8Array.
 */
export function buildPdf({ pageSize = 'letter', blocks, title = 'Capture', createdAt = new Date() }) {
  const [W, H] = PAGE_SIZES[pageSize] || PAGE_SIZES.letter;
  const contentW = W - 2 * MARGIN;
  const pages = []; // { ops: [], annots: [], images: [] }
  let page = null;
  let y = 0;

  const newPage = () => {
    page = { ops: [], annots: [], images: [] };
    pages.push(page);
    y = H - MARGIN;
  };
  const ensure = (h) => { if (!page || y - h < MARGIN) newPage(); };
  const text = (str, x, size, { bold = false, color = [0, 0, 0] } = {}) => {
    page.ops.push(`BT /${bold ? 'F2' : 'F1'} ${n(size)} Tf ${color.map(n).join(' ')} rg ${n(x)} ${n(y)} Td (${esc(str)}) Tj ET`);
  };

  const images = []; // global XObjects
  newPage();

  for (const b of blocks) {
    if (b.type === 'title') {
      for (const line of wrapText(b.text, 18, contentW, true)) {
        ensure(24);
        y -= 18;
        text(line, MARGIN, 18, { bold: true });
        y -= 6;
      }
      y -= 2;
    } else if (b.type === 'meta') {
      for (const line of wrapText(b.text, 9, contentW)) {
        ensure(13);
        y -= 10;
        text(line, MARGIN, 9, { color: [0.38, 0.42, 0.48] });
        y -= 3;
      }
      y -= 8;
    } else if (b.type === 'field') {
      if (!b.text) continue;
      ensure(30);
      y -= 10;
      text(toWinAnsi(b.label.toUpperCase()), MARGIN, 8.5, { bold: true, color: [0.38, 0.42, 0.48] });
      y -= 5;
      for (const line of wrapText(b.text, 10.5, contentW)) {
        ensure(15);
        y -= 11;
        text(line, MARGIN, 10.5);
        y -= 3.5;
      }
      y -= 6;
    } else if (b.type === 'list') {
      const items = (b.items || []).filter((i) => i && i.trim());
      if (!items.length) continue;
      ensure(30);
      y -= 10;
      text(toWinAnsi(b.label.toUpperCase()), MARGIN, 8.5, { bold: true, color: [0.38, 0.42, 0.48] });
      y -= 5;
      const indent = 18;
      items.forEach((item, i) => {
        wrapText(item, 10.5, contentW - indent).forEach((line, j) => {
          ensure(15);
          y -= 11;
          if (j === 0) text(`${i + 1}.`, MARGIN, 10.5, { bold: true });
          text(line, MARGIN + indent, 10.5);
          y -= 3.5;
        });
      });
      y -= 6;
    } else if (b.type === 'link') {
      ensure(30);
      y -= 10;
      text(toWinAnsi(b.label.toUpperCase()), MARGIN, 8.5, { bold: true, color: [0.38, 0.42, 0.48] });
      y -= 5;
      for (const line of wrapText(b.url, 10, contentW)) {
        ensure(15);
        y -= 11;
        text(line, MARGIN, 10, { color: [0.1, 0.33, 0.85] });
        page.annots.push({ rect: [MARGIN, y - 2, MARGIN + textWidth(line, 10), y + 9], url: b.url });
        y -= 3.5;
      }
      y -= 6;
    } else if (b.type === 'image') {
      const maxH = H - 2 * MARGIN - (b.caption ? 16 : 0);
      let w = Math.min(contentW, b.width);
      let h = (w * b.height) / b.width;
      if (h > maxH) { h = maxH; w = (h * b.width) / b.height; }
      if (y - h - 10 < MARGIN) newPage();
      const idx = images.length;
      images.push(b);
      page.images.push(idx);
      y -= 8;
      if (b.caption) {
        y -= 9;
        text(toWinAnsi(b.caption), MARGIN, 9, { color: [0.38, 0.42, 0.48] });
        y -= 6;
      }
      y -= h;
      page.ops.push(`q 0.8 0.82 0.86 RG 0.5 w ${n(MARGIN - 0.5)} ${n(y - 0.5)} ${n(w + 1)} ${n(h + 1)} re S Q`);
      page.ops.push(`q ${n(w)} 0 0 ${n(h)} ${n(MARGIN)} ${n(y)} cm /Im${idx} Do Q`);
      y -= 12;
    }
  }

  // ---- serialize ----
  const objects = []; // index i → object number i+1; each entry is array of string|Uint8Array parts
  const alloc = () => { objects.push(null); return objects.length; };
  const set = (num, ...parts) => { objects[num - 1] = parts; };

  const catalog = alloc();
  const pagesObj = alloc();
  const fontRegular = alloc();
  const fontBold = alloc();
  const info = alloc();
  set(fontRegular, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  set(fontBold, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  set(info, `<< /Title (${esc(toWinAnsi(title))}) /Producer (Snap Companion) /CreationDate (${pdfDate(createdAt)}) >>`);

  const imageNums = images.map((img) => {
    const num = alloc();
    set(num,
      `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB ` +
      `/BitsPerComponent 8 /Filter /DCTDecode /Length ${img.jpeg.length} >>\nstream\n`,
      img.jpeg,
      '\nendstream');
    return num;
  });

  const pageNums = [];
  for (const p of pages) {
    const content = p.ops.join('\n');
    const contentNum = alloc();
    set(contentNum, `<< /Length ${content.length} >>\nstream\n`, content, '\nendstream');
    const annotNums = p.annots.map((a) => {
      const num = alloc();
      set(num, `<< /Type /Annot /Subtype /Link /Rect [${a.rect.map(n).join(' ')}] /Border [0 0 0] ` +
        `/A << /S /URI /URI (${esc(toWinAnsi(a.url))}) >> >>`);
      return num;
    });
    const xobj = p.images.length ? `/XObject << ${p.images.map((i) => `/Im${i} ${imageNums[i]} 0 R`).join(' ')} >>` : '';
    const pageNum = alloc();
    set(pageNum,
      `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${n(W)} ${n(H)}] ` +
      `/Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> ${xobj} >> ` +
      `/Contents ${contentNum} 0 R${annotNums.length ? ` /Annots [${annotNums.map((a) => `${a} 0 R`).join(' ')}]` : ''} >>`);
    pageNums.push(pageNum);
  }
  set(pagesObj, `<< /Type /Pages /Kids [${pageNums.map((p) => `${p} 0 R`).join(' ')}] /Count ${pageNums.length} >>`);
  set(catalog, `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);

  const chunks = [];
  let offset = 0;
  const push = (part) => {
    const bytes = typeof part === 'string' ? binaryStringToBytes(part) : part;
    chunks.push(bytes);
    offset += bytes.length;
  };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const offsets = [];
  objects.forEach((parts, i) => {
    offsets.push(offset);
    push(`${i + 1} 0 obj\n`);
    parts.forEach(push);
    push('\nendobj\n');
  });
  const xrefAt = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  const out = new Uint8Array(offset);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}
