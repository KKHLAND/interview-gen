// Vercel 서버리스 함수: /api/health, /api/review, /api/questions(스트리밍) 등 모든 API를 처리
import { handleApi } from "../lib/api.mjs";

export default function handler(req, res) {
  return handleApi(req, res);
}
