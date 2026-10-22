// 학교생활기록부·개인별 대입전형자료 PDF 파서 (브라우저/Node 공용 ESM)
// 개인정보 보호 원칙: 아래 6개 영역만 읽는다. 그 외 영역(인적·학적, 출결, 수상, 자격증,
// 학교폭력, 봉사, 독서)과 페이지 머리말/꼬리말(성명·반·번호·학교명·출력정보)은 아예 수집하지 않는다.
//   1) 자율활동 2) 동아리활동 3) 진로활동 4) 교과 성적 5) 세부능력 및 특기사항 6) 행동특성 및 종합의견

const FOOTER_ZONE = 60; // 페이지 하단 60pt(성명·반·번호·출력정보 꼬리말)는 무조건 버림
const HEADER_ZONE = 40; // 페이지 상단 머리말 여유

// 섹션 제목은 공백을 모두 지운 문자열로 비교한다.
// 학교생활기록부는 "6. 창의적 체험활동상황"처럼 번호가 붙고, 개인별 대입전형자료는 번호 없이 "창의적 체험활동상황"으로 나온다.
const RE = {
  sec6: /^(?:6\.)?창의적체험활동상황/,
  volunteer: /^봉\s*사\s*활\s*동\s*실\s*적/,
  sec7: /^(?:7\.)?교과학습발달상황/,
  sec9: /^(?:9\.)?행동특성및종합의견/,
  anySection: /^\d{1,2}\.\s*\S/,
  // 번호 없는 그 외 섹션(대입전형자료) → 수집 중단
  otherSection: /^(?:인적[·ㆍ・]?학적사항|학적사항|출결상황|수상경력|자격증및인증취득상황|국가직무능력표준|학교폭력|독서활동상황|봉사활동실적|정정대장)/,
  printDate: /^\d{4}\.\d{1,2}\.\d{1,2}\.?$/,
  gradeHeader: /^\[(\d)학년\]/,
  subTable: /^<\s*(진로\s*선택\s*과목|체육\s*[ㆍ·・]?\s*예술|교양\s*과목|.+?)\s*>$/,
  seteukHeader: /세부능력및특기사항/, // 대입전형자료는 "세 부 능 력 및 특 기 사 항"처럼 글자 사이가 띄어져 있어 공백 제거 후 비교
  none: /^(해당\s*사항\s*없음|해당\s*학년의\s*자료가\s*없습니다)$/,
  score: /^(\d{1,3}(?:\.\d+)?)\/(\d{1,3}(?:\.\d+)?)(?:\((\d{1,3}(?:\.\d+)?)\))?$/,
  achieve: /^([A-EP])(?:\((\d+)\))?$/,
  dist: /^A\([\d.]+\)/,
  subjectPrefix: /^((?:\(\d학기\))?[^\s:.,'"]{1,14}(?:\s[^\s:.,'"]{1,10}){0,2})\s*:\s*(.*)$/,
};

const AREAS = ["자율활동", "동아리활동", "진로활동"];

// ---------- 개인정보 마스킹 (방어적 2차 필터) ----------
export function scrub(text, stats) {
  const rules = [
    [/\d{6}\s*-\s*[1-4]\d{6}/g, "[주민번호 삭제]"],
    [/01[016789][-\s.]?\d{3,4}[-\s.]?\d{4}/g, "[전화번호 삭제]"],
    [/0\d{1,2}[-)]\s?\d{3,4}-\d{4}/g, "[전화번호 삭제]"],
    [/[\w.+-]+@[\w-]+\.[\w.]+/g, "[이메일 삭제]"],
    [/[가-힣]{1,10}(초등학교|중학교|고등학교|여자고등학교|대학교부설고등학교)/g, "OO$1"],
    [/(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충청|충북|충남|전라|전북|전남|경상|경북|경남|제주)[가-힣]*\s?[가-힣]+[시군구]\s?[가-힣0-9]+(로|길)\s?\d+[^\s,)]*/g, "[주소 삭제]"],
  ];
  let out = text;
  for (const [re, rep] of rules) {
    out = out.replace(re, (m, ...g) => {
      if (stats) stats.masked++;
      return typeof rep === "string" ? rep.replace("$1", g[0] ?? "") : rep;
    });
  }
  return out;
}

