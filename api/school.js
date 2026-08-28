'use strict';

/**
 * GET /api/school
 * 연결 점검용. 컴시간에서 학교가 검색되는지, 어떤 코드로 붙었는지 확인합니다.
 * 배포 후 가장 먼저 열어봐야 하는 주소입니다.
 */

const config = require('../data/config.json');
const { sendJson, handler } = require('./_http');

module.exports = handler(async (req, res) => {
  const q = (req.query && req.query.q) || config.schoolName;

  let Timetable;
  try {
    // eslint-disable-next-line global-require
    Timetable = require('comcigan-parser');
  } catch (e) {
    sendJson(res, 200, {
      ok: false,
      오류: 'comcigan-parser 를 불러오지 못했습니다.',
      안내: 'npm install 을 실행했는지 확인하세요. 이 상태에서도 시간표는 학교 기초시간표로 표시됩니다.',
    });
    return;
  }
  const inst = new Timetable();
  await inst.init({ maxGrade: Number(config.maxGrade) || 3 });

  let results = [];
  let searchError = null;
  try {
    results = (await inst.search(q)) || [];
  } catch (err) {
    searchError = err.message;
  }

  const hint = Number(config.schoolCodeHint) || null;
  const codeMatch = hint ? results.find((s) => Number(s.code) === hint) : null;

  sendJson(res, 200, {
    ok: true,
    검색어: q,
    설정된_학교코드: hint,
    검색결과: results.map((s) => ({
      이름: s.name,
      지역: s.region,
      코드: s.code,
      설정코드와_일치: hint ? Number(s.code) === hint : null,
    })),
    코드로_찾은_학교: codeMatch ? codeMatch.name : null,
    검색오류: searchError,
    안내: results.length
      ? '검색결과에서 우리 학교를 찾고, 그 코드가 data/config.json 의 schoolCodeHint 와 같은지 확인하세요. 다르면 config 의 값을 검색결과의 코드로 바꾸면 됩니다.'
      : '검색이 되지 않으면 config.json 의 schoolName 을 "인천공항고등학교" 처럼 정식 명칭으로 바꿔 다시 시도해 보세요.',
  });
});
