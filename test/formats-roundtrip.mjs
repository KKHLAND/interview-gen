// 사용법: node test/formats-roundtrip.mjs [생기부.pdf]
// PDF(없으면 예시 데이터) → MD → JSON 왕복 변환 뒤 내용이 그대로인지, 마스킹이 적용되는지 확인한다.
import fs from "node:fs";
import { recordToMarkdown, markdownToRecord, recordToJSON, jsonToRecord, recordCount } from "../public/formats.js";
import { recordToText } from "../public/parser.js";

let rec;
const file = process.argv[2];
if (file) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { parseSaenggibu } = await import("../public/parser.js");
  rec = await parseSaenggibu(pdfjsLib, new Uint8Array(fs.readFileSync(file)));
} else {
  rec = {
    creative: [{ grade: 1, area: "자율활동", hours: 12, hope: "환경공학", text: "학급 회의에서 | 기후 문제를 제기함." }],
    grades: [{ grade: 1, semester: 1, kind: "일반", group: "국어", subject: "국어", credits: 4, score: 92, avg: 71.2, sd: 15.3, achievement: "A", students: 210, rank: 2 }],
    seteuk: [{ grade: 2, kind: "진로선택", subject: "물리학Ⅱ", text: "역학 탐구. 연락처 010-1234-5678" }],
    behavior: [{ grade: 1, text: "성실함." }],
    meta: { pages: 1, masked: 0, warnings: [] },
  };
}

const body = (r) => JSON.stringify({ c: r.creative, g: r.grades, s: r.seteuk, b: r.behavior });
const fromMd = markdownToRecord(recordToMarkdown(rec));
const fromJson = jsonToRecord(recordToJSON(fromMd));
let fail = 0;
const check = (name, ok) => { console.log(`${ok ? "PASS" : "FAIL"} ${name}`); if (!ok) fail++; };
check("MD 왕복 후 항목 수 유지", recordCount(fromMd) === recordCount(rec));
check("MD → JSON 왕복 내용 동일", body(fromMd) === body(fromJson));
check("MD 왕복 후 AI 전송 텍스트 동일", recordToText(fromJson).replace(/\[전화번호 삭제\]/g, "") === recordToText(rec).replace(/010-1234-5678|\[전화번호 삭제\]/g, ""));
if (!file) check("불러올 때 개인정보 패턴 마스킹", !JSON.stringify(fromJson).includes("010-1234-5678"));
check("앱 형식이 아닌 MD는 자유 텍스트로", markdownToRecord("# 메모\n내용").rawText === "# 메모\n내용");
process.exit(fail ? 1 : 0);
