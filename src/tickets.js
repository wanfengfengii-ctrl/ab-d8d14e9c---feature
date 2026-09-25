'use strict';

/**
 * 复测证据单：去重裁决成功后，分析员以当时完整草稿在服务端重新裁决并冻结
 * 最终颗粒、采用关联与来源摘要，复核员逐条对采用关联记录“确认 / 否决”。
 *
 * 语义：
 *  - 证据单一旦创建即冻结，当前草稿的后续修改不会改写既有证据；
 *  - 全部关联均获确认 → 已证实；任一否决 → 立即转为需重裁决；
 *  - 每次复核提交携带当前版本号与唯一操作号：
 *      · 同操作号 + 同内容 → 返回原结果（幂等重试）；
 *      · 同操作号 + 不同内容 → 409 拒绝，证据单不变；
 *      · 版本过期 → 409 拒绝，证据单不变；
 *  - 创建与每次提交均写透到数据目录，服务重启后按编号恢复。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { solveDeduplication } from './dedup.js';

export const TICKET_STATUS = Object.freeze({
  PENDING: 'pending',                    // 复核中
  VERIFIED: 'verified',                  // 已证实（全部关联确认）
  NEEDS_READJUDICATION: 'needs-readjudication', // 需重裁决（存在否决）
});

export const REVIEW_LIMITS = Object.freeze({
  maxOperationIdLength: 120,
  maxDecisions: 100000,
});

/** 键序稳定的序列化，用于草稿指纹与操作内容指纹。 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** 状态推导：任一否决 → 需重裁决；全部确认 → 已证实；否则复核中。 */
function computeStatus(links) {
  if (links.some((l) => l.decision === 'rejected')) return TICKET_STATUS.NEEDS_READJUDICATION;
  if (links.every((l) => l.decision === 'confirmed')) return TICKET_STATUS.VERIFIED;
  return TICKET_STATUS.PENDING;
}

function obsView(o) {
  return {
    fieldIndex: o.fieldIndex,
    fieldName: o.fieldName,
    particleId: o.particleId,
    localX: o.localX,
    localY: o.localY,
    filterX: o.filterX,
    filterY: o.filterY,
  };
}

/** 从冻结的裁决结果展开“采用关联”清单：两端观测、类别与坐标差。 */
function buildLinks(result) {
  const links = [];
  for (const p of result.particles) {
    const byId = new Map(p.observations.map((o) => [o.particleId, o]));
    for (const l of p.links) {
      const a = byId.get(l.a);
      const b = byId.get(l.b);
      const dx = Math.abs(a.filterX - b.filterX);
      const dy = Math.abs(a.filterY - b.filterY);
      links.push({
        index: links.length,
        particleId: p.id,
        category: p.category,
        a: obsView(a),
        b: obsView(b),
        dx,
        dy,
        manhattan: dx + dy,
        decision: 'pending',
        decidedAt: null,
      });
    }
  }
  return links;
}

/** 冻结来源摘要：完整草稿 + 概览 + 草稿指纹。 */
function buildSource(value) {
  return {
    tolerance: value.tolerance,
    fieldCount: value.fields.length,
    observationCount: value.fields.reduce((s, f) => s + f.particles.length, 0),
    fields: value.fields.map((f) => ({
      name: f.name,
      offset: { x: f.offset.x, y: f.offset.y },
      particleCount: f.particles.length,
    })),
    draftHash: sha256(canonical(value)),
  };
}

function progressOf(links) {
  const confirmed = links.filter((l) => l.decision === 'confirmed').length;
  const rejected = links.filter((l) => l.decision === 'rejected').length;
  return { total: links.length, confirmed, rejected, remaining: links.length - confirmed - rejected };
}

/** 对外视图：附带进度与首条否决关联；关联逐条拷贝，避免内部状态被外部引用。 */
export function toPublic(ticket) {
  const first = ticket.links.find((l) => l.decision === 'rejected');
  return {
    id: ticket.id,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    version: ticket.version,
    status: ticket.status,
    source: ticket.source,
    draft: ticket.draft,
    result: ticket.result,
    links: ticket.links.map((l) => ({ ...l, a: { ...l.a }, b: { ...l.b } })),
    progress: progressOf(ticket.links),
    firstRejectedLinkIndex: first ? first.index : null,
  };
}

