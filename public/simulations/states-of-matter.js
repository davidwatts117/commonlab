// Physics, canvas drawing, and control bindings only. Page structure is owned by the shell.
export function mount(ui) {
    const document = ui;
    const T = SimLib.Theme.use('light');
'use strict';

// ═══════════════════════════════════════
//  SUBSTANCE DATABASE (PhET-aligned)
// ═══════════════════════════════════════
const SUBS = {
    neon:    { name:'Neon',    mp:17,  bp:24,  minT:5,   maxT:45,  atomR:5.5, color:SimLib.Color.lighten(T.accent, 0.3), mol:'mono',
                seg:[15, 3, 25, 4, 53] },
    nitrogen:{ name:'Nitrogen',mp:63,  bp:78,  minT:30,  maxT:120, atomR:5.8, color:T.secondary, mol:'di',
                seg:[15, 3, 25, 4, 53] },
    argon:   { name:'Argon',   mp:84,  bp:87,  minT:50,  maxT:130, atomR:6.5, color:SimLib.Color.lighten(T.success, 0.3), mol:'mono',
                seg:[15, 3, 25, 4, 53] },
    oxygen:  { name:'Oxygen',  mp:54,  bp:90,  minT:30,  maxT:140, atomR:4.5, color:T.accent, mol:'di',
                seg:[15, 3, 25, 4, 53] },
    water:   { name:'Water',   mp:273, bp:373, minT:200, maxT:450, atomR:4.5, color:T.accent, mol:'tri',
                seg:[12, 7, 35, 7, 39] },
};

let subKey = 'water';
let sub = SUBS[subKey];
let temperature = 250; // Kelvin
let energy = 0; // 0–100, total energy added
let phase = 'solid';
let heatFlow = 0; // -100 (max cooling) to +100 (max heating)

// ═══════════════════════════════════════
//  CANVAS & CONTAINER
// ═══════════════════════════════════════
const C = document.getElementById('matterCanvas');
const ctx = C.getContext('2d');
const W = C.width, H = C.height;

// Container bounds
const BOX = { x:216, y:34, w:468, h:533 };

// ═══════════════════════════════════════
//  PARTICLE SYSTEM
// ═══════════════════════════════════════
const NUM = 50;
let particles = [];

function initParticles() {
    const lattice = buildLattice();
    particles = [];
    for (let i = 0; i < NUM; i++) {
        const pos = lattice[i] || randomPos();
        particles.push({
            x: pos.x, y: pos.y,
            eqX: pos.x, eqY: pos.y,
            vx: 0, vy: 0,
            angle: Math.random() * Math.PI * 2,
            av: 0,
            seed: Math.random() * 9999
        });
    }
}

function buildLattice() {
    const positions = [];
    const sp = sub.atomR * 3.0;
    const rh = sp * 0.866;
    const cx = BOX.x + BOX.w / 2;
    const cy = BOX.y + BOX.h - 40;
    for (let row = 0; row < 30; row++) {
        const y = cy - row * rh;
        if (y < BOX.y + 30) break;
        const off = (row % 2) * sp / 2;
        for (let col = -12; col < 12; col++) {
            const x = cx + off + col * sp;
            if (x > BOX.x + 18 && x < BOX.x + BOX.w - 18 && y > BOX.y + 18) {
                positions.push({ x, y });
            }
        }
    }
    return positions;
}

// Assign each particle to its nearest free lattice site (for smooth solidification)
function reassignLattice() {
    const sites = buildLattice();
    if (sites.length === 0) return;
    const used = new Set();
    for (const p of particles) {
        let best = null, bestDist = Infinity;
        for (let i = 0; i < sites.length; i++) {
            if (used.has(i)) continue;
            const dx = p.x - sites[i].x, dy = p.y - sites[i].y;
            const d = dx*dx + dy*dy;
            if (d < bestDist) { bestDist = d; best = i; }
        }
        if (best !== null) {
            used.add(best);
            // Gently guide toward the lattice site (don't snap instantly)
            p.eqX = sites[best].x;
            p.eqY = sites[best].y;
        }
    }
}

function randomPos() {
    return {
        x: BOX.x + 30 + Math.random() * (BOX.w - 60),
        y: BOX.y + 60 + Math.random() * (BOX.h - 120)
    };
}

// ═══════════════════════════════════════
//  PHYSICS — soft IMFs, emergent phases
// ═══════════════════════════════════════
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, va, vb, x) { if (b===a) return va; const t=(x-a)/(b-a); return va+(vb-va)*t; }
function gauss() { return (Math.random()+Math.random()+Math.random()-1.5)*1.4; }

