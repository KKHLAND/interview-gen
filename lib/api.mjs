// 생기부 맞춤 면접 Lab — Gemini API 처리 (로컬 server.mjs와 Vercel api/[route].js가 공용으로 사용)
// - PDF 원본은 서버로 오지 않는다. 브라우저에서 6개 영역만 추출된 텍스트만 받는다.
// - 요청 본문은 저장·로그하지 않는다.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI, ApiError } from "@google/genai";
import { scrub } from "../public/parser.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try { process.loadEnvFile(path.join(root, ".env")); } catch { /* .env 없음 (Vercel은 환경 변수 사용) */ }

export const MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";

// 키 우선순위: 브라우저 설정 창에서 입력한 키(x-gemini-key 헤더) → 서버 .env 키
const clients = new Map();
function clientFor(key) {
  if (!key) return null;
  if (!clients.has(key)) {
    if (clients.size > 20) clients.clear();
    clients.set(key, new GoogleGenAI({ apiKey: key }));
  }
  return clients.get(key);
}
function keyFrom(req) {
  const h = String(req.headers["x-gemini-key"] || "").trim();
  return /^[\w.\-]{20,200}$/.test(h) ? h : API_KEY;
}

// ---------------- 프롬프트 ----------------
const COMPETENCIES = ["학업역량", "탐구역량", "진로·전공역량", "자기주도성", "창의·비판적 사고", "협력·공동체", "의사소통", "성찰·성장"];
const AREAS = ["자율활동", "동아리활동", "진로활동", "교과성적", "세부능력및특기사항", "행동특성및종합의견"];

const SYSTEM = `당신은 대한민국 주요 대학에서 학생부종합전형 서류평가와 면접을 20년 넘게 담당해 온 베테랑 입학사정관입니다.
원칙:
- 오직 제공된 학교생활기록부 6개 영역(자율·동아리·진로활동, 교과 성적, 세부능력 및 특기사항, 행동특성 및 종합의견)만 근거로 삼습니다. 기록에 없는 활동·수상·독서를 지어내지 않습니다.
- 학생은 '지원자'로 지칭하며, 이름·학교 등 개인정보를 추측하거나 언급하지 않습니다.
- 지원 대학·학과의 인재상과 전공 기초 역량 관점에서 평가합니다. 대학별 세부 사실이 불확실하면 단정하지 말고 일반적인 학과 평가 관점으로 서술합니다.
- 한국어로, 실제 면접장에서 쓰는 자연스러운 존댓말 문장으로 작성합니다.`;

function targetLine(t = {}) {
  const parts = [t.university && `대학: ${t.university}`, t.major && `학과(모집단위): ${t.major}`, t.track && `계열: ${t.track}`, t.mode && `면접 유형: ${t.mode}`].filter(Boolean);
  return parts.length ? parts.join(" / ") : "지원 학과 미정 (생기부의 진로 희망을 기준으로 판단)";
}

const reviewSchema = {
  type: "object",
  properties: {
    studentType: { type: "string", description: "지원자를 한 줄로 규정하는 유형 (예: 데이터로 환경 문제를 푸는 탐구형)" },
    summary: { type: "string", description: "입학사정관 총평 3~4문장" },
    keywords: { type: "array", items: { type: "string" }, description: "생기부 핵심 키워드 6~10개" },
    majorFit: {
      type: "object",
      properties: { score: { type: "integer", minimum: 0, maximum: 100 }, comment: { type: "string" } },
      required: ["score", "comment"],
    },
    competencies: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string", enum: COMPETENCIES }, score: { type: "integer", minimum: 0, maximum: 100 }, comment: { type: "string" } },
        required: ["name", "score", "comment"],
      },
    },
    areas: {
      type: "array",
      items: {
        type: "object",
        properties: {
          area: { type: "string", enum: AREAS },
          rating: { type: "integer", minimum: 1, maximum: 5 },
          summary: { type: "string" },
          highlights: { type: "array", items: { type: "string" }, description: "면접에서 강점으로 살릴 기록 (짧게)" },
          concerns: { type: "array", items: { type: "string" }, description: "면접관이 의문을 가질 지점" },
        },
        required: ["area", "rating", "summary", "highlights", "concerns"],
      },
    },
    gradeTrend: { type: "string", description: "학기별 성적 추이와 전공 관련 과목 성취에 대한 해석" },
    strengths: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" }, description: "면접에서 압박 질문이 들어올 약점" },
    strategy: { type: "array", items: { type: "string" }, description: "면접 대비 전략 3~5개" },
  },
  required: ["studentType", "summary", "keywords", "majorFit", "competencies", "areas", "gradeTrend", "strengths", "risks", "strategy"],
};