function toSummary(ticket) {
  const first = ticket.links.find((l) => l.decision === 'rejected');
  return {
    id: ticket.id,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    version: ticket.version,
    status: ticket.status,
    source: {
      tolerance: ticket.source.tolerance,
      fieldCount: ticket.source.fieldCount,
      observationCount: ticket.source.observationCount,
      draftHash: ticket.source.draftHash,
    },
    progress: progressOf(ticket.links),
    firstRejectedLinkIndex: first ? first.index : null,
  };
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * 复核提交校验：{ version, operationId, decisions:[{linkIndex, decision}] }。
 * linkCount 用于定位越界的 linkIndex。
 */
export function validateReviewBody(body, linkCount) {
  const issues = [];
  if (!isPlainObject(body)) {
    return { ok: false, issues: [{ path: '', message: '请求体必须是 JSON 对象' }] };
  }
  const { version, operationId, decisions } = body;
  if (!Number.isInteger(version) || version < 0) {
    issues.push({ path: 'version', message: '版本号必须是 ≥ 0 的整数（取自证据单当前 version）' });
  }
  if (typeof operationId !== 'string' || operationId.trim().length === 0) {
    issues.push({ path: 'operationId', message: '操作号必须是非空字符串' });
  } else if (operationId.length > REVIEW_LIMITS.maxOperationIdLength) {
    issues.push({ path: 'operationId', message: `操作号长度不能超过 ${REVIEW_LIMITS.maxOperationIdLength} 字符` });
  }
  if (!Array.isArray(decisions) || decisions.length === 0) {
    issues.push({ path: 'decisions', message: 'decisions 必须是非空数组，元素为 {linkIndex, decision}' });
  } else if (decisions.length > REVIEW_LIMITS.maxDecisions) {
    issues.push({ path: 'decisions', message: `单次提交的复核项不能超过 ${REVIEW_LIMITS.maxDecisions} 条` });
  } else {
    const seen = new Set();
    decisions.forEach((d, i) => {
      const p = `decisions[${i}]`;
      if (!isPlainObject(d)) {
        issues.push({ path: p, message: '复核项必须是对象 {linkIndex, decision}' });
        return;
      }
      if (!Number.isInteger(d.linkIndex) || d.linkIndex < 0 || d.linkIndex >= linkCount) {
        issues.push({ path: `${p}.linkIndex`, message: `linkIndex 必须是 0 ~ ${Math.max(linkCount - 1, 0)} 的整数` });
      } else if (seen.has(d.linkIndex)) {
        issues.push({ path: `${p}.linkIndex`, message: `关联 #${d.linkIndex} 在本次提交中重复` });
      } else {
        seen.add(d.linkIndex);
      }
      if (d.decision !== 'confirmed' && d.decision !== 'rejected') {
        issues.push({ path: `${p}.decision`, message: 'decision 必须是 confirmed（确认）或 rejected（否决）' });
      }
    });
  }
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      version,
      operationId: operationId.trim(),
      decisions: decisions.map((d) => ({ linkIndex: d.linkIndex, decision: d.decision })),
    },
  };
}

export class TicketStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.tickets = new Map(); // id → ticket
    this.nextId = 1;
    this._load();
  }

  /** 启动时按编号恢复全部证据单（含复核进度与操作号台账）。 */
  _load() {
    let files;
    try {
      files = fs.readdirSync(this.dataDir);
    } catch {
      return; // 数据目录尚不存在：从零开始
    }
    for (const name of files) {
      const m = /^ticket-(\d+)\.json$/.exec(name);
      if (!m) continue;
      try {
        const ticket = JSON.parse(fs.readFileSync(path.join(this.dataDir, name), 'utf8'));
        if (ticket && Number.isInteger(ticket.id) && Array.isArray(ticket.links)) {
          this.tickets.set(ticket.id, ticket);
          if (ticket.id >= this.nextId) this.nextId = ticket.id + 1;
        }
      } catch {
        // 跳过无法解析的文件，不影响其余证据单恢复
      }
    }
  }

  /** 写透持久化：临时文件 + 原子改名，保证重启后不会读到半写文件。 */
  async _persist(ticket) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const file = path.join(this.dataDir, `ticket-${ticket.id}.json`);
    const tmp = `${file}.tmp-${process.pid}`;
    await fs.promises.writeFile(tmp, JSON.stringify(ticket, null, 2));
    await fs.promises.rename(tmp, file);
  }

  list() {
    return [...this.tickets.values()].map(toSummary).sort((a, b) => a.id - b.id);
  }

  get(id) {
    return this.tickets.get(id) || null;
  }

  /**
   * 创建证据单：以当时完整草稿在服务端重新裁决，冻结最终颗粒、
   * 采用关联与来源摘要。返回新建证据单。
   */
  async create(value) {
    const result = solveDeduplication(value); // 重新裁决，不信任客户端结果
    const now = new Date().toISOString();
    const ticket = {
      id: this.nextId,
      createdAt: now,
      updatedAt: now,
      version: 0,
      status: TICKET_STATUS.PENDING,
      source: buildSource(value),
      draft: value,
      result,
      links: buildLinks(result),
      operations: {}, // operationId → { contentHash, response }（幂等台账）
    };
    ticket.status = computeStatus(ticket.links); // 零关联时全部关联视为已确认
    this.nextId += 1;
    await this._persist(ticket);
    this.tickets.set(ticket.id, ticket);
    return ticket;
  }

  /**
   * 应用一次复核提交。返回 { status, body }：
   *  - 200：已应用（或同操作号同内容重试，返回原结果）；
   *  - 404：证据单不存在；
   *  - 409：版本过期 / 同操作号不同内容，证据单不变。
   */
  async applyReview(id, review) {
    const ticket = this.tickets.get(id);
    if (!ticket) {
      return { status: 404, body: { error: { message: `证据单 #${id} 不存在` } } };
    }

    const contentHash = sha256(canonical({ version: review.version, decisions: review.decisions }));
    const existing = ticket.operations[review.operationId];
    if (existing) {
      if (existing.contentHash === contentHash) {
        return { status: 200, body: existing.response }; // 幂等重试：返回原结果
      }
      return {
        status: 409,
        body: {
          error: {
            code: 'OPERATION_CONFLICT',
            message: `操作号“${review.operationId}”已用于不同内容，本次提交被拒绝，证据单未改变`,
            currentVersion: ticket.version,
          },
        },
      };
    }
    if (review.version !== ticket.version) {
      return {
        status: 409,
        body: {
          error: {
            code: 'VERSION_CONFLICT',
            message: `证据单版本已过期（提交版本 ${review.version}，当前版本 ${ticket.version}），请刷新后重试，证据单未改变`,
            currentVersion: ticket.version,
          },
        },
      };
    }

    const now = new Date().toISOString();
    for (const d of review.decisions) {
      const link = ticket.links[d.linkIndex];
      link.decision = d.decision;
      link.decidedAt = now;
    }
    ticket.version += 1;
    ticket.status = computeStatus(ticket.links);
    ticket.updatedAt = now;
    const response = toPublic(ticket);
    ticket.operations[review.operationId] = { contentHash, response };
    await this._persist(ticket);
    return { status: 200, body: response };
  }
}
