'use strict';

/** GET /api/links -> 바로가기 목록 (data/links.json 그대로) */

const links = require('../data/links.json');
const { sendJson, handler } = require('./_http');

module.exports = handler(async (req, res) => {
  sendJson(res, 200, { ok: true, 바로가기: links.바로가기 || [] }, 3600);
});