const questionItem = {
  type: "object",
  properties: {
    category: { type: "string", enum: [...COMPETENCIES, "기본·공통"] },
    area: { type: "string", enum: [...AREAS, "종합"] },
    source: { type: "string", description: "근거 위치 (예: 2학년 화학Ⅰ 세특, 1학년 동아리활동)" },
    evidence: { type: "string", description: "근거가 된 생기부 원문 구절 (40자 이내 발췌)" },
    question: { type: "string" },
    intent: { type: "string", description: "입학사정관의 출제 의도 — 무엇을 확인하려는가" },
    difficulty: { type: "integer", minimum: 1, maximum: 5 },
    answerGuide: { type: "array", items: { type: "string" }, description: "답변에 꼭 들어가야 할 핵심 포인트 3개" },
    sampleAnswer: { type: "string", description: "지원자 1인칭 모범 답변 (생기부 기록 범위 안에서 구체적으로, 300~450자)" },
    followUps: { type: "array", items: { type: "string" }, description: "심층 꼬리질문" },
  },
  required: ["category", "area", "source", "evidence", "question", "intent", "difficulty", "answerGuide", "sampleAnswer", "followUps"],
};
const questionsSchema = { type: "object", properties: { questions: { type: "array", items: questionItem } }, required: ["questions"] };

const feedbackSchema = {
  type: "object",
  properties: {
    score: { type: "integer", minimum: 0, maximum: 100 },
    grade: { type: "string", enum: ["S", "A", "B", "C", "D"] },
    oneLine: { type: "string", description: "한 줄 총평" },
    strengths: { type: "array", items: { type: "string" } },
    improvements: { type: "array", items: { type: "string" } },
    evidenceUse: { type: "string", description: "생기부 기록을 근거로 잘 활용했는지 평가" },
    revisedAnswer: { type: "string", description: "지원자 답변을 살려 다듬은 개선 답변" },
    followUp: { type: "string", description: "이 답변을 들은 면접관이 이어서 던질 질문" },
  },
  required: ["score", "grade", "oneLine", "strengths", "improvements", "evidenceUse", "revisedAnswer", "followUp"],
};

function questionsPrompt(record, body) {
  const count = Math.min(Math.max(Number(body.count) || 30, 5), 50);
  const focus = Array.isArray(body.focus) && body.focus.length ? body.focus.join(", ") : "8대 평가요소 균형";
  const depth = Number(body.followDepth) || 2;
  return `[지원 정보] ${targetLine(body.target)}
[중심 평가요소] ${focus}

다음 생기부를 읽고 지원 학과 맞춤형 면접 예상 질문 ${count}개를 만드세요.

출제 규칙
1. 모든 질문은 생기부의 구체적 기록(활동명, 탐구 주제, 읽은 자료, 실험, 역할 등)을 직접 짚어야 합니다. evidence에는 근거 원문을 짧게 발췌합니다.
2. 영역 배분: 세부능력및특기사항 약 40%, 창체(자율·동아리·진로) 약 35%, 행동특성및종합의견 약 10%, 교과성적 약 10%, 종합(지원동기·학업계획 등) 약 5%.${body.includeBasic === false ? " (단, 기본·공통 질문은 제외)" : ""}
3. 지원 학과와의 연결을 묻는 질문을 충분히 포함하고, 전공 기초 개념을 확인하는 심층 질문도 넣습니다.
4. 성적이 낮거나 하락한 과목, 희망 진로가 바뀐 흔적, 활동 간 연결이 약한 부분 등 약점을 확인하는 압박 질문도 2~4개 포함합니다.
5. 난이도(1~5)를 고르게 분포시키고, 같은 활동을 반복해서 묻지 않습니다.
6. 꼬리질문은 질문마다 ${depth}개, 앞선 답변을 파고드는 순서로 작성합니다.
7. 모범 답변은 지원자의 1인칭 말투로, 기록에 있는 사실만 사용하고 결론-근거-배운 점-전공 연결 구조로 작성합니다.
8. 질문 배열은 면접 흐름(도입 → 핵심 활동 → 전공 심층 → 인성 → 마무리) 순서로 정렬합니다.

[학교생활기록부 — 6개 영역 발췌]
${record}`;
}

// ---------------- Gemini 호출 ----------------
function genConfig(schema, extra = {}) {
  return {
    systemInstruction: SYSTEM,
    responseMimeType: "application/json",
    responseJsonSchema: schema,
    maxOutputTokens: 65536,
    ...extra,
  };
}

