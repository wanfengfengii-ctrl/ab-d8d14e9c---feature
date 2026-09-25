'use strict';

import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateSubmission } from './validation.js';
import { solveDeduplication, SolverLimitError } from './dedup.js';
import { TicketStore, toPublic, validateReviewBody } from './tickets.js';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(SRC_DIR, '..', 'public');
const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error(`请求体超过 ${limit} 字节上限`), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req, res) {
  let raw;
  try {
    raw = await readBody(req, MAX_BODY_BYTES);
  } catch (err) {
    sendJson(res, err.statusCode || 400, { error: { message: err.message } });
    return { ok: false };
  }
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    sendJson(res, 400, {
      error: { message: '请求体不是合法 JSON', issues: [{ path: '', message: 'JSON 解析失败' }] },
    });
    return { ok: false };
  }
}

async function handleDeduplication(req, res) {
  const parsed = await readJsonBody(req, res);
  if (!parsed.ok) return;
  const validation = validateSubmission(parsed.body);
  if (!validation.ok) {
    return sendJson(res, 400, {
      error: { message: '输入不合规，请根据定位信息修正后重新提交（草稿已保留）', issues: validation.issues },
    });
  }
  try {
    const result = solveDeduplication(validation.value);
    return sendJson(res, 200, result);
  } catch (err) {
    if (err instanceof SolverLimitError) {
      return sendJson(res, 422, { error: { message: err.message } });
    }
    throw err;
  }
}

/** 创建复测证据单：以当时完整草稿在服务端重新裁决并冻结。 */
async function handleCreateTicket(req, res, store) {
  const parsed = await readJsonBody(req, res);
  if (!parsed.ok) return;
  const validation = validateSubmission(parsed.body);
  if (!validation.ok) {
    return sendJson(res, 400, {
      error: { message: '输入不合规，请根据定位信息修正后重新提交（草稿已保留）', issues: validation.issues },
    });
  }
  try {
    const ticket = await store.create(validation.value);
    return sendJson(res, 201, toPublic(ticket));
  } catch (err) {
    if (err instanceof SolverLimitError) {
      return sendJson(res, 422, { error: { message: err.message } });
    }
    throw err;
  }
}

/** 提交复核结论：携带当前版本号与唯一操作号，幂等且拒绝过期版本。 */
async function handleSubmitReview(req, res, store, id) {
  const parsed = await readJsonBody(req, res);
  if (!parsed.ok) return;
  const ticket = store.get(id);
  if (!ticket) {
    return sendJson(res, 404, { error: { message: `证据单 #${id} 不存在` } });
  }
  const validation = validateReviewBody(parsed.body, ticket.links.length);
  if (!validation.ok) {
    return sendJson(res, 400, {
      error: { message: '复核提交不合规，证据单未改变', issues: validation.issues },
    });
  }
  const outcome = await store.applyReview(id, validation.value);
  return sendJson(res, outcome.status, outcome.body);
}

async function serveStatic(pathname, res) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    return sendJson(res, 403, { error: { message: '禁止访问' } });
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    return res.end(data);
  } catch {
    return sendJson(res, 404, { error: { message: '资源不存在' } });
  }
}

export function createServer(options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || path.join(SRC_DIR, '..', 'data');
  const store = new TicketStore(dataDir);
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;

      if (req.method === 'GET' && pathname === '/api/health') {
        return sendJson(res, 200, { status: 'ok', service: 'particle-deduplication' });
      }
      if (req.method === 'POST' && pathname === '/api/particle-deduplications') {
        return await handleDeduplication(req, res);
      }
      // 复测证据单
      if (req.method === 'POST' && pathname === '/api/review-tickets') {
        return await handleCreateTicket(req, res, store);
      }
      if (req.method === 'GET' && pathname === '/api/review-tickets') {
        return sendJson(res, 200, { tickets: store.list() });
      }
      const ticketMatch = /^\/api\/review-tickets\/(\d+)$/.exec(pathname);
      if (req.method === 'GET' && ticketMatch) {
        const ticket = store.get(Number(ticketMatch[1]));
        if (!ticket) return sendJson(res, 404, { error: { message: `证据单 #${ticketMatch[1]} 不存在` } });
        return sendJson(res, 200, toPublic(ticket));
      }
      const reviewMatch = /^\/api\/review-tickets\/(\d+)\/reviews$/.exec(pathname);
      if (req.method === 'POST' && reviewMatch) {
        return await handleSubmitReview(req, res, store, Number(reviewMatch[1]));
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        return await serveStatic(pathname, res);
      }
      return sendJson(res, 404, { error: { message: '接口不存在' } });
    } catch (err) {
      console.error('[server] 未处理异常:', err);
      return sendJson(res, 500, { error: { message: '服务器内部错误' } });
    }
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.PORT) || 8080;
  const server = createServer();
  server.listen(port, '0.0.0.0', () => {
    console.log(`[server] 颗粒去重裁决服务已启动: http://0.0.0.0:${port}`);
  });
  const shutdown = (signal) => {
    console.log(`[server] 收到 ${signal}，正在关闭…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
