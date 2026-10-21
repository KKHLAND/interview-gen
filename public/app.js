import * as pdfjsLib from "/vendor/pdf.min.mjs";
import { parseSaenggibu, recordToText } from "/parser.js";
import { toPrintHtml, toText, toDocx, toHwpx } from "/exporters.js";
import { recordCount, recordToJSON, jsonToRecord, recordToMarkdown, markdownToRecord, recordToWorkbook, workbookToRecord } from "/formats.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs";

// 엑셀 처리(SheetJS)는 엑셀 파일을 다룰 때만 불러온다
const XLSX_URLS = ["https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs", "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/xlsx.mjs"];
let xlsxLib = null;
async function loadXLSX() {
  if (xlsxLib) return xlsxLib;
  for (const u of XLSX_URLS) {
    try { xlsxLib = await import(u); return xlsxLib; } catch (e) { console.warn("SheetJS load failed", u, e); }
  }
  throw new Error("엑셀 처리 모듈을 불러오지 못했습니다. 인터넷 연결을 확인하세요.");
}

const FILE_KINDS = {
  pdf: { re: /\.pdf$/i, label: "PDF" },
  xlsx: { re: /\.(xlsx|xlsm|xls)$/i, label: "엑셀" },
  csv: { re: /\.csv$/i, label: "CSV" },
  md: { re: /\.(md|markdown|txt)$/i, label: "MD" },
  json: { re: /\.json$/i, label: "JSON" },
};
function fileKind(file) {
  for (const [k, v] of Object.entries(FILE_KINDS)) if (v.re.test(file.name)) return k;
  if (file.type === "application/pdf") return "pdf";
  if (file.type === "application/json") return "json";
  if (/spreadsheet|excel/.test(file.type)) return "xlsx";
  if (file.type === "text/markdown") return "md";
  return null;
}
// UTF-8이 아니면(엑셀에서 저장한 CSV 등) EUC-KR로 다시 읽는다
function decodeText(buf) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf).replace(/^﻿/, ""); }
  catch { return new TextDecoder("euc-kr").decode(buf); }
}

// ---------------- 상수 ----------------
const COMPETENCIES = ["학업역량", "탐구역량", "진로·전공역량", "자기주도성", "창의·비판적 사고", "협력·공동체", "의사소통", "성찰·성장"];
const CAT_COLOR = { 학업역량: "var(--c1)", 탐구역량: "var(--c2)", "진로·전공역량": "var(--c3)", 자기주도성: "var(--c4)", "창의·비판적 사고": "var(--c5)", "협력·공동체": "var(--c6)", 의사소통: "var(--c7)", "성찰·성장": "var(--c8)", "기본·공통": "var(--c9)" };
const AREA_LABEL = { 자율활동: "자율활동", 동아리활동: "동아리활동", 진로활동: "진로활동", 교과성적: "교과 성적", 세부능력및특기사항: "세특", 행동특성및종합의견: "행특", 종합: "종합" };
const EDIT_PRESETS = ["더 어렵게", "전공 개념 심화", "압박 질문으로", "더 짧고 명확하게", "인성·가치관 관점으로"];

// ---------------- 상태 (메모리에만 존재) ----------------
const S = {
  record: null,
  recordText: "",
  opts: { count: 30, depth: 2, focus: new Set(), basic: true },
  review: null, reviewState: "idle", reviewError: "",
  questions: [], qState: "idle", qProgress: 0, qError: "",
  filter: { cat: "all", area: "all", kept: false, q: "" },
  openAll: false,
  uni: null, uniState: "idle", uniError: "",
  practice: null,
  tab: "data",
  edit: { fmt: "md", draft: null }, // 파일로 저장·편집 카드 (draft: 사용자가 고친 내용, null이면 레코드에서 새로 생성)
};

// ---------------- 유틸 ----------------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

