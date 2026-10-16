// Physics, canvas drawing, and control bindings only. Page structure is owned by the shell.
export function mount(ui) {
    const document = ui;
    const T = SimLib.Theme.use('light');


// ═══════════════════════════════════════════════
//  SETUP
// ═══════════════════════════════════════════════
const canvas = document.getElementById('circuitCanvas');
const ctx = canvas.getContext('2d');
const W = canvas.width, H = canvas.height;

const GRID   = 10;      // grid snap
const JOIN   = 12;      // distance at which two endpoints connect
const SPLIT  = 8;       // distance at which an endpoint splits a wire
const HANDLE = 12;      // click radius for an endpoint
const HIT    = 15;      // click radius for a part body
const GMIN   = 1e-9;    // tiny leak conductance (keeps the math well behaved)
const WIRE_R = 1e-3;    // wire resistance (ohms)
const BULB_R = 10;      // bulb resistance (ohms)
const BATT_R = 0.5;     // battery internal resistance (ohms)

const DEF = {
    battery:  { len: 70, voltage: 9 },
    resistor: { len: 70, resistance: 100 },
    bulb:     { len: 70 },
    switch:   { len: 60 },
    wire:     { len: 90 }
};

let comps = [];         // every part on the board
let nextId = 1;
let tool = 'select';    // 'select' | 'wire' | 'battery' | 'bulb' | 'resistor' | 'switch' | 'delete'
let selected = null;
let drag = null;
let hoverEp = null;     // endpoint under the pointer
let ghost = null;       // preview while dragging a part from the toolbox
let showCurrent = true;
let showValues = false;
let phase = 0;          // animation clock (seconds)
let lastTs = 0;
let animId = null;
let net = null;         // latest circuit solution
let dirty = true;       // topology changed -> re-solve

// ═══════════════════════════════════════════════
//  MODEL
// ═══════════════════════════════════════════════
function makeComp(type, ax, ay, bx, by) {
    const c = { id: nextId++, type, a: { x: ax, y: ay }, b: { x: bx, y: by } };
    if (type === 'battery')  c.voltage = DEF.battery.voltage;
    if (type === 'resistor') c.resistance = DEF.resistor.resistance;
    if (type === 'bulb')     c.resistance = BULB_R;
    if (type === 'switch')   c.closed = true;
    return c;
}

function defaultComp(type, cx, cy) {
    const L = DEF[type].len;
    return makeComp(type, cx - L / 2, cy, cx + L / 2, cy);
}

function removeComp(c) {
    const i = comps.indexOf(c);
    if (i >= 0) comps.splice(i, 1);
    if (selected === c) select(null);
    dirty = true;
}

// ═══════════════════════════════════════════════
//  GEOMETRY HELPERS
// ═══════════════════════════════════════════════
function cLen(c) { return Math.hypot(c.b.x - c.a.x, c.b.y - c.a.y) || 1; }
function cUnit(c) { const L = cLen(c); return { x: (c.b.x - c.a.x) / L, y: (c.b.y - c.a.y) / L }; }
function cMid(c)  { return { x: (c.a.x + c.b.x) / 2, y: (c.a.y + c.b.y) / 2 }; }

function distToSeg(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy;
    let t = L2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = x1 + t * dx, cy = y1 + t * dy;
    return { d: Math.hypot(px - cx, py - cy), x: cx, y: cy, t };
}

function snapGrid(v) { return Math.round(v / GRID) * GRID; }

function nearestEndpoint(x, y, radius, exclude) {
    let best = null, bd = radius;
    for (const c of comps) {
        if (c === exclude) continue;
        for (const end of ['a', 'b']) {
            const p = c[end];
            const d = Math.hypot(p.x - x, p.y - y);
            if (d < bd) { bd = d; best = { comp: c, end }; }
        }
    }
    return best;
}

// Snap a point onto a nearby endpoint, or to the grid.
function snapPoint(x, y, exclude) {
    const ep = nearestEndpoint(x, y, JOIN, exclude);
    if (ep) { const p = ep.comp[ep.end]; return { x: p.x, y: p.y }; }
    return { x: snapGrid(x), y: snapGrid(y) };
}

function compAt(x, y) {
    let best = null, bd = HIT;
    for (const c of comps) {
        let d = distToSeg(x, y, c.a.x, c.a.y, c.b.x, c.b.y).d;
        if (c.type === 'bulb') {
            const m = cMid(c);
            d = Math.min(d, Math.abs(Math.hypot(m.x - x, m.y - y) - 15));
        }
        if (d < bd) { bd = d; best = c; }
    }
    return best;
}

function toCanvas(e) {
    const r = canvas.getBoundingClientRect();
    return {
        x: (e.clientX - r.left) * (W / r.width),
        y: (e.clientY - r.top) * (H / r.height)
    };
}

// ═══════════════════════════════════════════════
//  CIRCUIT SOLVER  (Modified Nodal Analysis)
// ═══════════════════════════════════════════════
function gauss(A, b) {
    const n = b.length;
    for (let col = 0; col < n; col++) {
        let piv = col;
        for (let r = col + 1; r < n; r++) {
            if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
        }
        if (Math.abs(A[piv][col]) < 1e-14) return null;
        if (piv !== col) {
            const t = A[piv]; A[piv] = A[col]; A[col] = t;
            const tb = b[piv]; b[piv] = b[col]; b[col] = tb;
        }
        const pv = A[col][col];
        for (let r = col + 1; r < n; r++) {
            const f = A[r][col] / pv;
            if (f === 0) continue;
            for (let cc = col; cc < n; cc++) A[r][cc] -= f * A[col][cc];
            b[r] -= f * b[col];
        }
    }
    const x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
        let s = b[i];
        for (let j = i + 1; j < n; j++) s -= A[i][j] * x[j];
        x[i] = s / A[i][i];
    }
    return x;
}

