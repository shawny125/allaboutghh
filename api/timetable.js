'use strict';

/**
 * GET /api/timetable                -> 전체 메타(학년·반 목록, 교시 시간, 현재 교시)
 * GET /api/timetable?grade=2&class=4 -> 해당 학급의 주간 시간표
 * GET /api/timetable?force=1        -> 캐시 무시하고 새로 조회
 */

const { getData, currentPeriodInfo, config } = require('./_lib');
const { sendJson, handler } = require('./_http');

module.exports = handler(async (req, res) => {
  const query = req.query || {};
  const data = await getData({ force: query.force === '1' });
  const now = currentPeriodInfo(data.periods);

  const base = {
    ok: true,
    학교: data.school,
    조회시각: data.fetchedAt,
    캐시: data.cache,
    출처: data.source || '컴시간',
    낡은데이터: data.stale || false,
    오류: data.error || null,
    교시: data.periods.map((p) => ({ 교시: p.no, 시작: p.start, 종료: p.end })),
    학년: data.grades,
    학년별반: data.classesByGrade,
    현재: now,
  };

  const grade = Number(query.grade);
  const klass = Number(query['class']);

  if (!Number.isFinite(grade) || !Number.isFinite(klass)) {
    sendJson(res, 200, base, 300);
    return;
  }

  const mine = data.lessons.filter((l) => l.grade === grade && l.class === klass);
  if (!mine.length) {
    sendJson(res, 404, { ...base, ok: false, error: `${grade}학년 ${klass}반 시간표를 찾지 못했습니다.` });
    return;
  }

  const maxPeriod = mine.reduce((m, l) => Math.max(m, l.period), 0);
  const weekdays = config.weekdays || ['월', '화', '수', '목', '금'];

  // grid[요일][교시] 형태로 정리
  const grid = weekdays.map((label, dayIdx) => ({
    요일: label,
    수업: Array.from({ length: maxPeriod }, (_, i) => {
      const found = mine.find((l) => l.day === dayIdx && l.period === i + 1);
      if (!found) return null;
      if (found.block) {
        return { 교시: i + 1, 이동수업: true, 블록: found.block,
                 과목: '', 교사: '', 실명확인: true };
      }
      return { 교시: i + 1, 과목: found.subject, 교사: found.teacher,
               실명확인: found.teacherResolved, ...(found.고정 ? { 고정: true } : {}) };
    }),
  }));

  // 오늘 수업 + 지금 수업
  const today = now.isSchoolDay
    ? mine.filter((l) => l.day === now.weekday).sort((a, b) => a.period - b.period)
    : [];
  const nowRaw = now.status === 'in' ? today.find((l) => l.period === now.period) || null : null;
  const nowLesson = nowRaw && (nowRaw.block
    ? { 교시: nowRaw.period, 이동수업: true, 블록: nowRaw.block, 과목: '', 교사: '' }
    : { 교시: nowRaw.period, 과목: nowRaw.subject, 교사: nowRaw.teacher });

  sendJson(res, 200, {
    ...base,
    학급: { 학년: grade, 반: klass },
    최대교시: maxPeriod,
    주간시간표: grid,
    오늘수업: today.map((l) => (l.block
      ? { 교시: l.period, 이동수업: true, 블록: l.block, 과목: '', 교사: '' }
      : { 교시: l.period, 과목: l.subject, 교사: l.teacher, ...(l.고정 ? { 고정: true } : {}) })),
    지금수업: nowLesson,
  }, 300);
});
