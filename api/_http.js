'use strict';

function applyCors(res) {
  // 테스트 단계에서는 어디서든 부를 수 있게 열어둡니다.
  // 공개 배포 시에는 '*' 대신 실제 도메인으로 바꾸세요.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res, status, body, cacheSeconds) {
  applyCors(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (cacheSeconds) {
    res.setHeader('Cache-Control', `public, s-maxage=${cacheSeconds}, stale-while-revalidate=600`);
  } else {
    res.setHeader('Cache-Control', 'no-store');
  }
  res.status(status).send(JSON.stringify(body));
}

/** 공통 래퍼: OPTIONS 처리, 예외를 JSON 오류로 변환 */
function handler(fn) {
  return async (req, res) => {
    if (req.method === 'OPTIONS') {
      applyCors(res);
      res.status(204).end();
      return;
    }
    try {
      await fn(req, res);
    } catch (err) {
      sendJson(res, 500, {
        ok: false,
        error: err && err.message ? err.message : String(err),
        hint: '컴시간 응답 구조가 바뀌었거나 서버에 접속하지 못했을 수 있습니다. /api/school 로 학교 조회부터 확인해 보세요.',
      });
    }
  };
}

module.exports = { sendJson, applyCors, handler };