function bulbResistance(c) { return Math.max(0.1, c.resistance || BULB_R); }

// ─── Short-circuit detection ───────────────────────────────────────────
// Union-find with voltage potentials. Wires and closed switches force the
// same voltage at both ends; a battery forces a fixed voltage drop. If a
// loop made only of these parts gives contradictory constraints, its net
// voltage is not zero, so it drives current with no resistance to limit it.
// (A resistor or bulb in the loop breaks the chain and is not a short.)
function detectShort(sources, nodeCount) {
    const parent = new Array(nodeCount);
    const pot = new Array(nodeCount);
    for (let i = 0; i < nodeCount; i++) { parent[i] = i; pot[i] = 0; }

    function find(x) {
        if (parent[x] === x) return x;
        const p = parent[x];
        const r = find(p);
        pot[x] += pot[p];
        parent[x] = r;
        return r;
    }
    function union(x, y, diff) {           // true -> contradiction
        const rx = find(x), ry = find(y);
        if (rx === ry) return Math.abs((pot[x] - pot[y]) - diff) > 1e-6;
        parent[rx] = ry;
        pot[rx] = diff - pot[x] + pot[y];
        return false;
    }

    for (const c of comps) {
        if (c.type === 'wire') union(c.na, c.nb, 0);
        else if (c.type === 'switch' && c.closed) union(c.na, c.nb, 0);
    }
    const conflicts = [];
    for (const s of sources) {
        if (union(s.na, s.nb, s.voltage)) conflicts.push(s);
    }

    const parts = new Set();
    if (!conflicts.length) return { short: false, parts };

    // Walk back each offending loop so those parts can be drawn in red.
    const adj = new Map();
    function link(u, v, c) {
        if (!adj.has(u)) adj.set(u, []);
        adj.get(u).push({ to: v, comp: c });
    }
    for (const c of comps) {
        if (c.type === 'wire' || c.type === 'battery' || (c.type === 'switch' && c.closed)) {
            link(c.na, c.nb, c);
            link(c.nb, c.na, c);
        }
    }
    for (const cd of conflicts) {
        parts.add(cd);
        const prev = new Map([[cd.na, null]]);
        const queue = [cd.na];
        while (queue.length) {
            const u = queue.shift();
            if (u === cd.nb) break;
            for (const e of (adj.get(u) || [])) {
                if (e.comp === cd) continue;
                if (!prev.has(e.to)) { prev.set(e.to, { from: u, comp: e.comp }); queue.push(e.to); }
            }
        }
        let cur = cd.nb;
        while (prev.has(cur) && prev.get(cur)) {
            const p = prev.get(cur);
            parts.add(p.comp);
            cur = p.from;
        }
    }
    return { short: true, parts };
}