// ---------- PDF → 페이지별 라인 ----------
async function loadPages(pdfjsLib, data) {
  const task = pdfjsLib.getDocument({ data, isEvalSupported: false });
  const doc = await task.promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = [];
    for (const it of tc.items) {
      const str = (it.str || "").replace(/\s+/g, " ").trim();
      if (!str) continue;
      const x = it.transform[4];
      const y = vp.height - it.transform[5];
      if (y > vp.height - FOOTER_ZONE || y < HEADER_ZONE) continue; // 머리말·꼬리말 폐기
      if (y < HEADER_ZONE + 25 && RE.printDate.test(str)) continue; // 대입전형자료 상단 출력일자
      items.push({ str, x, y, w: it.width, page: p });
    }
    pages.push({ no: p, height: vp.height, width: vp.width, lines: toLines(items) });
    page.cleanup();
  }
  await task.destroy();
  return pages;
}

function toLines(items) {
  items.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const it of items) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - it.y) <= 2) last.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  for (const l of lines) {
    l.items.sort((a, b) => a.x - b.x);
    l.text = l.items.map((i) => i.str).join(" ");
    l.x = l.items[0].x;
    l.right = Math.max(...l.items.map((i) => i.x + i.w));
  }
  return lines;
}

// 같은 행 안에서 거의 붙어 있는 조각(예: "기술" "・" "가정/제2외")을 합친다
function mergePieces(items) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const out = [];
  for (const it of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.y - it.y) <= 2 && it.x - (last.x + last.w) < 3) {
      last.str += it.str;
      last.w = it.x + it.w - last.x;
    } else out.push({ ...it });
  }
  return out;
}

// 줄바꿈 결합: 생기부는 글자 수로 줄을 바꿔 단어가 잘리므로, 꽉 찬 줄이 한글로 끝나면 붙인다.
// 단, 조사·어미로 끝나는 2글자 이상 단어(예: "대기가", "친구의", "꾸준히")는 온전한 단어로 보고 띄운다.
const WORD_END = /[가-힣][을를은는이가의에와과로서며고어히게함임음됨]$/;
function joinLines(lines) {
  if (!lines.length) return "";
  const maxRight = Math.max(...lines.map((l) => l.right));
  let s = "";
  lines.forEach((l, i) => {
    if (i === 0) { s = l.text; return; }
    const prev = lines[i - 1];
    const full = prev.right >= maxRight - 4;
    const lastWord = prev.text.split(" ").pop();
    const glue = full && /[가-힣]$/.test(prev.text) && /^[가-힣]/.test(l.text) && !WORD_END.test(lastWord);
    const punct = /^[.,)]/.test(l.text);
    s += glue || punct ? l.text : " " + l.text;
  });
  return s.replace(/\s+/g, " ").trim();
}

// 세로 중앙 정렬된 라벨로 행 경계를 추정 (top → 2*label - top 이 bottom)
function bandsFromCenteredLabels(labels, top) {
  const bands = [];
  let t = top;
  for (const lb of labels) {
    const bottom = Math.max(2 * lb.y - t, lb.y + 6);
    bands.push({ ...lb, top: t, bottom });
    t = bottom;
  }
  return bands;
}

