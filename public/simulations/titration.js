// Physics, canvas drawing, and control bindings only. Page structure is owned by the shell.
export function mount(ui) {
    const document = ui;
    const T = SimLib.Theme.use('light');



// ═══════════════════════════════════════════════════════════════
//  Reference data
// ═══════════════════════════════════════════════════════════════
const Kw = 1e-14;
const VESSEL_L = 0.025;      // L of solution initially in the vessel
const SCALE_MAX = 25.0;      // mL across the x-axis / capacity of the burette
const DROP = 1 / 15;         // mL per drop

const ACIDS = {
    'Hydrochloric acid': { strong: true,  Ka: null,    formula: 'HCl' },
    'Acetic acid':       { strong: false, Ka: 1.8e-5,  formula: 'CH\u2083COOH' },
    'Chlorous acid':     { strong: false, Ka: 1.2e-2,  formula: 'HClO\u2082' },
    'Hypochlorous acid': { strong: false, Ka: 3.5e-8,  formula: 'HClO' },
    'Hydrocyanic acid':  { strong: false, Ka: 6.2e-10, formula: 'HCN' }
};

const BASES = {
    'Sodium hydroxide': { strong: true,  Kb: null,    formula: 'NaOH' },
    'Ammonia':          { strong: false, Kb: 1.8e-5,  formula: 'NH\u2083' },
    'Methylamine':      { strong: false, Kb: 4.38e-4, formula: 'CH\u2083NH\u2082' },
    'Ethylamine':       { strong: false, Kb: 5.68e-4, formula: 'C\u2082H\u2085NH\u2082' },
    'Aniline':          { strong: false, Kb: 3.8e-10, formula: 'C\u2086H\u2085NH\u2082' },
    'Pyridine':         { strong: false, Kb: 1.7e-9,  formula: 'C\u2085H\u2085N' }
};

// base = colour of the basic form (high pH), acid = colour of the acidic form (low pH)
// lo/hi are the pH bounds over which the colour develops visually
const INDICATORS = {
    'Phenolphthalein':   { lo: 6.6,  hi: 9.2,  base: [244, 114, 182], acid: [248, 250, 252], range: '8.0 \u2013 10.0' },
    'Methyl orange':     { lo: 2.6,  hi: 4.6,  base: [250, 204,  21], acid: [234,  88,  12], range: '3.3 \u2013 4.5' },
    'Bromothymol blue':  { lo: 5.8,  hi: 8.0,  base: [ 37,  99, 235], acid: [250, 204,  21], range: '6.0 \u2013 7.5' },
    'Crystal violet':    { lo: 0.0,  hi: 1.8,  base: [126,  34, 206], acid: [132, 204,  22], range: '0.0 \u2013 1.8' },
    'Alizarin yellow':   { lo: 9.8,  hi: 12.0, base: [220,  38,  38], acid: [250, 204,  21], range: '10.0 \u2013 12.0' },
    'Erichrome black T': { lo: 4.6,  hi: 6.8,  base: [ 30,  64, 175], acid: [225,  29,  72], range: '5.0 \u2013 6.5' }
};

// ═══════════════════════════════════════════════════════════════
//  State
// ═══════════════════════════════════════════════════════════════
let acid = 'Hydrochloric acid';
let base = 'Sodium hydroxide';
let indicator = 'Phenolphthalein';
let concAcid = 0.100;
let concBase = 0.150;
let titrant = 'base';

let filled = false;         // glassware contains the solutions
let tapOpen = false;
let volumeAdded = 0;
let zeroReading = 0;        // burette level before any titrant is added
let eqVol = 0;
let eqPH = 7;
let crossedEq = false;

let trace = [];             // { v, pH, rgb:[r,g,b] }
let logRows = [];           // { v, reading, pH }
let clock = 0;
let realLab = false;        // real-lab mode: hide the curve and every pH readout
let displayF = 0;           // eased fraction of the indicator's high-pH form
let swirl = 0;              // decaying strength of freshly added (unmixed) titrant

// ═══════════════════════════════════════════════════════════════
//  DOM
// ═══════════════════════════════════════════════════════════════
const canvas        = document.getElementById('titrCanvas');
const ctx           = canvas.getContext('2d');
const W = canvas.width, H = canvas.height;

const acidSelect    = document.getElementById('acidSelect');
const baseSelect    = document.getElementById('baseSelect');
const indicatorSel  = document.getElementById('indicatorSelect');
const concAcidInput = document.getElementById('concAcid');
const concBaseInput = document.getElementById('concBase');
const acidHint      = document.getElementById('acidHint');
const baseHint      = document.getElementById('baseHint');
const showEqCb      = document.getElementById('showEqPt');
const showDataCb    = document.getElementById('showDataPts');
const dropRate      = document.getElementById('dropRate');
const dropRateVal   = document.getElementById('dropRateVal');
const tapBtn        = document.getElementById('titrateBtn');
const burReadout    = document.getElementById('buretteReadout');
const phReadout     = document.getElementById('phReadout');
const eqReadout     = document.getElementById('eqVolReadout');
const dockPH        = document.getElementById('dockPH');
const resetBtn      = document.getElementById('resetBtn');
const dockSwatch    = document.getElementById('dockSwatch');
const dockPHLabel   = document.getElementById('dockPHLabel');
const realLabCb     = document.getElementById('realLab');
const logThirdHead  = document.getElementById('logThirdHead');
const messageEl     = document.getElementById('titrMessage');
const dataBody      = document.getElementById('dataBody');
const titrantPick   = document.getElementById('titrantPick');
const dataWrap      = dataBody.closest('.simulation-table-wrap');
const dataHint      = document.getElementById('dataHint');

// ═══════════════════════════════════════════════════════════════
//  Equilibrium pH  (full quadratic / cubic treatment)
// ═══════════════════════════════════════════════════════════════
function sgn(a) { return a > 0 ? 1 : a < 0 ? -1 : 0; }

function positiveRoot(b, c) {                 // x² + b·x + c = 0 → positive x
    const d = b * b - 4 * c;
    if (d < 0) return 0;
    const r1 = (-b + Math.sqrt(d)) / 2;
    if (r1 >= 0) return r1;
    const r2 = (-b - Math.sqrt(d)) / 2;
    return r2 >= 0 ? r2 : 0;
}

function cubicRoots(a, b, c, d) {             // a·x³ + b·x² + c·x + d = 0
    const out = [0, 0, 0, 0, 0, 0];
    const f = (3 * c / a - b * b / (a * a)) / 3;
    const g = (2 * b * b * b / (a * a * a) - 9 * b * c / (a * a) + 27 * d / a) / 27;
    const h = g * g / 4 + f * f * f / 27;

    if (h > 0) {                              // one real root
        const r = -g / 2 + Math.sqrt(h);
        const s = sgn(r) * Math.pow(Math.abs(r), 1 / 3);
        const t = -g / 2 - Math.sqrt(h);
        const u = sgn(t) * Math.pow(Math.abs(t), 1 / 3);
        out[0] = (s + u) - b / (3 * a);         out[3] = 0;
        out[1] = -(s + u) / 2 - b / (3 * a);    out[4] = (s - u) * Math.sqrt(3) / 2;
        out[2] = -(s + u) / 2 - b / (3 * a);    out[5] = -(s - u) * Math.sqrt(3) / 2;
        return out;
    }
    if (f === 0 && g === 0 && h === 0) {
        const v = -sgn(d / a) * Math.pow(Math.abs(d / a), 1 / 3);
        out[0] = out[1] = out[2] = v;
        return out;
    }
    const i = Math.sqrt(g * g / 4 - h);       // three real roots
    const j = sgn(i) * Math.pow(Math.abs(i), 1 / 3);
    const k = Math.acos(Math.max(-1, Math.min(1, -g / (2 * i))));
    const l = -j;
    const m = Math.cos(k / 3);
    const n = Math.sqrt(3) * Math.sin(k / 3);
    const p = -b / (3 * a);
    out[0] = 2 * j * Math.cos(k / 3) - b / (3 * a); out[3] = 0;
    out[1] = l * (m + n) + p;                        out[4] = 0;
    out[2] = l * (m - n) + p;                        out[5] = 0;
    return out;
}

function biggestReal(roots) {
    if (roots[4] !== 0) return roots[0] > 0 ? roots[0] : 0;
    let r = 0;
    for (let i = 0; i < 3; i++) if (roots[i] > r) r = roots[i];
    return r;
}

function pHstrongStrong(vA, vB, tot) {
    const net = (vA * concAcid - vB * concBase) / tot;
    if (net > 0) return -Math.log10(positiveRoot(net, -Kw) + net);
    return 14 + Math.log10(positiveRoot(-net, -Kw) - net);
}

function pHweakAcidStrongBase(vA, vB, tot, Ka) {
    const net = (vA * concAcid - vB * concBase) / tot;
    const conj = (vB * concBase) / tot;
    if (net > 2e-3) return -Math.log10(positiveRoot(conj + Ka, -(net * Ka)));
    if (net >= -2e-3) {
        const y = biggestReal(cubicRoots(-Ka, -(Kw + Ka * net), (conj * Kw + Ka * Kw), Kw * Kw));
        if (y !== 0) return -Math.log10(Kw / y);
        return 14 + Math.log10(Math.sqrt(conj * Kw / Ka));
    }
    return 14 + Math.log10(positiveRoot(-net, -Kw) - net);
}

function pHstrongAcidWeakBase(vA, vB, tot, Kb) {
    const net = (vB * concBase - vA * concAcid) / tot;
    const conj = (vA * concAcid) / tot;
    if (net > 2e-3) return 14 + Math.log10(positiveRoot(conj + Kb, -(net * Kb)));
    if (net >= -2e-3) {
        const y = biggestReal(cubicRoots(-Kb, -(Kw + Kb * net), (conj * Kw + Kb * Kw), Kw * Kw));
        if (y !== 0) return 14 + Math.log10(Kw / y);
        return -Math.log10(Math.sqrt(conj * Kw / Kb));
    }
    return -Math.log10(positiveRoot(-net, -Kw) - net);
}

function pHat(v) {
    const A = ACIDS[acid], B = BASES[base];
    const vA = titrant === 'acid' ? v / 1000 : VESSEL_L;
    const vB = titrant === 'base' ? v / 1000 : VESSEL_L;
    const tot = vA + vB;
    let pH;
    if (A.strong && B.strong)       pH = pHstrongStrong(vA, vB, tot);
    else if (!A.strong && B.strong) pH = pHweakAcidStrongBase(vA, vB, tot, A.Ka);
    else if (A.strong && !B.strong) pH = pHstrongAcidWeakBase(vA, vB, tot, B.Kb);
    else                            pH = 7;
    return Math.max(0, Math.min(14, pH));
}

function weakPair() { return !ACIDS[acid].strong && !BASES[base].strong; }

// ═══════════════════════════════════════════════════════════════
//  Colour helpers
// ═══════════════════════════════════════════════════════════════
function smoothstep(a, b, x) {
    if (a === b) return x < a ? 0 : 1;
    let t = (x - a) / (b - a);
    t = Math.max(0, Math.min(1, t));
    return t * t * (3 - 2 * t);
}

// how far into its basic (high-pH) colour the indicator is at a given pH
function fractionAt(pH) {
    const ind = INDICATORS[indicator];
    // the exponent lifts the first faint tint so it is actually perceptible
    return Math.pow(smoothstep(ind.lo, ind.hi, pH), 0.72);
}

function colorForFraction(f, shade) {
    const ind = INDICATORS[indicator];
    const c = [
        ind.acid[0] + (ind.base[0] - ind.acid[0]) * f,
        ind.acid[1] + (ind.base[1] - ind.acid[1]) * f,
        ind.acid[2] + (ind.base[2] - ind.acid[2]) * f
    ];
    const s = shade == null ? 1 : shade;
    return [Math.round(c[0] * s), Math.round(c[1] * s), Math.round(c[2] * s)];
}

// true colour at a pH (used for the plotted band and the log)
function mixRGB(pH, shade) {
    return colorForFraction(fractionAt(pH), shade);
}

// live, time-smoothed colour of the mixture
function liveRGB(shade) {
    return colorForFraction(displayF, shade);
}

function rgbStr(c, a) {
    return SimLib.Color.rgb(c[0], c[1], c[2], a == null ? undefined : a);
}

function nearlyWhite(c) { return c[0] > 244 && c[1] > 244 && c[2] > 244; }

function asSwatch(c) {
    if (!nearlyWhite(c)) return c;
    const clear = SimLib.Color.parse(T.secondarySoft);
    return [clear.r, clear.g, clear.b];
}

function liquidStyle() {
    const c = liveRGB(1);
    if (nearlyWhite(c)) return SimLib.Color.alpha(T.secondarySoft, 0.7);
    return rgbStr(c, 0.72);
}

function solutionSwatch(pH) {
    return asSwatch(mixRGB(pH, 1));
}

function liveSwatch() {
    return asSwatch(liveRGB(1));
}

// ═══════════════════════════════════════════════════════════════
//  Formatting
// ═══════════════════════════════════════════════════════════════
function fmtM(x) {
    const r = Math.round(x * 1000) / 1000;
    return String(r);
}

// ═══════════════════════════════════════════════════════════════
//  Drawing — helpers
// ═══════════════════════════════════════════════════════════════
function rrect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
}