async function generateJSON(ai, prompt, schema, extra) {
  const res = await ai.models.generateContent({ model: MODEL, contents: prompt, config: genConfig(schema, extra) });
  return parseJSON(res.text);
}

function parseJSON(text) {
  const t = (text || "").trim();
  try { return JSON.parse(t); } catch { /* 코드펜스 등 제거 후 재시도 */ }
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/) || t.match(/(\{[\s\S]*\})/);
  if (m) return JSON.parse(m[1]);
  throw new Error("AI 응답을 해석하지 못했습니다.");
}

// ---------------- 라우트 ----------------
const routes = {
  "GET /api/health": async () => ({ ok: true, model: MODEL, keyConfigured: !!API_KEY }),

  // 연결 테스트: 아주 짧은 생성 요청으로 키·모델·할당량을 한 번에 확인
  "POST /api/test-key": async (b, ai, req) => {
    const key = String(b.key || "").trim();
    const client = key ? clientFor(key) : ai;
    if (!client) throw httpError(400, "테스트할 API 키가 없습니다.");
    const t0 = Date.now();
    const res = await client.models.generateContent({ model: MODEL, contents: "연결 테스트입니다. 'OK'라고만 답하세요.", config: { maxOutputTokens: 256 } });
    return { ok: true, model: MODEL, modelVersion: res.modelVersion || MODEL, ms: Date.now() - t0, source: key ? "browser" : keyFrom(req) === API_KEY ? "server" : "browser", reply: (res.text || "").trim().slice(0, 40) };
  },

  "POST /api/review": async (b, ai) => {
    const prompt = `[지원 정보] ${targetLine(b.target)}

입학사정관 관점에서 아래 생기부를 6개 영역별로 평가하고, 8대 평가요소(${COMPETENCIES.join(", ")}) 점수와 지원 학과 적합도를 산출하세요. 점수는 상대적으로 엄정하게 매기고, 근거는 기록에서 찾으세요.

[학교생활기록부 — 6개 영역 발췌]
${b.record}`;
    return generateJSON(ai, prompt, reviewSchema);
  },

  "POST /api/question": async (b, ai) => {
    const q = b.question || {};
    const how = b.instruction ? `사용자 요청: "${String(b.instruction).slice(0, 500)}"` : "같은 근거를 다른 각도에서 묻는 새로운 질문으로 바꾸세요. 기존 질문과 겹치지 않게 하세요.";
    const prompt = `[지원 정보] ${targetLine(b.target)}

아래 기존 면접 질문을 수정합니다. ${how}
꼬리질문은 ${Number(b.followDepth) || 2}개, 출력은 질문 1개입니다.

[기존 질문] ${JSON.stringify({ category: q.category, area: q.area, source: q.source, question: q.question })}
[이미 생성된 다른 질문들 — 중복 금지]
${(b.others || []).slice(0, 60).map((s) => "- " + s).join("\n")}

[학교생활기록부 — 6개 영역 발췌]
${b.record}`;
    return generateJSON(ai, prompt, questionItem);
  },

  "POST /api/feedback": async (b, ai) => {
    const prompt = `[지원 정보] ${targetLine(b.target)}

모의 면접입니다. 아래 질문에 대한 지원자의 실제 답변을 입학사정관으로서 평가하세요. 구체성, 생기부 근거 활용, 전공 연결, 논리 구조, 진정성을 봅니다. 답변이 짧거나 비어 있으면 엄정하게 평가합니다.

[질문] ${b.question}
[출제 의도] ${b.intent || "-"}
[지원자 답변] ${String(b.answer || "").slice(0, 4000) || "(무응답)"}

[학교생활기록부 — 6개 영역 발췌]
${b.record}`;
    return generateJSON(ai, prompt, feedbackSchema);
  },

  "POST /api/university": async (b, ai) => {
    const t = b.target || {};
    if (!t.university && !t.major) throw httpError(400, "대학 또는 학과를 입력하세요.");
    const prompt = `${t.university || ""} ${t.major || ""} 학생부종합전형 면접 준비를 위해 최신 공식 정보를 검색해 정리하세요.
반드시 아래 JSON 형식 하나만 \`\`\`json 코드블록으로 출력합니다. 확인되지 않은 항목은 "확인 필요"라고 적습니다.
{"university":"","major":"","overview":"학과 소개 2~3문장","talent":["인재상/평가 키워드"],"evaluation":["서류·면접 평가요소와 반영 방식"],"interview":["면접 형식(시간, 제시문 여부, 방식 등)"],"curriculum":["주요 전공 교과목"],"related":["고교 권장/연계 과목"],"tips":["이 학과 면접 대비 팁"]}`;
    const res = await ai.models.generateContent({
      model: MODEL,
      contents: prompt,
      config: { tools: [{ googleSearch: {} }], maxOutputTokens: 8192 },
    });
    let data;
    try { data = parseJSON(res.text); } catch { data = { overview: res.text }; }
    const chunks = res.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    const seen = new Set();
    data.sources = chunks
      .map((c) => c.web)
      .filter((w) => w?.uri && !seen.has(w.uri) && seen.add(w.uri))
      .slice(0, 8)
      .map((w) => ({ title: w.title || w.uri, uri: w.uri }));
    return data;
  },
};

