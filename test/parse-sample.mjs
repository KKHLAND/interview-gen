// 사용법: node test/parse-sample.mjs <생기부.pdf> [금지어1,금지어2,...]
// 금지어(학생 이름, 학교명 등)가 파싱 결과에 하나라도 남아 있으면 실패한다.
import fs from "node:fs";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { parseSaenggibu, recordToText } from "../public/parser.js";

const [file, banned = ""] = process.argv.slice(2);
if (!file) {
  console.error("usage: node test/parse-sample.mjs <pdf> [banned,words]");
  process.exit(2);
}
const record = await parseSaenggibu(pdfjsLib, new Uint8Array(fs.readFileSync(file)));
const short = (s, n = 70) => (s.length > n ? s.slice(0, n) + "…" : s);

console.log("== 창체", record.creative.length);
for (const c of record.creative) console.log(` ${c.grade}학년 ${c.area} ${c.hours}h hope=${c.hope} | ${short(c.text)} … ${c.text.slice(-25)}`);
console.log("== 성적", record.grades.length);
for (const g of record.grades) console.log(` ${g.grade}-${g.semester} [${g.kind}] ${g.group} / ${g.subject} ${g.credits}학점 ${g.score ?? ""}/${g.avg ?? ""}(${g.sd ?? ""}) ${g.achievement ?? ""}(${g.students ?? ""}) ${g.rank ?? ""} ${g.distribution ?? ""}`);
console.log("== 세특", record.seteuk.length);
for (const s of record.seteuk) console.log(` ${s.grade}학년 [${s.kind}] ${s.subject} | ${short(s.text, 50)} … ${s.text.slice(-20)}`);
console.log("== 행특", record.behavior.length);
for (const b of record.behavior) console.log(` ${b.grade}학년 | ${short(b.text)} … ${b.text.slice(-20)}`);
console.log("== meta", record.meta);

const all = JSON.stringify(record) + recordToText(record);
const leaks = banned.split(",").filter(Boolean).filter((w) => all.includes(w));
if (leaks.length) {
  console.error("PRIVACY FAIL: found", leaks.length, "banned term(s) in output");
  process.exit(1);
}
console.log(`privacy check: ${banned ? "PASS" : "skipped"} · prompt chars=${recordToText(record).length}`);
