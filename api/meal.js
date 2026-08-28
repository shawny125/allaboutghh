"use strict";

/**
 * 인천공항고등학교 홈페이지 급식표 조회
 *
 * GET /api/meal
 * GET /api/meal?date=20260828
 */

const { kstNow } = require("./_lib");
const { sendJson, handler } = require("./_http");

const FOOD_URL =
  "https://gonghang-h.icehs.kr/foodlist.do";

const ALLERGY = {
  1: "난류",
  2: "우유",
  3: "메밀",
  4: "땅콩",
  5: "대두",
  6: "밀",
  7: "고등어",
  8: "게",
  9: "새우",
  10: "돼지고기",
  11: "복숭아",
  12: "토마토",
  13: "아황산류",
  14: "호두",
  15: "닭고기",
  16: "쇠고기",
  17: "오징어",
  18: "조개류",
  19: "잣",
};

function decodeHtml(text) {
  return String(text || "")
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function parseMenu(html) {
  const clean = decodeHtml(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/　/g, " ")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  return clean.map((line) => {
    const allergens = [];

    const name = line
      .replace(/\(([\d.,\s]+)\)\s*$/, (whole, numbers) => {
        String(numbers)
          .split(/[.,\s]+/)
          .filter(Boolean)
          .forEach((number) => {
            const value = Number(number);

            if (value >= 1 && value <= 19) {
              allergens.push(value);
            }
          });

        return "";
      })
      .trim();

    return {
      이름: name || line,
      알레르기: [...new Set(allergens)].sort((a, b) => a - b),
    };
  });
}

function findDayMenu(html, day) {
  const pattern = new RegExp(
    `<th[^>]*>[\\s\\S]*?<span[^>]*>\\s*${day}\\s*일<\\/span>[\\s\\S]*?<\\/th>\\s*<td[^>]*>([\\s\\S]*?)<\\/td>`,
    "i"
  );

  const match = html.match(pattern);

  if (!match) {
    return [];
  }

  return parseMenu(match[1]);
}

module.exports = handler(async (req, res) => {
  const query = req.query || {};

  const ymd = /^\d{8}$/.test(String(query.date || ""))
    ? String(query.date)
    : kstNow().date.replace(/-/g, "");

  const year = ymd.slice(0, 4);
  const month = ymd.slice(4, 6);
  const day = Number(ymd.slice(6, 8));

  try {
    const url =
      `${FOOD_URL}?year=${year}` +
      `&month=${month}` +
      `&m=030908` +
      `&s=gonghang_h`;

    const response = await fetch(url, {
      cache: "no-store",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent":
          "Mozilla/5.0 (compatible; AllAboutGonghang/1.0)",
      },
    });

    if (!response.ok) {
      throw new Error(
        `학교 홈페이지 응답 오류 (${response.status})`
      );
    }

    const html = await response.text();
    const menu = findDayMenu(html, day);

    const usedAllergens = new Set();

    menu.forEach((dish) => {
      dish.알레르기.forEach((number) => {
        usedAllergens.add(number);
      });
    });

    sendJson(
      res,
      200,
      {
        ok: true,
        날짜: ymd,
        급식: menu.length
          ? [
              {
                구분: "중식",
                메뉴: menu,
                칼로리: null,
                원산지: null,
              },
            ]
          : [],
        안내: menu.length
          ? null
          : "학교 홈페이지에 해당 날짜의 급식이 없습니다.",
        알레르기표: Object.fromEntries(
          [...usedAllergens]
            .sort((a, b) => a - b)
            .map((number) => [number, ALLERGY[number]])
        ),
        출처: "인천공항고등학교 홈페이지",
      },
      300
    );
  } catch (error) {
    sendJson(res, 200, {
      ok: false,
      날짜: ymd,
      급식: [],
      안내: error.message,
      알레르기표: {},
      출처: "인천공항고등학교 홈페이지",
    });
  }
});