// ---------- 6. 창의적 체험활동상황 ----------
function parseCreative(chunks) {
  // chunks: [{page, lines}] 섹션 6 범위(봉사활동 실적 이전)
  const rows = [];
  for (const ch of chunks) {
    const header = ch.lines.find((l) => /특기사항/.test(l.text) && /영역/.test(l.text));
    if (!header) continue;
    const timeItem = header.items.find((i) => i.str === "시간");
    const splitX = timeItem ? timeItem.x + timeItem.w + 6 : 190;
    const body = ch.lines.filter((l) => l.y > header.y + 2);
    const labels = [];
    const content = [];
    for (const l of body) {
      for (const it of l.items) {
        if (it.x < splitX) {
          const area = AREAS.find((a) => it.str.replace(/\s/g, "") === a);
          if (area) labels.push({ area, y: it.y, hours: null, labelItem: it });
          else if (/^\d{1,3}$/.test(it.str) && it.x > splitX - 40) {
            const lb = [...labels].reverse().find((x) => Math.abs(x.y - it.y) < 2);
            if (lb) lb.hours = Number(it.str);
          }
        }
      }
      const cItems = l.items.filter((i) => i.x >= splitX);
      if (cItems.length) {
        const text = cItems.map((i) => i.str).join(" ");
        content.push({ y: l.y, text, right: Math.max(...cItems.map((i) => i.x + i.w)), x: cItems[0].x });
      }
    }
    // 시간 숫자가 라벨보다 먼저 정렬돼 누락된 경우 보정
    for (const lb of labels) {
      if (lb.hours == null) {
        const line = body.find((l) => Math.abs(l.y - lb.y) < 2);
        const num = line?.items.find((i) => i.x < splitX && /^\d{1,3}$/.test(i.str) && i.x > lb.labelItem.x);
        if (num) lb.hours = Number(num.str);
      }
    }
    labels.sort((a, b) => a.y - b.y);
    const bands = bandsFromCenteredLabels(labels, header.y + 9);
    for (const b of bands) {
      const mine = content.filter((c) => c.y >= b.top - 1 && c.y < b.bottom - 1);
      let hope = null;
      const textLines = [];
      for (const c of mine) {
        const m = c.text.match(/^희망\s*분야\s*(.*)$/);
        if (m) hope = m[1].trim() || null;
        else textLines.push(c);
      }
      rows.push({ area: b.area, hours: b.hours, hope, lines: textLines, page: ch.page });
    }
  }
  // 페이지를 넘어 이어지는 같은 영역 행 병합
  const merged = [];
  for (const r of rows) {
    const last = merged[merged.length - 1];
    if (last && last.area === r.area && last.page !== r.page) {
      last.lines.push(...r.lines);
      last.hope = last.hope || r.hope;
      last.page = r.page;
    } else merged.push({ ...r, lines: [...r.lines] });
  }
  // 자율→동아리→진로 순환으로 학년 부여
  let grade = 0;
  let prevIdx = 99;
  return merged.map((r) => {
    const idx = AREAS.indexOf(r.area);
    if (idx <= prevIdx) grade++;
    prevIdx = idx;
    return { grade, area: r.area, hours: r.hours, hope: r.hope, text: joinLines(r.lines) };
  });
}

// ---------- 7. 교과학습발달상황 ----------
function parseTable(lineGroups, kind, grade) {
  // lineGroups: [{page, lines, header}] 표 한 개(페이지가 넘어가면 여러 그룹)
  const rows = [];
  for (const g of lineGroups) {
    const creditHdr = g.headerItems.find((i) => /^학점(수)?$/.test(i.str));
    const subjHdr = g.headerItems.find((i) => i.str === "과목");
    if (!creditHdr) continue;
    const cx0 = creditHdr.x - 6, cx1 = creditHdr.x + creditHdr.w + 6;
    const items = g.lines.flatMap((l) => l.items);
    const subjHdrX = subjHdr ? subjHdr.x : cx0;
    const semLabels = items.filter((i) => /^[1-4]$/.test(i.str) && i.x < 60);
    const anchors = items
      .filter((i) => /^\d{1,2}$/.test(i.str) && i.x >= cx0 && i.x + i.w <= cx1 && !semLabels.includes(i))
      .sort((a, b) => a.y - b.y);
    if (!anchors.length) continue;
    const rowObjs = anchors.map((a) => ({ y: a.y, credits: Number(a.str), items: [] }));
    for (const it of items) {
      if (anchors.includes(it) || semLabels.includes(it)) continue;
      let best = null, bd = 1e9;
      for (const r of rowObjs) {
        const d = Math.abs(r.y - it.y);
        if (d < bd) { bd = d; best = r; }
      }
      if (best && bd < 30) best.items.push(it);
    }
    // 학기 라벨: 해당 학기 행 묶음의 세로 중앙에 위치
    semLabels.sort((a, b) => a.y - b.y);
    let start = 0;
    semLabels.forEach((lb, k) => {
      if (start >= rowObjs.length) return;
      let end = start, bestD = 1e9;
      const last = k === semLabels.length - 1 ? rowObjs.length - 1 : rowObjs.length - 1;
      for (let e = start; e <= last; e++) {
        const d = Math.abs((rowObjs[start].y + rowObjs[e].y) / 2 - lb.y);
        if (d < bestD - 0.5) { bestD = d; end = e; }
      }
      if (k === semLabels.length - 1) end = rowObjs.length - 1;
      for (let e = start; e <= end; e++) rowObjs[e].semester = Number(lb.str);
      start = end + 1;
    });
    // 텍스트 조각의 왼쪽 정렬 위치로 교과/과목 열 구분
    const textPieces = rowObjs.flatMap((r) => mergePieces(r.items.filter((i) => i.x < cx0)));
    const lefts = textPieces.map((p) => Math.round(p.x));
    const groupX = Math.min(...lefts);
    const subjCandidates = lefts.filter((x) => x > groupX + 30);
    const subjX = subjCandidates.length ? Math.min(...subjCandidates) : subjHdrX - 40;
    const split = (groupX + subjX) / 2;
    for (const r of rowObjs) {
      const pieces = mergePieces(r.items.filter((i) => i.x < cx0)).sort((a, b) => a.y - b.y || a.x - b.x);
      const group = pieces.filter((p) => p.x < split).map((p) => p.str).join("");
      const subject = pieces.filter((p) => p.x >= split).map((p) => p.str).join("");
      const right = r.items.filter((i) => i.x >= cx1 - 2).sort((a, b) => a.x - b.x);
      const row = { grade, semester: r.semester ?? null, kind, group, subject, credits: r.credits };
      for (const it of right) {
        let m;
        if ((m = it.str.match(RE.score))) {
          row.score = Number(m[1]); row.avg = Number(m[2]);
          if (m[3]) row.sd = Number(m[3]);
        } else if ((m = it.str.match(RE.achieve)) && !row.achievement) {
          row.achievement = m[1];
          if (m[2]) row.students = Number(m[2]);
        } else if ((m = it.str.match(/^\((\d+)\)$/)) && row.students == null) {
          row.students = Number(m[1]); // 대입전형자료: 성취도 없이 (수강자수)만 표기
        } else if (RE.dist.test(it.str)) {
          row.distribution = it.str;
        } else if (/^[1-9]$/.test(it.str) && (row.achievement || row.students != null) && row.rank == null) {
          row.rank = Number(it.str);
        }
      }
      if (row.subject || row.group) rows.push(row);
    }
  }
  return rows;
}

