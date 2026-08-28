'use strict';

/**
 * 컴시간 연동 공용 모듈
 *  - 파서 초기화 / 학교 코드 확인
 *  - 시간표 조회 + 캐싱 + 실패 시 마지막 성공 데이터 폴백
 *  - 한국 시간 기준 '현재 교시' 계산
 *  - 마스킹된 교사명 -> 실명 변환
 */

const config = require('../data/config.json');
const teacherMapFile = require('../data/teacher-map.json');
const baseData = require('./_base');

const TEACHER_MAP = (teacherMapFile && teacherMapFile.map) || {};

// ---------------------------------------------------------------- 캐시 상태
let _instance = null;      // 파서 인스턴스 (초기화 1회)
let _cache = null;         // { at: epochMs, payload }
let _lastGood = null;      // 마지막으로 성공한 payload (파싱 실패 시 폴백용)
let _inflight = null;      // 동시 요청 합치기

const CACHE_MS = Math.max(1, Number(config.cacheMinutes) || 20) * 60 * 1000;

// ---------------------------------------------------------------- 시간 유틸
/** 한국 시간 기준 현재 시각 정보 */
function kstNow(date) {
  const d = date || new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'short', hour12: false,
  }).formatToParts(d).reduce((acc, p) => (acc[p.type] = p.value, acc), {});

  const WD = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: WD[parts.weekday],            // 0=월 ... 6=일
    weekdayString: ['월','화','수','목','금','토','일'][WD[parts.weekday]],
    minutes: hour * 60 + minute,           // 자정부터 경과한 분
    clock: `${parts.hour}:${parts.minute}`,
  };
}

function hhmmToMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function minutesToHhmm(mins) {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * 컴시간이 주는 ['1(09:10)', '2(10:10)', ...] 형태를 교시 목록으로 변환.
 * 끝나는 시각은 컴시간이 주지 않으므로 config.periodMinutes 로 계산하되,
 * 다음 교시 시작 시각을 넘지 않도록 잘라낸다.
 */
function buildPeriods(rawClassTime) {
  const override = config.periodTimesOverride;
  if (Array.isArray(override) && override.length) {
    return override.map((p, i) => ({
      no: Number(p.no) || i + 1,
      start: p.start,
      end: p.end,
      startMin: hhmmToMinutes(p.start),
      endMin: hhmmToMinutes(p.end),
    })).filter((p) => p.startMin !== null && p.endMin !== null);
  }

  const list = [];
  (rawClassTime || []).forEach((entry, idx) => {
    const m = /(\d+)\s*\(\s*(\d{1,2}):(\d{2})\s*\)/.exec(String(entry));
    if (!m) return;
    const startMin = Number(m[2]) * 60 + Number(m[3]);
    list.push({ no: Number(m[1]) || idx + 1, startMin });
  });

  if (!list.length) return baseData.PERIODS;   // 컴시간이 교시 시간을 못 주면 기초시간표 기준

  const span = Math.max(5, Number(config.periodMinutes) || 50);
  return list.map((p, i) => {
    const next = list[i + 1];
    let endMin = p.startMin + span;
    if (next && endMin > next.startMin) endMin = next.startMin;
    return {
      no: p.no,
      start: minutesToHhmm(p.startMin),
      end: minutesToHhmm(endMin),
      startMin: p.startMin,
      endMin,
    };
  });
}

// ------------------------------------------------------------ 교사명 변환
/**
 * 컴시간은 교사명을 '이서*' 처럼 마스킹해서 준다.
 * data/teacher-map.json 의 표로 실명을 찾되,
 *  1) "마스킹명|과목" 키를 먼저 보고 (동명이인 구분용)
 *  2) 없으면 "마스킹명" 키를 본다.
 * 값이 null 이면 '표시하지 않음' 처리로 보고 마스킹 상태를 유지한다.
 */
function resolveTeacher(masked, subject) {
  const name = String(masked || '').trim();
  if (!name) return { masked: '', display: '', resolved: false };

  const keyed = `${name}|${String(subject || '').trim()}`;
  let real;
  if (Object.prototype.hasOwnProperty.call(TEACHER_MAP, keyed)) real = TEACHER_MAP[keyed];
  else if (Object.prototype.hasOwnProperty.call(TEACHER_MAP, name)) real = TEACHER_MAP[name];

  if (typeof real === 'string' && real.trim()) {
    return { masked: name, display: real.trim(), resolved: true };
  }
  return { masked: name, display: name, resolved: false };
}

// ------------------------------------------------------------ 컴시간 조회
/** comcigan-parser 가 없거나 깨져도 앱 전체가 죽지 않도록 늦게 불러온다. */
function loadParser() {
  try {
    // eslint-disable-next-line global-require
    return require('comcigan-parser');
  } catch (e) {
    throw new Error('comcigan-parser 를 불러오지 못했습니다. npm install 이 됐는지 확인하세요.');
  }
}

async function getInstance() {
  if (_instance) return _instance;
  const Timetable = loadParser();
  const inst = new Timetable();
  await inst.init({ maxGrade: Number(config.maxGrade) || 3 });
  _instance = inst;
  return inst;
}

async function resolveSchool(inst) {
  const hint = Number(config.schoolCodeHint) || null;
  let candidates = [];
  try {
    candidates = (await inst.search(config.schoolName)) || [];
  } catch (e) {
    candidates = [];
  }

  // 1순위: 설정에 적어둔 학교 코드와 일치하는 결과
  if (hint) {
    const byCode = candidates.find((s) => Number(s.code) === hint);
    if (byCode) return { ...byCode, matchedBy: 'code' };
  }
  // 2순위: 이름이 정확히 같은 결과
  const byName = candidates.find((s) => String(s.name).trim() === String(config.schoolName).trim());
  if (byName) return { ...byName, matchedBy: 'name' };
  // 3순위: 검색 결과가 하나뿐이면 그것
  if (candidates.length === 1) return { ...candidates[0], matchedBy: 'only' };
  // 4순위: 이름 부분일치 첫 번째
  if (candidates.length) return { ...candidates[0], matchedBy: 'first', ambiguous: candidates.length };

  // 검색이 안 되면 설정의 코드로 직행 (컴시간교사.kr 에서 쓰는 코드)
  if (hint) return { name: config.schoolName, code: hint, matchedBy: 'hint-only' };

  throw new Error(`학교를 찾지 못했습니다: ${config.schoolName}`);
}

/** 컴시간에서 실제로 데이터를 받아 평평한 수업 목록으로 정리 */
async function fetchFromComcigan() {
  const inst = await getInstance();
  const school = await resolveSchool(inst);

  await inst.setSchool(Number(school.code));

  const [grid, rawClassTime] = await Promise.all([
    inst.getTimetable(),
    inst.getClassTime().catch(() => []),
  ]);

  const periods = buildPeriods(rawClassTime);
  const lessons = [];
  const classesByGrade = {};

  // grid[학년][반][요일 0~4][교시 0~]
  for (const gKey of Object.keys(grid || {})) {
    const grade = Number(gKey);
    if (!Number.isFinite(grade) || grade <= 0) continue;
    const classes = grid[gKey];
    if (!classes) continue;

    for (const cKey of Object.keys(classes)) {
      const klass = Number(cKey);
      if (!Number.isFinite(klass) || klass <= 0) continue;
      const days = classes[cKey];
      if (!Array.isArray(days)) continue;

      let hasAny = false;
      days.forEach((slots, dayIdx) => {
        if (!Array.isArray(slots)) return;
        slots.forEach((cell, periodIdx) => {
          if (!cell) return;
          const subject = String(cell.subject || '').trim();
          if (!subject) return;
          hasAny = true;
          const t = resolveTeacher(cell.teacher, subject);
          lessons.push({
            grade,
            class: klass,
            day: Number.isFinite(cell.weekday) ? cell.weekday : dayIdx,
            period: Number(cell.classTime) || periodIdx + 1,
            subject,
            teacherMasked: t.masked,
            teacher: t.display,
            teacherResolved: t.resolved,
          });
        });
      });

      if (hasAny) {
        if (!classesByGrade[grade]) classesByGrade[grade] = [];
        if (!classesByGrade[grade].includes(klass)) classesByGrade[grade].push(klass);
      }
    }
  }

  Object.keys(classesByGrade).forEach((g) => classesByGrade[g].sort((a, b) => a - b));

  if (!lessons.length) throw new Error('시간표가 비어 있습니다. 컴시간 응답 구조가 바뀌었을 수 있습니다.');

  const merged = baseData.attachBlocks(lessons);

  return {
    school: { name: school.name, code: Number(school.code), matchedBy: school.matchedBy },
    fetchedAt: new Date().toISOString(),
    periods,
    grades: Object.keys(classesByGrade).map(Number).sort((a, b) => a - b),
    classesByGrade,
    lessons: merged,
    source: '컴시간',
  };
}

/** 캐시 -> 신규 조회 -> 실패 시 마지막 성공 데이터 순으로 반환 */
async function getData(opts) {
  const force = opts && opts.force;
  const now = Date.now();

  if (!force && _cache && now - _cache.at < CACHE_MS) {
    return { ...(_cache.payload), cache: 'hit', stale: false };
  }
  if (_inflight) return _inflight;

  _inflight = (async () => {
    try {
      const payload = await fetchFromComcigan();
      _cache = { at: Date.now(), payload };
      _lastGood = payload;
      return { ...payload, cache: 'miss', stale: false };
    } catch (err) {
      if (_lastGood) {
        return { ..._lastGood, cache: 'fallback', stale: true, error: err.message };
      }
      // 컴시간을 아예 못 쓸 때는 학교 기초시간표로 화면을 채운다.
      return { ...baseData.basePayload(), cache: 'base', stale: true, error: err.message };
    } finally {
      _inflight = null;
    }
  })();

  return _inflight;
}

// ------------------------------------------------------------ 현재 교시
/** 지금이 몇 교시인지, 다음 교시까지 몇 분 남았는지 */
function currentPeriodInfo(periods, at) {
  const now = kstNow(at);
  const isSchoolDay = now.weekday >= 0 && now.weekday <= 4;
  const result = {
    ...now,
    isSchoolDay,
    status: 'before',   // before | in | break | after | weekend
    period: null,
    nextPeriod: null,
    minutesLeft: null,
  };

  if (!isSchoolDay || !periods.length) {
    result.status = isSchoolDay ? 'after' : 'weekend';
    return result;
  }

  for (let i = 0; i < periods.length; i += 1) {
    const p = periods[i];
    if (now.minutes >= p.startMin && now.minutes < p.endMin) {
      result.status = 'in';
      result.period = p.no;
      result.minutesLeft = p.endMin - now.minutes;
      result.nextPeriod = periods[i + 1] ? periods[i + 1].no : null;
      return result;
    }
    if (now.minutes < p.startMin) {
      result.status = i === 0 ? 'before' : 'break';
      result.nextPeriod = p.no;
      result.minutesLeft = p.startMin - now.minutes;
      return result;
    }
  }

  result.status = 'after';
  return result;
}

module.exports = {
  config,
  baseData,
  getData,
  kstNow,
  currentPeriodInfo,
  resolveTeacher,
  buildPeriods,
  minutesToHhmm,
  hhmmToMinutes,
};