function calcTargetSp(T, sub) {
    if (T <= sub.mp) {
        const f = (T - sub.minT) / (sub.mp - sub.minT);
        return 0.04 + 1.46 * f * f;
    }
    if (T <= sub.bp) {
        const f = (T - sub.mp) / (sub.bp - sub.mp);
        return 1.5 + 2.5 * f;
    }
    const f = (T - sub.bp) / (sub.maxT - sub.bp);
    return 4.0 + 4.0 * f;
}

// Map energy (0-100) to temperature via heating curve with plateaus
function energyToTemp(en, sub) {
    const s = sub.seg, total = s[0]+s[1]+s[2]+s[3]+s[4];
    const frac = clamp(en, 0, 100) / 100 * total;
    let acc = 0;
    // Solid heating
    if (frac <= s[0]) return sub.minT + (frac/s[0]) * (sub.mp - sub.minT);
    acc += s[0];
    // Melting plateau
    if (frac <= acc + s[1]) return sub.mp;
    acc += s[1];
    // Liquid heating
    if (frac <= acc + s[2]) return sub.mp + ((frac-acc)/s[2]) * (sub.bp - sub.mp);
    acc += s[2];
    // Boiling plateau
    if (frac <= acc + s[3]) return sub.bp;
    acc += s[3];
    // Gas heating
    return sub.bp + Math.min(1, (frac-acc)/s[4]) * (sub.maxT - sub.bp);
}

// Map temperature back to energy (for initialisation)
function tempToEnergy(T, sub) {
    // Binary search
    let lo = 0, hi = 100;
    for (let i = 0; i < 30; i++) {
        const mid = (lo+hi)/2;
        if (energyToTemp(mid, sub) < T) lo = mid; else hi = mid;
    }
    return (lo+hi)/2;
}

