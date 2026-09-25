'use strict';

/**
 * 复测证据单：去重裁决成功后，分析员以当时完整草稿在服务端重新裁决并冻结结论
 * （最终颗粒、采用关联、来源摘要），复核员逐条对采用关联记录“确认 / 否决”。
 *
 * 状态机（由关联判定派生，落盘内容可完全重建）：
 *   任一关联被否决           → needs_readjudication（需重裁决，立即生效）
 *   全部关联均获确认         → verified（已证实）
 *   其余                     → pending（复核中）
 * 终态（verified / needs_readjudication）后不再接受复核提交。
 *
 * 幂等与并发：每次复核提交携带当前版本号与唯一操作号；
 *   同操作号同内容重试 → 返回首次提交的原结果（不改变证据单）；
 *   同操作号不同内容 / 过期版本 → 拒绝（409），证据单保持不变。
 *
 * 持久化：每份证据单一个 JSON 文件（原子写入），服务重启后按编号恢复。
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const EVIDENCE_LIMITS = Object.freeze({
  maxOperationIdLength: 128,
  maxDecisionsPerSubmission: 500,
});

export const DECISIONS = Object.freeze({ CONFIRM: 'confirm', REJECT: 'reject' });

/** 稳定序列化（对象键排序），用于内容指纹。 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** 内容指纹（SHA-256），用于来源摘要与复核请求的幂等判定。 */
export function contentHash(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

/** 由冻结的裁决结果展开复核关联清单：每条采用关联列出两端观测、类别与坐标差。 */
function extractLinks(result) {
  const links = [];
  for (const particle of result.particles) {
    const byPid = new Map(particle.observations.map((o) => [o.particleId, o]));
    for (const l of particle.links) {
      const a = byPid.get(l.a);
      const b = byPid.get(l.b);
      links.push({
        linkId: links.length + 1,
        particleId: particle.id,
        category: particle.category,
        a,
        b,
        dx: Math.abs(a.filterX - b.filterX),
        dy: Math.abs(a.filterY - b.filterY),
        manhattan: l.manhattan,
        decision: null, // null=待复核 | confirmed | rejected
        decidedAt: null,
        decisionSeq: null,
      });
    }
  }
  return links;
}

/**
 * 以通过校验的完整草稿与其重新裁决结果构建证据单（id 由存储层分配）。
 * 草稿与裁决结果整体冻结，之后的草稿编辑不会改写本证据。
 */
export function buildSheet(normalizedDraft, result, now = new Date().toISOString()) {
  return {
    id: null,
    version: 0,
    createdAt: now,
    updatedAt: now,
    decisionSeq: 0,
    firstRejectedLinkId: null,
    source: {
      tolerance: normalizedDraft.tolerance,
      fieldCount: normalizedDraft.fields.length,
      observationCount: result.observationCount,
      fields: normalizedDraft.fields.map((f) => ({
        name: f.name,
        offset: { x: f.offset.x, y: f.offset.y },
        particleCount: f.particles.length,
      })),
      hash: contentHash(normalizedDraft),
      draft: normalizedDraft, // 冻结的完整草稿（创建时刻）
    },
    result, // 冻结的裁决结果（最终颗粒、代表坐标、采用关联）
    links: extractLinks(result),
    operations: {}, // operationId → { requestHash, response }（仅记录成功提交）
  };
}

/** 证据单状态（由关联判定派生）。 */
export function statusOf(sheet) {
  if (sheet.links.some((l) => l.decision === 'rejected')) return 'needs_readjudication';
  if (sheet.links.every((l) => l.decision === 'confirmed')) return 'verified';
  return 'pending';
}

function progressOf(sheet) {
  const total = sheet.links.length;
  const confirmed = sheet.links.filter((l) => l.decision === 'confirmed').length;
  const rejected = sheet.links.filter((l) => l.decision === 'rejected').length;
  return { total, confirmed, rejected, remaining: total - confirmed - rejected };
}

/** 完整视图（不含内部幂等日志）。 */
export function publicView(sheet) {
  return {
    id: sheet.id,
    version: sheet.version,
    status: statusOf(sheet),
    createdAt: sheet.createdAt,
    updatedAt: sheet.updatedAt,
    source: sheet.source,
    result: sheet.result,
    links: sheet.links,
    progress: progressOf(sheet),
    firstRejectedLinkId: sheet.firstRejectedLinkId,
  };
}

/** 列表摘要视图。 */
export function summaryView(sheet) {
  return {
    id: sheet.id,
    version: sheet.version,
    status: statusOf(sheet),
    createdAt: sheet.createdAt,
    updatedAt: sheet.updatedAt,
    source: {
      tolerance: sheet.source.tolerance,
      fieldCount: sheet.source.fieldCount,
      observationCount: sheet.source.observationCount,
      hash: sheet.source.hash,
    },
    progress: progressOf(sheet),
    firstRejectedLinkId: sheet.firstRejectedLinkId,
  };
}

/** 复核提交体形校验：返回 { ok, issues } 或 { ok, value }。 */
export function validateReviewRequest(body) {
  const issues = [];
  const push = (path, message) => issues.push({ path, message });
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(body)) {
    return { ok: false, issues: [{ path: '', message: '请求体必须是 JSON 对象' }] };
  }

  const v = body.version;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    push('version', '必须携带当前版本号（非负整数）');
  }
  const op = body.operationId;
  if (typeof op !== 'string' || op.trim().length === 0) {
    push('operationId', '必须携带唯一操作号（非空字符串）');
  } else if (op.trim().length > EVIDENCE_LIMITS.maxOperationIdLength) {
    push('operationId', `操作号长度不能超过 ${EVIDENCE_LIMITS.maxOperationIdLength} 字符`);
  }

  const ds = body.decisions;
  if (!Array.isArray(ds) || ds.length === 0) {
    push('decisions', 'decisions 必须是非空数组（逐条记录确认或否决）');
  } else {
    if (ds.length > EVIDENCE_LIMITS.maxDecisionsPerSubmission) {
      push('decisions', `单次提交的判定条数不能超过 ${EVIDENCE_LIMITS.maxDecisionsPerSubmission}`);
    }
    const seen = new Set();
    ds.forEach((d, i) => {
      const p = `decisions[${i}]`;
      if (!isObj(d)) {
        push(p, '判定必须是对象 {linkId, decision}');
        return;
      }
      if (typeof d.linkId !== 'number' || !Number.isInteger(d.linkId) || d.linkId < 1) {
        push(`${p}.linkId`, 'linkId 必须是 ≥ 1 的整数');
      } else if (seen.has(d.linkId)) {
        push(`${p}.linkId`, `关联 #${d.linkId} 在本次提交中重复`);
      } else {
        seen.add(d.linkId);
      }
      if (d.decision !== DECISIONS.CONFIRM && d.decision !== DECISIONS.REJECT) {
        push(`${p}.decision`, `decision 必须是 "${DECISIONS.CONFIRM}"（确认）或 "${DECISIONS.REJECT}"（否决）`);
      }
    });
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      version: v,
      operationId: op.trim(),
      decisions: ds.map((d) => ({ linkId: d.linkId, decision: d.decision })),
    },
  };
}

