// Transaction view (docs/landscape-transactions-plan.md): a transaction as a bridge in the air
// above its block, magenta ribbons rising from the coins it spent and white ribbons falling to the
// coins it made (ui/tx-layout.js, render/tx-ribbons.js), and a card listing every input and output.
//
// The card shares the inspector's panel (#inspector) and shows while no cell is inspected: a cell
// clicked under a ribbon opens over it, and closing the cell brings the transaction back. Answers
// come from /api/landscape/tx (the landscape Worker running the 2D explorer's lookup code) and are
// kept for the session. Opening a transaction pauses playback, seeks to its block and frames it;
// ← tx and tx → open the transaction that made or spent a coin and keep the ones before as a dim
// trail. Nothing is drawn at a block before a transaction, as in the 2D explorer.
import { groupTx, txCurves, framedPoints, frameTx, ribbonStyle } from './tx-layout.js';
import { fmtInt, fmtBtc, isoUtc, escapeHtml } from './format.js';
import { SHARE_ICON } from './share.js';
import { Vector3 } from 'three';

export const TXID = /^[0-9a-f]{64}$/;
export const TRAIL = 8;              // earlier transactions kept as a dim trail
const TRAIL_RIBBONS = 40;            // ribbons per side of a trail transaction
const PREVIEW_ROWS = 12;             // rows listed before "All n"
const REBUILD_MS = 500;              // a changed block or terrain rebuilds the ribbons at most this often
const PICK_PX = 8;                   // a pointer this close to a ribbon lights it
const ONLINE = 'https://bitcoinlandscape.com/';
const EXPLORER_2D = 'https://bitcointimelapse.com/explorer';
const VIEW = { yaw: 0, pitch: -32 }; // framing direction: from the small amounts, looking down
const EYE_CLEARANCE = 10;            // the framed camera stays this high above the terrain around the bridge
const MIN_DISTANCE = 40;             // even a small transaction is framed with the land around it
// Linear colours. Inputs: the 2D explorer's magenta (#ff3df2). Outputs: white over a black
// casing, or dark ink over a white casing on a light ground (Paper).
const IN = [1, 0.047, 0.888];
const OUT = [0.92, 0.92, 0.92];
const INK = [0.01, 0.012, 0.018];
const REST = [0.42, 0.42, 0.47];
const BLACK = [0, 0, 0];
const WHITE = [1, 1, 1];

const amountCell = (sat) => '<td class="in-amount"><span class="in-cell-main">' + escapeHtml(fmtBtc(sat)) + '</span></td>';

