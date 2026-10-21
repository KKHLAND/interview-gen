// 생기부 추출 데이터 ↔ 파일 형식(MD · JSON · 엑셀) 변환 (브라우저/Node 공용 ESM)
// - PDF에서 추출한 데이터를 MD·JSON·XLSX로 저장하고, 같은 형식으로 다시 불러올 수 있다.
// - 이 앱 형식이 아닌 MD·JSON·엑셀·CSV는 '자유 텍스트'로 읽어 AI 전송 텍스트로 쓴다.
// - 어떤 형식으로 들어오든 개인정보 패턴 마스킹(scrub)을 한 번 더 적용한다.
import { scrub } from "./parser.js";

export const FORMAT_ID = "saenggibu-record";
const AREAS = ["자율활동", "동아리활동", "진로활동"];

// ---------- 공통 ----------
const num = (v) => {
  if (v == null || v === "" || v === "-") return null;
  const n = Number(String(v).replace(/[^\d.\-]/g, ""));
  return Number.isFinite(n) && String(v).trim() !== "" ? n : null;
};
const str = (v) => (v == null ? "" : String(v)).trim();
const opt = (v) => { const s = str(v); return s && s !== "-" ? s : null; };

export function emptyRecord(source = "text") {
  return { creative: [], grades: [], seteuk: [], behavior: [], meta: { pages: 0, masked: 0, warnings: [], source } };
}

// 임의의 객체를 앱 레코드 형태로 정리하고 텍스트를 마스킹한다
export function normalizeRecord(obj, source) {
  const stats = { masked: 0 };
  const S = (t) => scrub(str(t), stats);
  const arr = (v) => (Array.isArray(v) ? v : []);
  const r = {
    creative: arr(obj.creative).map((c) => ({
      grade: num(c.grade) ?? 0,
      area: AREAS.find((a) => str(c.area).replace(/\s/g, "") === a) || str(c.area) || "자율활동",
      hours: num(c.hours),
      hope: opt(c.hope) ? S(c.hope) : null,
      text: S(c.text),
    })),
    grades: arr(obj.grades).map((g) => {
      const row = { grade: num(g.grade) ?? 0, semester: num(g.semester), kind: str(g.kind) || "일반", group: str(g.group), subject: str(g.subject), credits: num(g.credits) ?? 0 };
      for (const k of ["score", "avg", "sd", "students", "rank"]) { const v = num(g[k]); if (v != null) row[k] = v; }
      if (opt(g.achievement)) row.achievement = str(g.achievement);
      if (opt(g.distribution)) row.distribution = str(g.distribution);
      return row;
    }).filter((g) => g.subject || g.group),
    seteuk: arr(obj.seteuk).map((s) => ({ grade: num(s.grade) ?? 0, kind: str(s.kind) || "일반", subject: str(s.subject) || "개인별 세특", text: S(s.text) })).filter((s) => s.text),
    behavior: arr(obj.behavior).map((b) => ({ grade: num(b.grade) ?? 0, text: S(b.text) })).filter((b) => b.text),
  };
  r.meta = { pages: num(obj.meta?.pages) ?? 0, masked: stats.masked, warnings: [], source };
  return r;
}

export function recordCount(r) {
  return r.creative.length + r.grades.length + r.seteuk.length + r.behavior.length;
}

// 구조를 알 수 없는 텍스트 → 영역 없이 전송 텍스트만 가진 레코드
export function textRecord(text, source) {
  const stats = { masked: 0 };
  const r = emptyRecord(source);
  r.rawText = scrub(str(text), stats);
  r.meta.masked = stats.masked;
  r.meta.warnings.push("이 앱 형식이 아닌 파일이라 6개 영역으로 나누지 못했습니다. 파일 내용을 그대로 AI 전송 텍스트로 사용합니다. 개인정보 영역 필터링이 적용되지 않으니 전송 전에 꼭 확인하세요.");
  return r;
}

// ---------- JSON ----------
export function recordToJSON(r) {
  const { creative, grades, seteuk, behavior } = r;
  return JSON.stringify({ format: FORMAT_ID, version: 1, exportedAt: new Date().toISOString().slice(0, 10), creative, grades, seteuk, behavior, meta: { pages: r.meta?.pages ?? 0 } }, null, 2);
}