function updatePhysics() {
    // ── Evolve energy from heat flow, then map to temperature (latent heat plateaus) ──
    energy += heatFlow / 100 * 0.06;
    energy = clamp(energy, 0, 100);
    temperature = energyToTemp(energy, sub);
    const T = temperature;

    // ── Thermostat ──
    const targetSp = calcTargetSp(T, sub);
    const gamma = 0.016;
    const kickStd = Math.sqrt(2 * gamma) * targetSp;

    // ── Triangular-well IMF (molecule-size-aware) ──
    const effR = sub.mol === 'tri' ? sub.atomR * 1.6 :
                 sub.mol === 'di'  ? sub.atomR * 1.3 : sub.atomR;
    const R_EQ   = effR * 2.5;
    const R_PEAK = effR * 3.0;
    const R_CUT  = effR * 5.5;
    const NEIGHBOR_R = effR * 3.0;

    // ── Phase-dependent parameters with smooth plateau blending ──
    const s = sub.seg, total = s[0]+s[1]+s[2]+s[3]+s[4];
    const frac = energy / 100 * total;
    const meltStart = s[0], meltEnd = s[0]+s[1];
    const boilStart = s[0]+s[1]+s[2], boilEnd = s[0]+s[1]+s[2]+s[3];

    let K_REP, K_ATTR, GRAVITY;
    if (frac <= meltStart) {
        K_REP = 0.55; K_ATTR = 0.30; GRAVITY = 0.05;
    } else if (frac <= meltEnd) {
        const f = (frac - meltStart) / (meltEnd - meltStart);
        K_REP = 0.55 + (0.45-0.55)*f;
        K_ATTR = 0.30 + (0.14-0.30)*f;
        GRAVITY = 0.05 + (0.07-0.05)*f;
    } else if (frac <= boilStart) {
        K_REP = 0.45; K_ATTR = 0.14; GRAVITY = 0.07;
    } else if (frac <= boilEnd) {
        const f = (frac - boilStart) / (boilEnd - boilStart);
        K_REP = 0.45 + (0.40-0.45)*f;
        K_ATTR = 0.14 + (0.05-0.14)*f;
        GRAVITY = 0.07 + (0.01-0.07)*f;
    } else {
        K_REP = 0.40; K_ATTR = 0.05; GRAVITY = 0.01;
    }
    const SPEED_LIMIT = 22;

    // ── Step 1: thermostat + gravity + rotation damping ──
    const rotDamp = phase === 'solid' ? 0.82 : phase === 'liquid' ? 0.88 : 0.94;
    for (const p of particles) {
        p.vx += -gamma * p.vx + kickStd * gauss();
        p.vy += -gamma * p.vy + kickStd * gauss();
        p.vy += GRAVITY;
        p.av *= rotDamp;
        p.angle += p.av;
    }

    // ── Step 2: pair forces ──
    let totalNeighbors = 0;
    for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
            const a = particles[i], b = particles[j];
            const dx = b.x - a.x, dy = b.y - a.y;
            const d2 = dx*dx + dy*dy;
            if (d2 > R_CUT * R_CUT) continue;
            const dist = Math.sqrt(d2);
            const nx = dx / dist, ny = dy / dist;

            if (dist < NEIGHBOR_R) totalNeighbors++;

            // Triangular well: force = 0 at R_EQ, peaks at R_PEAK, zero at R_CUT
            let force;
            if (dist < R_EQ) {
                // Linear repulsion: 0 at R_EQ, increasing inward
                force = K_REP * (R_EQ - dist);
            } else if (dist < R_PEAK) {
                // Attraction ramp-up: 0 at R_EQ, peaks at R_PEAK
                force = -K_ATTR * ((dist - R_EQ) / (R_PEAK - R_EQ));
            } else {
                // Attraction taper: peak at R_PEAK, 0 at R_CUT
                force = -K_ATTR * (1 - (dist - R_PEAK) / (R_CUT - R_PEAK));
            }

            a.vx -= nx * force;
            a.vy -= ny * force;
            b.vx += nx * force;
            b.vy += ny * force;

            // Velocity damping during overlap (kills bouncing)
            if (dist < R_EQ) {
                const dvx = a.vx - b.vx, dvy = a.vy - b.vy;
                const dvn = dvx * nx + dvy * ny;
                if (dvn > 0) {
                    const damp = dvn * 0.4;
                    a.vx -= nx * damp; a.vy -= ny * damp;
                    b.vx += nx * damp; b.vy += ny * damp;
                }
            }

            const torque = force * 0.006;
            a.av += torque;
            b.av += torque;
        }
    }

    // ── Step 2.5: crystalline ordering + liquid ceiling + center merge ──
    const floorCx = BOX.x + BOX.w / 2;
    const floorCy = BOX.y + BOX.h - 25;

    if (phase === 'solid') {
        const sites = buildLattice();
        if (sites.length > 0) {
            for (const p of particles) {
                // Lattice bias: nudge toward nearest site
                let bestD = Infinity, bestS = null;
                for (const s of sites) {
                    const d = (p.x-s.x)*(p.x-s.x) + (p.y-s.y)*(p.y-s.y);
                    if (d < bestD) { bestD = d; bestS = s; }
                }
                if (bestS && bestD < 400) {
                    const dx = bestS.x - p.x, dy = bestS.y - p.y;
                    const dist = Math.sqrt(bestD) || 1;
                    p.vx += (dx/dist) * 0.04 * Math.min(dist/10, 1);
                    p.vy += (dy/dist) * 0.04 * Math.min(dist/10, 1);
                }
                // Center merge: gently pull clumps toward floor center
                const cdx = floorCx - p.x, cdy = floorCy - p.y;
                const cdist = Math.sqrt(cdx*cdx + cdy*cdy) || 1;
                if (cdist > 25) {
                    p.vx += (cdx/cdist) * 0.025;
                    p.vy += (cdy/cdist) * 0.025;
                }
            }
        }
    }

    // ── Liquid ceiling: fades in during melting, out during boiling ──
    let liquidFactor;
    if (frac <= meltStart) liquidFactor = 0;
    else if (frac <= meltEnd) liquidFactor = (frac - meltStart) / (meltEnd - meltStart);
    else if (frac <= boilStart) liquidFactor = 1;
    else if (frac <= boilEnd) liquidFactor = 1 - (frac - boilStart) / (boilEnd - boilStart);
    else liquidFactor = 0;

    if (liquidFactor > 0.01) {
        const ceilingY = BOX.y + BOX.h * (0.5 - liquidFactor * 0.1);
        for (const p of particles) {
            if (p.y < ceilingY) {
                const push = (ceilingY - p.y) * 0.08 * liquidFactor;
                p.vy += push;
                p.vy *= 1 - 0.3 * liquidFactor;
            }
        }
    }

    // ── Step 3: integrate & walls (with anti-stick push) ──
    let sumSpeed = 0;
    const br = sub.atomR + 1;
    const wallPush = 0.15; // gentle push away from walls to prevent sticking

    for (const p of particles) {
        p.x += p.vx; p.y += p.vy;

        // Anti-stick: push away from near walls
        if (p.x < BOX.x + br + 4)      p.vx += wallPush;
        if (p.x > BOX.x + BOX.w - br - 4) p.vx -= wallPush;
        if (p.y < BOX.y + br + 4)      p.vy += wallPush;
        if (p.y > BOX.y + BOX.h - br - 4) p.vy -= wallPush;

        // Wall bounce (elastic)
        if (p.x < BOX.x + br)      { p.x = BOX.x + br;      p.vx = Math.abs(p.vx); }
        if (p.x > BOX.x + BOX.w - br) { p.x = BOX.x + BOX.w - br; p.vx = -Math.abs(p.vx); }
        if (p.y < BOX.y + br)      { p.y = BOX.y + br;      p.vy = Math.abs(p.vy); }
        if (p.y > BOX.y + BOX.h - br) { p.y = BOX.y + BOX.h - br; p.vy = -Math.abs(p.vy); }

        const s = Math.sqrt(p.vx*p.vx + p.vy*p.vy);
        sumSpeed += s;
        if (s > SPEED_LIMIT) { const sc = SPEED_LIMIT/s; p.vx *= sc; p.vy *= sc; }
    }

    // ── Phase label: energy-based (accounts for latent heat plateaus) ──
    if (frac <= meltStart) phase = 'solid';
    else if (frac <= meltEnd) phase = 'solid';
    else if (frac <= boilStart) phase = 'liquid';
    else if (frac <= boilEnd) phase = 'liquid';
    else phase = 'gas';
}