const ICONS = {
  shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z"/><path d="M9 12l2 2 4-4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  sparkle: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
  quote: '<path d="M7 7h4v4H7zM7 11c0 3-1 5-3 6M15 7h4v4h-4zM15 11c0 3-1 5-3 6"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
  msg: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z"/>',
  corner: '<path d="M9 10l-5 5 5 5"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>',
  wand: '<path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8l1.4 1.4M17.8 6.2l1.4-1.4M12.2 6.2l-1.4-1.4"/><path d="M3 21l9-9"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  play: '<path d="M6 4l14 8-14 8z"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v4"/>',
  print: '<path d="M6 9V2h12v7"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v8H6z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 20h16"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  book: '<path d="M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4z"/><path d="M20 4h-6a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h7z"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 20a6.5 6.5 0 0 0-3-5.5"/>',
  next: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3L21 2M16 7l3 3M18.5 4.5l2 2"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  zap: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/>',
};
const icon = (n) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ""}</svg>`;
const hydrateIcons = (root = document) => $$("[data-icon]", root).forEach((el) => { el.innerHTML = icon(el.dataset.icon); el.removeAttribute("data-icon"); });

let toastTimer;
function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show" + (err ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = "toast"), err ? 4200 : 2200);
}

function target() {
  return { university: $("#univ").value.trim(), major: $("#major").value.trim(), track: $("#track").value, mode: $("#mode").value };
}

async function api(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data.needKey) openKeyDialog();
    else if (res.status === 401 || /API 키/.test(data.error || "")) setKeyState("bad");
    throw new Error(data.error || `요청 실패 (${res.status})`);
  }
  return data;
}

// ---------------- Gemini API 키 ----------------
// 키는 이 브라우저(localStorage 또는 sessionStorage)에만 두고, 요청마다 로컬 서버로 헤더 전달한다.
const KEY_STORE = "gemini_api_key";
let serverHasKey = false;
let keyState = "none"; // none | unknown | ok | bad
function getKey() {
  try { return sessionStorage.getItem(KEY_STORE) || localStorage.getItem(KEY_STORE) || ""; } catch { return ""; }
}
function storeKey(k, keep) {
  try {
    localStorage.removeItem(KEY_STORE); sessionStorage.removeItem(KEY_STORE);
    if (k) (keep === "session" ? sessionStorage : localStorage).setItem(KEY_STORE, k);
  } catch {}
}
function authHeaders() { const k = getKey(); return k ? { "x-gemini-key": k } : {}; }
function hasAnyKey() { return !!getKey() || serverHasKey; }
const maskKey = (k) => (k.length > 12 ? `${k.slice(0, 5)}…${k.slice(-4)}` : "••••");

function setKeyState(s) {
  keyState = s;
  const dot = $("#keyDot"), label = $("#keyLabel");
  dot.className = "kdot" + (s === "ok" ? " ok" : s === "unknown" ? " wait" : "");
  label.textContent = s === "ok" ? "Gemini 연결됨" : s === "bad" ? "API 키 확인 필요" : s === "unknown" ? "API 키" : "API 키 설정";
  $("#keyBtn").title = s === "ok" ? "Gemini API 연결 정상 · 클릭해서 키 변경" : "Gemini API 키 설정";
  const hint = $("#runHint");
  if (hint) hint.innerHTML = hasAnyKey() ? "생기부 리뷰와 맞춤 면접 질문을 동시에 만듭니다." : `먼저 <a href="#" id="hintKey">Gemini API 키를 설정</a>하세요.`;
  $("#hintKey")?.addEventListener("click", (e) => { e.preventDefault(); openKeyDialog(); });
}

function keyFormat(k) {
  if (!k) return ["", ""];
  if (/\s/.test(k)) return ["warn", "키 중간에 공백이나 줄바꿈이 있습니다. 다시 복사해 보세요."];
  if (k.startsWith("AQ.")) return ["ok", "✓ 새 형식(AQ.) Gemini API 키입니다."];
  if (k.startsWith("AIza")) return ["ok", "✓ 이전 형식(AIza) API 키입니다. 그대로 사용할 수 있습니다."];
  return ["warn", "Gemini 키는 보통 <code>AQ.</code> 또는 <code>AIza</code>로 시작합니다. 맞는 키인지 확인하세요."];
}

function showTest(kind, title, sub) {
  const box = $("#testBox");
  box.hidden = false;
  box.className = "test-box " + kind;
  box.innerHTML = `${kind === "run" ? '<span class="spin"></span>' : icon(kind === "ok" ? "check" : "alert")}<div><b>${title}</b>${sub ? `<p>${sub}</p>` : ""}</div>`;
}

async function testKey(k) {
  showTest("run", "연결 테스트 중…", "Gemini에 짧은 요청을 보내 키와 모델을 확인합니다.");
  try {
    const res = await fetch("/api/test-key", { method: "POST", headers: { "Content-Type": "application/json", ...(k ? {} : authHeaders()) }, body: JSON.stringify({ key: k }) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || `연결 실패 (${res.status})`);
    showTest("ok", "연결 성공! 바로 사용할 수 있습니다.", `모델 <b style="display:inline">${esc(d.modelVersion)}</b> · 응답 ${(d.ms / 1000).toFixed(1)}초${d.source === "server" ? " · 서버(.env) 키 사용" : ""}`);
    return true;
  } catch (e) {
    const tip = /한도/.test(e.message) ? "무료 등급 한도일 수 있습니다. 1분 뒤 다시 시도하거나 결제를 연결하세요."
      : /접근을 차단/.test(e.message) ? "키를 다시 붙여넣어도 해결되지 않습니다. 같은 프로젝트에서 새로 만든 키도 막힙니다. 다른 Google 계정의 새 프로젝트 키를 쓰거나 결제를 연결하세요."
      : /키가 올바르지/.test(e.message) ? "AI Studio에서 키를 다시 복사해 붙여넣어 보세요. 삭제된 키는 사용할 수 없습니다."
      : /Failed to fetch|NetworkError/i.test(e.message) ? "로컬 서버(npm start)가 실행 중인지 확인하세요." : "";
    showTest("bad", esc(e.message), tip);
    return false;
  }
}

function openKeyDialog() {
  const dlg = $("#keyDlg");
  const k = getKey();
  const input = $("#keyInput");
  input.value = k;
  input.type = "password";
  let keep = "local";
  try { if (sessionStorage.getItem(KEY_STORE)) keep = "session"; } catch {}
  $$('input[name="keep"]', dlg).forEach((r) => (r.checked = r.value === keep));
  $("#testBox").hidden = true;
  if (keyState === "ok") showTest("ok", "현재 연결되어 있습니다.", k ? `저장된 키 ${esc(maskKey(k))}` : "서버(.env) 키 사용 중");
  else if (!k && serverHasKey) showTest("ok", "서버(.env)에 키가 설정되어 있습니다.", "따로 입력하지 않아도 됩니다. 다른 키를 쓰려면 아래에 입력하세요.");
  updateFmt();
  if (!dlg.open) dlg.showModal();
  setTimeout(() => input.focus(), 50);
}
function updateFmt() {
  const [cls, msg] = keyFormat($("#keyInput").value.trim());
  const el = $("#keyFmt");
  el.className = "key-fmt " + cls;
  el.innerHTML = msg;
}

function initKeyDialog() {
  const input = $("#keyInput");
  $("#keyBtn").onclick = openKeyDialog;
  input.oninput = updateFmt;
  input.addEventListener("paste", () => setTimeout(() => { input.value = input.value.trim(); updateFmt(); }, 0));
  input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); $("#keySave").click(); } };
  $("#keyEye").onclick = () => { input.type = input.type === "password" ? "text" : "password"; $("#keyEye").innerHTML = icon(input.type === "password" ? "eye" : "lock"); };
  $("#keyTest").onclick = async () => {
    const k = input.value.trim();
    if (!k && !serverHasKey) { showTest("bad", "키를 먼저 붙여넣으세요.", "1~3단계를 따라 AI Studio에서 키를 만들 수 있습니다."); return input.focus(); }
    $("#keyTest").disabled = true;
    await testKey(k);
    $("#keyTest").disabled = false;
  };
  $("#keySave").onclick = async () => {
    const k = input.value.trim();
    if (!k) {
      if (serverHasKey) { storeKey(""); $("#keyDlg").close(); setKeyState("unknown"); return toast("서버(.env) 키를 사용합니다."); }
      showTest("bad", "키를 먼저 붙여넣으세요.", "");
      return input.focus();
    }
    const btn = $("#keySave");
    btn.disabled = true; btn.textContent = "확인 중…";
    const ok = await testKey(k);
    btn.disabled = false; btn.textContent = "테스트 후 저장";
    if (!ok) return;
    storeKey(k, $('input[name="keep"]:checked').value);
    setKeyState("ok");
    setTimeout(() => $("#keyDlg").close(), 700);
    toast("API 키를 저장했습니다. 이제 AI 분석을 시작할 수 있어요.");
  };
  $("#keyClear").onclick = () => {
    if (!getKey() && !input.value) return;
    if (!confirm("이 브라우저에 저장된 API 키를 삭제할까요?")) return;
    storeKey("");
    input.value = "";
    updateFmt();
    $("#testBox").hidden = true;
    setKeyState(serverHasKey ? "unknown" : "none");
    toast("API 키를 삭제했습니다.");
  };
}

async function silentKeyCheck() {
  if (!hasAnyKey()) return setKeyState("none");
  setKeyState("unknown");
  try {
    const res = await fetch("/api/test-key", { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: "{}" });
    setKeyState(res.ok ? "ok" : "bad");
  } catch { setKeyState("unknown"); }
}

// ---------------- 테마 ----------------
function initTheme() {
  const btn = $("#themeBtn");
  const apply = (t) => {
    if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
    const dark = t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    btn.innerHTML = icon(dark ? "sun" : "moon");
  };
  let saved = null;
  try { saved = localStorage.getItem("theme"); } catch {}
  apply(saved);
  btn.onclick = () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    try { localStorage.setItem("theme", next); } catch {}
    apply(next);
  };
}

// ---------------- 업로드 & 파싱 ----------------
function initUpload() {
  const dz = $("#dropzone"), input = $("#fileInput");
  dz.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
  input.onchange = () => input.files[0] && handleFile(input.files[0]);
  ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("over"); }));
  dz.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) handleFile(f); });
}

async function handleFile(file) {
  const st = $("#dzStatus");
  st.hidden = false; st.className = "dz-status";
  const kind = fileKind(file);
  if (!kind) { st.textContent = "PDF, 엑셀(xlsx·xls·csv), MD, JSON 파일만 올릴 수 있습니다."; st.classList.add("err"); return; }
  if (file.size > 30 * 1024 * 1024) { st.textContent = "30MB 이하 파일만 올릴 수 있습니다."; st.classList.add("err"); return; }
  st.textContent = kind === "pdf" ? "브라우저에서 6개 영역만 추출하는 중…" : `${FILE_KINDS[kind].label} 파일을 읽는 중…`;
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    let record;
    if (kind === "pdf") {
      record = await parseSaenggibu(pdfjsLib, buf);
      record.meta.source = "pdf";
      if (!recordCount(record)) throw new Error("생기부 형식을 인식하지 못했습니다. NEIS에서 출력한 학교생활기록부 PDF인지 확인하세요.");
    } else if (kind === "json") {
      record = jsonToRecord(decodeText(buf), "json");
    } else if (kind === "md") {
      record = markdownToRecord(decodeText(buf), "md");
    } else {
      const XLSX = await loadXLSX();
      const wb = kind === "csv" ? XLSX.read(decodeText(buf), { type: "string" }) : XLSX.read(buf, { type: "array" });
      record = workbookToRecord(XLSX, wb, kind);
    }
    if (!recordCount(record) && !record.rawText?.trim()) throw new Error("파일에서 읽을 내용이 없습니다.");
    loadRecord(record);
    $("#landing").hidden = true;
    $("#workspace").hidden = false;
    $("#fileInput").value = "";
    guessMajor(record);
    setTab("data");
    renderAll();
    window.scrollTo({ top: 0 });
  } catch (e) {
    console.error(e);
    st.textContent = e.message || "파일을 읽지 못했습니다.";
    st.classList.add("err");
  }
}

const SOURCE_LABEL = { pdf: "PDF", json: "JSON", md: "MD", xlsx: "엑셀", csv: "CSV", text: "텍스트" };
// 새 레코드를 상태에 반영 (업로드·편집 적용 공용)
function loadRecord(record, { keepResults = false } = {}) {
  S.record = record;
  S.recordText = recordToText(record);
  S.edit = { fmt: S.edit?.fmt || "md", draft: null };
  if (!keepResults) Object.assign(S, { review: null, reviewState: "idle", questions: [], qState: "idle", uni: null, uniState: "idle", practice: null });
  // 파일명에는 학생 이름이 들어가는 경우가 많아 표시하지 않는다
  const src = SOURCE_LABEL[record.meta.source] || "파일";
  $("#fileMeta").textContent = recordCount(record)
    ? `${src}${record.meta.pages ? ` ${record.meta.pages}쪽` : ""} · 6개 영역 ${record.meta.source === "pdf" ? "추출" : "불러오기"} 완료`
    : `${src} · 자유 텍스트로 불러옴`;
}

function guessMajor(record) {
  const hope = [...record.creative].reverse().find((c) => c.hope)?.hope;
  if (hope && !$("#major").value) $("#major").placeholder = `예: ${hope} 관련 학과`;
}

// ---------------- 사이드바 ----------------
function initSide() {
  const pick = $("#focusPick");
  pick.innerHTML = COMPETENCIES.map((c) => `<button type="button" data-v="${esc(c)}">${esc(c)}</button>`).join("");
  pick.onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    const v = b.dataset.v;
    S.opts.focus.has(v) ? S.opts.focus.delete(v) : S.opts.focus.add(v);
    b.classList.toggle("on");
  };
  $$(".seg").forEach((seg) => (seg.onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    $$("button", seg).forEach((x) => x.classList.toggle("on", x === b));
    if (seg.dataset.name === "count") S.opts.count = Number(b.dataset.v);
    if (seg.dataset.name === "depth") S.opts.depth = Number(b.dataset.v);
  }));
  $("#basicChk").onchange = (e) => (S.opts.basic = e.target.checked);
  $("#runBtn").onclick = runAll;
  $("#resetBtn").onclick = () => {
    if (S.questions.length && !confirm("현재 결과가 모두 사라집니다. 다른 파일을 올릴까요?")) return;
    S.record = null; S.recordText = "";
    $("#workspace").hidden = true; $("#landing").hidden = false; $("#dzStatus").hidden = true;
  };
}

function busy() { return S.reviewState === "loading" || S.qState === "loading"; }
function syncRunBtn() {
  const b = $("#runBtn");
  b.disabled = busy();
  b.innerHTML = busy() ? `${icon("sparkle")}AI가 분석하는 중…` : `${icon("sparkle")}${S.questions.length ? "다시 분석 · 생성" : "AI 분석 · 질문 생성"}`;
}

async function runAll() {
  if (!S.recordText.trim()) return toast("전송할 생기부 데이터가 없습니다.", true);
  if (!hasAnyKey()) { toast("먼저 Gemini API 키를 설정하세요."); return openKeyDialog(); }
  if (S.questions.length && !confirm("기존 질문을 새로 생성한 질문으로 바꿉니다. 계속할까요?")) return;
  runReview();
  runQuestions();
  setTab("questions");
}

async function runReview() {
  S.reviewState = "loading"; S.reviewError = ""; renderReview(); syncRunBtn(); renderTabs();
  try {
    S.review = await api("/api/review", { record: S.recordText, target: target() });
    S.reviewState = "done";
  } catch (e) {
    S.reviewState = "error"; S.reviewError = e.message;
  }
  renderReview(); syncRunBtn(); renderTabs();
}

async function runQuestions() {
  S.qState = "loading"; S.qProgress = 0; S.qError = ""; renderQuestions(); syncRunBtn(); renderTabs();
  try {
    const res = await fetch("/api/questions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ record: S.recordText, target: target(), count: S.opts.count, focus: [...S.opts.focus], followDepth: S.opts.depth, includeBasic: S.opts.basic }),
    });
    if (!res.ok) { const d = await res.json().catch(() => ({})); if (d.needKey) openKeyDialog(); throw new Error(d.error || `요청 실패 (${res.status})`); }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", done = false;
    while (!done) {
      const r = await reader.read();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.type === "progress") { S.qProgress = ev.count; updateProgress(); }
        else if (ev.type === "done") { S.questions = ev.questions.map((q) => ({ ...q, id: uid(), kept: false })); done = true; }
        else if (ev.type === "error") throw new Error(ev.message);
      }
    }
    if (!S.questions.length) throw new Error("생성된 질문이 없습니다. 다시 시도해 주세요.");
    S.qState = "done";
    S.filter = { cat: "all", area: "all", kept: false, q: "" };
    toast(`면접 질문 ${S.questions.length}개를 만들었습니다.`);
  } catch (e) {
    S.qState = "error"; S.qError = e.message;
  }
  renderQuestions(); syncRunBtn(); renderTabs(); renderPractice();
}

// ---------------- 탭 ----------------
function setTab(t) {
  S.tab = t;
  $$(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
  $$(".panel").forEach((p) => (p.hidden = p.id !== `panel-${t}`));
  const tabs = $(".tabs");
  if (tabs && tabs.getBoundingClientRect().top < 0) window.scrollTo({ top: window.scrollY + tabs.getBoundingClientRect().top - 80 });
}
function renderTabs() {
  $("#qCount").textContent = S.questions.length;
  const dot = (tab, on) => {
    const b = $(`.tabs [data-tab="${tab}"]`);
    let d = $(".dot", b);
    if (on && !d) { d = document.createElement("span"); d.className = "dot"; b.appendChild(d); }
    if (!on && d) d.remove();
  };
  dot("review", S.reviewState === "loading");
  dot("questions", S.qState === "loading");
  dot("univ", S.uniState === "loading");
}
function renderAll() { renderData(); renderReview(); renderQuestions(); renderPractice(); renderUniv(); renderTabs(); syncRunBtn(); }

// ---------------- 패널: 추출 데이터 ----------------
function rankColor(r) {
  if (r == null) return "";
  const h = r <= 2 ? "var(--ok)" : r <= 4 ? "var(--c4)" : r <= 6 ? "var(--warn)" : "var(--bad)";
  return `style="color:${h};background:color-mix(in srgb, ${h} 12%, transparent)"`;
}

function renderData() {
  const r = S.record; if (!r) return;
  const p = $("#panel-data");
  const avgRank = weightedRank(r.grades);
  const stats = [
    ["자율활동", r.creative.filter((c) => c.area === "자율활동" && c.text).length, "개 학년"],
    ["동아리활동", r.creative.filter((c) => c.area === "동아리활동" && c.text).length, "개 학년"],
    ["진로활동", r.creative.filter((c) => c.area === "진로활동" && c.text).length, "개 학년"],
    ["교과 성적", r.grades.length, `과목 · ${avgRank ? avgRank.toFixed(2) + "등급" : "-"}`],
    ["세특", r.seteuk.length, "개 과목"],
    ["행특", r.behavior.length, "개 학년"],
  ];
  const creativeHtml = r.creative.filter((c) => c.text || c.hope).map((c) => `
    <div class="entry"><div class="entry-h"><span class="badge accent">${c.grade}학년</span>${esc(c.area)}${c.hours != null ? `<span class="badge">${c.hours}시간</span>` : ""}${c.hope ? `<span class="badge ok">희망분야 · ${esc(c.hope)}</span>` : ""}</div>
    <p class="${c.text ? "" : "muted"}">${esc(c.text || "기록 없음")}</p></div>`).join("") || `<p class="hint">기록이 없습니다.</p>`;
  const gradeRows = r.grades.map((g) => `<tr>
    <td>${g.grade}-${g.semester ?? "?"}</td><td>${esc(g.kind)}</td><td>${esc(g.group)}</td><td><b>${esc(g.subject)}</b></td>
    <td class="num">${g.credits}</td><td class="num">${g.score != null ? `${g.score} / ${g.avg}${g.sd != null ? ` (${g.sd})` : ""}` : "-"}</td>
    <td>${g.achievement ?? "-"}${g.students ? ` <small>(${g.students})</small>` : ""}</td>
    <td>${g.rank ? `<span class="rank" ${rankColor(g.rank)}>${g.rank}</span>` : g.distribution ? `<small>${esc(g.distribution)}</small>` : "-"}</td></tr>`).join("");
  const seteukHtml = r.seteuk.map((s) => `<div class="entry"><div class="entry-h"><span class="badge accent">${s.grade}학년</span>${esc(s.subject)}${s.kind !== "일반" ? `<span class="badge">${esc(s.kind)}</span>` : ""}</div><p>${esc(s.text)}</p></div>`).join("");
  const behHtml = r.behavior.map((b) => `<div class="entry"><div class="entry-h"><span class="badge accent">${b.grade}학년</span>행동특성 및 종합의견</div><p>${esc(b.text)}</p></div>`).join("");
  const acc = (title, n, body, open = false) => `<details class="acc" ${open ? "open" : ""}><summary>${title}<span class="badge">${n}</span><span class="chev">${icon("chev")}</span></summary><div class="acc-body">${body}</div></details>`;

  const structured = recordCount(r) > 0;
  const fromPdf = r.meta.source === "pdf";
  p.innerHTML = `
    ${r.meta.warnings.length ? `<div class="warnbox">${r.meta.warnings.map(esc).join("<br>")}${structured ? " 일부 영역은 아래 전송 텍스트에서 직접 보완할 수 있습니다." : ""}</div>` : ""}
    ${structured ? `
    <div class="stat-row">${stats.map(([k, v, u]) => `<div class="stat"><small>${k}</small><b>${v}<em>${u}</em></b></div>`).join("")}</div>
    <div class="card sec">
      <div class="sec-head"><h3>${fromPdf ? "추출된" : "불러온"} 6개 영역</h3><span class="sub">${fromPdf ? "성명·학교·반·번호 등 개인정보는 읽지 않았습니다" : `${esc(SOURCE_LABEL[r.meta.source] || "")} 파일에서 불러왔습니다`}${r.meta.masked ? ` · 개인정보 의심 패턴 ${r.meta.masked}건 마스킹` : ""}</span></div>
      ${acc("창의적 체험활동 — 자율 · 동아리 · 진로", r.creative.filter((c) => c.text).length, creativeHtml, true)}
      ${acc("교과 성적", r.grades.length, `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>학년-학기</th><th>구분</th><th>교과</th><th>과목</th><th>학점</th><th>원점수/평균(표준편차)</th><th>성취도(수강자)</th><th>등급/분포</th></tr></thead><tbody>${gradeRows}</tbody></table></div>`)}
      ${acc("세부능력 및 특기사항", r.seteuk.length, seteukHtml)}
      ${acc("행동특성 및 종합의견", r.behavior.length, behHtml)}
    </div>
    ${editCardHtml()}` : ""}
    <div class="card sec send-box">
      <div class="sec-head"><h3>AI로 전송될 텍스트</h3><span class="sub" id="sendLen">${S.recordText.length.toLocaleString()}자</span>
        <div class="right"><button class="btn-ghost sm" id="restoreText" type="button">${icon("refresh")}원래대로</button></div></div>
      <p class="hint" style="text-align:left;margin:-6px 0 10px">전송 전에 확인하고, 빼고 싶은 내용은 직접 지우거나 고칠 수 있습니다. 이 텍스트만 Gemini로 전송됩니다.</p>
      <textarea class="input mono" id="sendText" spellcheck="false">${esc(S.recordText)}</textarea>
    </div>`;
  $("#sendText").oninput = (e) => { S.recordText = e.target.value; $("#sendLen").textContent = `${S.recordText.length.toLocaleString()}자`; };
  $("#restoreText").onclick = () => { S.recordText = recordToText(S.record); $("#sendText").value = S.recordText; $("#sendLen").textContent = `${S.recordText.length.toLocaleString()}자`; toast("추출 원본으로 되돌렸습니다."); };
  if (structured) bindEditCard();
}

// ---------------- 파일로 저장 · 편집 (MD / JSON / 엑셀) ----------------
const EDIT_FMT = {
  md: { label: "Markdown", ext: "md", mime: "text/markdown", make: recordToMarkdown, parse: (t) => markdownToRecord(t, "md") },
  json: { label: "JSON", ext: "json", mime: "application/json", make: recordToJSON, parse: (t) => jsonToRecord(t, "json") },
};
function editDraft() {
  return S.edit.draft ?? EDIT_FMT[S.edit.fmt].make(S.record);
}
function editCardHtml() {
  const f = S.edit.fmt;
  return `<div class="card sec edit-card">
    <div class="sec-head"><h3>파일로 저장 · 편집</h3><span class="sub">${S.record.meta.source === "pdf" ? "PDF에서 추출한 6개 영역" : "불러온 데이터"}를 MD·JSON으로 고치고 저장합니다. 저장한 파일은 다음에 그대로 다시 올릴 수 있습니다.</span></div>
    <div class="edit-bar">
      <div class="seg fmt-seg" id="editFmt">${Object.entries(EDIT_FMT).map(([k, v]) => `<button type="button" data-v="${k}" class="${k === f ? "on" : ""}">${v.label}</button>`).join("")}</div>
      <span class="edit-state" id="editState">${S.edit.draft != null ? "수정됨 · 아직 적용 안 함" : ""}</span>
      <span class="grow"></span>
      <button class="btn-ghost sm" id="editReset" type="button">${icon("refresh")}되돌리기</button>
      <button class="btn-primary sm" id="editApply" type="button">${icon("check")}편집 내용 적용</button>
    </div>
    <textarea class="input mono" id="editText" spellcheck="false" aria-label="${EDIT_FMT[f].label} 편집">${esc(editDraft())}</textarea>
    <div class="edit-bar">
      <button class="btn-ghost sm" id="editDl" type="button">${icon("download")}.${EDIT_FMT[f].ext}로 저장</button>
      <button class="btn-ghost sm" id="editDlOther" type="button">${icon("download")}.${f === "md" ? "json" : "md"}로 저장</button>
      <button class="btn-ghost sm" id="editXlsx" type="button">${icon("download")}엑셀(.xlsx)로 저장</button>
      <button class="btn-ghost sm" id="editCopy" type="button">${icon("copy")}복사</button>
    </div>
  </div>`;
}

function saveFile(content, ext, mime) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: `${mime};charset=utf-8` });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `생기부_추출데이터_${new Date().toISOString().slice(0, 10)}.${ext}`; // 파일명에 학생 이름을 넣지 않는다
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// 편집 중인 내용을 레코드로 해석 (실패하면 오류)
function parseDraft() {
  const r = EDIT_FMT[S.edit.fmt].parse($("#editText").value);
  if (!recordCount(r)) throw new Error(`${EDIT_FMT[S.edit.fmt].label} 내용에서 6개 영역을 찾지 못했습니다. 영역 제목(##, ###)이나 키 이름을 확인하세요.`);
  r.meta.source = S.record.meta.source;
  r.meta.pages = S.record.meta.pages;
  return r;
}