export function jsonToRecord(text, source = "json") {
  let obj;
  try { obj = JSON.parse(text); } catch (e) { throw new Error("JSON 형식이 올바르지 않습니다: " + e.message); }
  const looksLikeRecord = obj && typeof obj === "object" && !Array.isArray(obj) && ["creative", "grades", "seteuk", "behavior"].some((k) => Array.isArray(obj[k]));
  if (looksLikeRecord) {
    const r = normalizeRecord(obj, source);
    if (recordCount(r)) return r;
  }
  return textRecord(JSON.stringify(obj, null, 2), source);
}

// ---------- Markdown ----------
const GRADE_COLS = ["학년", "학기", "구분", "교과", "과목", "학점", "원점수", "평균", "표준편차", "성취도", "수강자수", "등급", "성취도분포"];
const GRADE_KEYS = ["grade", "semester", "kind", "group", "subject", "credits", "score", "avg", "sd", "achievement", "students", "rank", "distribution"];
const H = { creative: "창의적 체험활동상황", grades: "교과 성적", seteuk: "세부능력 및 특기사항", behavior: "행동특성 및 종합의견" };
const cell = (v) => (v == null || v === "" ? "-" : String(v).replace(/\|/g, "\\|").replace(/\n/g, " "));
const oneLine = (t) => str(t).replace(/\r?\n+/g, " ");

export function recordToMarkdown(r) {
  const out = ["# 학교생활기록부 추출 데이터", "", "> 생기부 면접 Lab 형식입니다. `##` 영역 제목과 `###` 항목 제목을 유지하면 수정한 뒤 다시 불러올 수 있습니다.", ""];
  out.push(`## ${H.creative}`, "");
  for (const c of r.creative) {
    out.push(`### ${c.grade}학년 ${c.area}${c.hours != null ? ` (${c.hours}시간)` : ""}`);
    if (c.hope) out.push(`- 희망분야: ${oneLine(c.hope)}`);
    out.push("", oneLine(c.text) || "(기록 없음)", "");
  }
  out.push(`## ${H.grades}`, "");
  out.push(`| ${GRADE_COLS.join(" | ")} |`, `|${GRADE_COLS.map(() => "---").join("|")}|`);
  for (const g of r.grades) out.push(`| ${GRADE_KEYS.map((k) => cell(g[k])).join(" | ")} |`);
  out.push("", `## ${H.seteuk}`, "");
  for (const s of r.seteuk) out.push(`### ${s.grade}학년 ${s.subject}${s.kind && s.kind !== "일반" ? ` [${s.kind}]` : ""}`, "", oneLine(s.text), "");
  out.push(`## ${H.behavior}`, "");
  for (const b of r.behavior) out.push(`### ${b.grade}학년`, "", oneLine(b.text), "");
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function splitRow(line) {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let cur = "";
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "\\" && t[i + 1] === "|") { cur += "|"; i++; }
    else if (t[i] === "|") { cells.push(cur.trim()); cur = ""; }
    else cur += t[i];
  }
  cells.push(cur.trim());
  return cells;
}

function sectionOf(title) {
  const t = title.replace(/\s/g, "");
  if (/창의적체험활동|창체/.test(t)) return "creative";
  if (/교과성적|교과학습|성적/.test(t) && !/세부/.test(t)) return "grades";
  if (/세부능력|세특/.test(t)) return "seteuk";
  if (/행동특성|행특|종합의견/.test(t)) return "behavior";
  return null;
}

