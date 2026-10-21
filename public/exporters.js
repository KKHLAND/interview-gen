// 결과물 내보내기: 공통 문서 모델(blocks) → 인쇄용 HTML · TXT · Word(.docx) · 한글(.hwpx)
// 외부 라이브러리 없이 브라우저에서 직접 zip을 만든다. (압축: CompressionStream, 없으면 무압축)
//
// 문서 모델
//   { t: "title", text } 문서 제목     { t: "meta", text } 보조 정보 줄
//   { t: "h1", text } 영역 제목        { t: "item", blocks: [...] } 문항 묶음(인쇄 시 쪽 나눔 방지)
//   { t: "h2", text } 항목(문항) 제목  { t: "tag", text } 작은 꼬리표
//   { t: "p", text, label? } 문단      { t: "li", text, n? } 목록(n이 있으면 번호)

const flat = (blocks) => blocks.flatMap((b) => (b.t === "item" ? flat(b.blocks) : [b]));
const tidy = (s) => String(s ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").replace(/\s*\n\s*/g, " ");
const clean = (s) => tidy(s).trim();
const escHtml = (s) => clean(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const escXml = (s) => tidy(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
const bullet = (b) => (b.n != null ? `${b.n}. ` : "• ");

// ---------- 인쇄(PDF 저장)용 HTML ----------
export function toPrintHtml(blocks) {
  const one = (b) => {
    switch (b.t) {
      case "title": return `<h1>${escHtml(b.text)}</h1>`;
      case "meta": return `<div class="meta">${escHtml(b.text)}</div>`;
      case "h1": return `<h3 class="sec">${escHtml(b.text)}</h3>`;
      case "h2": return `<h2>${escHtml(b.text)}</h2>`;
      case "tag": return `<div class="tag">${escHtml(b.text)}</div>`;
      case "p": return `<p>${b.label ? `<span class="lbl">${escHtml(b.label)}</span> ` : ""}${escHtml(b.text)}</p>`;
      case "li": return `<p class="li"><span class="bul">${escHtml(bullet(b))}</span>${escHtml(b.text)}</p>`;
      case "item": return `<div class="pq">${b.blocks.map(one).join("")}</div>`;
      default: return "";
    }
  };
  return blocks.map(one).join("");
}

// ---------- TXT ----------
export function toText(blocks) {
  const out = [];
  for (const b of flat(blocks)) {
    const t = clean(b.text);
    if (b.t === "title") out.push(`[${t}]`);
    else if (b.t === "meta") out.push(t, "");
    else if (b.t === "h1") out.push("", `■ ${t}`, "");
    else if (b.t === "h2") out.push("", t);
    else if (b.t === "tag") out.push(`  (${t})`);
    else if (b.t === "p") out.push(`  - ${b.label ? `${clean(b.label)}: ` : ""}${t}`);
    else if (b.t === "li") out.push(`    ${bullet(b)}${t}`);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// ---------- zip (store / deflate-raw) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
async function deflateRaw(data) {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch { return null; }
}
const enc = new TextEncoder();

// entries: [{ name, data: string|Uint8Array, store?: boolean }] — 순서 그대로 기록
export async function makeZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const raw = typeof e.data === "string" ? enc.encode(e.data) : e.data;
    const crc = crc32(raw);
    let body = raw, method = 0;
    if (!e.store) { const d = await deflateRaw(raw); if (d && d.length < raw.length) { body = d; method = 8; } }
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, method, true);
    lh.setUint16(10, 0, true); lh.setUint16(12, 0x21, true); // 1980-01-01
    lh.setUint32(14, crc, true); lh.setUint32(18, body.length, true); lh.setUint32(22, raw.length, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    locals.push(new Uint8Array(lh.buffer), name, body);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, method, true);
    ch.setUint16(12, 0, true); ch.setUint16(14, 0x21, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, body.length, true); ch.setUint32(24, raw.length, true);
    ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    centrals.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const cdSize = centrals.reduce((s, a) => s + a.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...locals, ...centrals, new Uint8Array(end.buffer)]);
}

// ---------- Word (.docx) ----------
function docxRun(text, { bold, size, color } = {}) {
  const pr = [bold ? "<w:b/><w:bCs/>" : "", color ? `<w:color w:val="${color}"/>` : "", size ? `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` : ""].join("");
  return `<w:r>${pr ? `<w:rPr>${pr}</w:rPr>` : ""}<w:t xml:space="preserve">${escXml(text)}</w:t></w:r>`;
}
function docxPara(runs, { style, indent, before, after, keep } = {}) {
  const pr = [style ? `<w:pStyle w:val="${style}"/>` : "", keep ? "<w:keepNext/>" : "", before != null || after != null ? `<w:spacing w:before="${before ?? 0}" w:after="${after ?? 120}"/>` : "", indent ? `<w:ind w:left="${indent}" w:hanging="260"/>` : ""].join("");
  return `<w:p>${pr ? `<w:pPr>${pr}</w:pPr>` : ""}${runs}</w:p>`;
}
const DOCX_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Malgun Gothic" w:hAnsi="Malgun Gothic" w:eastAsia="맑은 고딕" w:cs="Malgun Gothic"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-US" w:eastAsia="ko-KR"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="80"/><w:jc w:val="left"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:bCs/><w:color w:val="2F2F8F"/><w:sz w:val="27"/><w:szCs w:val="27"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="23"/><w:szCs w:val="23"/></w:rPr></w:style>
</w:styles>`;

export async function toDocx(blocks, title = "문서") {
  const body = flat(blocks).map((b) => {
    switch (b.t) {
      case "title": return docxPara(docxRun(b.text), { style: "Title" });
      case "meta": return docxPara(docxRun(b.text, { color: "666666", size: 18 }), { after: 240 });
      case "h1": return docxPara(docxRun(b.text), { style: "Heading1" });
      case "h2": return docxPara(docxRun(b.text), { style: "Heading2" });
      case "tag": return docxPara(docxRun(b.text, { bold: true, color: "4343B8", size: 18 }), { after: 40, keep: true });
      case "p": return docxPara((b.label ? docxRun(b.label + " ", { bold: true }) : "") + docxRun(b.text));
      case "li": return docxPara(docxRun(bullet(b)) + docxRun(b.text), { indent: 520, after: 60 });
      default: return "";
    }
  }).join("");
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const files = [
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>` },
    { name: "docProps/core.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${escXml(title)}</dc:title><dc:creator>생기부 면접 Lab</dc:creator></cp:coreProperties>` },
    { name: "word/_rels/document.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "word/styles.xml", data: DOCX_STYLES },
    { name: "word/document.xml", data: doc },
  ];
  const zip = await makeZip(files);
  return new Blob([zip], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}

// ---------- 한글 (.hwpx) ----------
// 글자모양·문단모양 번호는 public/hwpx-template.js(빈 양식에 덧붙인 서식)를 따른다
const HC = { normal: 0, bold: 7, title: 8, head: 9, tag: 10, meta: 11 };
const HP = { normal: 0, head: 20, list: 21, body: 22, item: 23 };
const hRun = (cp, text) => `<hp:run charPrIDRef="${cp}"><hp:t>${escXml(text)}</hp:t></hp:run>`;
const hPara = (pp, runs) => `<hp:p id="0" paraPrIDRef="${pp}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">${runs}</hp:p>`;

export async function toHwpx(blocks, title = "문서") {
  const { HWPX_FILES } = await import("./hwpx-template.js");
  const body = flat(blocks).map((b) => {
    switch (b.t) {
      case "title": return hPara(HP.body, hRun(HC.title, b.text));
      case "meta": return hPara(HP.body, hRun(HC.meta, b.text));
      case "h1": return hPara(HP.head, hRun(HC.head, b.text));
      case "h2": return hPara(HP.item, hRun(HC.bold, b.text));
      case "tag": return hPara(HP.normal, hRun(HC.tag, b.text));
      case "p": return hPara(HP.body, (b.label ? hRun(HC.bold, b.label + " ") : "") + hRun(HC.normal, b.text));
      case "li": return hPara(HP.list, hRun(HC.normal, bullet(b) + clean(b.text)));
      default: return "";
    }
  }).join("");
  const files = HWPX_FILES.map(([name, kind, data]) => {
    let d = kind === "b" ? Uint8Array.from(atob(data), (c) => c.charCodeAt(0)) : data;
    if (name === "Contents/section0.xml") d = d.replace("{{BODY}}", body);
    if (name === "Contents/content.hpf") d = d.replace("<opf:title/>", `<opf:title>${escXml(title)}</opf:title>`);
    if (name === "Preview/PrvText.txt") d = toText(blocks).slice(0, 1000);
    return { name, data: d, store: name === "mimetype" };
  });
  const zip = await makeZip(files);
  return new Blob([zip], { type: "application/hwp+zip" });
}