function bindEditCard() {
  const ta = $("#editText");
  ta.oninput = () => { S.edit.draft = ta.value; $("#editState").textContent = "수정됨 · 아직 적용 안 함"; };
  $("#editFmt").onclick = (e) => {
    const b = e.target.closest("button"); if (!b || b.dataset.v === S.edit.fmt) return;
    if (S.edit.draft != null) {
      // 고친 내용을 버리지 않도록 현재 형식으로 해석한 뒤 새 형식으로 바꿔 보여준다
      try { const r = parseDraft(); S.edit = { fmt: b.dataset.v, draft: EDIT_FMT[b.dataset.v].make(r) }; }
      catch (err) { return toast(err.message, true); }
    } else S.edit = { fmt: b.dataset.v, draft: null };
    renderData();
  };
  $("#editReset").onclick = () => {
    if (S.edit.draft == null) return;
    if (!confirm("적용하지 않은 편집 내용을 버릴까요?")) return;
    S.edit.draft = null; renderData();
  };
  $("#editApply").onclick = () => {
    try {
      const r = parseDraft();
      const fmt = S.edit.fmt;
      const hasResults = S.questions.length || S.review;
      loadRecord(r, { keepResults: true });
      S.edit = { fmt, draft: null };
      renderData();
      toast(hasResults ? "편집 내용을 적용했습니다. 새 내용으로 분석하려면 ‘다시 분석 · 생성’을 누르세요." : "편집 내용을 적용했습니다. AI 전송 텍스트도 새로 만들었습니다.");
    } catch (err) { toast(err.message, true); }
  };
  const current = () => { try { return S.edit.draft != null ? parseDraft() : S.record; } catch (err) { toast(err.message, true); return null; } };
  $("#editDl").onclick = () => { const f = EDIT_FMT[S.edit.fmt]; if (S.edit.fmt === "json" && S.edit.draft != null && !current()) return; saveFile(ta.value, f.ext, f.mime); };
  $("#editDlOther").onclick = () => { const r = current(); if (!r) return; const f = EDIT_FMT[S.edit.fmt === "md" ? "json" : "md"]; saveFile(f.make(r), f.ext, f.mime); };
  $("#editXlsx").onclick = async () => {
    const r = current(); if (!r) return;
    try {
      const XLSX = await loadXLSX();
      const out = XLSX.write(recordToWorkbook(XLSX, r), { bookType: "xlsx", type: "array" });
      saveFile(new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "xlsx");
    } catch (err) { toast(err.message, true); }
  };
  $("#editCopy").onclick = async () => { try { await navigator.clipboard.writeText(ta.value); toast("클립보드에 복사했습니다."); } catch { toast("복사에 실패했습니다.", true); } };
}