function parseSeteukBlock(lineGroups, grade, kind, knownSubjects) {
  const norm = (s) => s.replace(/^\(\d학기\)/, "").replace(/\s/g, "");
  // 빈 줄 없이 바로 이어지는 "과목명:" 줄도 새 문단으로 인식 (성적표 과목명 또는 (n학기) 표기일 때)
  const startsSubject = (text) => {
    const m = text.match(RE.subjectPrefix);
    return !!m && (/^\(\d학기\)/.test(m[1]) || knownSubjects.has(norm(m[1])));
  };
  const paras = [];
  let cur = null; // 페이지가 바뀌어도 문단은 이어진다
  for (const g of lineGroups) {
    let prevY = null;
    g.lines.forEach((l, i) => {
      if (RE.none.test(l.text)) return;
      const gap = prevY == null ? 0 : l.y - prevY;
      prevY = l.y;
      // 페이지 첫 줄: 이전 페이지 마지막 줄이 문장으로 끝났다면 새 문단으로 본다
      const prevEnded = cur && /[.다]$/.test(cur.lines[cur.lines.length - 1].text.trim());
      const newPara = startsSubject(l.text) || (i === 0 ? paras.length === 0 || prevEnded : gap > 21);
      if (newPara || !cur) {
        cur = { lines: [l] };
        paras.push(cur);
      } else cur.lines.push(l);
    });
  }
  const entries = [];
  const labeledIdx = [];
  paras.forEach((p) => {
    const text = joinLines(p.lines);
    const m = text.match(RE.subjectPrefix);
    p.text = text;
    if (m && m[2]) { p.subject = m[1].trim(); p.body = m[2].trim(); }
  });
  let lastLabeled = -1;
  paras.forEach((p, i) => { if (p.subject) lastLabeled = i; });
  paras.forEach((p, i) => {
    if (p.subject) {
      entries.push({ grade, kind, subject: p.subject, text: p.body });
      labeledIdx.push(entries.length - 1);
    } else if (i > lastLabeled || !entries.length) {
      entries.push({ grade, kind, subject: "개인별 세특", text: p.text });
    } else {
      entries[entries.length - 1].text += " " + p.text;
    }
  });
  return entries;
}

