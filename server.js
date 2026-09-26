'use strict';

// 社区共享厨房值班安排服务（零依赖，Node 18+）
// 数据持久化到 data.json；所有冲突校验在单进程内原子完成。

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const SLOTS = [
  { id: 'breakfast', label: '早餐', time: '06:00-09:00' },
  { id: 'lunch', label: '午餐', time: '10:00-13:30' },
  { id: 'dinner', label: '晚餐', time: '16:00-19:30' },
  { id: 'late', label: '夜宵', time: '20:00-22:00' },
];
const STOVES = [1, 2, 3, 4];

// 占用中的状态：同一灶台同一时段只允许一条
const ACTIVE = ['booked', 'pending_sub', 'in_use'];

const STATUS_LABEL = {
  booked: '已登记',
  pending_sub: '待替班',
  in_use: '开火中',
  done: '已结束',
  cancelled: '已取消',
};

// ---------- 存储 ----------

let db = { bookings: [], closedDays: {} };
try {
  db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch {
  // 首次启动，使用空库
}

function save() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// ---------- 领域逻辑 ----------

function scheduleFor(date) {
  const bookings = db.bookings
    .filter((b) => b.date === date)
    .map((b) => ({ ...b, statusLabel: STATUS_LABEL[b.status] }));
  const summary = {
    people: bookings.filter((b) => ACTIVE.includes(b.status)).length,
    inUse: bookings.filter((b) => b.status === 'in_use').length,
    needSub: bookings.filter((b) => b.status === 'pending_sub').length,
    cancelled: bookings.filter((b) => b.status === 'cancelled').length,
  };
  const closeReason = db.closedDays[date] || null;
  return { date, slots: SLOTS, stoves: STOVES, closed: !!closeReason, closeReason, bookings, summary };
}

function findBooking(id) {
  return db.bookings.find((b) => b.id === id);
}

function addHistory(b, event, detail) {
  b.history.push({ at: new Date().toISOString(), event, detail });
  b.updatedAt = new Date().toISOString();
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function badRequest(res, date, message) {
  return sendJSON(res, 400, { error: message, schedule: date ? scheduleFor(date) : null });
}

// ---------- HTTP 工具 ----------

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e5) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, content) => {
    if (err) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(content);
  });
}

// ---------- 路由 ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    if (req.method === 'GET' && p === '/api/schedule') {
      const date = url.searchParams.get('date');
      if (!DATE_RE.test(date || '')) return badRequest(res, null, '日期格式应为 YYYY-MM-DD');
      return sendJSON(res, 200, scheduleFor(date));
    }

    if (req.method === 'POST' && p === '/api/bookings') {
      const body = await readBody(req);
      const { date, slot, name } = body;
      const stove = Number(body.stove);
      if (!DATE_RE.test(date || '')) return badRequest(res, null, '日期格式应为 YYYY-MM-DD');
      if (!SLOTS.some((s) => s.id === slot)) return badRequest(res, date, '无效的时段');
      if (!STOVES.includes(stove)) return badRequest(res, date, '无效的灶台');
      const who = String(name || '').trim().slice(0, 20);
      if (!who) return badRequest(res, date, '请填写登记人姓名');
      if (db.closedDays[date]) {
        return sendJSON(res, 423, {
          error: `当天预约已关闭：${db.closedDays[date]}`,
          schedule: scheduleFor(date),
        });
      }
      // 冲突校验：同日期同时段同灶台已有占用中的记录
      const clash = db.bookings.find(
        (b) => b.date === date && b.slot === slot && b.stove === stove && ACTIVE.includes(b.status)
      );
      if (clash) {
        return sendJSON(res, 409, {
          error: `${stove} 号灶台该时段已被「${clash.name}」占用（${STATUS_LABEL[clash.status]}），以下为最新安排`,
          schedule: scheduleFor(date),
        });
      }
      const now = new Date().toISOString();
      const booking = {
        id: crypto.randomUUID(),
        date,
        slot,
        stove,
        name: who,
        status: 'booked',
        cancelReason: null,
        createdAt: now,
        updatedAt: now,
        history: [{ at: now, event: 'booked', detail: `${who} 登记` }],
      };
      db.bookings.push(booking);
      save();
      return sendJSON(res, 201, { ok: true, schedule: scheduleFor(date) });
    }

    const bookingAction = p.match(/^\/api\/bookings\/([\w-]+)\/(start|finish|leave|handover)$/);
    if (req.method === 'POST' && bookingAction) {
      const [, id, action] = bookingAction;
      const b = findBooking(id);
      if (!b) return badRequest(res, null, '记录不存在');
      const date = b.date;

      if (action === 'start') {
        if (b.status !== 'booked') return badRequest(res, date, '只有「已登记」的记录才能开火');
        b.status = 'in_use';
        addHistory(b, 'start', `${b.name} 开火`);
      } else if (action === 'finish') {
        if (b.status !== 'in_use') return badRequest(res, date, '只有「开火中」的记录才能结束');
        b.status = 'done';
        addHistory(b, 'finish', `${b.name} 使用结束`);
      } else if (action === 'leave') {
        if (b.status !== 'booked') return badRequest(res, date, '已开火或已结束的记录不能请假');
        b.status = 'pending_sub';
        addHistory(b, 'leave', `${b.name} 临时有事，等待替班`);
      } else if (action === 'handover') {
        if (b.status !== 'pending_sub') return badRequest(res, date, '该记录当前不需要替班');
        const body = await readBody(req);
        const sub = String(body.substitute || '').trim().slice(0, 20);
        if (!sub) return badRequest(res, date, '请填写替班人姓名');
        addHistory(b, 'handover', `${b.name} 交接给 ${sub}`);
        b.name = sub;
        b.status = 'booked';
      }
      save();
      return sendJSON(res, 200, { ok: true, schedule: scheduleFor(date) });
    }

    const dayAction = p.match(/^\/api\/days\/(\d{4}-\d{2}-\d{2})\/(close|open)$/);
    if (req.method === 'POST' && dayAction) {
      const [, date, action] = dayAction;
      if (action === 'close') {
        const body = await readBody(req);
        const reason = String(body.reason || '').trim().slice(0, 50) || '管理员关闭当天预约';
        db.closedDays[date] = reason;
        let cancelled = 0;
        for (const b of db.bookings) {
          if (b.date === date && (b.status === 'booked' || b.status === 'pending_sub')) {
            b.status = 'cancelled';
            b.cancelReason = reason;
            addHistory(b, 'cancelled', `取消原因：${reason}`);
            cancelled += 1;
          }
          // in_use / done 的记录保留原样
        }
        save();
        return sendJSON(res, 200, { ok: true, cancelled, schedule: scheduleFor(date) });
      }
      // open：重新开放当天（已取消的记录保持取消状态，便于追溯原因）
      delete db.closedDays[date];
      save();
      return sendJSON(res, 200, { ok: true, schedule: scheduleFor(date) });
    }

    if (req.method === 'GET' && !p.startsWith('/api/')) return serveStatic(res, p);

    sendJSON(res, 404, { error: 'not found' });
  } catch (err) {
    sendJSON(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`共享厨房值班安排：http://localhost:${PORT}`);
});