// ═══════════════════════════════════════
//  RENDERING
// ═══════════════════════════════════════
// Color blending is provided by SimLib.Color.
const lighten = (color, amt) => SimLib.Color.lighten(color, amt);
const darken  = (color, amt) => SimLib.Color.darken(color, amt);

function drawGlossySphere(x, y, r, color) {
    // Flat, outlined particle in the graph-paper figure style.
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI*2);
    ctx.fill();
    ctx.strokeStyle = T.ink;
    ctx.lineWidth = 0.9;
    ctx.stroke();
}

function drawParticle(p) {
    const speed = Math.sqrt(p.vx*p.vx + p.vy*p.vy);
    const energyNorm = clamp(speed / 10, 0, 1);

    function energyTint(baseColor) {
        // Blend toward the accent as energy increases
        return SimLib.Color.mix(baseColor, T.accent, energyNorm*0.55);
    }

    const tintedColor = energyTint(sub.color);
    const r = sub.atomR;

    if (sub.mol === 'mono') {
        drawGlossySphere(p.x, p.y, r, tintedColor);
        // Glow for fast particles
        if (speed > 4) {
            const glowAlpha = Math.min((speed-4)/12, 1) * 0.2;
            ctx.fillStyle = SimLib.Color.alpha(T.glow, glowAlpha);
            ctx.beginPath();
            ctx.arc(p.x, p.y, r+4, 0, Math.PI*2);
            ctx.fill();
        }
    } else if (sub.mol === 'di') {
        // O₂ — two atoms with bond
        const bond = r * 1.8;
        const cos = Math.cos(p.angle), sin = Math.sin(p.angle);
        const x1 = p.x - cos * bond/2, y1 = p.y - sin * bond/2;
        const x2 = p.x + cos * bond/2, y2 = p.y + sin * bond/2;

        // Bond
        ctx.strokeStyle = darken(tintedColor, 0.3);
        ctx.lineWidth = r * 0.7;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();

        drawGlossySphere(x1, y1, r, tintedColor);
        drawGlossySphere(x2, y2, r, tintedColor);
        // Glow for fast particles
        if (speed > 4) {
            const ga = Math.min((speed-4)/12, 1) * 0.2;
            ctx.fillStyle = SimLib.Color.alpha(T.glow, ga);
            ctx.beginPath(); ctx.arc(x1, y1, r+4, 0, Math.PI*2); ctx.fill();
            ctx.beginPath(); ctx.arc(x2, y2, r+4, 0, Math.PI*2); ctx.fill();
        }
    } else if (sub.mol === 'tri') {
        // H₂O — central O with two H at 104.5°
        const oR = r;
        const hR = r * 0.6;
        const hBond = oR + hR + 1;
        const halfAngle = 104.5 * Math.PI / 180 / 2;
        const ox = p.x, oy = p.y;

        // H positions
        const h1x = ox + (Math.cos(p.angle + halfAngle) * hBond);
        const h1y = oy + (Math.sin(p.angle + halfAngle) * hBond);
        const h2x = ox + (Math.cos(p.angle - halfAngle) * hBond);
        const h2y = oy + (Math.sin(p.angle - halfAngle) * hBond);

        // Bonds
        ctx.strokeStyle = T.muted;
        ctx.lineWidth = hR * 0.5;
        ctx.beginPath();
        ctx.moveTo(ox, oy); ctx.lineTo(h1x, h1y);
        ctx.moveTo(ox, oy); ctx.lineTo(h2x, h2y);
        ctx.stroke();

        // Oxygen (central, larger) — tinted by energy
        drawGlossySphere(ox, oy, oR, tintedColor);

        // Hydrogens (smaller, white-ish)
        drawGlossySphere(h1x, h1y, hR, T.surface);
        drawGlossySphere(h2x, h2y, hR, T.surface);

        // Glow for fast molecules
        if (speed > 4) {
            const ga = Math.min((speed-4)/12, 1) * 0.2;
            ctx.fillStyle = SimLib.Color.alpha(T.glow, ga);
            ctx.beginPath(); ctx.arc(ox, oy, oR+5, 0, Math.PI*2); ctx.fill();
        }
    }
}