function parseAcademic(chunks) {
  const grades = [];
  const seteuk = [];
  let grade = 0;
  let kind = "일반";
  let mode = null; // 'table' | 'seteuk'
  let groups = [];
  let headerItems = [];
  const flush = () => {
    if (mode === "table" && groups.length) grades.push(...parseTable(groups, kind, grade));
    if (mode === "seteuk" && groups.length) {
      const known = new Set(grades.map((g) => g.subject.replace(/\s/g, "")));
      seteuk.push(...parseSeteukBlock(groups, grade, kind, known));
    }
    groups = [];
    mode = null;
  };
  const pushLine = (page, line) => {
    let g = groups[groups.length - 1];
    if (!g || g.page !== page) {
      g = { page, lines: [], headerItems };
      groups.push(g);
    }
    g.lines.push(line);
  };
  for (const ch of chunks) {
    const lines = ch.lines;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const t = l.text.trim();
      let m;
      if ((m = t.match(RE.gradeHeader))) { flush(); grade = Number(m[1]); kind = "일반"; continue; }
      if ((m = t.match(RE.subTable)) && l.x < 60) {
        flush();
        const name = m[1].replace(/\s/g, "");
        kind = /진로선택/.test(name) ? "진로선택" : /체육/.test(name) ? "체육·예술" : name;
        continue;
      }
      const isTableHeader = l.items.some((x) => x.str === "교과") && l.items.some((x) => x.str === "과목");
      if (isTableHeader) {
        flush();
        mode = "table";
        headerItems = lines.filter((o) => Math.abs(o.y - l.y) <= 10).flatMap((o) => o.items);
        // 헤더 보조줄은 건너뜀
        while (i + 1 < lines.length && lines[i + 1].y - l.y <= 10) i++;
        continue;
      }
      if (mode === "table" && /^\(?[가-힣]*\)?$/.test(t) && lines[i + 1] && lines[i + 1].y - l.y <= 10 && lines[i + 1].items.some((x) => x.str === "교과")) continue;
      if (RE.seteukHeader.test(t.replace(/\s/g, "")) && /과\s*목/.test(t)) {
        if (mode === "seteuk") continue; // 페이지가 넘어가며 반복되는 머리줄
        flush();
        mode = "seteuk";
        continue;
      }
      if (/^이수학점\s*합계/.test(t)) { flush(); continue; }
      if (mode === "table") {
        // 페이지 상단에서 표 머리말 보조줄 건너뛰기
        if (/^(원점수|\(표준편차\)|\(수강자수\)|성취도별|분포비율|학점|수)$/.test(t)) continue;
        pushLine(ch.page, l);
      } else if (mode === "seteuk") {
        pushLine(ch.page, l);
      }
    }
  }
  flush();
  // 성적표 과목명 띄어쓰기를 세특 표기와 맞춤 (예: 음악 감상과비평 → 음악 감상과 비평)
  const names = new Map(seteuk.map((s) => [s.subject.replace(/^\(\d학기\)/, "").replace(/\s/g, ""), s.subject.replace(/^\(\d학기\)/, "")]));
  for (const g of grades) {
    const key = g.subject.replace(/\s/g, "");
    if (names.has(key)) g.subject = names.get(key);
  }
  return { grades, seteuk };
}

// ---------- 9. 행동특성 및 종합의견 ----------
function parseBehavior(chunks) {
  const out = [];
  for (const ch of chunks) {
    const header = ch.lines.find((l) => /행동특성및종합의견/.test(l.text.replace(/\s/g, "")) && /학년/.test(l.text));
    const body = ch.lines.filter((l) => !header || l.y > header.y + 2);
    if (!body.length) continue;
    const contentX = Math.min(...body.flatMap((l) => l.items.filter((i) => i.str.length > 3).map((i) => i.x)));
    const labels = [];
    const content = [];
    for (const l of body) {
      for (const it of l.items) if (it.x < contentX - 10 && /^[1-3]$/.test(it.str)) labels.push({ grade: Number(it.str), y: it.y });
      const c = l.items.filter((i) => i.x >= contentX - 10);
      if (c.length) content.push({ y: l.y, text: c.map((i) => i.str).join(" "), right: Math.max(...c.map((i) => i.x + i.w)) });
    }
    labels.sort((a, b) => a.y - b.y);
    const top = header ? header.y + 9 : body[0].y - 7;
    const bands = bandsFromCenteredLabels(labels, top);
    for (const b of bands) {
      const mine = content.filter((c) => c.y >= b.top - 1 && c.y < b.bottom - 1);
      const text = joinLines(mine);
      const prev = out.find((o) => o.grade === b.grade);
      if (prev) prev.text = (prev.text + " " + text).trim();
      else out.push({ grade: b.grade, text });
    }
    if (!labels.length && content.length && out.length) out[out.length - 1].text += " " + joinLines(content);
  }
  return out.filter((o) => o.text);
}