export function createTxView({
  container, ribbons, camera, canvas, heightAt, rows, blocktimes, apiBase, local = false,
  seek, pause = () => {}, getBlock, poseLookingAt, flyTo, lightGround = () => false, inspectorOpen = () => false,
  closeInspector = () => {}, onChange = () => {}, onShare = () => {}, onRender = () => {}, signature = () => '', notice = () => {},
  fetchImpl = (...a) => fetch(...a),
}) {
  const answers = new Map(); // txid -> answer, for the session
  let cur = null;            // {answer, mark} of the open transaction
  let trail = [];            // earlier {answer, mark}, oldest first
  let loading = null;        // txid being looked up
  let failure = null;        // {txid, message, online} of a failed open
  let choices = null;        // {created, sat, matches}: outputs of one amount to pick from
  let seq = 0;
  let built = null;          // {block, at, signature} of the ribbons drawn
  let dirty = false;
  let drawn = null;          // {group, curves, nIn} of the open transaction as drawn
  let rowHover = -1, pickHover = -1, pointer = null, pointerMoved = false;
  const card = document.createElement('div');
  card.className = 'tx-card';
  const v3 = new Vector3();

  async function lookup(path) {
    let r = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        r = await fetchImpl(apiBase + path);
      } catch {
        return { offline: true };
      }
      // A lookup that reaches mempool.space is limited to one every two seconds after a short burst.
      if (r.status !== 429 || attempt) break;
      await new Promise((ok) => setTimeout(ok, 2100));
    }
    let body = null;
    try {
      body = await r.json();
    } catch { /* not JSON */ }
    if (r.ok && body && !body.error) return { body };
    // The native explorer of a local run answers no transaction lookups.
    if (local && (r.status === 501 || (r.status === 404 && !/transaction/i.test(body?.error || '')))) return { offline: true };
    if (r.status === 429) return { error: 'Too many lookups at once. Wait a few seconds and try again.' };
    return { error: body?.error || 'The lookup failed (' + r.status + ').' };
  }

  /** {kind: 'in' | 'out', row} of the marked coin in an answer, or null. */
  function markedRow(t) {
    if (!t.mark) return null;
    const [txid, vout] = t.mark.split(':');
    if (txid === t.answer.txid) {
      const j = t.answer.outputs.findIndex((o) => String(o.vout) === vout);
      return j >= 0 ? { kind: 'out', row: j } : null;
    }
    const i = t.answer.inputs.findIndex((p) => p.txid === txid && String(p.vout) === vout);
    return i >= 0 ? { kind: 'in', row: i } : null;
  }

  // ---- ribbons -----------------------------------------------------------------------------
  function curvesOf(t, dim, out) {
    const group = groupTx(t.answer, rows, getBlock(), dim ? { cap: TRAIL_RIBBONS } : undefined);
    if (!group) return null;
    const { curves, top } = txCurves(group, heightAt);
    const light = lightGround();
    const outColor = light ? INK : OUT;
    const outCase = light ? WHITE : BLACK;
    const nIn = group.inputs.length;
    const m = markedRow(t);
    const markedRibbon = m ? (m.kind === 'in' ? group.inRibbon : group.outRibbon)[m.row] : -1;
    for (const c of curves) {
      let style, color = outColor, casing = outCase, id = -1;
      if (c.kind === 'in' || c.kind === 'out') {
        const side = c.kind === 'in' ? group.inputs : group.outputs;
        style = ribbonStyle(side[c.ribbon].sat, c.kind === 'in' ? group.inSat : group.outSat, side.length);
        if (c.kind === 'in') [color, casing] = [IN, BLACK];
        if (!dim) id = c.kind === 'in' ? c.ribbon : nIn + c.ribbon;
        if (m && m.kind === c.kind && markedRibbon === c.ribbon) style = { px: style.px + 2.5, alpha: 1 };
      } else if (c.kind === 'rest') {
        style = { px: ribbonStyle(group.rest.sat, group.inSat, 1).px, alpha: 0.9 };
        [color, casing] = [REST, BLACK];
      } else style = c.kind === 'bridge' ? { px: 5, alpha: 0.95 } : { px: 1.5, alpha: 0.55 };
      const alpha = dim ? style.alpha * 0.3 : style.alpha;
      out.push({ p: c.p, px: dim ? style.px * 0.7 : style.px, color: [...color, alpha], casing: [...casing, alpha * 0.75], id, dash: c.kind === 'rest' });
    }
    return { group, curves, nIn, top };
  }

  function rebuild() {
    dirty = false;
    const block = getBlock();
    built = { block, at: performance.now(), signature: signature() };
    const list = [];
    for (const t of trail) if (t.answer.height <= block) curvesOf(t, true, list);
    drawn = cur ? curvesOf(cur, false, list) : null;
    ribbons.set(list);
    applyHover();
    onRender();
  }

  // ---- camera ------------------------------------------------------------------------------
  /** Flies to a pose that holds the bridge and the ribbons carrying most of the value, beside the card. */
  function frame() {
    if (!drawn) return Promise.resolve();
    const c = canvas.getBoundingClientRect();
    const k = container.hidden ? null : container.getBoundingClientRect();
    // The part of the canvas the card leaves free: left of a side card, above a bottom sheet.
    let [left, top, right, bottom] = [c.left, c.top, c.right, c.bottom];
    if (k && k.width && k.left > c.left + 0.4 * c.width) right = Math.min(right, k.left);
    else if (k && k.height && k.top > c.top + 0.3 * c.height) bottom = Math.min(bottom, k.top);
    const w = Math.max(1, right - left), h = Math.max(1, bottom - top);
    const tanV = Math.tan((camera.fov * Math.PI) / 360);
    const tanH = tanV * (c.width / Math.max(1, c.height));
    const fovDeg = (2 * Math.atan(tanV * (h / Math.max(1, c.height))) * 180) / Math.PI;
    const { target, distance } = frameTx(framedPoints(drawn.group, drawn.curves), { fovDeg, aspect: w / h, yawDeg: VIEW.yaw, pitchDeg: VIEW.pitch, minDistance: MIN_DISTANCE, minEye: drawn.top + EYE_CLEARANCE });
    const pose = poseLookingAt(target, { distance, yaw: VIEW.yaw, pitch: VIEW.pitch });
    // Shift the camera parallel to the screen so the target shows at the free part's centre.
    const ox = ((left + right) / 2 - (c.left + c.right) / 2) / (c.width / 2);
    const oy = ((c.top + c.bottom) / 2 - (top + bottom) / 2) / (c.height / 2);
    const yaw = (VIEW.yaw * Math.PI) / 180, pitch = (VIEW.pitch * Math.PI) / 180;
    const rightV = [Math.cos(yaw), 0, -Math.sin(yaw)];
    const upV = [Math.sin(yaw) * Math.sin(pitch), Math.cos(pitch), Math.cos(yaw) * Math.sin(pitch)];
    const s = -ox * distance * tanH, u = -oy * distance * tanV;
    pose.position.x += rightV[0] * s + upV[0] * u;
    pose.position.y += rightV[1] * s + upV[1] * u;
    pose.position.z += rightV[2] * s + upV[2] * u;
    return flyTo(pose);
  }

  // ---- card --------------------------------------------------------------------------------
  function head(title, sub) {
    return '<div class="in-head"><div><span class="eyebrow">Transaction</span><h2>' + title + '</h2><p class="in-sub">' + sub + '</p></div>' +
      '<div class="tx-head-actions">' + (cur ? '<button class="icon-btn" type="button" data-tx-share aria-label="Share this transaction" title="Share this transaction">' + SHARE_ICON + '</button>' : '') +
      '<button class="icon-btn" type="button" data-tx-close aria-label="Close transaction">\u00d7</button></div></div>';
  }

  function rowsTable(kind, list, label, cells) {
    const n = list.length;
    const body = (part) => part.map(cells).join('');
    const table = (part) => '<table class="in-table tx-table"><colgroup><col class="tx-col-amount"><col><col class="tx-col-hop"></colgroup><thead><tr><th scope="col">Amount</th><th scope="col">' + label + '</th><th scope="col" aria-label="Transaction"></th></tr></thead><tbody>' + body(part) + '</tbody></table>';
    return table(list.slice(0, PREVIEW_ROWS)) +
      (n > PREVIEW_ROWS ? '<details class="in-disclosure tx-all" data-all="' + kind + '"><summary>All ' + fmtInt(n) + ' ' + kind + '</summary>' + table(list.slice(PREVIEW_ROWS)) + '</details>' : '');
  }

  function cardHtml() {
    if (choices) {
      return head('Pick an output', fmtInt(choices.matches.length) + ' outputs of ' + escapeHtml(fmtBtc(choices.sat)) + ' were created in block ' + fmtInt(choices.created)) +
        '<section class="in-sec"><div class="tx-choices">' + choices.matches.map((m) =>
          '<button type="button" class="tx-hop" data-tx-pick="' + m.txid + '" data-tx-mark="' + m.txid + ':' + m.vout + '">' + m.txid.slice(0, 16) + '\u2026 output ' + m.vout + '</button>').join('') + '</div></section>';
    }
    if (!cur) {
      const txid = loading || failure?.txid || '';
      let html = head(loading ? 'Looking up\u2026' : 'Not drawn', '<span class="tx-id">' + txid + '</span>');
      if (failure?.online) {
        html += '<section class="in-sec"><p class="in-muted">Transactions are drawn in the online landscape, which looks them up.</p>' +
          '<div class="in-links"><a href="' + ONLINE + '#tx=' + txid + '" target="_blank" rel="noopener">Open it at bitcoinlandscape.com \u2197</a></div></section>';
      } else if (failure) html += '<section class="in-sec"><p class="in-warn" role="status">' + escapeHtml(failure.message) + '</p></section>';
      return html;
    }
    const t = cur.answer;
    const date = Number.isFinite(blocktimes?.[t.height]) ? isoUtc(blocktimes[t.height]) : '';
    const sum = (list) => list.reduce((s, p) => s + p.satoshi, 0);
    const inSat = sum(t.inputs), outSat = sum(t.outputs);
    const g = drawn?.group;
    const m = markedRow(cur);
    let html = head('Block ' + fmtInt(t.height), '<span class="tx-id">' + t.txid + '</span>' + (date ? '<br>' + escapeHtml(date) : ''));
    if (loading) html += '<p class="in-more" role="status">Looking up the next transaction\u2026</p>';
    if (getBlock() < t.height) {
      html += '<p class="in-warn" role="status">This transaction is in block ' + fmtInt(t.height) + ', after the block shown. <button type="button" class="tx-hop" data-tx-go>Go to block ' + fmtInt(t.height) + '</button></p>';
    }
    html += '<section class="in-sec"><dl class="in-grid">' +
      '<div><dt><i class="tx-key tx-key-in"></i>Inputs</dt><dd>' + (t.coinbase ? 'Newly mined' : fmtInt(t.inputs.length) + ' \u00b7 ' + escapeHtml(fmtBtc(inSat))) + '</dd></div>' +
      '<div><dt><i class="tx-key tx-key-out"></i>Outputs</dt><dd>' + fmtInt(t.outputs.length) + ' \u00b7 ' + escapeHtml(fmtBtc(outSat)) + '</dd></div>' +
      (t.coinbase ? '' : '<div><dt>Fee</dt><dd>' + escapeHtml(fmtBtc(inSat - outSat)) + '</dd></div>') +
      '<div><dt>Spent since</dt><dd>' + fmtInt(t.outputs.filter((o) => o.spent).length) + ' of ' + fmtInt(t.outputs.length) + ' outputs</dd></div></dl>';
    const undated = t.inputs.filter((p) => p.satoshi > 0 && p.height == null);
    if (undated.length) html += '<p class="in-more">' + fmtInt(undated.length) + ' ' + (undated.length === 1 ? 'input arrives' : 'inputs arrive') + ' on the dashed grey stub (' + escapeHtml(fmtBtc(sum(undated))) + '): outputs of the same amount but different ages were spent in this block, and the lookup stopped before placing them.</p>';
    if (t.inputs.some((p) => p.shared)) html += '<p class="in-more">* Inputs of one amount whose blocks are known together: each ribbon is in the right place, but which input came from which of those blocks is not.</p>';
    if (g && [...g.inputs, ...g.outputs].some((r) => r.level > 0)) html += '<p class="in-more">The smallest coins share coarser ribbons so the largest stay apart; every coin is listed below.</p>';
    html += '</section>';
    const order = (list, kind) => list.map((p, i) => i).sort((a, b) => (m && m.kind === kind ? (b === m.row) - (a === m.row) : 0) || list[b].satoshi - list[a].satoshi);
    const rid = (kind, i) => {
      const k = g ? (kind === 'in' ? g.inRibbon : g.outRibbon)[i] : -1;
      return k >= 0 ? (kind === 'in' ? k : drawn.nIn + k) : -1;
    };
    const tr = (kind, i, cells) => '<tr' + (rid(kind, i) >= 0 ? ' data-r="' + rid(kind, i) + '"' : '') + (m && m.kind === kind && m.row === i ? ' class="tx-marked"' : '') + '>' + cells + '</tr>';
    if (!t.coinbase) {
      html += '<section class="in-sec"><h3>Inputs <span>Coins it spent \u00b7 largest first</span></h3>' + rowsTable('inputs', order(t.inputs, 'in'), 'Created', (i) => {
        const p = t.inputs[i];
        const created = p.height == null ? '<span class="in-cell-main">\u2014</span><small>dashed stub</small>' : '<span class="in-cell-main">' + fmtInt(p.height) + (p.shared ? '*' : '') + '</span>';
        return tr('in', i, amountCell(p.satoshi) + '<td>' + created + '</td><td><button type="button" class="tx-hop" data-tx-open="' + p.txid + '" data-tx-mark="' + p.txid + ':' + p.vout + '" aria-label="Open the transaction that created this input">\u2190 tx</button></td>');
      }) + '</section>';
    }
    html += '<section class="in-sec"><h3>Outputs <span>Coins it made \u00b7 largest first</span></h3>' + rowsTable('outputs', order(t.outputs, 'out'), 'Spent', (j) => {
      const o = t.outputs[j];
      const spent = o.spent ? '<span class="in-cell-main">' + fmtInt(o.spent.height) + '</span>' : '<span class="in-cell-main tx-unspent">unspent</span>';
      const hop = o.spent ? '<button type="button" class="tx-hop" data-tx-open="' + o.spent.txid + '" data-tx-mark="' + t.txid + ':' + o.vout + '" aria-label="Open the transaction that spent this output">tx \u2192</button>' : '';
      return tr('out', j, amountCell(o.satoshi) + '<td>' + spent + '</td><td>' + hop + '</td>');
    }) + '</section>';
    if (trail.length) html += '<p class="in-more">' + fmtInt(trail.length) + (trail.length === 1 ? ' earlier transaction stays' : ' earlier transactions stay') + ' as a dim trail.</p>';
    html += '<div class="in-links"><a href="' + EXPLORER_2D + '?tx=' + t.txid + '" target="_blank" rel="noopener">Open in the 2D explorer \u2197</a>' +
      '<a href="https://mempool.space/tx/' + t.txid + '" target="_blank" rel="noopener">mempool.space \u2197</a></div>';
    return html;
  }

  function renderCard() {
    // A list opened with "All n" stays open while the same transaction is shown again.
    const keep = card.dataset.txid === (cur?.answer.txid || '') ? new Set([...card.querySelectorAll('details[open]')].map((d) => d.dataset.all)) : new Set();
    card.innerHTML = cardHtml();
    card.dataset.txid = cur?.answer.txid || '';
    for (const d of card.querySelectorAll('details[data-all]')) d.open = keep.has(d.dataset.all);
    applyHover();
  }

  function showCard() {
    if (inspectorOpen() || !(cur || loading || failure || choices)) return;
    if (card.parentNode !== container) container.replaceChildren(card);
    container.hidden = false;
    document.body.classList.add('inspector-open', 'inspector-front');
  }

  function hideCard() {
    if (card.parentNode !== container) return;
    container.replaceChildren();
    container.hidden = true;
    document.body.classList.remove('inspector-open', 'inspector-front');
  }

  function applyHover() {
    const id = rowHover >= 0 ? rowHover : pickHover;
    if (ribbons.highlighted !== id) {
      ribbons.highlight(id);
      onRender();
    }
    for (const el of card.querySelectorAll('tr.tx-hot')) el.classList.remove('tx-hot');
    if (id >= 0) for (const el of card.querySelectorAll('tr[data-r="' + id + '"]')) el.classList.add('tx-hot');
  }

  card.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.matches('[data-tx-close]')) return api.close();
    if (b.matches('[data-tx-share]')) return onShare();
    if (b.matches('[data-tx-go]')) return void seek(cur.answer.height);
    if (b.matches('[data-tx-open], [data-tx-pick]')) {
      const txid = b.dataset.txOpen || b.dataset.txPick;
      api.open(txid, { mark: b.dataset.txMark, hop: b.matches('[data-tx-open]') }).catch((err) => notice(err.message || String(err), 'warn', 'tx'));
    }
  });
  card.addEventListener('pointerover', (e) => {
    const row = e.target.closest('tr[data-r]');
    const id = row ? Number(row.dataset.r) : -1;
    if (id !== rowHover) {
      rowHover = id;
      applyHover();
    }
  });
  card.addEventListener('pointerleave', () => {
    rowHover = -1;
    applyHover();
  });
  canvas.addEventListener('pointermove', (e) => {
    pointer = { x: e.clientX, y: e.clientY };
    pointerMoved = true;
  });
  canvas.addEventListener('pointerleave', () => {
    pointer = null;
    pointerMoved = true;
  });

  /** The ribbon id nearest the pointer within PICK_PX, or -1. */
  function pickAt(x, y) {
    const picks = ribbons.picks;
    if (!picks.length || !drawn) return -1;
    const r = canvas.getBoundingClientRect();
    const screen = new Float32Array((picks.length / 4) * 3);
    for (let i = 0, j = 0; i < picks.length; i += 4, j += 3) {
      v3.set(picks[i + 1], picks[i + 2], picks[i + 3]).project(camera);
      screen[j] = r.left + ((v3.x + 1) / 2) * r.width;
      screen[j + 1] = r.top + ((1 - v3.y) / 2) * r.height;
      screen[j + 2] = v3.z;
    }
    let best = -1, bestD = PICK_PX;
    for (let i = 0, j = 0; i + 4 < picks.length; i += 4, j += 3) {
      if (picks[i] !== picks[i + 4] || Math.abs(screen[j + 2]) > 1 || Math.abs(screen[j + 5]) > 1) continue;
      const ax = screen[j], ay = screen[j + 1], bx = screen[j + 3], by = screen[j + 4];
      const dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
      const d = Math.hypot(x - ax - t * dx, y - ay - t * dy);
      if (d < bestD) {
        bestD = d;
        best = picks[i];
      }
    }
    return best;
  }

  const api = {
    get isOpen() {
      return !!cur;
    },
    /** A transaction, a lookup, a failed lookup or a pick list holds the card (Esc closes it). */
    get active() {
      return !!(cur || loading || failure || choices);
    },
    /** The open transaction's txid, or null. */
    get txid() {
      return cur ? cur.answer.txid : null;
    },
    /** For the share dialog: the open transaction in a few words. */
    get description() {
      return cur ? 'Transaction ' + cur.answer.txid.slice(0, 16) + '\u2026 \u00b7 block ' + fmtInt(cur.answer.height) : '';
    },
    /** Test hook and session cache: answers given here are never looked up. */
    seed(answer) {
      if (answer && TXID.test(answer.txid)) answers.set(answer.txid, answer);
    },
    /** Checks: the open transaction's bridge and framed control points ([[x, y, z], ...]), or null. */
    framed() {
      if (!drawn) return null;
      const bridge = drawn.curves.find((c) => c.kind === 'bridge').p;
      return { bridge: [bridge.slice(0, 3), bridge.slice(9)], points: framedPoints(drawn.group, drawn.curves) };
    },
    /** Checks: where ribbon id crosses the middle of its length on screen (CSS px), or null. */
    screenPoint(id) {
      const picks = ribbons.picks;
      for (let i = 0; i < picks.length; i += 4) {
        if (picks[i] !== id) continue;
        const k = i + 4 * 4; // the middle of its nine samples
        v3.set(picks[k + 1], picks[k + 2], picks[k + 3]).project(camera);
        const r = canvas.getBoundingClientRect();
        return { x: r.left + ((v3.x + 1) / 2) * r.width, y: r.top + ((1 - v3.y) / 2) * r.height };
      }
      return null;
    },
    get state() {
      return {
        txid: api.txid, height: cur ? cur.answer.height : null, loading, failure: failure && { ...failure }, choices: !!choices,
        trail: trail.map((t) => t.answer.txid), built: built && built.block,
        ribbons: drawn ? { in: drawn.group.inputs.length, out: drawn.group.outputs.length, rest: drawn.group.rest.count } : null,
        vertices: ribbons.vertices, highlighted: ribbons.highlighted, cardShown: card.parentNode === container && !container.hidden,
      };
    },
    /**
     * Open a transaction. mark: "txid:vout" of the coin to light. block: the block to show (its own
     * block by default). frame: fly the camera to it. hop: it was reached from the open one, which
     * then joins the trail; any other open starts a new trail.
     */
    async open(txid, { mark = null, block = null, frame: framing = true, hop = false } = {}) {
      txid = String(txid || '').trim().toLowerCase();
      if (!TXID.test(txid)) throw new Error('A transaction id is 64 hexadecimal characters.');
      const my = ++seq;
      pause();
      choices = null;
      let answer = answers.get(txid);
      if (!answer) {
        loading = txid;
        if (!hop) {
          cur = null;
          failure = null;
          trail = [];
          rebuild();
        }
        renderCard();
        showCard();
        const res = await lookup('/api/landscape/tx?txid=' + txid);
        if (my !== seq) return null;
        loading = null;
        if (!res.body) {
          if (hop && cur) {
            renderCard();
            notice(res.offline ? 'Transactions are drawn in the online landscape.' : res.error, 'warn', 'tx');
            return null;
          }
          failure = { txid, message: res.error || '', online: !!res.offline };
          renderCard();
          showCard();
          onChange();
          return null;
        }
        answer = res.body;
        answers.set(txid, answer);
      }
      if (hop && cur && cur.answer.txid !== txid) trail = trail.concat(cur);
      else if (!hop) trail = [];
      trail = trail.filter((t) => t.answer.txid !== txid).slice(-TRAIL);
      cur = { answer, mark: mark || null };
      failure = null;
      rowHover = pickHover = -1;
      const target = Number.isInteger(block) ? block : answer.height;
      rebuild();
      renderCard();
      showCard();
      card.scrollTop = 0;
      container.scrollTop = 0;
      onChange();
      if (getBlock() !== target) await seek(target);
      if (my !== seq) return null;
      rebuild();
      renderCard();
      if (framing) await frame();
      if (my !== seq) return null;
      rebuild();
      return answer;
    },
    /** Open the transaction that created the output of sat created in block created (the inspector's Trace). */
    async trace(created, sat) {
      const my = ++seq;
      notice('Looking up the transaction that created this output\u2026', 'info', 'tx');
      const res = await lookup('/api/landscape/txid?height=' + created + '&satoshi=' + sat);
      if (my !== seq) return null;
      if (!res.body) {
        notice(res.offline ? 'Tracing a coin needs the online landscape at bitcoinlandscape.com.' : res.error, 'warn', 'tx');
        return null;
      }
      const matches = res.body.matches || [];
      if (!matches.length) {
        notice('No output of ' + fmtBtc(sat) + ' was created in block ' + fmtInt(created) + '.', 'warn', 'tx');
        return null;
      }
      // The answer takes the panel from the cell it was traced from.
      closeInspector();
      if (matches.length === 1) return api.open(matches[0].txid, { mark: matches[0].txid + ':' + matches[0].vout });
      choices = { created, sat, matches };
      renderCard();
      showCard();
      return null;
    },
    close() {
      seq++;
      cur = null;
      trail = [];
      loading = null;
      failure = null;
      choices = null;
      rowHover = pickHover = -1;
      rebuild();
      hideCard();
      onChange();
    },
    /** The inspector closed: the transaction's card takes the panel back. */
    showCard() {
      if (cur || failure || choices) {
        renderCard();
        showCard();
      }
    },
    /** Settings changed (look, heights, ground colour): rebuild the ribbons soon. */
    refresh() {
      dirty = true;
    },
    /** Per frame, before drawing: ribbon widths, rebuilds and the ribbon under the pointer. */
    update(now = performance.now()) {
      if (!cur && !trail.length) return;
      ribbons.update(camera, canvas.clientHeight);
      const stale = !built || dirty || getBlock() !== built.block || (now - built.at > 1000 && signature() !== built.signature);
      if (stale && now - (built ? built.at : 0) > REBUILD_MS) {
        // The card changes only when the view crosses the transaction's block.
        const wasBefore = !!(built && cur && built.block < cur.answer.height);
        rebuild();
        if (cur && wasBefore !== built.block < cur.answer.height) renderCard();
      }
      if (pointerMoved) {
        pointerMoved = false;
        const id = pointer ? pickAt(pointer.x, pointer.y) : -1;
        if (id !== pickHover) {
          pickHover = id;
          applyHover();
        }
      }
    },
  };
  return api;
}