function solve() {
    // Group endpoints that sit on top of one another into electrical nodes.
    const nodes = [];
    function nodeIndex(x, y) {
        for (let i = 0; i < nodes.length; i++) {
            if (Math.abs(nodes[i].x - x) < JOIN && Math.abs(nodes[i].y - y) < JOIN) return i;
        }
        nodes.push({ x, y });
        return nodes.length - 1;
    }
    for (const c of comps) {
        c.na = nodeIndex(c.a.x, c.a.y);
        c.nb = nodeIndex(c.b.x, c.b.y);
    }

    const sources = comps.filter(c => c.type === 'battery');
    // Each battery gets an internal node for its series internal resistance.
    for (const s of sources) { nodes.push({ x: s.a.x, y: s.a.y }); s.nm = nodes.length - 1; }

    const N = nodes.length;
    const M = sources.length;
    const size = N + M;
    if (size === 0) { net = { cur: new Map(), total: 0, battV: 0, req: Infinity, power: 0, short: false, shortParts: new Set() }; return; }

    const sh = detectShort(sources, N);

    const A = [], b = new Array(size).fill(0);
    for (let i = 0; i < size; i++) A.push(new Array(size).fill(0));

    function stampG(i, j, g) {
        A[i][i] += g; A[j][j] += g; A[i][j] -= g; A[j][i] -= g;
    }

    // Two-terminal parts as conductances.
    for (const c of comps) {
        if (c.type === 'wire')          stampG(c.na, c.nb, 1 / WIRE_R);
        else if (c.type === 'resistor') stampG(c.na, c.nb, 1 / Math.max(0.01, c.resistance));
        else if (c.type === 'bulb')     stampG(c.na, c.nb, 1 / bulbResistance(c));
        else if (c.type === 'switch' && c.closed) stampG(c.na, c.nb, 1 / WIRE_R);
    }

    // Batteries: ideal source between + terminal (a) and internal node, then internal R.
    sources.forEach((s, k) => {
        const idx = N + k;
        A[s.na][idx] += 1; A[s.nm][idx] -= 1;
        A[idx][s.na] += 1; A[idx][s.nm] -= 1;
        b[idx] = s.voltage;
        stampG(s.nm, s.nb, 1 / BATT_R);
    });

    for (let i = 0; i < N; i++) A[i][i] += GMIN;

    // Ground node 0.
    for (let j = 0; j < size; j++) A[0][j] = 0;
    A[0][0] = 1; b[0] = 0;

    const v = gauss(A, b);
    if (!v) { net = null; return; }

    const cur = new Map();
    for (const c of comps) {
        if (c.type === 'wire')          cur.set(c, (v[c.na] - v[c.nb]) / WIRE_R);
        else if (c.type === 'resistor') cur.set(c, (v[c.na] - v[c.nb]) / Math.max(0.01, c.resistance));
        else if (c.type === 'bulb')     cur.set(c, (v[c.na] - v[c.nb]) / bulbResistance(c));
        else if (c.type === 'switch')   cur.set(c, c.closed ? (v[c.na] - v[c.nb]) / WIRE_R : 0);
    }

    let battV = 0, battI = 0;
    sources.forEach((s, k) => {
        const I = v[N + k];          // current leaving the + terminal through the source
        cur.set(s, I);               // signed a->b (negative means it flows b->a inside the part)
        battV = s.voltage;
        if (Math.abs(I) > Math.abs(battI)) battI = I;
    });

    const total = Math.abs(battI);
    const req = total > 1e-6 ? battV / total : Infinity;
    net = { cur, total, battV, req, power: battV * total, short: sh.short, shortParts: sh.parts };
}

// ═══════════════════════════════════════════════
//  JUNCTION SPLITTING  (lets an end sit mid-wire)
// ═══════════════════════════════════════════════
function splitWires() {
    for (let iter = 0; iter < 60; iter++) {
        let did = false;
        outer:
        for (const c of comps) {
            for (const end of ['a', 'b']) {
                const p = c[end];
                for (const w of comps) {
                    if (w === c || w.type !== 'wire') continue;
                    const r = distToSeg(p.x, p.y, w.a.x, w.a.y, w.b.x, w.b.y);
                    if (r.d < SPLIT && r.t > 0.001 && r.t < 0.999) {
                        const da = Math.hypot(r.x - w.a.x, r.y - w.a.y);
                        const db = Math.hypot(r.x - w.b.x, r.y - w.b.y);
                        if (da > 4 && db > 4) {
                            const newW = makeComp('wire', r.x, r.y, w.b.x, w.b.y);
                            w.b = { x: r.x, y: r.y };
                            comps.push(newW);
                            did = true;
                            break outer;
                        }
                    }
                }
            }
        }
        if (!did) break;
    }
}

// Nudge a freshly placed part so one of its ends lands on a nearby junction.
function settleSnap(c) {
    let best = null, bd = JOIN;
    for (const end of ['a', 'b']) {
        const p = c[end];
        const ep = nearestEndpoint(p.x, p.y, JOIN, c);
        if (!ep) continue;
        const q = ep.comp[ep.end];
        const d = Math.hypot(q.x - p.x, q.y - p.y);
        if (d < bd) { bd = d; best = { dx: q.x - p.x, dy: q.y - p.y }; }
    }
    if (best) {
        c.a.x += best.dx; c.a.y += best.dy;
        c.b.x += best.dx; c.b.y += best.dy;
    }
}

function fmt(v) {
    if (!isFinite(v)) return '\u221E';
    const a = Math.abs(v);
    if (a >= 1000) return v.toFixed(0);
    if (a >= 100) return v.toFixed(1);
    return v.toFixed(2);
}

// ═══════════════════════════════════════════════
//  RENDERING
// ═══════════════════════════════════════════════
function line(p, q) {
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(q.x, q.y);
    ctx.stroke();
}

function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

function drawGrid() {
    // Graph paper on the 20px snap grid, every fifth rule stronger.
    SimLib.Draw.paper(ctx, W, H, { theme: T, minor: 20 });
}

function elementCurrent(c) {
    if (!net) return 0;
    const v = net.cur.get(c);
    return v === undefined ? 0 : v;
}