function draw() {
    ctx.clearRect(0, 0, W, H);

    // Background + grid + title (shared theme)
    SimLib.Draw.paper(ctx, W, H, { theme: T });
    SimLib.Draw.title(ctx, 'States of Matter', 14, 20, { size: 13, color: T.muted, theme: T });

    // ── Thermometer (left of box) ──
    drawThermometer();

    // ── Container shadow ──
    ctx.fillStyle = T.ink;
    ctx.beginPath();
    roundRect(ctx, BOX.x+4, BOX.y+4, BOX.w, BOX.h, 0);
    ctx.fill();

    // ── Container ──
    ctx.fillStyle = T.surface;
    ctx.strokeStyle = T.ink;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    roundRect(ctx, BOX.x, BOX.y, BOX.w, BOX.h, 0);
    ctx.fill();
    ctx.stroke();

    // Floor line
    ctx.strokeStyle = T.borderStrong;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(BOX.x, BOX.y + BOX.h + 1);
    ctx.lineTo(BOX.x + BOX.w, BOX.y + BOX.h + 1);
    ctx.stroke();

    // ── Lid ──
    const lidH = 12;
    ctx.fillStyle = T.surface2;
    ctx.strokeStyle = T.ink;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    roundRect(ctx, BOX.x-1, BOX.y - lidH, BOX.w+2, lidH+2, 0);
    ctx.fill();
    ctx.stroke();

    // ── Sort particles by y for depth ──
    const sorted = [...particles].sort((a,b) => a.y - b.y);
    for (const p of sorted) drawParticle(p);

    // ── Container border on top ──
    ctx.strokeStyle = T.ink;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    roundRect(ctx, BOX.x, BOX.y, BOX.w, BOX.h, 0);
    ctx.stroke();

    // ── Phase label inside box ──
    ctx.fillStyle = phase==='solid'?T.accentDark:phase==='liquid'?T.success:T.danger;
    ctx.font = T.font(12, 'bold');
    ctx.textAlign = 'right';
    ctx.fillText(phase.toUpperCase(), BOX.x+BOX.w-14, BOX.y+18);
}

