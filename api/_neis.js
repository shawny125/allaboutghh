'use strict';

/**
 * 나이스(NEIS) 교육정보 개방 포털 연동 — 급식 식단
 *
 *  - 학교 행정표준코드는 학교명으로 자동 조회해서 기억합니다.
 *  - 인증키가 없어도 동작하지만, 요청 수 제한이 있으므로
 *    open.neis.go.kr 에서 무료로 발급받아 넣는 것을 권합니다.
 *      · data/config.json 의 neis.인증키
 *      · 또는 환경변수 NEIS_KEY (이쪽이 우선, 저장소에 키가 안 남습니다)
 */

const config = require('../data/config.json');

const HOST = 'https://open.neis.go.kr/hub';
const NEIS = config.neis || {};
const REGION = NEIS.시도교육청코드 || 'E10';          // E10 = 인천광역시교육청
const SCHOOL_NAME = NEIS.학교명 || config.schoolName;
const CACHE_MS = Math.max(1, Number(NEIS.캐시분) || 180) * 60 * 1000;

// 식품알레르기 유발 식재료 (교육부 표시 기준)
const ALLERGY = {
  1: '난류', 2: '우유', 3: '메밀', 4: '땅콩', 5: '대두', 6: '밀', 7: '고등어',
  8: '게', 9: '새우', 10: '돼지고기', 11: '복숭아', 12: '토마토', 13: '아황산류',
  14: '호두', 15: '닭고기', 16: '쇠고기', 17: '오징어', 18: '조개류', 19: '잣',
};

let _schoolCode = NEIS.학교코드 || null;
const _cache = new Map();   // 날짜 -> { at, data }

function apiKey() {
  return process.env.NEIS_KEY || NEIS.인증키 || '';
}

async function getJson(path, params) {
  const q = new URLSearchParams();

  const key = apiKey();
  if (key) q.set("KEY", key);

  q.set("Type", "json");
  q.set("pIndex", "1");
  q.set("pSize", "100");

  for (const [name, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== "") {
      q.set(name, String(value));
    }
  }

  const url = `${HOST}/${path}?${q.toString()}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);

  try {
    const response = await fetch(url, {
      signal: ctrl.signal,
      cache: "no-store",
      headers: {
        Accept: "application/json, text/plain, */*",
        "User-Agent": "Mozilla/5.0 (compatible; AllAboutGonghang/1.0)",
      },
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(
        `나이스 응답 오류 (${response.status})${
          text ? `: ${text.slice(0, 200)}` : ""
        }`
      );
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`나이스 응답 해석 오류: ${text.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
/** 나이스 응답에서 결과 코드와 row 목록을 꺼낸다 */
function unwrap(json, name) {
  // 데이터가 없을 때는 최상위에 RESULT 만 온다
  if (json && json.RESULT) {
    return { code: json.RESULT.CODE, message: json.RESULT.MESSAGE, rows: [] };
  }
  const box = json && json[name];
  if (!Array.isArray(box)) return { code: 'UNKNOWN', message: '알 수 없는 응답', rows: [] };

  let code = 'INFO-000';
  let message = '';
  let rows = [];
  box.forEach((part) => {
    if (part && Array.isArray(part.head)) {
      part.head.forEach((h) => {
        if (h && h.RESULT) { code = h.RESULT.CODE; message = h.RESULT.MESSAGE; }
      });
    }
    if (part && Array.isArray(part.row)) rows = part.row;
  });
  return { code, message, rows };
}

/** 학교명으로 행정표준코드 찾기 (한 번만) */
async function schoolCode() {
  if (_schoolCode) return _schoolCode;
  const json = await getJson('schoolInfo', {
    ATPT_OFCDC_SC_CODE: REGION,
    SCHUL_NM: SCHOOL_NAME,
  });
  const { rows, message } = unwrap(json, 'schoolInfo');
  if (!rows.length) throw new Error(`나이스에서 '${SCHOOL_NAME}' 을 찾지 못했습니다. ${message || ''}`.trim());
  const exact = rows.find((r) => String(r.SCHUL_NM).trim() === SCHOOL_NAME) || rows[0];
  _schoolCode = exact.SD_SCHUL_CODE;
  return _schoolCode;
}

/** '차조밥<br/>쇠고기미역국 (5.16)' -> [{ 이름, 알레르기: [..] }] */
function parseDishes(raw) {
  return String(raw || '')
    .split(/<br\s*\/?>/i)
    .map((s) => s.replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((line) => {
      const nums = [];
      const name = line.replace(/\(([\d.\s,]+)\)\s*$/, (m, g) => {
        String(g).split(/[.,\s]+/).forEach((n) => {
          const v = Number(n);
          if (v >= 1 && v <= 19) nums.push(v);
        });
        return '';
      }).trim();
      return {
        이름: name || line,
        알레르기: [...new Set(nums)].sort((a, b) => a - b),
      };
    })
    .filter((d) => d.이름);
}

const MEAL_ORDER = { 조식: 1, 중식: 2, 석식: 3 };

/** 하루치 급식 (조·중·석식) */
async function meals(ymd) {
  const hit = _cache.get(ymd);
  if (hit && Date.now() - hit.at < CACHE_MS) return { ...hit.data, cache: 'hit' };

  const code = await schoolCode();
  const json = await getJson('mealServiceDietInfo', {
    ATPT_OFCDC_SC_CODE: REGION,
    SD_SCHUL_CODE: code,
    MLSV_YMD: ymd,
  });
  const { code: rc, message, rows } = unwrap(json, 'mealServiceDietInfo');

  const list = rows.map((r) => ({
    구분: r.MMEAL_SC_NM || '급식',
    메뉴: parseDishes(r.DDISH_NM),
    칼로리: (r.CAL_INFO || '').trim() || null,
    원산지: (r.ORPLC_INFO || '').replace(/<br\s*\/?>/gi, ', ').trim() || null,
  })).sort((a, b) => (MEAL_ORDER[a.구분] || 9) - (MEAL_ORDER[b.구분] || 9));

  const data = {
    날짜: ymd,
    급식: list,
    안내: list.length ? null : (message || '이 날짜의 급식 정보가 없습니다.'),
    결과코드: rc,
  };
  _cache.set(ymd, { at: Date.now(), data });
  return { ...data, cache: 'miss' };
}

module.exports = { meals, schoolCode, parseDishes, ALLERGY, REGION, SCHOOL_NAME, apiKey };