function drawComp(c, preview) {
    const u = cUnit(c);
    const L = cLen(c);
    const A = c.a, B = c.b;
    const M = cMid(c);
    const ux = u.x, uy = u.y, px = -uy, py = ux;
    const danger = !!(net && net.short && net.shortParts && net.shortParts.has(c));
    const col = danger ? T.danger : T.ink;

    ctx.save();
    if (preview) ctx.globalAlpha = 0.55;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (c.type === 'wire') {
        ctx.strokeStyle = danger ? T.dangerSoft : T.border; ctx.lineWidth = 5; line(A, B);
        ctx.strokeStyle = danger ? T.danger : T.ink; ctx.lineWidth = 2.5; line(A, B);
    } else if (c.type === 'resistor') {
        const bh = Math.min(L * 0.42, 22);
        const s = { x: M.x - ux * bh, y: M.y - uy * bh };
        const e = { x: M.x + ux * bh, y: M.y + uy * bh };
        ctx.strokeStyle = col; ctx.lineWidth = 3;
        line(A, s); line(e, B);
        const n = 6, amp = 7;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        for (let i = 1; i < n; i++) {
            const t = i / n;
            const bx = s.x + (e.x - s.x) * t, by = s.y + (e.y - s.y) * t;
            const off = (i % 2 ? amp : -amp);
            ctx.lineTo(bx + px * off, by + py * off);
        }
        ctx.lineTo(e.x, e.y);
        ctx.stroke();
    } else if (c.type === 'battery') {
        const gap = 6;
        const p1 = { x: M.x - ux * gap, y: M.y - uy * gap };
        const p2 = { x: M.x + ux * gap, y: M.y + uy * gap };
        ctx.strokeStyle = col; ctx.lineWidth = 3;
        line(A, p1); line(p2, B);
        line({ x: p1.x - px * 10, y: p1.y - py * 10 }, { x: p1.x + px * 10, y: p1.y + py * 10 });
        line({ x: p2.x - px * 5, y: p2.y - py * 5 }, { x: p2.x + px * 5, y: p2.y + py * 5 });
        ctx.fillStyle = col;
        ctx.font = T.font(12, '500');
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('+', p1.x + ux * 13 + px * 12, p1.y + uy * 13 + py * 12);
        ctx.fillText('\u2212', p2.x - ux * 13 + px * 12, p2.y - uy * 13 + py * 12);
    } else if (c.type === 'bulb') {
        const rad = 15;
        const c1 = { x: M.x - ux * rad, y: M.y - uy * rad };
        const c2 = { x: M.x + ux * rad, y: M.y + uy * rad };
        ctx.strokeStyle = col; ctx.lineWidth = 3;
        line(A, c1); line(c2, B);
        const i = Math.abs(elementCurrent(c));
        const p = i * i * bulbResistance(c);
        const bright = Math.min(1, p / 0.9);
        if (i > 0.002) {
            const g = ctx.createRadialGradient(M.x, M.y, 2, M.x, M.y, rad * 3.2);
            g.addColorStop(0, SimLib.Color.alpha(T.glow, 0.75 * bright));
            g.addColorStop(1, SimLib.Color.alpha(T.glow, 0));
            ctx.fillStyle = g;
            ctx.beginPath(); ctx.arc(M.x, M.y, rad * 3.2, 0, Math.PI * 2); ctx.fill();
        }
        ctx.beginPath(); ctx.arc(M.x, M.y, rad, 0, Math.PI * 2);
        ctx.fillStyle = i > 0.002 ? SimLib.Color.alpha(SimLib.Color.lighten(T.glow, 0.45), 0.45 + 0.55 * bright) : T.surface;
        ctx.fill();
        ctx.strokeStyle = col; ctx.lineWidth = 2.5; ctx.stroke();
        ctx.strokeStyle = i > 0.002 ? T.series[2] : T.faint;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(M.x - ux * rad * 0.5, M.y - uy * rad * 0.5);
        ctx.lineTo(M.x, M.y);
        ctx.lineTo(M.x + ux * rad * 0.5, M.y + uy * rad * 0.5);
        ctx.stroke();
    } else if (c.type === 'switch') {
        const gap = 10;
        const s = { x: M.x - ux * gap, y: M.y - uy * gap };
        const e = { x: M.x + ux * gap, y: M.y + uy * gap };
        ctx.strokeStyle = col; ctx.lineWidth = 3;
        line(A, s); line(e, B);
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(s.x, s.y, 3.2, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(e.x, e.y, 3.2, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = danger ? T.danger : (c.closed ? T.success : col);
        ctx.lineWidth = 3;
        const lever = c.closed ? e : { x: s.x + ux * gap * 1.5 - px * gap, y: s.y + uy * gap * 1.5 - py * gap };
        line(s, lever);
    }

    ctx.restore();
}

function drawValues() {
    if (!showValues || !net) return;
    ctx.font = T.font(11, '500');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const c of comps) {
        const u = cUnit(c), M = cMid(c);
        const px = -u.y, py = u.x;
        const danger = !!(net.short && net.shortParts && net.shortParts.has(c));
        const amps = danger ? '\u221E A' : fmt(Math.abs(elementCurrent(c))) + ' A';
        let txt = '';
        if (c.type === 'battery')       txt = fmt(c.voltage) + ' V';
        else if (c.type === 'resistor') txt = fmt(c.resistance) + ' \u03A9  ' + amps;
        else if (c.type === 'bulb')     txt = fmt(c.resistance) + ' \u03A9  ' + amps;
        else if (c.type === 'switch')   txt = c.closed ? 'closed' : 'open';
        else if (c.type === 'wire')     txt = amps;
        if (!txt) continue;
        const lx = M.x + px * 22, ly = M.y + py * 22;
        const w = ctx.measureText(txt).width + 10;
        ctx.fillStyle = SimLib.Color.alpha(T.surface, 0.94);
        roundRect(lx - w / 2, ly - 9, w, 18, 0);
        ctx.fill();
        ctx.fillStyle = T.accentDark;
        ctx.fillText(txt, lx, ly);
    }
}

function drawDots() {
    if (!showCurrent || !net) return;
    for (const c of comps) {
        const I = elementCurrent(c);
        const mag = Math.abs(I);
        if (mag < 0.004) continue;
        ctx.fillStyle = (net.short && net.shortParts && net.shortParts.has(c)) ? T.danger : T.accent;
        const L = cLen(c);
        if (L < 6) continue;
        const dir = I > 0 ? 1 : -1;
        const spacing = 22;
        const speed = Math.min(170, 32 + mag * 70);
        const off = ((phase * speed * dir) % spacing + spacing) % spacing;
        for (let d = off; d < L - 1; d += spacing) {
            const t = d / L;
            const x = c.a.x + (c.b.x - c.a.x) * t;
            const y = c.a.y + (c.b.y - c.a.y) * t;
            ctx.beginPath();
            ctx.arc(x, y, 2.6, 0, Math.PI * 2);
            ctx.fill();
        }
    }
}

function drawJunctions() {
    const groups = [];
    for (const c of comps) {
        for (const end of ['a', 'b']) {
            const p = c[end];
            const g = groups.find(gr => Math.abs(gr.x - p.x) < JOIN && Math.abs(gr.y - p.y) < JOIN);
            if (g) { g.n++; }
            else groups.push({ x: p.x, y: p.y, n: 1 });
        }
    }
    ctx.fillStyle = T.ink;
    for (const g of groups) {
        if (g.n >= 3) {
            ctx.beginPath();
            ctx.arc(g.x, g.y, 4.2, 0, Math.PI * 2);
            ctx.fill();
        }
    }
}

function drawSelection(c) {
    const pad = 18;
    const x = Math.min(c.a.x, c.b.x) - pad;
    const y = Math.min(c.a.y, c.b.y) - pad;
    const w = Math.abs(c.a.x - c.b.x) + pad * 2;
    const h = Math.abs(c.a.y - c.b.y) + pad * 2;
    ctx.save();
    ctx.fillStyle = SimLib.Color.alpha(T.accent, 0.08);
    ctx.strokeStyle = T.accent;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    roundRect(x, y, w, h, 0);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = T.accent;
    for (const end of ['a', 'b']) {
        ctx.beginPath(); ctx.arc(c[end].x, c[end].y, 4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
}

function drawHover() {
    if (!hoverEp) return;
    const p = hoverEp.comp[hoverEp.end];
    ctx.save();
    ctx.strokeStyle = T.accent;
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.arc(p.x, p.y, HANDLE, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
}

function buildDragComp() {
    const s = drag.start, e = drag.cur;
    const dist = Math.hypot(e.x - s.x, e.y - s.y);
    let bx, by;
    if (dist < 6) {
        bx = s.x + DEF[tool].len; by = s.y;
    } else {
        const ux = (e.x - s.x) / dist, uy = (e.y - s.y) / dist;
        const L = tool === 'wire' ? dist : DEF[tool].len;
        bx = s.x + ux * L; by = s.y + uy * L;
    }
    return makeComp(tool, s.x, s.y, bx, by);
}

function draw() {
    // Paint the board colour so the faint grid reads on any page background.
    ctx.fillStyle = T.bg;
    ctx.fillRect(0, 0, W, H);
    drawGrid();

    for (const c of comps) if (c.type !== 'wire') drawComp(c, false);
    for (const c of comps) if (c.type === 'wire') drawComp(c, false);

    drawJunctions();
    drawDots();
    drawValues();

    if (drag && drag.mode === 'draw') drawComp(buildDragComp(), true);
    if (ghost) drawComp(ghost.preview, true);

    drawHover();
    if (selected && comps.indexOf(selected) >= 0) drawSelection(selected);
}

// ═══════════════════════════════════════════════
//  UI
// ═══════════════════════════════════════════════
function select(c) {
    selected = c;
    updateSelectedPanel();
}

const toolbox = document.getElementById('tools');
const toolButtons = toolbox.querySelectorAll('button');

function setTool(t) {
    tool = t;
    toolbox.value = t;
    toolButtons.forEach(b => {
        b.classList.toggle('is-active', b.dataset.value === t);
        b.setAttribute('aria-pressed', String(b.dataset.value === t));
    });
    canvas.style.cursor = t === 'delete' ? 'not-allowed' : (t === 'select' ? 'default' : 'crosshair');
    updateHint();
}

function updateHint() {
    const hint = document.getElementById('hint');
    const msgs = {
        select: 'Click a part to edit its value, or drag it to move. Drag a wire end dot to reconnect it.',
        wire: 'Drag on the board to draw a wire. Its ends snap onto nearby parts to connect.',
        battery: 'Drag on the board to place a battery. The + end is where you start the drag.',
        bulb: 'Drag on the board to place a bulb.',
        resistor: 'Drag on the board to place a resistor.',
        switch: 'Drag on the board to place a switch, then click it to open or close.',
        delete: 'Click a part on the board to remove it.'
    };
    hint.textContent = msgs[tool] || '';
}

// The part editor is a declared description, slider, number box and button.
// Only the controls that apply to the selected part are shown.
const selText = document.getElementById('selectedPanel');
const selRange = document.getElementById('selRange');
const selNum = document.getElementById('selNum');
const selToggle = document.getElementById('selToggle');
const selRangeRow = selRange.closest('.control-row');
const selNumField = selNum.closest('.simulation-field');
const selToggleRow = selToggle.closest('.sim-actions');
let selEdit = null;     // { min, max, set } for the selected numeric part

function applySelected(raw, syncNum, syncRange) {
    const c = selected;
    if (!selEdit || !c) return;
    let v = parseFloat(raw);
    if (!isFinite(v)) return;
    v = Math.min(selEdit.max, Math.max(selEdit.min, v));
    selEdit.set(v);
    if (syncNum) selNum.value = v;
    if (syncRange) selRange.value = v;
    if (c.type === 'battery') document.getElementById('vBat').textContent = fmt(v);
    dirty = true;
}
selRange.addEventListener('input', () => applySelected(selRange.value, true, false));
selNum.addEventListener('input', () => applySelected(selNum.value, false, true));
selNum.addEventListener('change', () => applySelected(selNum.value, true, true));
selToggle.addEventListener('click', () => {
    if (!selected || selected.type !== 'switch') return;
    selected.closed = !selected.closed;
    dirty = true;
    updateSelectedPanel();
});

function updateSelectedPanel() {
    const c = selected;
    selEdit = null;
    selRangeRow.hidden = selNumField.hidden = selToggleRow.hidden = true;
    if (!c || comps.indexOf(c) < 0) {
        selText.textContent = 'Select a part to edit it, or drag a part onto the board.';
        return;
    }

    // Battery, resistor and bulb all expose one editable number.
    if (c.type === 'battery' || c.type === 'resistor' || c.type === 'bulb') {
        let name, unit, min, max, step, get, set;
        if (c.type === 'battery') {
            name = 'Voltage'; unit = 'V'; min = 1; max = 24; step = 0.5;
            get = () => c.voltage;
            set = v => { c.voltage = v; };
        } else {
            name = 'Resistance'; unit = '\u03A9'; min = 1; max = 1000; step = 1;
            get = () => c.resistance;
            set = v => { c.resistance = v; };
        }
        const label = c.type.charAt(0).toUpperCase() + c.type.slice(1);
        selText.textContent = label + ' \u00b7 ' + name + ' (' + unit + ')';
        selEdit = { min, max, set };
        for (const el of [selRange, selNum]) { el.min = min; el.max = max; el.step = step; el.value = get(); }
        selNum.setAttribute('aria-label', name + ' (' + unit + ')');
        selRangeRow.hidden = selNumField.hidden = false;
        return;
    }

    if (c.type === 'switch') {
        selText.textContent = 'Switch \u00b7 ' + (c.closed ? 'Closed' : 'Open');
        selToggle.textContent = c.closed ? 'Open it' : 'Close it';
        selToggleRow.hidden = false;
        return;
    }

    selText.textContent = 'Wire \u00b7 An ideal connecting wire (0 \u03A9).';
}

function updateReadouts() {
    const vB = comps.find(c => c.type === 'battery');
    document.getElementById('vBat').textContent = vB ? fmt(vB.voltage) : '0.00';
    const cur = document.getElementById('current');
    const reqEl = document.getElementById('req');
    const powEl = document.getElementById('power');
    const danger = !!(net && net.short);
    document.getElementById('warning').hidden = !danger;
    cur.parentElement.dataset.tone = danger ? 'warn' : '';
    powEl.parentElement.dataset.tone = danger ? 'warn' : '';
    if (!net) {
        cur.textContent = '0.00';
        reqEl.textContent = '\u221E';
        powEl.textContent = '0.00';
        return;
    }
    if (danger) {
        // Nothing limits the current in a short, so it is unbounded.
        cur.textContent = '\u221E';
        reqEl.textContent = '0.00';
        powEl.textContent = '\u221E';
        return;
    }
    cur.textContent = fmt(net.total);
    reqEl.textContent = isFinite(net.req) ? fmt(net.req) : '\u221E';
    powEl.textContent = fmt(net.power);
}

// ═══════════════════════════════════════════════
//  MOVE HELPERS
// ═══════════════════════════════════════════════
function startMove(c, p) {
    const attached = [];
    for (const other of comps) {
        if (other === c || other.type !== 'wire') continue;
        for (const end of ['a', 'b']) {
            const q = other[end];
            for (const myEnd of ['a', 'b']) {
                const t = c[myEnd];
                if (Math.hypot(q.x - t.x, q.y - t.y) < JOIN) {
                    attached.push({ comp: other, end, offx: q.x - t.x, offy: q.y - t.y, myEnd });
                    break;
                }
            }
        }
    }
    return {
        mode: 'move', comp: c,
        from: { x: p.x, y: p.y },
        a0: { x: c.a.x, y: c.a.y }, b0: { x: c.b.x, y: c.b.y },
        attached, moved: false
    };
}

function moveSnapCorrection(c, a, b, excluded) {
    let best = null, bd = JOIN;
    for (const o of comps) {
        if (o === c || excluded.has(o)) continue;
        for (const end of ['a', 'b']) {
            const q = o[end];
            for (const pt of [a, b]) {
                const d = Math.hypot(q.x - pt.x, q.y - pt.y);
                if (d < bd) { bd = d; best = { dx: q.x - pt.x, dy: q.y - pt.y }; }
            }
        }
    }
    return best;
}

// ═══════════════════════════════════════════════
//  PRESETS
// ═══════════════════════════════════════════════
function clearAll() {
    comps = [];
    selected = null;
    net = null;
    drag = null;
    ghost = null;
    updateSelectedPanel();
    dirty = true;
}

function addRaw(type, ax, ay, bx, by, props) {
    const c = makeComp(type, ax, ay, bx, by);
    if (props) Object.assign(c, props);
    comps.push(c);
    return c;
}

function presetSeries() {
    clearAll();
    addRaw('battery', 350, 430, 280, 430);
    addRaw('resistor', 220, 270, 220, 340, { resistance: 20 });
    addRaw('switch', 400, 150, 460, 150);
    addRaw('bulb', 680, 340, 680, 270);
    addRaw('wire', 220, 430, 280, 430);
    addRaw('wire', 350, 430, 680, 430);
    addRaw('wire', 680, 430, 680, 340);
    addRaw('wire', 680, 270, 680, 150);
    addRaw('wire', 680, 150, 460, 150);
    addRaw('wire', 400, 150, 220, 150);
    addRaw('wire', 220, 150, 220, 270);
    addRaw('wire', 220, 340, 220, 430);
    select(null);
    dirty = true;
}

function presetParallel() {
    clearAll();
    addRaw('battery', 160, 210, 160, 280);
    addRaw('wire', 160, 150, 160, 210);
    addRaw('wire', 160, 280, 160, 430);
    addRaw('wire', 160, 150, 380, 150);
    addRaw('wire', 380, 150, 540, 150);
    addRaw('wire', 160, 430, 380, 430);
    addRaw('wire', 380, 430, 540, 430);
    addRaw('resistor', 380, 150, 380, 220, { resistance: 100 });
    addRaw('wire', 380, 220, 380, 430);
    addRaw('resistor', 540, 150, 540, 220, { resistance: 220 });
    addRaw('wire', 540, 220, 540, 430);
    select(null);
    dirty = true;
}

// ═══════════════════════════════════════════════
//  POINTER INTERACTION ON THE BOARD
// ═══════════════════════════════════════════════
canvas.addEventListener('pointerdown', (e) => {
    if (e.button === 2) return;
    const p = toCanvas(e);
    canvas.setPointerCapture(e.pointerId);

    if (tool === 'delete') {
        const c = compAt(p.x, p.y);
        if (c) removeComp(c);
        return;
    }

    const ep = nearestEndpoint(p.x, p.y, HANDLE, null);

    if (tool === 'select') {
        if (ep && ep.comp.type === 'wire') {
            drag = { mode: 'endpoint', comp: ep.comp, end: ep.end };
        } else {
            const c = compAt(p.x, p.y);
            if (c) { drag = startMove(c, p); select(c); }
            else { select(null); drag = null; }
        }
        return;
    }

    // placing a part
    if (ep) {
        const q = ep.comp[ep.end];
        drag = { mode: 'draw', start: { x: q.x, y: q.y }, cur: { x: q.x, y: q.y }, moved: false, anchored: true };
    } else {
        const c = compAt(p.x, p.y);
        if (c) { drag = startMove(c, p); select(c); }
        else {
            const s = snapPoint(p.x, p.y, null);
            drag = { mode: 'draw', start: s, cur: { x: p.x, y: p.y }, moved: false, anchored: false };
        }
    }
});

canvas.addEventListener('pointermove', (e) => {
    const p = toCanvas(e);

    if (drag) {
        if (drag.mode === 'endpoint') {
            let np = snapPoint(p.x, p.y, drag.comp);
            const other = drag.end === 'a' ? drag.comp.b : drag.comp.a;
            let dx = np.x - other.x, dy = np.y - other.y;
            let d = Math.hypot(dx, dy);
            if (d < 8) {
                if (d < 0.001) { dx = 1; dy = 0; d = 1; }
                np = { x: other.x + dx / d * 8, y: other.y + dy / d * 8 };
            }
            drag.comp[drag.end] = np;
            drag.moved = true;
            dirty = true;
            return;
        }
        if (drag.mode === 'move') {
            const dx = p.x - drag.from.x, dy = p.y - drag.from.y;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
            const a = { x: drag.a0.x + dx, y: drag.a0.y + dy };
            const b = { x: drag.b0.x + dx, y: drag.b0.y + dy };
            const ex = new Set(drag.attached.map(at => at.comp));
            const corr = moveSnapCorrection(drag.comp, a, b, ex);
            if (corr) { a.x += corr.dx; a.y += corr.dy; b.x += corr.dx; b.y += corr.dy; }
            drag.comp.a = a;
            drag.comp.b = b;
            for (const at of drag.attached) {
                const t = drag.comp[at.myEnd];
                at.comp[at.end] = { x: t.x + at.offx, y: t.y + at.offy };
            }
            dirty = true;
            return;
        }
        if (drag.mode === 'draw') {
            drag.cur = tool === 'wire' ? snapPoint(p.x, p.y, null) : { x: p.x, y: p.y };
            drag.moved = true;
            return;
        }
    }

    hoverEp = nearestEndpoint(p.x, p.y, HANDLE, null);
    if (tool === 'delete') canvas.style.cursor = 'not-allowed';
    else if (hoverEp) canvas.style.cursor = 'pointer';
    else canvas.style.cursor = tool === 'select' ? 'default' : 'crosshair';
});

function endDrag() {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.mode === 'draw') {
        const c = (!d.moved && !d.anchored) ? defaultComp(tool, d.start.x, d.start.y) : buildDragComp();
        comps.push(c);
        settleSnap(c);
        select(c);
        splitWires();
        dirty = true;
    } else if (d.mode === 'move') {
        if (!d.moved) {
            if (d.comp.type === 'switch') d.comp.closed = !d.comp.closed;
            select(d.comp);
        } else {
            splitWires();
        }
        dirty = true;
    } else if (d.mode === 'endpoint') {
        splitWires();
        dirty = true;
    }
}

canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', () => { drag = null; canvas.style.cursor = 'crosshair'; });

canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const p = toCanvas(e);
    const c = compAt(p.x, p.y);
    if (c) removeComp(c);
});

// Double-click a part to jump straight to its value box.
canvas.addEventListener('dblclick', (e) => {
    const p = toCanvas(e);
    const c = compAt(p.x, p.y);
    if (!c) return;
    select(c);
    const n = document.getElementById('selNum');
    if (n) { n.focus(); n.select(); }
});

// ═══════════════════════════════════════════════
//  DRAG A PART FROM THE TOOLBOX ONTO THE BOARD
// ═══════════════════════════════════════════════
let toolDrag = null;

toolButtons.forEach(btn => {
    btn.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        const t = btn.dataset.value;
        setTool(t);
        if (t === 'select' || t === 'delete') return;
        toolDrag = { type: t, x: ev.clientX, y: ev.clientY, active: false };
        btn.setPointerCapture(ev.pointerId);
    });
});