/**
 * 应用复核提交（纯内存操作，调用方负责持久化）。
 * 顺序：幂等重放 → 版本检查 → 终态检查 → 关联检查 → 应用。
 * 所有拒绝路径均不改变证据单。
 *
 * @returns {{ok:true, replay:boolean, response:object} | {ok:false, status:number, code:string, message:string, currentVersion?:number}}
 */
export function applyReview(sheet, request) {
  const requestHash = contentHash({ version: request.version, decisions: request.decisions });
  const seen = sheet.operations[request.operationId];
  if (seen) {
    if (seen.requestHash === requestHash) {
      return { ok: true, replay: true, response: { ...seen.response, idempotentReplay: true } };
    }
    return {
      ok: false,
      status: 409,
      code: 'OPERATION_CONFLICT',
      message: `操作号“${request.operationId}”已被不同内容的提交占用，证据单未改变`,
    };
  }
  if (request.version !== sheet.version) {
    return {
      ok: false,
      status: 409,
      code: 'STALE_VERSION',
      message: `版本过期：提交版本 ${request.version}，当前版本 ${sheet.version}；请刷新后重试，证据单未改变`,
      currentVersion: sheet.version,
    };
  }
  if (statusOf(sheet) !== 'pending') {
    return {
      ok: false,
      status: 409,
      code: 'SHEET_CLOSED',
      message: '证据单已终结（已证实或需重裁决），不再接受复核提交；如需继续请基于新裁决创建新证据单',
      currentVersion: sheet.version,
    };
  }
  const byId = new Map(sheet.links.map((l) => [l.linkId, l]));
  for (const d of request.decisions) {
    const link = byId.get(d.linkId);
    if (!link) {
      return {
        ok: false,
        status: 400,
        code: 'UNKNOWN_LINK',
        message: `关联 #${d.linkId} 不存在于证据单 #${sheet.id}`,
      };
    }
    if (link.decision !== null) {
      return {
        ok: false,
        status: 409,
        code: 'LINK_ALREADY_DECIDED',
        message: `关联 #${d.linkId} 已有复核结论（${link.decision === 'confirmed' ? '已确认' : '已否决'}），不可重复判定，证据单未改变`,
        currentVersion: sheet.version,
      };
    }
  }

  const now = new Date().toISOString();
  for (const d of request.decisions) {
    const link = byId.get(d.linkId);
    link.decision = d.decision === DECISIONS.CONFIRM ? 'confirmed' : 'rejected';
    link.decidedAt = now;
    link.decisionSeq = ++sheet.decisionSeq;
    if (link.decision === 'rejected' && sheet.firstRejectedLinkId === null) {
      sheet.firstRejectedLinkId = link.linkId;
    }
  }
  sheet.version += 1;
  sheet.updatedAt = now;
  const response = { ...publicView(sheet), idempotentReplay: false };
  sheet.operations[request.operationId] = { requestHash, response };
  return { ok: true, replay: false, response };
}