function drawThermometer() {
    const tx = BOX.x - 32, ty = BOX.y + 10, tw = 14, th = BOX.h - 20;
    const tNorm = (temperature - sub.minT) / (sub.maxT - sub.minT);

    // Tube
    ctx.fillStyle = T.surface2;
    ctx.strokeStyle = T.ink;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    roundRect(ctx, tx, ty, tw, th, 7);
    ctx.fill();
    ctx.stroke();

    // Fill
    const fillH = th * tNorm;
    const fillY = ty + th - fillH;
    if (fillH > 2) {
        ctx.fillStyle = SimLib.Color.heat(tNorm);
        ctx.beginPath();
        roundRect(ctx, tx+2, fillY, tw-4, fillH-2, 5);
        ctx.fill();
    }

    // Bulb
    ctx.fillStyle = SimLib.Color.heat(tNorm);
    ctx.beginPath();
    ctx.arc(tx+tw/2, ty+th+8, 8, 0, Math.PI*2);
    ctx.fill();
    ctx.strokeStyle = T.ink;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Labels
    ctx.fillStyle = T.ink;
    ctx.font = T.font(9);
    ctx.textAlign = 'center';
    ctx.fillText(Math.round(temperature)+' K', tx+tw/2, ty-5);

    // Tick marks
    ctx.fillStyle = T.muted;
    ctx.font = T.font(7);
    ctx.textAlign = 'right';
    const ticks = [
        { t: sub.minT, lab: sub.minT+'K' },
        { t: sub.mp, lab: 'MP' },
        { t: sub.bp, lab: 'BP' },
        { t: sub.maxT, lab: sub.maxT+'K' },
    ];
    for (const tk of ticks) {
        const frac = (tk.t - sub.minT) / (sub.maxT - sub.minT);
        const y = ty + th - frac * th;
        ctx.fillText(tk.lab, tx-4, y+3);
        ctx.strokeStyle = T.borderStrong;
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(tx, y);
        ctx.lineTo(tx+5, y);
        ctx.stroke();
    }
}

function roundRect(ctx, x, y, w, h, r) {
    if (typeof r==='number') r=[r,r,r,r];
    const [tl,tr,br,bl] = r.map(v=>Math.min(v,Math.min(w,h)/2));
    ctx.moveTo(x+tl, y);
    ctx.lineTo(x+w-tr, y);
    ctx.quadraticCurveTo(x+w,y, x+w,y+tr);
    ctx.lineTo(x+w, y+h-br);
    ctx.quadraticCurveTo(x+w,y+h, x+w-br,y+h);
    ctx.lineTo(x+bl, y+h);
    ctx.quadraticCurveTo(x,y+h, x,y+h-bl);
    ctx.lineTo(x, y+tl);
    ctx.quadraticCurveTo(x,y, x+tl,y);
}

