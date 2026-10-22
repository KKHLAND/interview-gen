// 스캔 PDF용 글자 인식(OCR) — tesseract.js로 이 브라우저 안에서만 처리한다 (이미지·결과를 서버로 보내지 않음)
// 페이지를 고해상도로 그린 뒤 인식한 줄 텍스트를 돌려준다. 6개 영역만 남기는 일은 parser.js(scanToRecord)가 한다.

// getWorker: tesseract 워커를 돌려주는 async 함수 — 스캔 페이지가 실제로 있을 때만 모델을 불러오도록 지연 생성
export function makeOcr(getWorker, { scale = 3, createCanvas, toImage = (c) => c } = {}) {
  return async (page) => {
    const worker = await getWorker();
    const vp = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
    const { data } = await worker.recognize(await toImage(canvas));
    return (data.text || "").split("\n");
  };
}