export function markdownToRecord(md, source = "md") {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const obj = { creative: [], grades: [], seteuk: [], behavior: [] };
  let sec = null, item = null, found = false;
  const finish = () => {
    if (!item) return;
    item.text = item.buf.join(" ").replace(/\s+/g, " ").replace(/^\(기록 없음\)$/, "").trim();
    delete item.buf;
    obj[item.sec].push(item);
    delete item.sec;
    item = null;
  };
  let header = null;
  for (const raw of lines) {
    const line = raw.trim();
    let m;
    if ((m = line.match(/^##\s+(.+)$/)) && !line.startsWith("###")) {
      finish(); header = null;
      sec = sectionOf(m[1]);
      if (sec) found = true;
      continue;
    }
    if (!sec) continue;
    if ((m = line.match(/^###\s+(.+)$/))) {
      finish();
      const t = m[1].trim();
      const g = num((t.match(/(\d)\s*학년/) || [])[1]) ?? 0;
      if (sec === "creative") {
        const area = AREAS.find((a) => t.replace(/\s/g, "").includes(a)) || "자율활동";
        const hours = num((t.match(/(\d+)\s*시간/) || [])[1]);
        item = { sec, grade: g, area, hours, hope: null, buf: [] };
      } else if (sec === "seteuk") {
        const kind = (t.match(/\[(.+?)\]\s*$/) || [])[1] || "일반";
        const subject = t.replace(/^\d\s*학년\s*/, "").replace(/\s*\[.+?\]\s*$/, "").trim() || "개인별 세특";
        item = { sec, grade: g, kind, subject, buf: [] };
      } else if (sec === "behavior") {
        item = { sec, grade: g, buf: [] };
      }
      continue;
    }
    if (sec === "grades") {
      if (!line.startsWith("|")) continue;
      const cells = splitRow(line);
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
      if (!header) { header = cells; continue; }
      const row = {};
      header.forEach((h, i) => {
        const k = GRADE_KEYS[GRADE_COLS.indexOf(h.replace(/\s/g, ""))];
        if (k) row[k] = cells[i] === "-" ? "" : cells[i];
      });
      obj.grades.push(row);
      continue;
    }
    if (!item || !line || line.startsWith(">")) continue;
    if (sec === "creative" && (m = line.match(/^[-*]\s*희망\s*분야\s*[:：]\s*(.*)$/))) { item.hope = m[1].trim() || null; continue; }
    item.buf.push(line);
  }
  finish();
  if (found) {
    const r = normalizeRecord(obj, source);
    if (recordCount(r)) return r;
  }
  return textRecord(md, source);
}

// ---------- 엑셀 (SheetJS 라이브러리를 인자로 받는다) ----------
const SHEETS = {
  creative: { name: "창체", cols: ["학년", "영역", "시간", "희망분야", "내용"], keys: ["grade", "area", "hours", "hope", "text"] },
  grades: { name: "교과성적", cols: GRADE_COLS, keys: GRADE_KEYS },
  seteuk: { name: "세특", cols: ["학년", "구분", "과목", "내용"], keys: ["grade", "kind", "subject", "text"] },
  behavior: { name: "행특", cols: ["학년", "내용"], keys: ["grade", "text"] },
};

export function recordToWorkbook(XLSX, r) {
  const wb = XLSX.utils.book_new();
  for (const [k, def] of Object.entries(SHEETS)) {
    const rows = [def.cols, ...r[k].map((x) => def.keys.map((kk) => x[kk] ?? ""))];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = def.cols.map((c) => ({ wch: c === "내용" ? 90 : c === "성취도분포" ? 24 : c === "과목" || c === "교과" ? 18 : 9 }));
    XLSX.utils.book_append_sheet(wb, ws, def.name);
  }
  return wb;
}

function sheetKind(name, headerRow) {
  const n = name.replace(/\s/g, "");
  const hdr = headerRow.map((c) => str(c).replace(/\s/g, ""));
  for (const [k, def] of Object.entries(SHEETS)) if (n === def.name) return k;
  if (hdr.includes("영역") && hdr.includes("내용")) return "creative";
  if (hdr.includes("과목") && (hdr.includes("학점") || hdr.includes("등급") || hdr.includes("원점수"))) return "grades";
  if (hdr.includes("과목") && hdr.includes("내용")) return "seteuk";
  if (hdr.length <= 3 && hdr.includes("학년") && hdr.includes("내용")) return "behavior";
  return sectionOf(name);
}

export function workbookToRecord(XLSX, wb, source = "xlsx") {
  const obj = { creative: [], grades: [], seteuk: [], behavior: [] };
  const free = [];
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: "" }).filter((row) => row.some((c) => str(c)));
    if (!rows.length) continue;
    const kind = sheetKind(name, rows[0]);
    const def = kind && SHEETS[kind];
    const hdr = rows[0].map((c) => str(c).replace(/\s/g, ""));
    const idx = def ? def.cols.map((c) => hdr.indexOf(c.replace(/\s/g, ""))) : [];
    if (def && idx.filter((i) => i >= 0).length >= Math.min(2, def.cols.length)) {
      for (const row of rows.slice(1)) {
        const o = {};
        def.keys.forEach((k, j) => { if (idx[j] >= 0) o[k] = row[idx[j]]; });
        obj[kind].push(o);
      }
    } else {
      free.push(`## ${name}\n` + rows.map((row) => row.map(str).join(" | ")).join("\n"));
    }
  }
  const r = normalizeRecord(obj, source);
  if (recordCount(r)) {
    if (free.length) r.extraText = scrub(free.join("\n\n"));
    return r;
  }
  return textRecord(free.join("\n\n"), source);
}