const SHEET_FILE = /^sheet-(\d+)\.json$/;
const fileName = (id) => `sheet-${String(id).padStart(6, '0')}.json`;

/**
 * 证据单存储：每单一文件（tmp + rename 原子写入），启动时扫描目录按编号恢复。
 * 每个证据单的写入串行化，避免并发写坏文件。
 */
export class EvidenceStore {
  constructor(dir) {
    this.dir = dir;
    this.sheets = new Map(); // id → sheet
    this.nextId = 1;
    this.writeChains = new Map(); // id → Promise
    this._ready = null;
  }

  /** 懒加载：首次访问证据接口时建目录并恢复全部证据单。 */
  ensureReady() {
    if (!this._ready) this._ready = this._init();
    return this._ready;
  }

  async _init() {
    await mkdir(this.dir, { recursive: true });
    const files = (await readdir(this.dir))
      .map((f) => ({ f, m: f.match(SHEET_FILE) }))
      .filter((x) => x.m)
      .sort((x, y) => Number(x.m[1]) - Number(y.m[1]));
    for (const { f } of files) {
      try {
        const sheet = JSON.parse(await readFile(path.join(this.dir, f), 'utf8'));
        if (typeof sheet.id !== 'number') continue;
        this.sheets.set(sheet.id, sheet);
        if (sheet.id >= this.nextId) this.nextId = sheet.id + 1;
      } catch (err) {
        console.error(`[evidence] 跳过无法恢复的证据单文件 ${f}: ${err.message}`);
      }
    }
    return this.sheets.size;
  }

  get(id) {
    return this.sheets.get(id) || null;
  }

  list() {
    return [...this.sheets.values()].sort((a, b) => a.id - b.id);
  }

  /** 分配编号、落盘并登记。 */
  async create(sheet) {
    sheet.id = this.nextId;
    this.nextId += 1;
    this.sheets.set(sheet.id, sheet);
    await this.save(sheet);
    return sheet;
  }

  /** 原子落盘（同一证据单串行写入）。 */
  save(sheet) {
    const id = sheet.id;
    const prev = this.writeChains.get(id) || Promise.resolve();
    const next = prev.then(() => this._writeAtomic(sheet));
    this.writeChains.set(id, next.catch(() => {}));
    return next;
  }

  async _writeAtomic(sheet) {
    const target = path.join(this.dir, fileName(sheet.id));
    const tmp = `${target}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(sheet, null, 2));
    await rename(tmp, target);
  }
}
