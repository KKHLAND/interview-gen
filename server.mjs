// 생기부 맞춤 면접 Lab — 로컬 실행용 서버 (정적 파일 + /api/*)
// Vercel 배포에서는 public/이 정적 파일로, api/[route].js가 함수로 동작한다.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleApi, MODEL, hasServerKey } from "./lib/api.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5178);
const PUBLIC = path.join(here, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };
// npm run build 없이도 로컬에서 pdf.js를 쓸 수 있도록 node_modules에서 바로 제공
const STATIC = {
  "/vendor/pdf.min.mjs": path.join(here, "node_modules/pdfjs-dist/build/pdf.min.mjs"),
  "/vendor/pdf.worker.min.mjs": path.join(here, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs"),
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/api/")) return handleApi(req, res);
  let file = STATIC[url.pathname];
  if (!file) {
    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
    file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(data);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`생기부 맞춤 면접 Lab → http://localhost:${PORT}  (model: ${MODEL}${hasServerKey ? ", 서버 키 사용" : ", 브라우저에서 API 키 설정 필요"})`);
});