// ---------- 섹션 분리 ----------
function splitSections(pages) {
  const sec = { creative: [], academic: [], behavior: [] };
  let cur = null;
  for (const pg of pages) {
    const buckets = {};
    for (const l of pg.lines) {
      const t = l.text.trim();
      const flat = t.replace(/\s/g, "");
      const leftAligned = l.x < 80;
      if (leftAligned && RE.sec6.test(flat)) { cur = "creative"; continue; }
      if (RE.volunteer.test(t.replace(/\s/g, " ")) || /^봉사활동실적$/.test(flat)) { cur = null; continue; }
      if (leftAligned && RE.sec7.test(flat)) { cur = "academic"; continue; }
      if (leftAligned && RE.sec9.test(flat)) { cur = "behavior"; continue; }
      if (leftAligned && RE.otherSection.test(flat)) { cur = null; continue; }
      if (leftAligned && RE.anySection.test(t) && !/^\d+\.\d/.test(t)) {
        // 그 외 번호 섹션(8. 독서 등) 진입 → 수집 중단
        if (!/^[679]\./.test(t)) { cur = null; continue; }
      }
      if (!cur) continue;
      (buckets[cur] ||= []).push(l);
    }
    for (const [k, lines] of Object.entries(buckets)) sec[k].push({ page: pg.no, lines });
  }
  return sec;
}

// ---------- 공개 API ----------
export async function parseSaenggibu(pdfjsLib, data) {
  const pages = await loadPages(pdfjsLib, data);
  const sec = splitSections(pages);
  const stats = { masked: 0 };
  const creative = parseCreative(sec.creative).map((r) => ({ ...r, text: scrub(r.text, stats) }));
  const { grades, seteuk } = parseAcademic(sec.academic);
  const behavior = parseBehavior(sec.behavior).map((r) => ({ ...r, text: scrub(r.text, stats) }));
  const record = {
    creative,
    grades,
    seteuk: seteuk.map((s) => ({ ...s, text: scrub(s.text, stats) })),
    behavior,
    meta: { pages: pages.length, masked: stats.masked, warnings: [] },
  };
  if (!creative.length) record.meta.warnings.push("창의적 체험활동상황을 찾지 못했습니다.");
  if (!grades.length) record.meta.warnings.push("교과 성적표를 찾지 못했습니다.");
  if (!seteuk.length) record.meta.warnings.push("세부능력 및 특기사항을 찾지 못했습니다.");
  if (!behavior.length) record.meta.warnings.push("행동특성 및 종합의견을 찾지 못했습니다.");
  return record;
}

// LLM에 보낼 압축 텍스트 (6개 영역만, 개인 식별 정보 없음)
export function recordToText(r) {
  // MD·JSON·엑셀 등 영역 구조가 없는 파일은 내용을 그대로 쓴다
  const n = r.creative.length + r.grades.length + r.seteuk.length + r.behavior.length;
  if (!n && r.rawText) return r.rawText;
  const out = [];
  out.push("## 창의적 체험활동상황");
  for (const c of r.creative) {
    if (!c.text && !c.hope) continue;
    out.push(`[${c.grade}학년 ${c.area}${c.hours != null ? ` ${c.hours}시간` : ""}]${c.hope ? ` (희망분야: ${c.hope})` : ""}\n${c.text}`);
  }
  out.push("\n## 교과 성적");
  const byGrade = {};
  for (const g of r.grades) (byGrade[`${g.grade}학년 ${g.semester ?? "-"}학기`] ||= []).push(g);
  for (const [k, list] of Object.entries(byGrade)) {
    out.push(`[${k}] ` + list.map((g) => {
      const parts = [g.subject];
      if (g.score != null) parts.push(`${g.score}/${g.avg}${g.sd != null ? `(${g.sd})` : ""}`);
      if (g.achievement) parts.push(g.achievement + (g.students ? `(${g.students}명)` : ""));
      if (g.rank) parts.push(`${g.rank}등급`);
      if (g.kind !== "일반") parts.push(g.kind);
      return parts.join(" ");
    }).join(" | "));
  }
  out.push("\n## 세부능력 및 특기사항");
  for (const s of r.seteuk) out.push(`[${s.grade}학년 ${s.subject}] ${s.text}`);
  out.push("\n## 행동특성 및 종합의견");
  for (const b of r.behavior) out.push(`[${b.grade}학년] ${b.text}`);
  if (r.extraText) out.push("\n## 기타 자료", r.extraText);
  return out.join("\n");
}