function weightedRank(rows) {
  let s = 0, c = 0;
  for (const g of rows) if (g.rank && g.credits) { s += g.rank * g.credits; c += g.credits; }
  return c ? s / c : null;
}

// ---------------- 패널: 생기부 리뷰 ----------------
function loadingBlock(title, sub, indet = true) {
  return `<div class="card progress"><b>${title}</b><div class="bar ${indet ? "indet" : ""}"><div></div></div><p>${sub}</p></div>`;
}
function errorBlock(msg, retryId) {
  return `<div class="card empty"><div class="big">${icon("refresh")}</div><b>생성에 실패했습니다</b><p>${esc(msg)}</p><button class="btn-ghost" id="${retryId}" type="button">${icon("refresh")}다시 시도</button></div>`;
}
function emptyBlock(ic, title, sub) {
  return `<div class="card empty"><div class="big">${icon(ic)}</div><b>${title}</b><p>${sub}</p></div>`;
}

function renderReview() {
  const p = $("#panel-review");
  if (S.reviewState === "loading") return (p.innerHTML = loadingBlock("입학사정관이 생기부를 읽고 있습니다", "6개 영역 평가와 8대 역량 점수를 산출하는 중…"));
  if (S.reviewState === "error") { p.innerHTML = errorBlock(S.reviewError, "retryReview"); $("#retryReview").onclick = runReview; return; }
  if (!S.review) return (p.innerHTML = emptyBlock("chart", "아직 리뷰가 없습니다", "왼쪽에서 지원 정보를 입력하고 ‘AI 분석 · 질문 생성’을 누르세요.") + gradeTrendCard());
  const v = S.review;
  const fit = Math.max(0, Math.min(100, v.majorFit?.score ?? 0));
  const C = 2 * Math.PI * 70;
  const comps = COMPETENCIES.map((n) => v.competencies?.find((c) => c.name === n) || { name: n, score: 0, comment: "" });
  const areaOrder = ["자율활동", "동아리활동", "진로활동", "교과성적", "세부능력및특기사항", "행동특성및종합의견"];
  const areas = areaOrder.map((a) => v.areas?.find((x) => x.area === a)).filter(Boolean);
  const stars = (n) => "★".repeat(n) + `<i>${"★".repeat(5 - n)}</i>`;
  p.innerHTML = `
    <div class="card export-bar"><b>${icon("download")}생기부 리뷰 내보내기</b><span class="grow"></span>${exportBtns("review", true)}</div>
    <div class="card sec review-hero">
      <div><span class="type-tag">${esc(v.studentType)}</span><h2>${esc(target().major || "지원 학과")} 관점 총평</h2><p>${esc(v.summary)}</p>
        <div class="kw">${(v.keywords || []).map((k) => `<span>#${esc(k)}</span>`).join("")}</div></div>
      <div class="gauge" title="${esc(v.majorFit?.comment)}">
        <svg viewBox="0 0 160 160"><circle cx="80" cy="80" r="70" fill="none" stroke="var(--surface-3)" stroke-width="12"/><circle cx="80" cy="80" r="70" fill="none" stroke="url(#gg)" stroke-width="12" stroke-linecap="round" stroke-dasharray="${(C * fit) / 100} ${C}"/><defs><linearGradient id="gg"><stop offset="0" stop-color="var(--accent)"/><stop offset="1" stop-color="var(--accent-2)"/></linearGradient></defs></svg>
        <div class="num"><div><b>${fit}</b><small>전공 적합도</small></div></div>
      </div>
    </div>
    <div class="card sec"><div class="sec-head"><h3>전공 적합도 근거</h3></div><p style="margin:0;color:var(--text-2)">${esc(v.majorFit?.comment)}</p></div>
    <div class="card sec">
      <div class="sec-head"><h3>8대 평가요소</h3><span class="sub">입학사정관 관점 상대 평가</span></div>
      <div class="radar-wrap">${radarSvg(comps)}<div class="bars">${comps.map((c) => `
        <div class="bar-row" title="${esc(c.comment)}"><span>${esc(c.name)}</span><div class="track"><div class="fill" style="width:${c.score}%;background:${CAT_COLOR[c.name]}"></div></div><b>${c.score}</b><span class="cmt">${esc(c.comment)}</span></div>`).join("")}</div></div>
    </div>
    <div class="card sec"><div class="sec-head"><h3>영역별 평가</h3></div>
      <div class="area-grid">${areas.map((a) => `<div class="area-card"><h4>${esc(AREA_LABEL[a.area] || a.area)}<span class="stars">${stars(Math.max(0, Math.min(5, a.rating)))}</span></h4><p>${esc(a.summary)}</p>
        ${a.highlights?.length ? `<ul class="dots">${a.highlights.map((h) => `<li>${esc(h)}</li>`).join("")}</ul>` : ""}
        ${a.concerns?.length ? `<ul class="dots bad" style="margin-top:8px">${a.concerns.map((h) => `<li>${esc(h)}</li>`).join("")}</ul>` : ""}</div>`).join("")}</div>
    </div>
    <div class="grid-2">
      <div class="card sec"><div class="sec-head"><h3>면접에서 살릴 강점</h3></div><ul class="dots">${(v.strengths || []).map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>
      <div class="card sec"><div class="sec-head"><h3>압박 질문이 올 약점</h3></div><ul class="dots bad">${(v.risks || []).map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>
    </div>
    ${gradeTrendCard(v.gradeTrend)}
    <div class="card sec"><div class="sec-head"><h3>면접 대비 전략</h3></div><ul class="dots num">${(v.strategy || []).map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>`;
}

function radarSvg(comps) {
  const cx = 140, cy = 140, R = 100, n = comps.length;
  const pt = (i, r) => { const a = -Math.PI / 2 + (2 * Math.PI * i) / n; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; };
  const rings = [0.25, 0.5, 0.75, 1].map((k) => `<polygon points="${comps.map((_, i) => pt(i, R * k).join(",")).join(" ")}" fill="none" stroke="var(--line)"/>`).join("");
  const axes = comps.map((_, i) => `<line x1="${cx}" y1="${cy}" x2="${pt(i, R)[0]}" y2="${pt(i, R)[1]}" stroke="var(--line)"/>`).join("");
  const poly = comps.map((c, i) => pt(i, (R * c.score) / 100).join(",")).join(" ");
  const labels = comps.map((c, i) => { const [x, y] = pt(i, R + 22); return `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle" font-size="11" font-weight="600" fill="var(--text-2)">${esc(c.name.replace("창의·비판적 사고", "창의·비판"))}</text>`; }).join("");
  return `<svg class="radar" viewBox="-34 0 348 280" role="img" aria-label="8대 평가요소 레이더 차트">${rings}${axes}<polygon points="${poly}" fill="color-mix(in srgb, var(--accent) 22%, transparent)" stroke="var(--accent)" stroke-width="2"/>${comps.map((c, i) => { const [x, y] = pt(i, (R * c.score) / 100); return `<circle cx="${x}" cy="${y}" r="3.5" fill="var(--accent)"/>`; }).join("")}${labels}</svg>`;
}

function gradeTrendCard(comment) {
  const r = S.record; if (!r) return "";
  const keys = [...new Set(r.grades.filter((g) => g.rank).map((g) => `${g.grade}-${g.semester}`))];
  if (keys.length < 1) return "";
  const pts = keys.map((k) => ({ k, v: weightedRank(r.grades.filter((g) => `${g.grade}-${g.semester}` === k)) }));
  const W = 560, H = 170, pad = 34, xs = (i) => pad + (keys.length === 1 ? (W - 2 * pad) / 2 : (i * (W - 2 * pad)) / (keys.length - 1)), ys = (v) => 18 + ((v - 1) / 8) * (H - 44);
  const path = pts.map((p, i) => `${i ? "L" : "M"}${xs(i)},${ys(p.v)}`).join(" ");
  return `<div class="card sec trend"><div class="sec-head"><h3>학기별 평균 등급 추이</h3><span class="sub">석차등급 과목 · 학점 가중 평균 (낮을수록 우수)</span></div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="학기별 평균 등급">
      ${[1, 3, 5, 7, 9].map((g) => `<line x1="${pad}" x2="${W - pad}" y1="${ys(g)}" y2="${ys(g)}" stroke="var(--line)" stroke-dasharray="3 4"/><text x="${pad - 10}" y="${ys(g)}" font-size="10.5" fill="var(--text-3)" text-anchor="end" dominant-baseline="middle">${g}</text>`).join("")}
      <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round"/>
      ${pts.map((p, i) => `<circle cx="${xs(i)}" cy="${ys(p.v)}" r="5" fill="var(--surface)" stroke="var(--accent)" stroke-width="2.5"/><text x="${xs(i)}" y="${ys(p.v) - 12}" text-anchor="middle" font-size="12" font-weight="700" fill="var(--text)">${p.v.toFixed(2)}</text><text x="${xs(i)}" y="${H - 6}" text-anchor="middle" font-size="11.5" fill="var(--text-3)">${p.k.replace("-", "학년 ")}학기</text>`).join("")}
    </svg>${comment ? `<p style="margin:6px 0 0;color:var(--text-2);font-size:14px">${esc(comment)}</p>` : ""}</div>`;
}

// ---------------- 패널: 면접 질문 ----------------
function updateProgress() {
  const bar = $("#qBar"); if (!bar) return;
  const pct = Math.min(100, (S.qProgress / S.opts.count) * 100);
  bar.parentElement.classList.toggle("indet", S.qProgress === 0);
  bar.style.width = pct + "%";
  $("#qProgText").textContent = S.qProgress ? `${S.qProgress} / ${S.opts.count}개 작성 중…` : "생기부의 근거 문장을 찾는 중…";
}

function filtered() {
  const f = S.filter, q = f.q.trim();
  return S.questions.filter((x) => (f.cat === "all" || x.category === f.cat) && (f.area === "all" || x.area === f.area) && (!f.kept || x.kept) &&
    (!q || [x.question, x.source, x.evidence, x.intent].join(" ").includes(q)));
}

function qCard(x, i) {
  const open = S.openAll;
  return `<article class="card qcard ${x.kept ? "kept" : ""}" data-id="${x.id}">
    <div class="q-meta">
      <span class="q-no">Q${i + 1}</span>
      <span class="cat" style="--cc:${CAT_COLOR[x.category] || "var(--c9)"}">${esc(x.category)}</span>
      <span class="badge">${esc(AREA_LABEL[x.area] || x.area)}</span>
      <span class="diff" title="난이도 ${x.difficulty}/5">${[1, 2, 3, 4, 5].map((n) => `<span class="${n <= x.difficulty ? "on" : ""}"></span>`).join("")}</span>
      <button class="keep ${x.kept ? "on" : ""}" data-act="keep" type="button" aria-label="보관" title="보관 — 내보내기·연습에 사용">${icon("star")}</button>
    </div>
    <p class="q-text">${esc(x.question)}</p>
    <p class="q-src">${icon("quote")}<span><b>${esc(x.source)}</b>${x.evidence ? ` · <q>${esc(x.evidence)}</q>` : ""}</span></p>
    <div class="q-body" ${open ? "" : "hidden"}>
      <div class="q-block"><h5>${icon("target")}출제 의도</h5><p>${esc(x.intent)}</p></div>
      ${x.answerGuide?.length ? `<div class="q-block"><h5>${icon("list")}답변 핵심 포인트</h5><ol>${x.answerGuide.map((a) => `<li>${esc(a)}</li>`).join("")}</ol></div>` : ""}
      <div class="q-block answer"><h5>${icon("msg")}모범 답변</h5><p>${esc(x.sampleAnswer)}</p></div>
      ${x.followUps?.length ? `<div class="q-block"><h5>${icon("corner")}꼬리질문</h5><ol class="follow">${x.followUps.map((a) => `<li>${esc(a)}</li>`).join("")}</ol></div>` : ""}
    </div>
    <div class="q-actions">
      <button class="btn-ghost sm" data-act="toggle" type="button">${open ? "접기" : "의도 · 답변 · 꼬리질문 보기"}</button>
      <span class="grow"></span>
      <button class="btn-ghost sm" data-act="regen" type="button">${icon("refresh")}재생성</button>
      <button class="btn-ghost sm" data-act="edit" type="button">${icon("wand")}수정</button>
      <button class="btn-ghost sm" data-act="practice" type="button">${icon("play")}연습</button>
    </div>
  </article>`;
}

function renderQuestions() {
  const p = $("#panel-questions");
  if (S.qState === "loading") {
    p.innerHTML = `<div class="card progress"><b>입학사정관 맞춤 면접 질문 생성 중</b><div class="bar indet"><div id="qBar"></div></div><p id="qProgText">생기부의 근거 문장을 찾는 중…</p><small>문항 ${S.opts.count}개 · 모범 답변과 꼬리질문까지 작성하므로 1~2분 정도 걸릴 수 있습니다.</small></div>
      ${[0, 1, 2].map(() => `<div class="card qcard"><div class="skel" style="height:18px;width:40%"></div><div class="skel" style="height:22px;margin-top:14px"></div><div class="skel" style="height:22px;width:70%;margin-top:8px"></div></div>`).join("")}`;
    updateProgress();
    return;
  }
  if (S.qState === "error") { p.innerHTML = errorBlock(S.qError, "retryQ"); $("#retryQ").onclick = runQuestions; return; }
  if (!S.questions.length) return (p.innerHTML = emptyBlock("sparkle", "아직 면접 질문이 없습니다", "지원 대학·학과를 입력하고 ‘AI 분석 · 질문 생성’을 누르면 맞춤 질문이 만들어집니다."));

  const counts = {};
  S.questions.forEach((q) => (counts[q.category] = (counts[q.category] || 0) + 1));
  const cats = [...COMPETENCIES, "기본·공통"].filter((c) => counts[c]);
  const areas = [...new Set(S.questions.map((q) => q.area))];
  const list = filtered();
  const keptN = S.questions.filter((q) => q.kept).length;
  p.innerHTML = `
    <div class="card q-toolbar">
      <div class="cat-filter">
        <button type="button" data-cat="all" class="${S.filter.cat === "all" ? "on" : ""}">전체 <i>${S.questions.length}</i></button>
        ${cats.map((c) => `<button type="button" data-cat="${esc(c)}" class="${S.filter.cat === c ? "on" : ""}"><span class="cat" style="--cc:${CAT_COLOR[c]};height:auto;padding:0;background:none">●</span>${esc(c)} <i>${counts[c]}</i></button>`).join("")}
      </div>
      <div class="q-tools">
        <input class="search" id="qSearch" placeholder="질문·근거 검색" value="${esc(S.filter.q)}" />
        <select id="qArea" aria-label="영역 필터"><option value="all">모든 영역</option>${areas.map((a) => `<option value="${esc(a)}" ${S.filter.area === a ? "selected" : ""}>${esc(AREA_LABEL[a] || a)}</option>`).join("")}</select>
        <button class="btn-ghost ${S.filter.kept ? "on" : ""}" id="qKept" type="button">${icon("star")}보관 ${keptN}</button>
        <button class="btn-ghost" id="qOpen" type="button">${S.openAll ? "모두 접기" : "모두 펼치기"}</button>
        ${exportBtns("questions")}
        <button class="btn-ghost" id="qCopy" type="button">${icon("copy")}복사</button>
      </div>
    </div>
    <div id="qList">${list.length ? list.map((x) => qCard(x, S.questions.indexOf(x))).join("") : emptyBlock("search", "조건에 맞는 질문이 없습니다", "필터를 바꿔 보세요.")}</div>`;

  $(".cat-filter", p).onclick = (e) => { const b = e.target.closest("button"); if (!b) return; S.filter.cat = b.dataset.cat; renderQuestions(); };
  $("#qSearch").oninput = (e) => { S.filter.q = e.target.value; const pos = e.target.selectionStart; renderQuestions(); const s = $("#qSearch"); s.focus(); s.setSelectionRange(pos, pos); };
  $("#qArea").onchange = (e) => { S.filter.area = e.target.value; renderQuestions(); };
  $("#qKept").onclick = () => { S.filter.kept = !S.filter.kept; renderQuestions(); };
  $("#qOpen").onclick = () => { S.openAll = !S.openAll; renderQuestions(); };
  $("#qCopy").onclick = async () => { try { await navigator.clipboard.writeText(toText(questionsDoc().blocks)); toast("클립보드에 복사했습니다."); } catch { toast("복사에 실패했습니다.", true); } };
  $("#qList").onclick = onCardAction;
}

function onCardAction(e) {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const card = b.closest(".qcard"); const q = S.questions.find((x) => x.id === card.dataset.id); if (!q) return;
  const act = b.dataset.act;
  if (act === "keep") { q.kept = !q.kept; card.classList.toggle("kept", q.kept); b.classList.toggle("on", q.kept); const k = $("#qKept"); if (k) k.innerHTML = `${icon("star")}보관 ${S.questions.filter((x) => x.kept).length}`; }
  if (act === "toggle") { const body = $(".q-body", card); body.hidden = !body.hidden; b.textContent = body.hidden ? "의도 · 답변 · 꼬리질문 보기" : "접기"; }
  if (act === "regen") rewriteQuestion(q, card, "");
  if (act === "edit") toggleEditBox(q, card);
  if (act === "practice") { startPractice([q]); setTab("practice"); }
}

function toggleEditBox(q, card) {
  const old = $(".edit-box", card);
  if (old) return old.remove();
  const box = document.createElement("div");
  box.className = "edit-box";
  box.innerHTML = `<div class="presets">${EDIT_PRESETS.map((p) => `<button class="btn-ghost sm" type="button" data-p="${esc(p)}">${esc(p)}</button>`).join("")}</div>
    <div class="row"><input placeholder="원하는 방향을 직접 입력 (예: 탐구 한계와 개선 방안을 묻도록)" maxlength="300" /><button class="btn-primary" type="button" style="height:38px;padding:0 14px;font-size:13.5px">${icon("wand")}적용</button></div>`;
  $(".q-actions", card).after(box);
  const input = $("input", box);
  input.focus();
  box.onclick = (e) => {
    const pb = e.target.closest("[data-p]"); if (pb) return rewriteQuestion(q, card, pb.dataset.p);
    if (e.target.closest(".btn-primary")) { if (!input.value.trim()) return input.focus(); rewriteQuestion(q, card, input.value.trim()); }
  };
  input.onkeydown = (e) => { if (e.key === "Enter" && input.value.trim()) rewriteQuestion(q, card, input.value.trim()); };
}

async function rewriteQuestion(q, card, instruction) {
  card.classList.add("busy");
  try {
    const nq = await api("/api/question", { record: S.recordText, target: target(), question: q, instruction, followDepth: S.opts.depth, others: S.questions.filter((x) => x !== q).map((x) => x.question) });
    Object.assign(q, nq);
    const i = S.questions.indexOf(q);
    card.outerHTML = qCard(q, i);
    const fresh = $(`.qcard[data-id="${q.id}"]`);
    if (fresh) { $(".q-body", fresh).hidden = false; $('[data-act="toggle"]', fresh).textContent = "접기"; }
    toast(instruction ? "요청대로 질문을 수정했습니다." : "새 질문으로 바꿨습니다.");
  } catch (e) {
    card.classList.remove("busy");
    toast(e.message, true);
  }
}

// 내보내기
function exportSet() { const k = S.questions.filter((q) => q.kept); return k.length ? k : S.questions; }
// ---------------- 결과물 내보내기 (PDF 인쇄 · 한글 · Word · TXT) ----------------
const EXPORT_FMTS = [["pdf", "print", "PDF·인쇄"], ["hwpx", "download", "한글"], ["docx", "download", "Word"], ["txt", "download", "TXT"]];
function exportBtns(kind, sm = false) {
  return EXPORT_FMTS.map(([f, ic, l]) => `<button class="btn-ghost${sm ? " sm" : ""}" type="button" data-export="${kind}:${f}" title="${l}로 내보내기">${icon(ic)}${l}</button>`).join("");
}
const today = () => new Date().toLocaleDateString("ko-KR");
const targetLine = (extra = []) => [target().university, target().major, ...extra].filter(Boolean).join(" · ");

function questionsDoc() {
  const set = exportSet();
  if (!set.length) return null;
  const kept = S.questions.some((q) => q.kept);
  return {
    title: "생기부 맞춤 면접 질문", file: "면접질문",
    blocks: [
      { t: "title", text: "생기부 맞춤 면접 질문" },
      { t: "meta", text: `${targetLine([target().mode])} · ${set.length}문항${kept ? "(보관 문항)" : ""} · ${today()}` },
      ...set.map((q, i) => ({ t: "item", blocks: [
        { t: "tag", text: `${q.category} · ${AREA_LABEL[q.area] || q.area || ""} · 난이도 ${q.difficulty}/5` },
        { t: "h2", text: `Q${i + 1}. ${q.question}` },
        { t: "p", label: "근거", text: `${q.source}${q.evidence ? ` "${q.evidence}"` : ""}` },
        { t: "p", label: "출제 의도", text: q.intent },
        ...(q.answerGuide?.length ? [{ t: "p", label: "답변 포인트", text: "" }, ...q.answerGuide.map((a, j) => ({ t: "li", n: j + 1, text: a }))] : []),
        { t: "p", label: "모범 답변", text: q.sampleAnswer },
        ...(q.followUps?.length ? [{ t: "p", label: "꼬리질문", text: "" }, ...q.followUps.map((f, j) => ({ t: "li", n: j + 1, text: f }))] : []),
      ] })),
    ],
  };
}

function reviewDoc() {
  const v = S.review;
  if (!v) return null;
  const list = (arr, n) => (arr || []).map((x, i) => ({ t: "li", text: x, ...(n ? { n: i + 1 } : {}) }));
  const comps = COMPETENCIES.map((n) => v.competencies?.find((c) => c.name === n)).filter(Boolean);
  const areaOrder = ["자율활동", "동아리활동", "진로활동", "교과성적", "세부능력및특기사항", "행동특성및종합의견"];
  const areas = areaOrder.map((a) => v.areas?.find((x) => x.area === a)).filter(Boolean);
  const r = S.record;
  const keys = r ? [...new Set(r.grades.filter((g) => g.rank).map((g) => `${g.grade}-${g.semester}`))] : [];
  const trend = keys.map((k) => `${k.replace("-", "학년 ")}학기 ${weightedRank(r.grades.filter((g) => `${g.grade}-${g.semester}` === k)).toFixed(2)}등급`);
  return {
    title: "생기부 리뷰", file: "생기부리뷰",
    blocks: [
      { t: "title", text: `생기부 리뷰 — ${target().major || "지원 학과"} 관점` },
      { t: "meta", text: `${targetLine()}${targetLine() ? " · " : ""}${today()}` },
      { t: "h1", text: "총평" },
      { t: "p", label: "학생 유형", text: v.studentType },
      { t: "p", text: v.summary },
      ...(v.keywords?.length ? [{ t: "p", label: "키워드", text: v.keywords.map((k) => "#" + k).join(" ") }] : []),
      { t: "h1", text: `전공 적합도 ${Math.max(0, Math.min(100, v.majorFit?.score ?? 0))}점` },
      { t: "p", text: v.majorFit?.comment },
      { t: "h1", text: "8대 평가요소" },
      ...comps.map((c) => ({ t: "li", text: `${c.name} ${c.score}점 — ${c.comment || ""}` })),
      { t: "h1", text: "영역별 평가" },
      ...areas.map((a) => ({ t: "item", blocks: [
        { t: "h2", text: `${AREA_LABEL[a.area] || a.area} (${"★".repeat(Math.max(0, Math.min(5, a.rating)))}${"☆".repeat(5 - Math.max(0, Math.min(5, a.rating)))})` },
        { t: "p", text: a.summary },
        ...(a.highlights?.length ? [{ t: "p", label: "돋보이는 점", text: "" }, ...list(a.highlights)] : []),
        ...(a.concerns?.length ? [{ t: "p", label: "아쉬운 점", text: "" }, ...list(a.concerns)] : []),
      ] })),
      { t: "h1", text: "면접에서 살릴 강점" }, ...list(v.strengths),
      { t: "h1", text: "압박 질문이 올 약점" }, ...list(v.risks),
      ...(trend.length || v.gradeTrend ? [{ t: "h1", text: "학기별 평균 등급 추이" }, ...(trend.length ? [{ t: "p", text: trend.join(" → ") }] : []), ...(v.gradeTrend ? [{ t: "p", text: v.gradeTrend }] : [])] : []),
      { t: "h1", text: "면접 대비 전략" }, ...list(v.strategy, true),
    ],
  };
}

function practiceDoc() {
  const P = S.practice;
  if (!P?.list?.length) return null;
  const done = P.list.filter((x) => x.fb);
  const avg = done.length ? Math.round(done.reduce((s, x) => s + x.fb.score, 0) / done.length) : null;
  return {
    title: "모의 면접 결과", file: "모의면접결과",
    blocks: [
      { t: "title", text: "모의 면접 결과" },
      { t: "meta", text: `${targetLine()}${targetLine() ? " · " : ""}${done.length}/${P.list.length}문항 평가${avg != null ? ` · 평균 ${avg}점` : ""} · 답변 시간 ${P.sec}초 · ${today()}` },
      ...P.list.map((x, i) => ({ t: "item", blocks: [
        { t: "tag", text: `${x.q.category}${x.fb ? ` · ${x.fb.score}점 (${x.fb.grade})` : " · 평가 안 함"}` },
        { t: "h2", text: `Q${i + 1}. ${x.q.question}` },
        { t: "p", label: "내 답변", text: x.answer.trim() || "(답변 없음)" },
        ...(x.fb ? [
          { t: "p", label: "한 줄 평", text: x.fb.oneLine },
          ...(x.fb.evidenceUse ? [{ t: "p", label: "생기부 근거 활용", text: x.fb.evidenceUse }] : []),
          ...(x.fb.strengths?.length ? [{ t: "p", label: "잘한 점", text: "" }, ...x.fb.strengths.map((s) => ({ t: "li", text: s }))] : []),
          ...(x.fb.improvements?.length ? [{ t: "p", label: "보완할 점", text: "" }, ...x.fb.improvements.map((s) => ({ t: "li", text: s }))] : []),
          { t: "p", label: "다듬은 답변", text: x.fb.revisedAnswer },
          ...(x.fb.followUp ? [{ t: "p", label: "면접관의 다음 질문", text: x.fb.followUp }] : []),
        ] : []),
      ] })),
    ],
  };
}

const DOCS = { questions: questionsDoc, review: reviewDoc, practice: practiceDoc };
function exportName(doc, ext) {
  const tag = (target().major || "").replace(/[\\/:*?"<>|]/g, "").trim();
  return `${doc.file}${tag ? "_" + tag : ""}_${new Date().toISOString().slice(0, 10)}.${ext}`;
}
function saveBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}
async function runExport(kind, fmt, btn) {
  const doc = DOCS[kind]?.();
  if (!doc) return toast("내보낼 결과가 없습니다.", true);
  if (fmt === "pdf") {
    $("#printRoot").innerHTML = toPrintHtml(doc.blocks);
    return window.print();
  }
  if (btn) btn.disabled = true;
  try {
    if (fmt === "txt") saveBlob(new Blob(["\uFEFF" + toText(doc.blocks)], { type: "text/plain;charset=utf-8" }), exportName(doc, "txt"));
    if (fmt === "docx") saveBlob(await toDocx(doc.blocks, doc.title), exportName(doc, "docx"));
    if (fmt === "hwpx") saveBlob(await toHwpx(doc.blocks, doc.title), exportName(doc, "hwpx"));
    toast(`${{ txt: "TXT", docx: "Word", hwpx: "한글" }[fmt]} 파일을 저장했습니다.`);
  } catch (e) {
    console.error(e);
    toast("파일을 만들지 못했습니다: " + e.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------------- 패널: 실전 연습 ----------------
let timerId = null, recog = null;
function stopTimers() { clearInterval(timerId); timerId = null; try { recog?.stop(); } catch {} recog = null; }

function startPractice(list) {
  stopTimers();
  const sec = Number($("#prTime")?.value || S.practice?.sec || 90);
  S.practice = { list: list.map((q) => ({ q, answer: "", fb: null })), idx: 0, sec, left: sec, started: true };
  renderPractice();
  startTimer();
}
function startTimer() {
  clearInterval(timerId);
  timerId = setInterval(() => {
    const P = S.practice; if (!P) return stopTimers();
    P.left = Math.max(0, P.left - 1);
    const el = $("#prTimer"); if (!el) return;
    const C = 2 * Math.PI * 28;
    $("circle.run", el).setAttribute("stroke-dasharray", `${(C * P.left) / P.sec} ${C}`);
    $("b", el).textContent = fmt(P.left);
    el.classList.toggle("low", P.left <= 10);
    if (P.left === 0) { clearInterval(timerId); toast("답변 시간이 끝났습니다."); }
  }, 1000);
}
const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

function renderPractice() {
  const p = $("#panel-practice");
  if (!S.questions.length) { p.innerHTML = emptyBlock("play", "연습할 질문이 없습니다", "먼저 면접 질문을 생성하세요. 몬스터T처럼 실제 면접처럼 시간을 재며 답변하고 AI 피드백을 받을 수 있습니다."); return; }
  const P = S.practice;
  if (!P || !P.started) {
    const keptN = S.questions.filter((q) => q.kept).length;
    p.innerHTML = `<div class="card sec">
      <div class="sec-head"><h3>실전 모의 면접</h3><span class="sub">질문을 듣고(읽고) 제한 시간 안에 답한 뒤, 입학사정관 AI의 피드백을 받습니다.</span></div>
      <div class="pr-setup">
        <div class="field"><label for="prSet">문항 세트</label><select id="prSet"><option value="all">전체 ${S.questions.length}문항 (무작위 10)</option><option value="kept" ${keptN ? "" : "disabled"}>보관한 문항 ${keptN}개</option><option value="hard">고난도(4~5) 문항</option><option value="order">순서대로 전체</option></select></div>
        <div class="field"><label for="prTime">답변 시간</label><select id="prTime"><option value="60">60초</option><option value="90" selected>90초</option><option value="120">120초</option><option value="180">180초</option></select></div>
        <button class="btn-primary" id="prStart" type="button">${icon("play")}모의 면접 시작</button>
      </div></div>`;
    $("#prStart").onclick = () => {
      const v = $("#prSet").value;
      let list = [...S.questions];
      if (v === "kept") list = list.filter((q) => q.kept);
      if (v === "hard") list = list.filter((q) => q.difficulty >= 4);
      if (v === "all") list = list.sort(() => Math.random() - 0.5).slice(0, 10);
      if (!list.length) return toast("해당 문항이 없습니다.", true);
      startPractice(list);
    };
    return;
  }
  if (P.idx >= P.list.length) return renderPracticeSummary();
  const cur = P.list[P.idx];
  const C = 2 * Math.PI * 28;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  p.innerHTML = `<div class="card pr-stage">
    <div class="pr-top">
      <span class="badge accent">${P.idx + 1} / ${P.list.length}</span>
      <span class="cat" style="--cc:${CAT_COLOR[cur.q.category] || "var(--c9)"}">${esc(cur.q.category)}</span>
      <div class="prog"><div style="width:${(P.idx / P.list.length) * 100}%"></div></div>
      <div class="timer ${P.left <= 10 ? "low" : ""}" id="prTimer"><svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" fill="none" stroke="var(--surface-3)" stroke-width="5"/><circle class="run" cx="32" cy="32" r="28" fill="none" stroke="var(--accent)" stroke-width="5" stroke-linecap="round" stroke-dasharray="${(C * P.left) / P.sec} ${C}"/></svg><b>${fmt(P.left)}</b></div>
    </div>
    <p class="pr-q">${esc(cur.q.question)}</p>
    <textarea class="pr-answer" id="prAns" placeholder="실제 면접처럼 답변을 말하거나 적어 보세요. (마이크 버튼으로 음성 입력)">${esc(cur.answer)}</textarea>
    <div class="pr-bar">
      ${SR ? `<button class="btn-ghost mic" id="prMic" type="button">${icon("mic")}음성 답변</button>` : ""}
      <button class="btn-ghost" id="prHint" type="button">${icon("list")}답변 포인트</button>
      <span class="grow"></span>
      <button class="btn-ghost" id="prQuit" type="button">그만하기</button>
      <button class="btn-ghost" id="prSkip" type="button">건너뛰기</button>
      <button class="btn-primary" id="prSubmit" type="button" style="height:40px">${icon("check")}${cur.fb ? "다시 평가" : "답변 제출 · 피드백"}</button>
    </div>
    <div id="prHintBox" hidden class="q-block" style="margin-top:12px"><h5>${icon("list")}답변 핵심 포인트</h5><ol>${(cur.q.answerGuide || []).map((a) => `<li>${esc(a)}</li>`).join("")}</ol></div>
    <div id="prFb">${cur.fb ? feedbackHtml(cur.fb) : ""}</div>
  </div>`;
  const ans = $("#prAns");
  ans.oninput = () => (cur.answer = ans.value);
  $("#prHint").onclick = () => ($("#prHintBox").hidden = !$("#prHintBox").hidden);
  $("#prQuit").onclick = () => { stopTimers(); S.practice.idx = S.practice.list.length; renderPractice(); };
  $("#prSkip").onclick = () => nextPractice();
  $("#prSubmit").onclick = () => submitAnswer(cur);
  if (SR) $("#prMic").onclick = () => toggleMic(SR, ans, cur);
}

function toggleMic(SR, ans, cur) {
  const btn = $("#prMic");
  if (recog) { recog.stop(); return; }
  recog = new SR();
  recog.lang = "ko-KR"; recog.continuous = true; recog.interimResults = true;
  const base = ans.value ? ans.value + " " : "";
  let finalText = "";
  recog.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
    }
    ans.value = base + finalText + interim;
    cur.answer = ans.value;
  };
  recog.onend = () => { recog = null; btn?.classList.remove("rec"); if (btn) btn.innerHTML = `${icon("mic")}음성 답변`; };
  recog.onerror = (e) => toast(e.error === "not-allowed" ? "마이크 권한이 필요합니다." : "음성 인식 오류", true);
  recog.start();
  btn.classList.add("rec");
  btn.innerHTML = `${icon("mic")}녹음 중… 멈추기`;
}

async function submitAnswer(cur) {
  if (!cur.answer.trim()) return toast("답변을 입력하거나 말해 주세요.", true);
  try { recog?.stop(); } catch {}
  clearInterval(timerId);
  const btn = $("#prSubmit");
  btn.disabled = true; btn.textContent = "입학사정관이 평가 중…";
  $("#prFb").innerHTML = `<div class="skel" style="height:120px;margin-top:18px"></div>`;
  try {
    cur.fb = await api("/api/feedback", { record: S.recordText, target: target(), question: cur.q.question, intent: cur.q.intent, answer: cur.answer });
    $("#prFb").innerHTML = feedbackHtml(cur.fb);
    btn.disabled = false; btn.innerHTML = `${icon("next")}다음 질문`;
    btn.onclick = () => nextPractice();
  } catch (e) {
    $("#prFb").innerHTML = "";
    btn.disabled = false; btn.innerHTML = `${icon("check")}답변 제출 · 피드백`;
    toast(e.message, true);
  }
}

function feedbackHtml(f) {
  return `<div class="fb">
    <div class="fb-head"><div class="fb-score">${esc(f.grade)}</div><div><b>${f.score}점 · ${esc(f.oneLine)}</b><p>${esc(f.evidenceUse)}</p></div></div>
    <div class="grid-2">
      <div class="q-block"><h5>${icon("check")}잘한 점</h5><ul class="dots">${(f.strengths || []).map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>
      <div class="q-block"><h5>${icon("edit")}보완할 점</h5><ul class="dots bad">${(f.improvements || []).map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>
    </div>
    <div class="q-block answer"><h5>${icon("msg")}다듬은 답변</h5><p>${esc(f.revisedAnswer)}</p></div>
    <div class="q-block"><h5>${icon("corner")}면접관의 다음 질문</h5><p>${esc(f.followUp)}</p></div>
  </div>`;
}

function nextPractice() {
  const P = S.practice;
  stopTimers();
  P.idx++; P.left = P.sec;
  renderPractice();
  if (P.idx < P.list.length) startTimer();
}

function renderPracticeSummary() {
  stopTimers();
  const P = S.practice;
  const done = P.list.filter((x) => x.fb);
  const avg = done.length ? Math.round(done.reduce((s, x) => s + x.fb.score, 0) / done.length) : 0;
  $("#panel-practice").innerHTML = `<div class="card sec">
    <div class="sec-head"><h3>모의 면접 결과</h3><span class="sub">${done.length} / ${P.list.length}문항 평가</span><div class="right"><button class="btn-primary" id="prAgain" type="button" style="height:38px">${icon("refresh")}새 세트로 다시</button></div></div>
    <div class="export-bar inline"><b>${icon("download")}결과 내보내기</b><span class="sub">질문 · 내 답변 · AI 채점 · 다듬은 답변</span><span class="grow"></span>${exportBtns("practice", true)}</div>
    ${done.length ? `<div class="fb-head" style="margin-bottom:14px"><div class="fb-score">${avg}</div><div><b>평균 점수</b><p>낮은 점수 문항의 ‘다듬은 답변’을 다시 읽고 반복 연습하세요.</p></div></div>` : ""}
    <div class="summary-list">${P.list.map((x, i) => `<div><span class="badge">${i + 1}</span><span>${esc(x.q.question)}</span><b>${x.fb ? `${x.fb.score}점` : "건너뜀"}</b></div>`).join("")}</div>
  </div>`;
  $("#prAgain").onclick = () => { S.practice = null; renderPractice(); };
}

// ---------------- 패널: 대학 정보 ----------------
function renderUniv() {
  const p = $("#panel-univ");
  const t = target();
  if (S.uniState === "loading") return (p.innerHTML = loadingBlock("공식 정보를 검색하고 있습니다", "Google 검색으로 인재상·평가요소·면접 방식을 확인하는 중…"));
  const head = `<div class="card sec"><div class="sec-head"><h3>대학 · 학과 정보</h3><span class="sub">Google 검색 기반 요약 · 반드시 대학 모집요강으로 최종 확인하세요</span>
    <div class="right"><button class="btn-primary" id="uniBtn" type="button" style="height:38px">${icon("globe")}${S.uni ? "다시 검색" : "정보 가져오기"}</button></div></div>
    <p class="hint" style="text-align:left;margin:0">${t.university || t.major ? `검색 대상: <b>${esc([t.university, t.major].filter(Boolean).join(" "))}</b>` : "왼쪽에서 대학과 학과를 먼저 입력하세요."} · 이 검색에는 생기부 내용이 전송되지 않습니다.</p></div>`;
  let body = "";
  if (S.uniState === "error") body = errorBlock(S.uniError, "uniRetry");
  else if (S.uni) {
    const u = S.uni;
    const list = (arr) => (Array.isArray(arr) && arr.length ? `<ul class="dots">${arr.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : `<p class="hint" style="text-align:left">정보 없음</p>`);
    body = `${u.overview ? `<div class="card sec"><div class="sec-head"><h3>${esc([u.university, u.major].filter(Boolean).join(" ") || "개요")}</h3></div><p style="margin:0;color:var(--text-2)">${esc(u.overview)}</p></div>` : ""}
      <div class="uni-grid">
        <div class="card uni-card"><h4>${icon("users")}인재상</h4>${list(u.talent)}</div>
        <div class="card uni-card"><h4>${icon("target")}평가요소</h4>${list(u.evaluation)}</div>
        <div class="card uni-card"><h4>${icon("msg")}면접 방식</h4>${list(u.interview)}</div>
        <div class="card uni-card"><h4>${icon("book")}주요 전공 교과목</h4>${list(u.curriculum)}</div>
        <div class="card uni-card"><h4>${icon("list")}고교 연계·권장 과목</h4>${list(u.related)}</div>
        <div class="card uni-card"><h4>${icon("sparkle")}면접 대비 팁</h4>${list(u.tips)}</div>
      </div>
      ${u.sources?.length ? `<div class="card sec" style="margin-top:16px"><div class="sec-head"><h3>출처</h3></div><div class="src">${u.sources.map((s) => `<a href="${esc(s.uri)}" target="_blank" rel="noopener noreferrer">${icon("link")}<span>${esc(s.title)}</span></a>`).join("")}</div></div>` : ""}`;
  } else body = emptyBlock("globe", "지원 학과 정보를 확인하세요", "AI Studio 면접 생성기처럼 학과 인재상과 평가 방식을 함께 보면 답변 방향을 잡기 쉽습니다.");
  p.innerHTML = head + body;
  $("#uniBtn").onclick = runUniv;
  $("#uniRetry")?.addEventListener("click", runUniv);
}

async function runUniv() {
  const t = target();
  if (!t.university && !t.major) { toast("대학 또는 학과를 입력하세요.", true); $("#univ").focus(); return; }
  S.uniState = "loading"; renderUniv(); renderTabs();
  try { S.uni = await api("/api/university", { target: t }); S.uniState = "done"; }
  catch (e) { S.uniState = "error"; S.uniError = e.message; }
  renderUniv(); renderTabs();
}

// ---------------- 초기화 ----------------
async function init() {
  hydrateIcons();
  initTheme();
  initUpload();
  initSide();
  $(".tabs").onclick = (e) => { const b = e.target.closest("button[data-tab]"); if (b) { setTab(b.dataset.tab); if (b.dataset.tab === "univ") renderUniv(); } };
  $("#privacyBtn").onclick = () => $("#privacyDlg").showModal();
  ["#univ", "#major"].forEach((s) => $(s).addEventListener("change", () => S.tab === "univ" && renderUniv()));
  window.addEventListener("beforeunload", (e) => { if (S.questions.length) { e.preventDefault(); e.returnValue = ""; } });
  initKeyDialog();
  document.addEventListener("click", (e) => { const b = e.target.closest("[data-export]"); if (b) { const [k, f] = b.dataset.export.split(":"); runExport(k, f, b); } });
  try {
    const h = await fetch("/api/health").then((r) => r.json());
    serverHasKey = !!h.keyConfigured;
    $("#keyBtn").dataset.model = h.model;
  } catch {}
  silentKeyCheck();
}
init();
