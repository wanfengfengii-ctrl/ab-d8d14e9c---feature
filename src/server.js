'use strict';

import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateSubmission } from './validation.js';
import { solveDeduplication, SolverLimitError } from './dedup.js';
import {
  EvidenceStore,
  applyReview,
  buildSheet,
  publicView,
  summaryView,
  validateReviewRequest,
} from './evidence.js';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(SRC_DIR, '..', 'public');
const DEFAULT_DATA_DIR = path.join(SRC_DIR, '..', 'data');
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

/**
 * 创建复测证据单：以当时完整草稿在服务端重新裁决并冻结结论，
 * 之后的草稿编辑不会改写本证据单。
 */
async function handleCreateEvidence(req, res, store) {
  await store.ensureReady();
  const parsed = await readJsonBody(req, res);
  if (!parsed.ok) return;
  const validation = validateSubmission(parsed.body);
  if (!validation.ok) {
    return sendJson(res, 400, {
      error: { message: '草稿不合规，无法创建复测证据单（草稿已保留）', issues: validation.issues },
    });
  }
  let result;
  try {
    result = solveDeduplication(validation.value);
  } catch (err) {
    if (err instanceof SolverLimitError) {
      return sendJson(res, 422, { error: { message: err.message } });
    }
    throw err;
  }
  const sheet = await store.create(buildSheet(validation.value, result));
  return sendJson(res, 201, publicView(sheet));
}

async function handleListEvidence(res, store) {
  await store.ensureReady();
  return sendJson(res, 200, { sheets: store.list().map(summaryView) });
}

async function handleGetEvidence(res, store, id) {
  await store.ensureReady();
  const sheet = store.get(id);
  if (!sheet) {
    return sendJson(res, 404, { error: { message: `证据单 #${id} 不存在` } });
  }
  return sendJson(res, 200, publicView(sheet));
}

/** 复核提交：携带当前版本号与唯一操作号；幂等重放，过期版本 / 冲突操作号拒绝且不改证据单。 */
async function handleReview(req, res, store, id) {
  await store.ensureReady();
  const sheet = store.get(id);
  if (!sheet) {
    return sendJson(res, 404, { error: { message: `证据单 #${id} 不存在` } });
  }
  const parsed = await readJsonBody(req, res);
  if (!parsed.ok) return;
  const validation = validateReviewRequest(parsed.body);
  if (!validation.ok) {
    return sendJson(res, 400, { error: { message: '复核提交不合规', issues: validation.issues } });
  }
  // 校验与应用之间无 await：同一证据单的检查与变更对并发请求是原子的
  const outcome = applyReview(sheet, validation.value);
  if (!outcome.ok) {
    const error = { code: outcome.code, message: outcome.message };
    if (outcome.currentVersion !== undefined) error.currentVersion = outcome.currentVersion;
    return sendJson(res, outcome.status, { error });
  }
  if (!outcome.replay) await store.save(sheet);
  return sendJson(res, 200, outcome.response);
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
  const dataDir = options.dataDir || process.env.DATA_DIR || DEFAULT_DATA_DIR;
  const evidenceStore = new EvidenceStore(dataDir);
  const server = http.createServer(async (req, res) => {
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
      if (req.method === 'POST' && pathname === '/api/review-evidence-sheets') {
        return await handleCreateEvidence(req, res, evidenceStore);
      }
      if (req.method === 'GET' && pathname === '/api/review-evidence-sheets') {
        return await handleListEvidence(res, evidenceStore);
      }
      const sheetMatch = pathname.match(/^\/api\/review-evidence-sheets\/(\d+)$/);
      if (sheetMatch && req.method === 'GET') {
        return await handleGetEvidence(res, evidenceStore, Number(sheetMatch[1]));
      }
      const reviewMatch = pathname.match(/^\/api\/review-evidence-sheets\/(\d+)\/reviews$/);
      if (reviewMatch && req.method === 'POST') {
        return await handleReview(req, res, evidenceStore, Number(reviewMatch[1]));
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
  server.evidenceStore = evidenceStore;
  return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.PORT) || 8080;
  const server = createServer();
  server.evidenceStore.ensureReady().then((recovered) => {
    console.log(`[server] 证据单存储就绪（${server.evidenceStore.dir}），已恢复 ${recovered} 份证据单`);
  }).catch((err) => {
    console.error('[server] 证据单存储初始化失败:', err);
  });
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