// 질문 대량 생성은 스트리밍(NDJSON)으로 진행 상황을 보낸다
async function streamQuestions(b, res, ai) {
  res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" });
  const send = (o) => res.write(JSON.stringify(o) + "\n");
  try {
    const stream = await ai.models.generateContentStream({ model: MODEL, contents: questionsPrompt(b.record, b), config: genConfig(questionsSchema) });
    let text = "";
    let last = 0;
    for await (const chunk of stream) {
      text += chunk.text || "";
      const n = (text.match(/"sampleAnswer"\s*:/g) || []).length;
      if (n !== last) { last = n; send({ type: "progress", count: n }); }
    }
    const data = parseJSON(text);
    send({ type: "done", questions: data.questions || [] });
  } catch (e) {
    send({ type: "error", message: errorMessage(e) });
  }
  res.end();
}

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
function errorMessage(e) {
  if (e instanceof ApiError) {
    const m = String(e.message || "");
    if (/API[_ ]?key|API_KEY_INVALID|credential|unauthenticated/i.test(m)) return "API 키가 올바르지 않습니다. 키를 다시 복사해 붙여넣었는지 확인하세요.";
    if (/billing|FAILED_PRECONDITION/i.test(m)) return "이 키의 프로젝트에서 Gemini API를 쓸 수 없습니다. AI Studio에서 결제 또는 프로젝트 설정을 확인하세요.";
    if (/location|region/i.test(m)) return "현재 지역에서 이 모델을 사용할 수 없습니다.";
    if (e.status === 400) return "요청이 거부되었습니다 (400). 모델 이름이나 입력을 확인하세요.";
    if (e.status === 401 || e.status === 403) return "Gemini API 키가 올바르지 않거나 권한이 없습니다.";
    if (e.status === 404) return `모델(${MODEL})을 찾을 수 없습니다. GEMINI_MODEL 설정을 확인하세요.`;
    if (e.status === 429) return "요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.";
    if (e.status >= 500) return "Gemini 서버가 일시적으로 응답하지 않습니다. 잠시 후 다시 시도하세요.";
  }
  return e.message || "알 수 없는 오류";
}

// ---------------- 요청 처리 ----------------
function readBody(req) {
  const clean = (body) => {
    // 2차 방어: 서버에서도 개인정보 패턴 마스킹
    if (body && typeof body.record === "string") body.record = scrub(body.record).slice(0, 120_000);
    return body || {};
  };
  // Vercel 런타임은 JSON 본문을 req.body로 미리 파싱해 준다
  if (req.body !== undefined) {
    try { return Promise.resolve(clean(typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body)); }
    catch { return Promise.reject(httpError(400, "잘못된 JSON")); }
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 2_000_000) { reject(httpError(413, "요청이 너무 큽니다.")); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(clean(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"))); }
      catch { reject(httpError(400, "잘못된 JSON")); }
    });
    req.on("error", reject);
  });
}

export const hasServerKey = !!API_KEY;

export async function handleApi(req, res) {
  const url = new URL(req.url, "http://localhost");
  const key = `${req.method} ${url.pathname}`;
  const json = (status, obj) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(obj));
  };
  try {
    const ai = clientFor(keyFrom(req));
    const keyless = key === "GET /api/health" || key === "POST /api/test-key";
    if (!keyless && !ai) return json(401, { error: "Gemini API 키가 없습니다. 오른쪽 위 ‘API 키’에서 설정하세요.", needKey: true });
    if (key === "POST /api/questions") return await streamQuestions(await readBody(req), res, ai);
    const handler = routes[key];
    if (!handler) return json(404, { error: "not found" });
    const body = req.method === "POST" ? await readBody(req) : {};
    if (req.method === "POST" && !keyless && key !== "POST /api/university" && !body.record) return json(400, { error: "생기부 데이터가 없습니다." });
    return json(200, await handler(body, ai, req));
  } catch (e) {
    if (!res.headersSent) json(e.status || 500, { error: errorMessage(e) });
    else res.end();
  }
}