window.addEventListener('pointermove', (ev) => {
    if (!toolDrag) return;
    if (Math.hypot(ev.clientX - toolDrag.x, ev.clientY - toolDrag.y) > 6) toolDrag.active = true;
    if (!toolDrag.active) return;
    const r = canvas.getBoundingClientRect();
    if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
        const p = { x: (ev.clientX - r.left) * (W / r.width), y: (ev.clientY - r.top) * (H / r.height) };
        ghost = { preview: defaultComp(toolDrag.type, snapGrid(p.x), snapGrid(p.y)) };
    } else {
        ghost = null;
    }
});

window.addEventListener('pointerup', () => {
    if (!toolDrag) return;
    const td = toolDrag;
    toolDrag = null;
    if (td.active && ghost) {
        const c = ghost.preview;
        ghost = null;
        comps.push(c);
        settleSnap(c);
        select(c);
        splitWires();
        dirty = true;
    } else {
        ghost = null;
    }
});

// ═══════════════════════════════════════════════
//  CONTROLS
// ═══════════════════════════════════════════════
document.getElementById('presetSeries').addEventListener('click', presetSeries);
document.getElementById('presetParallel').addEventListener('click', presetParallel);
document.getElementById('clearBtn').addEventListener('click', () => { clearAll(); setTool('select'); });
document.getElementById('showCurrent').addEventListener('change', (e) => { showCurrent = e.target.checked; });
document.getElementById('showValues').addEventListener('change', (e) => { showValues = e.target.checked; });

// ═══════════════════════════════════════════════
//  ANIMATION LOOP
// ═══════════════════════════════════════════════
function tick(dt) {
    if (dt > 0.05) dt = 0.016;
    phase += dt;
    if (dirty) { solve(); dirty = false; updateReadouts(); }
    draw();
}

presetSeries();
setTool('select');

// ═══ Animation (SimLib) ═══
// The circuit is drawn in a fixed 900x560 logical coordinate space; SimLib
// maps that space onto the responsive (HiDPI-aware) displayed canvas so that
// what is drawn and what the pointer hits both line up.
const app = SimLib.attach({
    canvas: canvas,
    logicalWidth: W,
    logicalHeight: H,
    SimulationClass: class CircuitSim extends SimLib.Simulation {
        onResize() { draw(); }
        onTick(dt) { tick(dt); }
        onDraw() { draw(); }
    }
});
app.sim.start();

    return { app };
}
