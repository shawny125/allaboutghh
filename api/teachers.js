'use strict';

/**
 * GET /api/teachers            -> 교사 목록 + 지금 수업 중인지
 * GET /api/teachers?name=이서연 -> 해당 교사의 주간 시간표
 *
 * 컴시간교사.kr 를 따로 긁지 않습니다.
 * 학급 시간표의 모든 칸에 담당 교사가 들어 있으므로, 그것을 교사 기준으로 뒤집으면
 * 동일한 교사별 시간표가 나옵니다. 출처가 하나라 두 화면이 절대 어긋나지 않습니다.
 */

const { getData, currentPeriodInfo, config } = require('./_lib');
const { sendJson, handler } = require('./_http');

function groupByTeacher(lessons) {
  const map = new Map();
  lessons.forEach((l) => {
    if (!l.teacher) return;
    const key = l.teacher;               // 실명이 확인되면 실명, 아니면 마스킹명
    if (!map.has(key)) {
      map.set(key, {
        이름: key,
        마스킹명: l.teacherMasked,
        실명확인: l.teacherResolved,
        과목: new Set(),
        수업: [],
      });
    }
    const t = map.get(key);
    t.과목.add(l.subject);
    t.수업.push(l);
    if (!l.teacherResolved) t.실명확인 = false;
  });
  return map;
}

module.exports = handler(async (req, res) => {
  const query = req.query || {};
  const data = await getData({ force: query.force === '1' });
  const now = currentPeriodInfo(data.periods);
  const weekdays = config.weekdays || ['월', '화', '수', '목', '금'];
  const teachers = groupByTeacher(data.lessons);

  // 같은 슬롯에 여러 건이 잡히면 전부 돌려준다.
  // 실제 교사는 한 시간에 한 곳에만 있으므로, 2건 이상이면
  // 마스킹된 이름 하나에 서로 다른 두 교사가 묶였다는 신호다.
  const 슬롯 = (수업목록, 교시) => {
    if (!now.isSchoolDay || !교시) return [];
    return 수업목록.filter((l) => l.day === now.weekday && l.period === 교시);
  };
  const 지금 = (수업목록) => (now.status === 'in' ? 슬롯(수업목록, now.period) : []);
  const 다음 = (수업목록) => 슬롯(수업목록, now.nextPeriod);
  const 요약 = (arr) => (arr.length
    ? { 교시: arr[0].period, 과목: arr[0].subject, 학급: arr[0].class ? `${arr[0].grade}-${arr[0].class}` : '', 동시건수: arr.length }
    : null);

  const name = query.name ? String(query.name).trim() : null;

  // ------------------------------------------------ 개별 교사 시간표
  if (name) {
    const t = teachers.get(name);
    if (!t) {
      sendJson(res, 404, { ok: false, error: `'${name}' 교사를 찾지 못했습니다.` });
      return;
    }
    const maxPeriod = t.수업.reduce((m, l) => Math.max(m, l.period), 0);
    let 충돌수 = 0;
    const grid = weekdays.map((label, dayIdx) => ({
      요일: label,
      수업: Array.from({ length: maxPeriod }, (_, i) => {
        const hits = t.수업.filter((l) => l.day === dayIdx && l.period === i + 1);
        if (!hits.length) return null;
        if (hits.length > 1) 충돌수 += 1;
        return {
          교시: i + 1,
          목록: hits.map((f) => ({ 과목: f.subject, 학급: `${f.grade}-${f.class}` })),
          충돌: hits.length > 1,
        };
      }),
    }));
    const cur = 지금(t.수업);
    const nxt = 다음(t.수업);

    sendJson(res, 200, {
      ok: true,
      조회시각: data.fetchedAt,
      낡은데이터: data.stale || false,
      현재: now,
      교사: {
        이름: t.이름,
        마스킹명: t.마스킹명,
        실명확인: t.실명확인,
        과목: [...t.과목],
        주간수업수: t.수업.length,
      },
      최대교시: maxPeriod,
      주간시간표: grid,
      충돌수,
      충돌안내: 충돌수
        ? '같은 시간에 두 곳 이상 수업이 잡혀 있습니다. 마스킹된 이름 하나에 서로 다른 교사가 묶였을 가능성이 큽니다. data/teacher-map.json 에서 과목을 붙인 키로 나눠 주세요.'
        : null,
      지금수업: 요약(cur),
      다음수업: 요약(nxt),
      오늘수업: now.isSchoolDay
        ? t.수업.filter((l) => l.day === now.weekday)
            .sort((a, b) => a.period - b.period)
            .map((l) => ({ 교시: l.period, 과목: l.subject, 학급: `${l.grade}-${l.class}` }))
        : [],
    }, 300);
    return;
  }

  // ------------------------------------------------ 교사 목록
  const list = [...teachers.values()]
    .map((t) => {
      const cur = 지금(t.수업);
      const nxt = 다음(t.수업);
      return {
        이름: t.이름,
        마스킹명: t.마스킹명,
        실명확인: t.실명확인,
        과목: [...t.과목],
        주간수업수: t.수업.length,
        상태: !now.isSchoolDay ? '휴일'
          : now.status === 'in' ? (cur.length ? '수업중' : '수업없음')
          : now.status === 'before' ? '수업전'
          : now.status === 'after' ? '일과후'
          : '쉬는시간',
        지금수업: 요약(cur),
        다음수업: 요약(nxt),
      };
    })
    .sort((a, b) => a.이름.localeCompare(b.이름, 'ko'));

  sendJson(res, 200, {
    ok: true,
    조회시각: data.fetchedAt,
    낡은데이터: data.stale || false,
    오류: data.error || null,
    현재: now,
    교시: data.periods.map((p) => ({ 교시: p.no, 시작: p.start, 종료: p.end })),
    교사수: list.length,
    실명미확인: list.filter((t) => !t.실명확인).length,
    교사: list,
  }, 300);
});
