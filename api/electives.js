'use strict';

/**
 * GET /api/electives          -> 2·3학년 선택과목 블록 배치와 강의실
 * GET /api/electives?grade=2  -> 해당 학년만
 *
 * 강의실은 '실제 수업이 운영되는 강의실' 을 기준으로 내려보냅니다.
 * 컴시간에 찍힌 강의실은 참고용으로 컴시간강의실 에 함께 담습니다.
 */

const { baseData } = require('./_lib');
const { sendJson, handler } = require('./_http');

module.exports = handler(async (req, res) => {
  const grade = (req.query && req.query.grade) ? String(req.query.grade) : null;
  const all = baseData.electives;

  const pick = (g) => {
    const e = all[g];
    if (!e) return null;
    let diff = 0, total = 0;
    Object.values(e.강좌 || {}).forEach((subs) => Object.values(subs).forEach((c) => {
      total += 1; if (c.다름) diff += 1;
    }));
    return {
      학년: Number(g),
      블록배치: e.블록배치,     // 요일(0=월) -> 교시 -> 블록
      특수: e.특수,             // 창체 등
      강좌: e.강좌,             // 블록 -> 과목 -> { 강의실, 컴시간강의실, 정원, 다름 }
      과목목록: e.과목목록,
      강좌수: total,
      강의실다른강좌수: diff,
    };
  };

  if (grade) {
    const one = pick(grade);
    if (!one) {
      sendJson(res, 404, { ok: false, error: `${grade}학년은 선택과목 이동수업이 없습니다.` });
      return;
    }
    sendJson(res, 200, { ok: true, ...one }, 3600);
    return;
  }

  sendJson(res, 200, {
    ok: true,
    안내: '강의실은 실제 수업이 운영되는 곳 기준입니다. 컴시간 화면과 다를 수 있습니다.',
    학년: Object.keys(all).map(Number).sort((a, b) => a - b),
    데이터: Object.fromEntries(Object.keys(all).map((g) => [g, pick(g)])),
  }, 3600);
});
