'use strict';

/**
 * API 冒烟验收：针对运行中的服务执行健康检查、页面可达性、
 * 去重裁决（含拒绝贪心的关键用例）、校验反馈与错误处理检查。
 * 既可被 verify 调用，也可独立运行：BASE_URL=http://host:port node scripts/smoke.js
 */

export async function runSmoke(base) {
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok: !!ok, detail: detail || '' });
  };
  const post = (body, raw = false) => fetch(`${base}/api/particle-deduplications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ? body : JSON.stringify(body),
  });

  // 1. 健康检查
  try {
    const res = await fetch(`${base}/api/health`);
    const body = await res.json();
    check('GET /api/health → 200 且 status=ok', res.status === 200 && body.status === 'ok', `HTTP ${res.status}`);
  } catch (err) {
    check('GET /api/health', false, String(err));
  }

  // 2. 前端页面
  try {
    const res = await fetch(`${base}/`);
    const html = await res.text();
    check('GET / → 200 且包含录入界面', res.status === 200 && html.includes('微塑料') && html.includes('app.js'), `HTTP ${res.status}`);
  } catch (err) {
    check('GET /', false, String(err));
  }

  // 3. 去重裁决：关键用例（局部贪心会得出 4 个颗粒，全局最优为 3 个）
  try {
    const res = await post({
      tolerance: 1,
      fields: [
        { name: 'F1', offset: { x: 0, y: 0 }, particles: [{ id: 'A1', x: 0, y: 0, category: 'PE' }, { id: 'A2', x: 2, y: 0, category: 'PE' }] },
        { name: 'F2', offset: { x: 0, y: 0 }, particles: [{ id: 'B1', x: 1, y: 0, category: 'PE' }, { id: 'B2', x: 0, y: 1, category: 'PE' }] },
        { name: 'F3', offset: { x: 100, y: 100 }, particles: [{ id: 'C1', x: 0, y: 0, category: 'PP' }] },
      ],
    });
    const body = await res.json();
    check('POST 裁决 → 200', res.status === 200, `HTTP ${res.status}`);
    check('最终颗粒总数为 3（拒绝贪心结果 4）', body.totalParticles === 3, `实际为 ${body.totalParticles}`);
    const groups = (body.particles || [])
      .map((p) => p.observations.map((o) => o.particleId).sort().join('+'))
      .sort();
    check('分组为 {A1,B2}、{A2,B1}、{C1}', JSON.stringify(groups) === JSON.stringify(['A1+B2', 'A2+B1', 'C1']), groups.join(' | '));
    const merged = (body.particles || []).find((p) => p.observations.some((o) => o.particleId === 'B2'));
    check(
      '代表坐标为质心 (0, 0.5) 且类别正确',
      !!merged && merged.representative.x === 0 && merged.representative.y === 0.5 && merged.category === 'PE',
      merged ? JSON.stringify(merged.representative) : '未找到颗粒',
    );
    const links = (body.particles || []).flatMap((p) => p.links.map((l) => [l.a, l.b].sort().join('~'))).sort();
    check('所选关联为 A1-B2、A2-B1', JSON.stringify(links) === JSON.stringify(['A1~B2', 'A2~B1']), links.join(' | '));
  } catch (err) {
    check('POST 裁决', false, String(err));
  }

  // 4. 校验反馈：可定位且保留草稿语义（400 + issues）
  try {
    const res = await post({
      tolerance: 1,
      fields: [
        { offset: { x: 0, y: 0 }, particles: [{ id: 'A1', x: 0, y: 0, category: 'PE' }] },
        { offset: { x: 0, y: 0 }, particles: [{ id: 'A1', x: 0.5, y: 0, category: '' }] },
      ],
    });
    const body = await res.json();
    const paths = (body.error && Array.isArray(body.error.issues)) ? body.error.issues.map((i) => i.path) : [];
    check('不合规输入 → 400', res.status === 400, `HTTP ${res.status}`);
    check(
      '反馈包含可定位路径',
      paths.includes('fields[1].particles[0].id') && paths.includes('fields[1].particles[0].x') && paths.includes('fields'),
      paths.join(' | '),
    );
  } catch (err) {
    check('校验反馈', false, String(err));
  }

  // 5. 非法 JSON
  try {
    const res = await post('{not valid json', true);
    check('非法 JSON → 400', res.status === 400, `HTTP ${res.status}`);
  } catch (err) {
    check('非法 JSON', false, String(err));
  }

  // 6. 未知接口
  try {
    const res = await fetch(`${base}/api/no-such-endpoint`);
    check('未知接口 → 404', res.status === 404, `HTTP ${res.status}`);
  } catch (err) {
    check('未知接口', false, String(err));
  }

  // 7. 复测证据单业务冒烟：创建 → 冻结 → 复核 → 幂等/冲突
  try {
    const postTicket = (body) => fetch(`${base}/api/review-tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const draft = {
      tolerance: 1,
      fields: [
        { name: 'F1', offset: { x: 0, y: 0 }, particles: [{ id: 'A1', x: 0, y: 0, category: 'PE' }, { id: 'A2', x: 2, y: 0, category: 'PE' }] },
        { name: 'F2', offset: { x: 0, y: 0 }, particles: [{ id: 'B1', x: 1, y: 0, category: 'PE' }, { id: 'B2', x: 0, y: 1, category: 'PE' }] },
        { name: 'F3', offset: { x: 100, y: 100 }, particles: [{ id: 'C1', x: 0, y: 0, category: 'PP' }] },
      ],
    };
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    // 创建：服务端重新裁决并冻结
    const createRes = await postTicket(draft);
    const ticket = await createRes.json();
    check('POST /api/review-tickets → 201 且冻结裁决结论', createRes.status === 201 && ticket.result && ticket.result.totalParticles === 3, `HTTP ${createRes.status}`);
    check('证据单列出每条采用关联的两端观测、类别与坐标差',
      Array.isArray(ticket.links) && ticket.links.length === 2
        && ticket.links.every((l) => l.a && l.b && l.category && Number.isInteger(l.dx) && Number.isInteger(l.dy) && l.decision === 'pending'),
      `links=${ticket.links && ticket.links.length}`);
    check('来源摘要含容差 / 视野数 / 观测数 / 草稿指纹',
      ticket.source && ticket.source.tolerance === 1 && ticket.source.fieldCount === 3 && ticket.source.observationCount === 5 && typeof ticket.source.draftHash === 'string');

    // 按编号查询与列表
    const getRes = await fetch(`${base}/api/review-tickets/${ticket.id}`);
    check('GET /api/review-tickets/:id → 200 按编号取回', getRes.status === 200, `HTTP ${getRes.status}`);
    const listRes = await fetch(`${base}/api/review-tickets`);
    const list = await listRes.json();
    check('GET /api/review-tickets 列表包含新证据单', listRes.status === 200 && list.tickets.some((x) => x.id === ticket.id));

    // 复核：全部确认 → 已证实
    const confirmAll = {
      version: ticket.version,
      operationId: `smoke-confirm-${suffix}`,
      decisions: ticket.links.map((l) => ({ linkIndex: l.index, decision: 'confirmed' })),
    };
    const reviewUrl = `${base}/api/review-tickets/${ticket.id}/reviews`;
    const postReview = (body) => fetch(reviewUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const confirmRes = await postReview(confirmAll);
    const confirmed = await confirmRes.json();
    check('全部确认 → 已证实（版本前进）', confirmRes.status === 200 && confirmed.status === 'verified' && confirmed.version === ticket.version + 1 && confirmed.progress.remaining === 0, `HTTP ${confirmRes.status} status=${confirmed.status}`);

    // 同内容重试 → 返回原结果
    const replayRes = await postReview(confirmAll);
    const replay = await replayRes.json();
    check('同操作号同内容重试 → 200 返回原结果', replayRes.status === 200 && JSON.stringify(replay) === JSON.stringify(confirmed), `HTTP ${replayRes.status}`);

    // 同操作号不同内容 → 409 且证据单不变
    const conflictRes = await postReview({ ...confirmAll, version: confirmed.version, decisions: [{ linkIndex: 0, decision: 'rejected' }] });
    check('同操作号不同内容 → 409', conflictRes.status === 409, `HTTP ${conflictRes.status}`);
    const afterConflict = await (await fetch(`${base}/api/review-tickets/${ticket.id}`)).json();
    check('操作号冲突后证据单不变', afterConflict.version === confirmed.version && afterConflict.status === 'verified');

    // 过期版本 → 409
    const staleRes = await postReview({ version: ticket.version, operationId: `smoke-stale-${suffix}`, decisions: [{ linkIndex: 0, decision: 'rejected' }] });
    check('过期版本 → 409', staleRes.status === 409 && (await staleRes.json()).error.code === 'VERSION_CONFLICT', `HTTP ${staleRes.status}`);

    // 否决流：任一否决 → 需重裁决，首条否决关联可见
    const t2 = await (await postTicket(draft)).json();
    const rejectRes = await fetch(`${base}/api/review-tickets/${t2.id}/reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: t2.version, operationId: `smoke-reject-${suffix}`, decisions: [{ linkIndex: 0, decision: 'rejected' }] }),
    });
    const rejected = await rejectRes.json();
    check('任一否决 → 需重裁决且首条否决关联明确',
      rejectRes.status === 200 && rejected.status === 'needs-readjudication' && rejected.firstRejectedLinkIndex === 0,
      `HTTP ${rejectRes.status} status=${rejected.status}`);
  } catch (err) {
    check('复测证据单业务冒烟', false, String(err));
  }

  return results;
}

import { pathToFileURL } from 'node:url';

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const base = process.env.BASE_URL || 'http://127.0.0.1:8080';
  console.log(`[smoke] 目标服务: ${base}`);
  const results = await runSmoke(base);
  for (const r of results) {
    console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ` — ${r.detail}`}`);
  }
  const ok = results.every((r) => r.ok);
  console.log(ok ? '[smoke] 全部通过' : '[smoke] 存在失败项');
  process.exit(ok ? 0 : 1);
}