// ═══════════════════════════════════════════════════════════════
//  Drawing — apparatus
// ═══════════════════════════════════════════════════════════════
function drawApparatus() {
    // ── Retort stand ──
    ctx.fillStyle = T.text;
    rrect(18, 527, 216, 14, 6); ctx.fill();
    ctx.fillRect(36, 68, 9, 460);
    ctx.fillStyle = T.text;
    rrect(45, 151, 54, 10, 4); ctx.fill();
    ctx.fillStyle = T.ink;
    ctx.fillRect(98, 144, 6, 24);

    // ── Burette ──
    const bx = 101, bw = 30, bTop = 56, bBot = 360;
    const bcx = bx + bw / 2;
    ctx.fillStyle = T.surface2;
    ctx.strokeStyle = T.muted;
    ctx.lineWidth = 2;
    rrect(bx, bTop, bw, bBot - bTop, 4);
    ctx.fill();
    ctx.stroke();

    const reading = filled ? zeroReading + volumeAdded : 0;
    const frac = Math.max(0, Math.min(1, reading / SCALE_MAX));
    const surfaceY = bTop + frac * (bBot - bTop);
    if (filled) {
        ctx.fillStyle = SimLib.Color.alpha(T.secondary, 0.26);
        ctx.fillRect(bx + 2, surfaceY, bw - 4, bBot - surfaceY - 2);
        ctx.strokeStyle = SimLib.Color.alpha(T.secondary, 0.85);
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(bx + 2, surfaceY + 4);
        ctx.quadraticCurveTo(bcx, surfaceY - 3, bx + bw - 2, surfaceY + 4);
        ctx.stroke();
    }

    // Graduations: ticks every 1 mL, labels every 5
    ctx.font = T.font(9);
    ctx.textAlign = 'left';
    for (let mL = 0; mL <= 25; mL++) {
        const y = bTop + (mL / SCALE_MAX) * (bBot - bTop);
        const major = mL % 5 === 0;
        ctx.strokeStyle = T.faint;
        ctx.lineWidth = major ? 1.2 : 0.6;
        ctx.beginPath();
        ctx.moveTo(bx + 3, y);
        ctx.lineTo(bx + 3 + (major ? 9 : 5), y);
        ctx.stroke();
        if (major) {
            ctx.fillStyle = T.muted;
            ctx.fillText(String(mL), bx + bw + 5, y + 3);
        }
    }

    // Burette label
    const inBurette = titrant === 'base' ? base : acid;
    const buretteConc = titrant === 'base' ? concBase : concAcid;
    ctx.textAlign = 'center';
    ctx.fillStyle = T.secondary;
    ctx.font = T.font(11, '500');
    ctx.fillText(inBurette, bcx, bTop - 20);
    ctx.font = T.font(10);
    ctx.fillStyle = T.muted;
    ctx.fillText(buretteConc.toFixed(3) + ' M in burette', bcx, bTop - 7);

    // ── Stopcock ──
    ctx.fillStyle = T.faint;
    ctx.strokeStyle = T.muted;
    ctx.lineWidth = 1.5;
    rrect(bcx - 13, bBot, 26, 13, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = tapOpen ? T.secondary : T.muted;
    ctx.beginPath();
    ctx.arc(bcx, bBot + 6, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = T.surface;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    if (tapOpen) { ctx.moveTo(bcx - 4, bBot + 6); ctx.lineTo(bcx + 4, bBot + 6); }
    else         { ctx.moveTo(bcx, bBot + 2);     ctx.lineTo(bcx, bBot + 10); }
    ctx.stroke();
    ctx.fillStyle = T.faint;
    ctx.beginPath();
    ctx.moveTo(bcx - 4, bBot + 13);
    ctx.lineTo(bcx + 4, bBot + 13);
    ctx.lineTo(bcx + 2, bBot + 24);
    ctx.lineTo(bcx - 2, bBot + 24);
    ctx.closePath();
    ctx.fill();

    // ── Falling drops ──
    if (tapOpen) {
        const phases = [0, 0.5];
        phases.forEach(function (offset) {
            const t = ((clock / 520) + offset) % 1;
            const y = bBot + 26 + t * 44;
            ctx.fillStyle = SimLib.Color.alpha(T.secondary, 0.85 - t * 0.4);
            ctx.beginPath();
            ctx.ellipse(bcx, y, 2.8, 3.9, 0, 0, Math.PI * 2);
            ctx.fill();
        });
    }

    // ── Digital burette readout ──
    ctx.fillStyle = T.ink;
    rrect(168, 78, 132, 64, 9); ctx.fill();
    ctx.fillStyle = SimLib.Color.lighten(T.secondary, 0.45);
    ctx.font = T.font(9, '500');
    ctx.textAlign = 'left';
    ctx.fillText('BURETTE', 180, 96);
    ctx.font = T.font(22, '500');
    ctx.fillText(filled ? (zeroReading + volumeAdded).toFixed(2) : '--.--', 180, 125);
    ctx.fillStyle = T.faint;
    ctx.font = T.font(10);
    ctx.fillText('mL', 280, 125);

    // ── Reaction vessel (beaker) ──
    const kx = 116, kTop = 438, kBot = 524, khw = 52;
    function vesselPath() {
        ctx.beginPath();
        ctx.moveTo(kx - khw, kTop);
        ctx.lineTo(kx + khw, kTop);
        ctx.lineTo(kx + khw, kBot - 9);
        ctx.quadraticCurveTo(kx + khw, kBot, kx + khw - 9, kBot);
        ctx.lineTo(kx - khw + 9, kBot);
        ctx.quadraticCurveTo(kx - khw, kBot, kx - khw, kBot - 9);
        ctx.closePath();
    }
    // liquid
    let liquidTop = kBot;
    if (filled) {
        const totalVol = 25 + volumeAdded;
        const fillFrac = Math.min(1, totalVol / 150);
        liquidTop = kBot - 9 - fillFrac * (kBot - 9 - (kTop + 12));
        ctx.save();
        vesselPath();
        ctx.clip();
        ctx.fillStyle = liquidStyle();
        ctx.fillRect(kx - khw, liquidTop, khw * 2, kBot + 6 - liquidTop);
        const c = liveRGB(0.78);
        ctx.strokeStyle = rgbStr(c, 0.95);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(kx - khw, liquidTop);
        ctx.quadraticCurveTo(kx, liquidTop - 5, kx + khw, liquidTop);
        ctx.stroke();

        // A drop does not mix instantly: a faint streak of the titrant's colour
        // lingers near the surface and lasts longer as the endpoint nears.
        const prox = smoothstep(eqVol - 1.5, eqVol - 0.05, volumeAdded);
        const a = Math.min(0.5, swirl * prox * 0.55);
        if (a > 0.012) {
            const sc = colorForFraction(titrant === 'base' ? 1 : 0, 1);
            ctx.strokeStyle = rgbStr(sc, a);
            ctx.lineWidth = 6;
            ctx.lineCap = 'round';
            const yy = liquidTop + 13;
            ctx.beginPath();
            ctx.moveTo(kx - 42, yy);
            ctx.quadraticCurveTo(kx, yy + 9, kx + 42, yy - 3);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(kx - 30, yy + 15);
            ctx.quadraticCurveTo(kx + 6, yy + 21, kx + 36, yy + 9);
            ctx.stroke();
        }
        ctx.restore();
    }
    // glass
    ctx.strokeStyle = T.muted;
    ctx.lineWidth = 2.5;
    vesselPath();
    ctx.stroke();
    // pour spout
    ctx.beginPath();
    ctx.moveTo(kx - khw, kTop);
    ctx.quadraticCurveTo(kx - khw - 7, kTop - 1, kx - khw - 11, kTop - 9);
    ctx.stroke();
    // volume ticks on the glass
    ctx.strokeStyle = SimLib.Color.alpha(T.muted, 0.6);
    ctx.lineWidth = 1;
    for (let i = 1; i <= 5; i++) {
        const y = kBot - 9 - (i / 6) * (kBot - 9 - (kTop + 12));
        ctx.beginPath();
        ctx.moveTo(kx + khw - 12, y);
        ctx.lineTo(kx + khw, y);
        ctx.stroke();
    }
    // stirrer bar
    ctx.save();
    ctx.translate(kx, kBot - 7);
    ctx.rotate(Math.sin(clock * 0.02) * 0.55);
    ctx.fillStyle = T.faint;
    rrect(-11, -3, 22, 6, 3); ctx.fill();
    ctx.restore();

    // ── Vessel labels ──
    const inVessel = titrant === 'base' ? acid : base;
    const vesselConc = titrant === 'base' ? concAcid : concBase;
    ctx.textAlign = 'left';
    ctx.fillStyle = T.faint;
    ctx.font = T.font(9, '500');
    ctx.fillText('IN THE VESSEL \u2014 25.0 mL', 186, 452);
    ctx.fillStyle = T.ink;
    ctx.font = T.font(11, '500');
    ctx.fillText(inVessel, 186, 468);
    ctx.fillStyle = T.muted;
    ctx.font = T.font(10);
    ctx.fillText(vesselConc.toFixed(3) + ' M', 186, 484);
}

// ═══════════════════════════════════════════════════════════════
//  Drawing — pH curve
// ═══════════════════════════════════════════════════════════════
function drawCurve() {
    const px = 330, py = 34, pw = 595, ph = 517;
    const gx0 = 392, gy0 = 102, gx1 = 890, gy1 = 472;
    const gw = gx1 - gx0, gh = gy1 - gy0;
    const X = v => gx0 + (v / SCALE_MAX) * gw;
    const Y = p => gy1 - (Math.max(0, Math.min(14, p)) / 14) * gh;

    // panel
    ctx.fillStyle = T.surface;
    ctx.strokeStyle = T.grid;
    ctx.lineWidth = 1;
    rrect(px, py, pw, ph, 14);
    ctx.fill();
    ctx.stroke();

    // header
    ctx.fillStyle = T.ink;
    ctx.font = T.font(13, '500');
    ctx.textAlign = 'left';
    ctx.fillText('pH Curve', px + 22, py + 30);
    ctx.fillStyle = T.faint;
    ctx.font = T.font(10);
    ctx.fillText('shaded band = colour of the mixture', px + 96, py + 30);

    // current-colour swatch
    const sw = filled ? liveSwatch() : [226, 232, 240];
    ctx.fillStyle = rgbStr(sw, 1);
    rrect(px + pw - 96, py + 14, 22, 22, 6); ctx.fill();
    ctx.strokeStyle = T.gridStrong; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = T.muted;
    ctx.font = T.font(10);
    ctx.fillText('current', px + pw - 66, py + 29);

    ctx.strokeStyle = T.surface2;
    ctx.beginPath();
    ctx.moveTo(px + 18, py + 46);
    ctx.lineTo(px + pw - 18, py + 46);
    ctx.stroke();

    // plot background
    ctx.fillStyle = T.bg;
    ctx.fillRect(gx0, gy0, gw, gh);

    // ── shaded band under the curve tinted by the indicator ──
    if (trace.length > 1) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(gx0, gy0, gw, gh);
        ctx.clip();
        for (let i = 1; i < trace.length; i++) {
            const a = trace[i - 1], b = trace[i];
            const c = solutionSwatch(b.pH);
            ctx.fillStyle = rgbStr(c, 0.34);
            ctx.beginPath();
            ctx.moveTo(X(a.v), Y(a.pH));
            ctx.lineTo(X(b.v), Y(b.pH));
            ctx.lineTo(X(b.v), gy1);
            ctx.lineTo(X(a.v), gy1);
            ctx.closePath();
            ctx.fill();
        }
        ctx.restore();
    }

    // grid
    ctx.font = T.font(10);
    ctx.textAlign = 'right';
    for (let p = 0; p <= 14; p += 2) {
        const y = Y(p);
        ctx.strokeStyle = T.surface2;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(gx0, y);
        ctx.lineTo(gx1, y);
        ctx.stroke();
        ctx.fillStyle = T.faint;
        ctx.fillText(String(p), gx0 - 9, y + 3);
    }
    ctx.textAlign = 'center';
    for (let v = 0; v <= SCALE_MAX; v += 5) {
        const x = X(v);
        ctx.strokeStyle = T.surface2;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, gy0);
        ctx.lineTo(x, gy1);
        ctx.stroke();
        ctx.fillStyle = T.faint;
        ctx.fillText(String(v), x, gy1 + 16);
    }

    // axes
    ctx.strokeStyle = T.faint;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(gx0, gy0);
    ctx.lineTo(gx0, gy1);
    ctx.lineTo(gx1, gy1);
    ctx.stroke();

    // titles
    ctx.fillStyle = T.text;
    ctx.font = T.font(10, '500');
    ctx.textAlign = 'center';
    ctx.fillText('volume added (mL)', gx0 + gw / 2, gy1 + 40);
    ctx.save();
    ctx.translate(gx0 - 42, gy0 + gh / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('pH', 0, 0);
    ctx.restore();

    // equivalence marker
    if (showEqCb.checked && filled && eqVol <= SCALE_MAX && volumeAdded >= eqVol + 0.2) {
        const ex = X(eqVol), ey = Y(eqPH);
        ctx.strokeStyle = T.series[2];
        ctx.lineWidth = 1.3;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(ex, gy0);
        ctx.lineTo(ex, ey);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = T.series[2];
        ctx.beginPath();
        ctx.moveTo(ex, ey - 5);
        ctx.lineTo(ex + 5, ey);
        ctx.lineTo(ex, ey + 5);
        ctx.lineTo(ex - 5, ey);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = T.surface;
        ctx.fillRect(ex - 34, gy0 - 16, 68, 15);
        ctx.fillStyle = T.warn;
        ctx.font = T.font(10, '500');
        ctx.textAlign = 'center';
        ctx.fillText('equivalence', ex, gy0 - 5);
    }

    // curve
    if (trace.length > 1) {
        ctx.strokeStyle = T.accent;
        ctx.lineWidth = 2.6;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(X(trace[0].v), Y(trace[0].pH));
        for (let i = 1; i < trace.length; i++) ctx.lineTo(X(trace[i].v), Y(trace[i].pH));
        ctx.stroke();
    }

    // recorded readings
    if (showDataCb.checked) {
        for (const row of logRows) {
            ctx.fillStyle = T.series[2];
            ctx.beginPath();
            ctx.arc(X(Math.min(SCALE_MAX, row.v)), Y(row.pH), 3, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = T.surface;
            ctx.lineWidth = 1.2;
            ctx.stroke();
        }
    }

    // current point
    if (filled) {
        const cx2 = X(Math.min(SCALE_MAX, volumeAdded)), cy2 = Y(pHat(volumeAdded));
        ctx.fillStyle = T.accent;
        ctx.beginPath();
        ctx.arc(cx2, cy2, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = T.surface;
        ctx.lineWidth = 2.2;
        ctx.stroke();
    }
}

function render() {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = T.bg;
    ctx.fillRect(0, 0, W, H);
    drawApparatus();
    if (realLab) drawObservationPanel();
    else drawCurve();
}

function drawObservationPanel() {
    const px = 330, py = 34, pw = 595, ph = 517;

    ctx.fillStyle = T.surface;
    ctx.strokeStyle = T.grid;
    ctx.lineWidth = 1;
    rrect(px, py, pw, ph, 14);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = T.ink;
    ctx.font = T.font(13, '500');
    ctx.textAlign = 'left';
    ctx.fillText('Observation', px + 22, py + 30);
    ctx.fillStyle = T.faint;
    ctx.font = T.font(10);
    ctx.fillText('everything the bench lets you see', px + 112, py + 30);

    // large colour field matching the vessel contents
    const fx = px + 40, fy = py + 66, fw = pw - 80, fh = 300;
    const sw = filled ? liveSwatch() : [241, 245, 249];
    ctx.fillStyle = rgbStr(sw, 1);
    rrect(fx, fy, fw, fh, 14);
    ctx.fill();
    ctx.strokeStyle = T.gridStrong;
    ctx.lineWidth = 1;
    ctx.stroke();
    // glass-like highlight
    ctx.strokeStyle = SimLib.Color.alpha(T.surface, 0.7);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(fx + 18, fy + fh - 24);
    ctx.lineTo(fx + 18, fy + 24);
    ctx.stroke();

    ctx.fillStyle = T.ink;
    ctx.font = T.font(14, '500');
    ctx.fillText(indicator, fx, fy + fh + 36);
    ctx.fillStyle = T.faint;
    ctx.font = T.font(11);
    ctx.fillText('indicator in the vessel', fx, fy + fh + 54);

    ctx.fillStyle = T.muted;
    ctx.font = T.font(11);
    ctx.fillText('No meter on this bench \u2014 the colour is your only reading.', fx, py + ph - 28);
    ctx.fillText('Add titrant slowly near the change and watch for the first permanent colour.', fx, py + ph - 11);
}

// ═══════════════════════════════════════════════════════════════
//  UI state helpers
// ═══════════════════════════════════════════════════════════════
// `content` is text, or text parts such as { strong: true, text } (never markup).
function say(content, tone) {
    ui.setContent('titrMessage', content);
    messageEl.dataset.tone = tone || '';
}

function readControls() {
    realLab = realLabCb.checked;
    acid = acidSelect.value;
    base = baseSelect.value;
    indicator = indicatorSel.value;
    concAcid = Math.max(0.001, Math.min(5, parseFloat(concAcidInput.value) || 0.1));
    concBase = Math.max(0.001, Math.min(5, parseFloat(concBaseInput.value) || 0.1));
    titrant = titrantPick.value === 'acid' ? 'acid' : 'base';
}

function updateHints() {
    const inVessel = titrant === 'base' ? concAcid : concBase;
    const inBurette = titrant === 'base' ? concBase : concAcid;

    // keep the equivalence volume between ~5 and ~20 mL
    const buretteLo = inVessel * 1.25;
    const buretteHi = inVessel * 5;
    const vesselLo = inBurette / 5;
    const vesselHi = inBurette / 1.25;

    function paint(el, value, lo, hi) {
        const ok = value >= lo - 1e-9 && value <= hi + 1e-9;
        el.textContent = 'suggested ' + fmtM(lo) + ' \u2013 ' + fmtM(hi) + ' M';
        el.dataset.tone = ok ? '' : 'warn';
    }
    if (titrant === 'base') {
        paint(baseHint, concBase, buretteLo, buretteHi);
        paint(acidHint, concAcid, vesselLo, vesselHi);
    } else {
        paint(acidHint, concAcid, buretteLo, buretteHi);
        paint(baseHint, concBase, vesselLo, vesselHi);
    }
}

function refreshButtons() {
    tapBtn.disabled = !filled || weakPair();
}

function refreshLog() {
    logThirdHead.textContent = realLab ? 'Colour' : 'pH';
    if (showDataCb.checked && logRows.length) {
        ui.setRows('dataBody', logRows.map(function (row, i) {
            const third = realLab
                ? { swatch: rgbStr(solutionSwatch(row.pH), 1), text: 'Indicator colour' }
                : row.pH.toFixed(2);
            return [String(i + 1), row.reading.toFixed(2), third];
        }));
        dataWrap.hidden = false;
        dataHint.hidden = true;
    } else {
        ui.setRows('dataBody', []);
        dataWrap.hidden = true;
        dataHint.hidden = false;
    }
}

function addLogRow() {
    if (!showDataCb.checked || !filled) return;
    logRows.push({ v: volumeAdded, reading: zeroReading + volumeAdded, pH: pHat(volumeAdded) });
    refreshLog();
}

function refreshReadouts() {
    if (!filled) {
        burReadout.textContent = '--';
        phReadout.textContent = '--';
        eqReadout.textContent = '--';
        dockPH.textContent = '--';
        dockSwatch.style.background = T.grid;
        return;
    }
    burReadout.textContent = (zeroReading + volumeAdded).toFixed(2);
    phReadout.textContent = pHat(volumeAdded).toFixed(2);
    eqReadout.textContent = eqVol.toFixed(2);
    dockPH.textContent = pHat(volumeAdded).toFixed(2);
    dockSwatch.style.background = rgbStr(liveSwatch(), 1);
}

const phOnly = [showEqCb.closest('label'), phReadout.parentElement, eqReadout.parentElement];

function applyMode() {
    realLab = realLabCb.checked;
    // Real-lab mode strips every live pH hint, leaving only the indicator colour.
    for (const el of phOnly) el.hidden = realLab;
    dockPH.hidden = realLab;
    dockSwatch.hidden = !realLab;
    dockPHLabel.textContent = realLab ? 'colour' : 'pH';
    refreshReadouts();
    refreshLog();
}

// ═══════════════════════════════════════════════════════════════
//  Filling / resetting the bench
// ═══════════════════════════════════════════════════════════════
function fillBench() {
    filled = true;
    tapOpen = false;
    crossedEq = false;
    volumeAdded = 0;
    trace = [];
    logRows = [];
    zeroReading = Math.round(Math.random() * 60) / 100;   // 0.00 – 0.60 mL

    const inVessel = titrant === 'base' ? concAcid : concBase;
    const inBurette = titrant === 'base' ? concBase : concAcid;
    eqVol = SCALE_MAX * inVessel / inBurette;
    eqPH = pHat(eqVol);

    const startPH = pHat(0);
    trace.push({ v: 0, pH: startPH, rgb: mixRGB(startPH, 1) });
    displayF = fractionAt(startPH);
    swirl = 0;

    tapBtn.classList.remove('is-active');
    tapBtn.textContent = 'Press & hold to open the tap';
    refreshButtons();
    refreshReadouts();
    addLogRow();
    refreshLog();

    if (realLab) {
        say('Bench is ready and stirring. Add titrant until the indicator changes colour, then release the tap.', 'ok');
    } else if (eqVol > SCALE_MAX + 0.01) {
        say(['Bench ready. The equivalence point would land at ', { strong: true, text: eqVol.toFixed(1) + ' mL' }, ', off the right-hand edge \u2014 raise the burette concentration or lower the vessel one. Aim for the suggested ranges.'], 'warn');
    } else if (eqVol < 4) {
        say(['Bench ready. The jump sits at just ', { strong: true, text: eqVol.toFixed(1) + ' mL' }, ', so it will happen almost at once. Try a more concentrated vessel solution.'], 'warn');
    } else {
        say('Bench ready and stirring. Press and hold the tap (or the button) to titrate, then release to pause.', 'ok');
    }
}

function resetBench() {
    readControls();
    updateHints();

    filled = false;
    tapOpen = false;
    volumeAdded = 0;
    trace = [];
    logRows = [];
    crossedEq = false;
    tapBtn.classList.remove('is-active');
    tapBtn.textContent = 'Press & hold to open the tap';

    if (weakPair()) {
        refreshButtons();
        refreshReadouts();
        refreshLog();
        say('A weak acid paired with a weak base is outside this model \u2014 make at least one partner strong.', 'warn');
        return;
    }
    fillBench();
}

// ═══════════════════════════════════════════════════════════════
//  Tap control
// ═══════════════════════════════════════════════════════════════
function openTap() {
    if (!filled || tapOpen || weakPair()) return;
    tapOpen = true;
    clock = 0;
    tapBtn.classList.add('is-active');
    tapBtn.textContent = 'Release to stop';
    say('Tap is open \u2014 drops are falling. Let go to pause.', 'ok');
}

function closeTap(automatic) {
    if (!tapOpen) return;
    tapOpen = false;
    tapBtn.classList.remove('is-active');
    tapBtn.textContent = 'Press & hold to open the tap';
    addLogRow();
    if (!automatic) {
        say('Tap closed. Hold it again to carry on, or change any setting to start a fresh run.', 'ok');
    }
}

function dripInterval() {
    const v = parseInt(dropRate.value, 10);
    return 100 - (v - 1) * (70 / 9);   // 100 ms slow … 30 ms fast
}

function advance() {
    volumeAdded = Math.min(SCALE_MAX, volumeAdded + DROP);
    const pH = pHat(volumeAdded);
    trace.push({ v: volumeAdded, pH: pH, rgb: mixRGB(pH, 1) });
    swirl = Math.min(1, swirl + 0.75);

    if (!crossedEq && volumeAdded >= eqVol) {
        crossedEq = true;
        if (!realLab) {
            say(['The jump has been passed at about ', { strong: true, text: eqVol.toFixed(2) + ' mL' }, '. Keep going to see the curve flatten out on the other side.'], 'ok');
        }
    }
    if (volumeAdded >= SCALE_MAX) {
        closeTap(true);
        say('Burette empty \u2014 the run finished automatically. Change a setting to start another.', 'ok');
    }
    refreshReadouts();
}

// ═══════════════════════════════════════════════════════════════
//  Loop
// ═══════════════════════════════════════════════════════════════
let dripAccum = 0;
function tick(dt) {
    const ms = dt * 1000;
    clock += ms;
    if (tapOpen) {
        const step = dripInterval();
        dripAccum += ms;
        let guard = 0;
        while (tapOpen && dripAccum >= step && guard++ < 200) {
            dripAccum -= step;
            advance();
        }
    } else {
        dripAccum = 0;
    }

    // ease the displayed colour so the indicator develops smoothly rather than snapping
    const targetF = filled ? fractionAt(pHat(volumeAdded)) : 0;
    displayF += (targetF - displayF) * 0.05;
    swirl *= 0.93;
}

// ═══════════════════════════════════════════════════════════════
//  Wiring
// ═══════════════════════════════════════════════════════════════
// Options are declared in the catalog; only the starting selections are applied here.
function buildSelects() {
    acidSelect.value = acid;
    baseSelect.value = base;
    indicatorSel.value = indicator;
}

function wire() {
    [acidSelect, baseSelect, indicatorSel].forEach(function (el) {
        el.addEventListener('change', resetBench);
    });
    [concAcidInput, concBaseInput].forEach(function (el) {
        el.addEventListener('change', resetBench);
    });
    let lastTitrant = titrantPick.value;
    titrantPick.addEventListener('click', function () {
        if (titrantPick.value === lastTitrant) return;
        lastTitrant = titrantPick.value;
        resetBench();
    });
    showDataCb.addEventListener('change', function () {
        if (!showDataCb.checked) logRows = [];
        refreshLog();
    });
    realLabCb.addEventListener('change', applyMode);
    dropRate.addEventListener('input', function () {
        const v = parseInt(dropRate.value, 10);
        dropRateVal.textContent = v <= 3 ? 'Slow' : v <= 7 ? 'Medium' : 'Fast';
    });

    resetBtn.addEventListener('click', function () {
        tapBtn.classList.remove('is-active');
        tapBtn.textContent = 'Press & hold to open the tap';
        resetBench();
    });

    // hold the on-screen button
    tapBtn.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        if (tapBtn.setPointerCapture) {
            try { tapBtn.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        }
        openTap();
    });
    ['pointerup', 'pointercancel'].forEach(function (ev) {
        tapBtn.addEventListener(ev, function () { closeTap(false); });
    });

    // hold the stopcock drawn on the canvas
    function onTap(e) {
        const r = canvas.getBoundingClientRect();
        const x = (e.clientX - r.left) * (W / r.width);
        const y = (e.clientY - r.top) * (H / r.height);
        return x > 78 && x < 152 && y > 352 && y < 390;
    }
    canvas.addEventListener('pointerdown', function (e) {
        if (onTap(e)) {
            e.preventDefault();
            openTap();
        }
    });
    window.addEventListener('pointerup', function () { closeTap(false); });
    window.addEventListener('blur', function () { closeTap(false); });
}

// ── roundRect polyfill ──
if (!CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
        r = typeof r === 'number' ? r : (r || 0);
        this.moveTo(x + r, y); this.lineTo(x + w - r, y);
        this.quadraticCurveTo(x + w, y, x + w, y + r); this.lineTo(x + w, y + h - r);
        this.quadraticCurveTo(x + w, y + h, x + w - r, y + h); this.lineTo(x + r, y + h);
        this.quadraticCurveTo(x, y + h, x, y + h - r); this.lineTo(x, y + r);
        this.quadraticCurveTo(x, y, x + r, y);
    };
}

// ═══════════════════════════════════════════════════════════════
//  Go
// ═══════════════════════════════════════════════════════════════
buildSelects();
wire();
applyMode();
resetBench();

// ═══ Animation (SimLib) ═══
// The scene is drawn in a fixed 940x580 logical space; SimLib maps it onto
// the responsive (HiDPI-aware) displayed canvas so nothing is clipped.
const app = SimLib.attach({
    canvas: canvas,
    logicalWidth: 940,
    logicalHeight: 580,
    SimulationClass: class TitrationSim extends SimLib.Simulation {
        onResize() { render(); }
        onTick(dt) { tick(dt); }
        onDraw() { render(); }
    }
});
app.sim.start();

    return { app };
}