// ═══════════════════════════════════════
//  UI
// ═══════════════════════════════════════
const heatSlider  = document.getElementById('heatSlider');
const heatLabel   = document.getElementById('heatLabel');
const phasePill   = document.getElementById('phasePill');
const tempValK    = document.getElementById('tempValK');
const tempValC    = document.getElementById('tempValC');
const mpVal       = document.getElementById('mpVal');
const bpVal       = document.getElementById('bpVal');
const tcIcon      = document.getElementById('tcIcon');
const tcIconR     = document.getElementById('tcIconR');

function updateUI() {
    // Heat slider visual
    const hf = heatFlow;
    if (hf > 5) {
        heatLabel.textContent = 'Heating';
        heatLabel.style.color = T.accentDark;
    } else if (hf < -5) {
        heatLabel.textContent = 'Cooling';
        heatLabel.style.color = T.secondary;
    } else {
        heatLabel.textContent = 'Heat / Cool';
        heatLabel.style.color = T.muted;
    }

    // Icons
    tcIcon.textContent = '−';
    tcIconR.textContent = '+';

    // Phase
    phasePill.textContent = phase.charAt(0).toUpperCase() + phase.slice(1);
    phasePill.className = 'sim-badge sim-badge--' + phase;

    // Readouts
    tempValK.textContent = Math.round(temperature);
    tempValC.textContent = Math.round(temperature - 273.15);
    mpVal.textContent = sub.mp + ' K';
    bpVal.textContent = sub.bp + ' K';
}

// ═══════════════════════════════════════
//  EVENTS
// ═══════════════════════════════════════
heatSlider.addEventListener('input', () => {
    heatFlow = parseFloat(heatSlider.value);
});
// Return to neutral when released
heatSlider.addEventListener('change', () => {
    heatFlow = 0;
    heatSlider.value = 0;
    updateUI();
});

document.getElementById('substancePick').addEventListener('click', e => {
    const btn = e.target.closest('.sim-seg__btn');
    if (!btn) return;
    const key = btn.getAttribute('data-value');
    if (key === subKey) return;
    subKey = key;
    sub = SUBS[key];
    document.querySelectorAll('.sim-seg__btn').forEach(b => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    temperature = clamp(temperature, sub.minT + 2, sub.maxT - 2);
    energy = tempToEnergy(temperature, sub);
    heatFlow = 0;
    heatSlider.value = 0;
    initParticles();
    updateUI();
});

document.getElementById('btnReset').addEventListener('click', () => {
    temperature = sub.mp - 10;
    if (temperature < sub.minT) temperature = sub.minT + 3;
    energy = tempToEnergy(temperature, sub);
    heatFlow = 0;
    heatSlider.value = 0;
    initParticles();
    updateUI();
});

// ═══════════════════════════════════════
//  INIT + SimLib integration
// ═══════════════════════════════════════
// Initialize particle data and UI state (do not start a separate RAF loop)
initParticles();
temperature = sub.mp - 10;
if (temperature < sub.minT) temperature = sub.minT + 3;
energy = tempToEnergy(temperature, sub);
updateUI();

// The scene is drawn in a fixed 900x600 logical space; SimLib maps it onto
// the responsive (HiDPI-aware) displayed canvas so nothing is clipped.
const app = SimLib.attach({
    canvas: C,
    logicalWidth: 900,
    logicalHeight: 600,
    SimulationClass: class StatesOfMatterSim extends SimLib.Simulation {
        onResize() { draw(); }
        onTick() { updatePhysics(); updateUI(); }
        onDraw(ctx) { draw(); }
    }
});
app.sim.start();
    return { app };
}
