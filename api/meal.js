'use strict';

/**
 * GET /api/meal              -> 오늘(한국시간) 급식
 * GET /api/meal?date=20260901 -> 특정 날짜
 */

const neis = require('./_neis');
const { kstNow } = require('./_lib');
const { sendJson, handler } = require('./_http');

module.exports = handler(async (req, res) => {
  const q = req.query || {};
  const ymd = /^\d{8}$/.test(String(q.date || ''))
    ? String(q.date)
    : kstNow().date.replace(/-/g, '');

  try {
    const m = await neis.meals(ymd);
    const used = new Set();
    m.급식.forEach((meal) => meal.메뉴.forEach((d) => d.알레르기.forEach((n) => used.add(n))));

    sendJson(res, 200, {
      ok: true,
      날짜: ymd,
      급식: m.급식,
      안내: m.안내,
      알레르기표: Object.fromEntries([...used].sort((a, b) => a - b).map((n) => [n, neis.ALLERGY[n]])),
      인증키사용: Boolean(neis.apiKey()),
    }, 1800);
  } catch (err) {
    // 급식을 못 가져와도 앱의 나머지는 멀쩡해야 하므로 200 으로 조용히 알린다
    sendJson(res, 200, {
      ok: false,
      날짜: ymd,
      급식: [],
      안내: err.message,
      인증키사용: Boolean(neis.apiKey()),
    });
  }
});
