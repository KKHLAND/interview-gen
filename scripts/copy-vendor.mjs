// 배포용: pdf.js 브라우저 파일을 public/vendor로 복사 (Vercel 정적 파일로 제공)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "public", "vendor");
fs.mkdirSync(out, { recursive: true });
for (const f of ["pdf.min.mjs", "pdf.worker.min.mjs"]) {
  fs.copyFileSync(path.join(root, "node_modules", "pdfjs-dist", "build", f), path.join(out, f));
  console.log("copied", f);
}
