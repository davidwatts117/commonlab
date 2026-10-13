// Physics, canvas drawing, and control bindings only. Page structure is owned by the shell.
export function mount(ui) {
    const document = ui;
'use strict';

// ═══ Constants ═══
const canvas = document.getElementById('titrCanvas');
const T = SimLib.Theme.use('light');
const ctx = canvas.getContext('2d');
const W = canvas.width, H = canvas.height;

// ═══ State ═══
let scenario = 'strong-strong';
let acidConc = 0.1;     // M
let acidVol = 25.0;     // mL (analyte in flask)
let baseConc = 0.1;     // M (titrant in burette)
let volumeAdded = 0.0;  // mL of base added
let showAnswer = false; // reveal the "unknown" analyte concentration
let showPH = false;     // show pH instrumentation (off by default)

// Indicator
let indicator = 'phenolphthalein';

const INDICATORS = {
    methylorange:    { label: 'Methyl Orange',    lo: 3.1, hi: 4.4,  acid: [255, 140, 0],  base: [255, 210, 60] },
    bromothymol:     { label: 'Bromothymol Blue', lo: 6.0, hi: 7.6,  acid: [255, 220, 60], base: [40, 110, 200] },
    phenolphthalein: { label: 'Phenolphthalein',  lo: 8.2, hi: 10.0, acid: [250, 250, 250], base: [220, 40, 110] },
};

// ═══ Chemistry ═══
// Instead of hand-rolled piecewise formulas (which drift out of sync and were
// demonstrably wrong for the strong-acid/weak-base case), we solve the
// charge-balance equation numerically. This one expression is correct for
// every strong/weak combination, including near the equivalence point where
// the piecewise versions needed fudge factors.
//
//   [H+] + cation = anion + [OH-]
//
//   cation = [base species carrying a charge]
//            strong base -> fully dissociated,  [Na+]  = CB
//            weak base   -> [BH+] = CB·Kb/(Kb+[OH-])
//   anion  = [acid species carrying a charge]
//            strong acid -> fully dissociated,  [Cl-]  = CA
//            weak acid   -> [A-]  = CA·Ka/(Ka+[H+])

const KW = 1e-14; // Kw at 25 °C

const SCENARIOS = {
    'strong-strong': { label: 'Strong Acid + Strong Base', acid: 'strong', base: 'strong', Ka: null,    Kb: null },
    'weak-strong':   { label: 'Weak Acid + Strong Base',   acid: 'weak',   base: 'strong', Ka: 1.8e-5, Kb: null },
    'strong-weak':   { label: 'Strong Acid + Weak Base',   acid: 'strong', base: 'weak',   Ka: null,    Kb: 1.8e-5 },
    'weak-weak':     { label: 'Weak Acid + Weak Base',     acid: 'weak',   base: 'weak',   Ka: 1.8e-5, Kb: 1.8e-5 },
};

function currentSpec() {
    return SCENARIOS[scenario] || SCENARIOS['strong-strong'];
}

function computeEquivalenceVolume() {
    return (acidConc * acidVol) / baseConc;
}

/** Volume of titrant the burette can hold; the titration is clamped to this. */
function buretteCapacity() {
    const needed = computeEquivalenceVolume() * 2 + 5;
    return Math.max(50, Math.ceil(needed / 10) * 10);
}

// Solve the charge balance for [H+] by bisection in log space.
// The residual is strictly increasing in [H+], so bisection is guaranteed to
// converge; 50 halvings of a 15-decade range is far more precision than needed.
function solveH(CA, Ka, CB, Kb) {
    const residual = (h) => {
        const oh = KW / h;
        const cation = Kb ? CB * Kb / (Kb + oh) : CB;
        const anion = Ka ? CA * Ka / (Ka + h) : CA;
        return h + cation - anion - oh;
    };

    let loExp = -15, hiExp = 0; // [H+] from 1e-15 to 1
    for (let i = 0; i < 50; i++) {
        const midExp = (loExp + hiExp) / 2;
        if (residual(Math.pow(10, midExp)) > 0) hiExp = midExp;
        else loExp = midExp;
    }
    return Math.pow(10, (loExp + hiExp) / 2);
}

function computePH(volAdded) {
    const spec = currentSpec();
    const totalVolL = (acidVol + volAdded) / 1000; // litres
    if (totalVolL <= 0) return 7;

    const nAcid = acidConc * acidVol / 1000;  // moles
    const nBase = baseConc * volAdded / 1000;  // moles

    const CA = nAcid / totalVolL; // total acid species concentration
    const CB = nBase / totalVolL; // total base species concentration

    const Ka = spec.acid === 'weak' ? spec.Ka : null;
    const Kb = spec.base === 'weak' ? spec.Kb : null;

    const h = solveH(CA, Ka, CB, Kb);
    return Math.max(0, Math.min(14, -Math.log10(h)));
}

// ═══ Drawing ═══
// By default there is NO pH meter, pH scale, or pH curve. In a real lab you
// cannot see the pH — the only evidence is the indicator colour in the flask,
// and the titre is whatever reading you had when the colour changed. Anything
// that displayed a number would defeat the exercise.
//
// The "Show pH" toggle (showPH) turns all three on for anyone who would rather
// watch the chemistry than find the endpoint by eye.
function draw() {
    ctx.clearRect(0, 0, W, H);
    SimLib.Draw.background(ctx, W, H, T);
    SimLib.Draw.title(ctx, 'Titration', 14, 22, { size: 13, color: T.muted, theme: T });

    // ── Lab apparatus ──
    const labW = 280;
    drawLabApparatus(labW);

    // ── Right side: either the pH curve, or the burette reading panel ──
    // They are mutually exclusive: the pH curve claims the same space, and
    // showing it already hands over the pH the exercise is meant to hide.
    if (showPH) {
        const curveX = labW + 20, curveY = 30;
        const curveW = W - curveX - 15, curveH = H - 60;
        drawPHCurve(curveX, curveY, curveW, curveH);
        drawPHBar(curveX, H - 20, curveW);
    } else {
        drawBurettePanel(W - 150, 40, 130, 150);
    }
}

function drawLabApparatus(labW) {
    // ── Burette (left, tall) ──
    const buretteX = 70, buretteTop = 40, buretteW = 22, buretteH = 260;
    const buretteBottom = buretteTop + buretteH;

    // Burette body
    ctx.fillStyle = T.accentSoft;
    ctx.strokeStyle = T.accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(buretteX, buretteTop);
    ctx.lineTo(buretteX + buretteW, buretteTop);
    ctx.lineTo(buretteX + buretteW - 2, buretteBottom - 10);
    ctx.lineTo(buretteX + 2, buretteBottom - 10);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Burette graduations
    const maxML = 50;
    const fillPct = 1 - (volumeAdded / maxML);
    const liquidTop = buretteBottom - 10 - (buretteH - 30) * fillPct;
    const mLPerPx = maxML / (buretteH - 30);

    // Liquid inside burette
    if (fillPct > 0.01) {
        ctx.fillStyle = 'rgba(180, 210, 240, 0.5)';
        ctx.beginPath();
        ctx.rect(buretteX + 3, liquidTop, buretteW - 6, buretteBottom - 10 - liquidTop);
        ctx.fill();
    }

    // Tick marks
    ctx.fillStyle = T.accent;
    ctx.font = T.font(8);
    ctx.textAlign = 'right';
    for (let mL = 0; mL <= 50; mL += 5) {
        const y = buretteBottom - 10 - (mL / maxML) * (buretteH - 30);
        ctx.fillText(mL, buretteX - 6, y + 3);
        ctx.strokeStyle = T.borderStrong;
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(buretteX + 2, y);
        ctx.lineTo(buretteX + buretteW - 2, y);
        ctx.stroke();
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = T.accent;
    ctx.font = T.font(9, 'bold');
    ctx.fillText('NaOH', buretteX + buretteW/2, buretteTop - 10);
    ctx.fillText(baseConc.toFixed(2) + ' M', buretteX + buretteW/2, buretteBottom + 12);

    // Stopcock
    const stopcockY = buretteBottom - 10;
    ctx.fillStyle = T.muted;
    ctx.beginPath();
    ctx.roundRect(buretteX - 6, stopcockY - 4, buretteW + 12, 10, 3);
    ctx.fill();
    ctx.fillStyle = T.text;
    ctx.beginPath();
    ctx.arc(buretteX + buretteW/2, stopcockY + 1, 5, 0, Math.PI * 2);
    ctx.fill();

    // Drop forming
    if (volumeAdded < computeEquivalenceVolume() + 10) {
        const dropY = stopcockY + 15 + Math.sin(Date.now() * 0.005) * 3;
        ctx.fillStyle = 'rgba(140, 180, 220, 0.7)';
        ctx.beginPath();
        ctx.arc(buretteX + buretteW/2, dropY, 3.5, 0, Math.PI * 2);
        ctx.fill();
        // Drop falling
        const dropY2 = dropY + 18;
        ctx.fillStyle = 'rgba(140, 180, 220, 0.4)';
        ctx.beginPath();
        ctx.arc(buretteX + buretteW/2 - 1, dropY2, 2.5, 0, Math.PI * 2);
        ctx.fill();
    }

    // ── Flask (below burette tip) ──
    const flaskCX = buretteX + buretteW/2, flaskTop = stopcockY + 38;
    const flaskW = 90, flaskH = 100;
    const flaskBottom = flaskTop + flaskH;

    // Flask body (Erlenmeyer shape)
    ctx.fillStyle = T.surface;
    ctx.strokeStyle = T.muted;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(flaskCX - flaskW/2 + 25, flaskTop);
    ctx.lineTo(flaskCX + flaskW/2 - 25, flaskTop);
    ctx.lineTo(flaskCX + flaskW/2, flaskTop + 20);
    ctx.lineTo(flaskCX + flaskW/2 - 10, flaskBottom);
    ctx.lineTo(flaskCX - flaskW/2 + 10, flaskBottom);
    ctx.lineTo(flaskCX - flaskW/2, flaskTop + 20);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Flask neck
    ctx.fillStyle = T.surface;
    ctx.strokeStyle = T.muted;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.rect(flaskCX - 16, flaskTop - 6, 32, 12);
    ctx.fill();
    ctx.stroke();

    // Solution in flask
    const pH = computePH(volumeAdded);
    const indicatorColor = getIndicatorColor(pH);
    const flaskMidY = flaskTop + flaskH/2 + 5;

    ctx.fillStyle = indicatorColor;
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.moveTo(flaskCX - flaskW/2 + 28, flaskTop + 8);
    ctx.lineTo(flaskCX + flaskW/2 - 28, flaskTop + 8);
    ctx.lineTo(flaskCX + flaskW/2 - 12, flaskBottom - 4);
    ctx.lineTo(flaskCX - flaskW/2 + 12, flaskBottom - 4);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;

    // Flask label
    ctx.fillStyle = T.accent;
    ctx.font = T.font(9, 'bold');
    ctx.textAlign = 'center';
    const spec = currentSpec();
    const acidLabel = spec.acid === 'weak' ? 'CH\u2083COOH' : 'HCl';
    ctx.fillText(acidLabel, flaskCX, flaskBottom + 16);
    // The analyte concentration is the "unknown" the user is meant to determine,
    // so it stays hidden until explicitly revealed.
    ctx.fillText(
        (showAnswer ? acidConc.toFixed(3) + ' M' : '? M') + ', ' + acidVol.toFixed(0) + ' mL',
        flaskCX, flaskBottom + 30
    );

    // On reveal, also give the true endpoint so the user can grade their own run.
    if (showAnswer) {
        ctx.fillStyle = T.success;
        ctx.font = T.font(9, 'bold');
        ctx.fillText(
            'True endpoint: ' + computeEquivalenceVolume().toFixed(2) + ' mL',
            flaskCX, flaskBottom + 44
        );
    }

    // ── pH meter (only when pH instrumentation is switched on) ──
    if (showPH) {
        const pHMeterX = flaskCX + flaskW / 2 + 20, pHMeterY = flaskTop;
        ctx.fillStyle = T.surface2;
        ctx.strokeStyle = T.ink;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.roundRect(pHMeterX, pHMeterY, 50, 70, 6);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = T.ink;
        ctx.font = T.font(18, 'bold');
        ctx.textAlign = 'center';
        ctx.fillText(pH.toFixed(2), pHMeterX + 25, pHMeterY + 32);
        ctx.fillStyle = T.muted;
        ctx.font = T.font(9, 'bold');
        ctx.fillText('pH', pHMeterX + 25, pHMeterY + 50);
        // Probe wire
        ctx.strokeStyle = T.faint;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(pHMeterX, pHMeterY + 15);
        ctx.quadraticCurveTo(flaskCX, flaskTop - 20, flaskCX, flaskTop + 5);
        ctx.stroke();
        // Probe tip in flask
        ctx.fillStyle = T.ink;
        ctx.beginPath();
        ctx.arc(flaskCX, flaskTop + 10, 3, 0, Math.PI * 2);
        ctx.fill();
    }

    // Magnetic stirrer
    // Offset down so it never collides with the reveal caption.
    const stirY = flaskBottom + (showAnswer ? 60 : 48);
    ctx.fillStyle = T.borderStrong;
    ctx.beginPath();
    ctx.roundRect(flaskCX - 35, stirY, 70, 14, 4);
    ctx.fill();
    ctx.fillStyle = T.faint;
    ctx.font = T.font(8);
    ctx.textAlign = 'center';
    ctx.fillText('Stirrer', flaskCX, stirY + 10);
    // Stir bar in flask
    const stirAngle = Date.now() * 0.008;
    const stirLen = 12;
    ctx.save();
    ctx.translate(flaskCX, flaskBottom - 10);
    ctx.rotate(stirAngle);
    ctx.fillStyle = T.faint;
    ctx.beginPath();
    ctx.roundRect(-stirLen/2, -2.5, stirLen, 5, 2);
    ctx.fill();
    ctx.restore();
}

// The solution colour follows the chosen indicator across its transition
// range; outside that range it sits at the pure acid or base colour.
function getIndicatorColor(pH) {
    const ind = INDICATORS[indicator] || INDICATORS.phenolphthalein;
    const t = Math.max(0, Math.min(1, (pH - ind.lo) / (ind.hi - ind.lo)));
    const mix = (a, b, f) => Math.round(a + (b - a) * f);
    const r = mix(ind.acid[0], ind.base[0], t);
    const g = mix(ind.acid[1], ind.base[1], t);
    const b = mix(ind.acid[2], ind.base[2], t);
    // A fully transparent "colourless" acid end (phenolphthalein) still needs
    // enough alpha for the liquid to be visible against the white flask.
    const alpha = (0.55 + t * 0.2).toFixed(2);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
}

/** Horizontal pH scale with a marker at the current pH. */
function drawPHBar(x, y, w) {
    const barH = 14;
    const pH = computePH(volumeAdded);

    // Gradient bar from pH 0 (red) to pH 14 (blue)
    const barGrad = ctx.createLinearGradient(x, 0, x + w, 0);
    for (let i = 0; i <= 14; i++) {
        const t = i / 14;
        let r, g, B;
        if (t < 0.5) {
            // Red to yellow
            const tt = t * 2;
            r = 220; g = Math.round(50 + tt * 180); B = Math.round(50 - tt * 20);
        } else {
            // Yellow to blue
            const tt = (t - 0.5) * 2;
            r = Math.round(220 - tt * 180); g = Math.round(230 - tt * 160); B = Math.round(30 + tt * 150);
        }
        barGrad.addColorStop(t, 'rgb(' + r + ',' + g + ',' + B + ')');
    }
    ctx.fillStyle = barGrad;
    ctx.beginPath();
    ctx.roundRect(x, y, w, barH, 4);
    ctx.fill();

    // Current pH indicator
    const pHX = x + (pH / 14) * w;
    ctx.fillStyle = T.ink;
    ctx.beginPath();
    ctx.moveTo(pHX, y - 6);
    ctx.lineTo(pHX - 5, y - 2);
    ctx.lineTo(pHX + 5, y - 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(pHX, y + barH + 6);
    ctx.lineTo(pHX - 5, y + barH + 2);
    ctx.lineTo(pHX + 5, y + barH + 2);
    ctx.fill();

    // pH label
    ctx.fillStyle = T.ink;
    ctx.font = T.font(10, 'bold');
    ctx.textAlign = 'center';
    ctx.fillText('pH ' + pH.toFixed(2), pHX, y - 8);

    // Tick marks
    ctx.fillStyle = T.text;
    ctx.font = T.font(8);
    ctx.textAlign = 'center';
    for (let p = 0; p <= 14; p += 2) {
        const tx = x + (p / 14) * w;
        ctx.fillText(p, tx, y + barH + 16);
    }
}

/** Titration curve: pH against volume of titrant added, with the endpoint marked. */
function drawPHCurve(cx, cy, cw, ch) {
    const eqVol = computeEquivalenceVolume();
    const maxVol = Math.max(eqVol * 2 + 5, volumeAdded + 5);

    // Axes
    ctx.strokeStyle = T.ink;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx, cy + ch);
    ctx.lineTo(cx + cw, cy + ch);
    ctx.stroke();

    // Labels
    ctx.fillStyle = T.ink;
    ctx.font = T.font(11, 'bold');
    ctx.textAlign = 'center';
    ctx.fillText('Volume of Titrant Added (mL)', cx + cw / 2, cy + ch + 30);
    ctx.save();
    ctx.translate(cx - 28, cy + ch / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('pH', 0, 0);
    ctx.restore();

    // Y-axis ticks
    ctx.fillStyle = T.muted;
    ctx.font = T.font(8);
    ctx.textAlign = 'right';
    for (let p = 0; p <= 14; p += 2) {
        const y = cy + ch - (p / 14) * ch;
        ctx.fillText(p, cx - 6, y + 3);
        ctx.strokeStyle = T.grid;
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(cx, y);
        ctx.lineTo(cx + cw, y);
        ctx.stroke();
    }

    // X-axis ticks
    ctx.fillStyle = T.muted;
    ctx.textAlign = 'center';
    const tickStep = maxVol > 100 ? 25 : maxVol > 50 ? 10 : 5;
    for (let v = 0; v <= maxVol; v += tickStep) {
        const x = cx + (v / maxVol) * cw;
        ctx.fillText(v, x, cy + ch + 14);
        ctx.strokeStyle = T.grid;
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(x, cy);
        ctx.lineTo(x, cy + ch);
        ctx.stroke();
    }

    // Equivalence point line
    const eqX = cx + (eqVol / maxVol) * cw;
    ctx.strokeStyle = T.success;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(eqX, cy);
    ctx.lineTo(eqX, cy + ch);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = T.success;
    ctx.font = T.font(9, 'bold');
    ctx.fillText('Equiv: ' + eqVol.toFixed(1) + ' mL', eqX, cy - 4);

    // Draw pH curve
    const points = [];
    const numPoints = 200;
    for (let i = 0; i <= numPoints; i++) {
        const v = (i / numPoints) * maxVol;
        const pH = computePH(v);
        const px = cx + (v / maxVol) * cw;
        const py = cy + ch - (pH / 14) * ch;
        points.push({ x: px, y: py, pH, v });
    }

    // Fill under curve
    ctx.fillStyle = 'rgba(74, 111, 165, 0.08)';
    ctx.beginPath();
    ctx.moveTo(points[0].x, cy + ch);
    for (const pt of points) ctx.lineTo(pt.x, pt.y);
    ctx.lineTo(points[points.length - 1].x, cy + ch);
    ctx.fill();

    // Curve line
    ctx.strokeStyle = T.accent;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (const pt of points) ctx.lineTo(pt.x, pt.y);
    ctx.stroke();

    // Current point highlight
    const curX = cx + (volumeAdded / maxVol) * cw;
    const curY = cy + ch - (computePH(volumeAdded) / 14) * ch;
    ctx.fillStyle = T.danger;
    ctx.beginPath();
    ctx.arc(curX, curY, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = T.surface;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Equivalence point dot
    if (volumeAdded >= eqVol - 0.5) {
        const eqPY = cy + ch - (computePH(eqVol) / 14) * ch;
        ctx.fillStyle = T.success;
        ctx.beginPath();
        ctx.arc(eqX, eqPY, 4, 0, Math.PI * 2);
        ctx.fill();
    }
}

/**
 * The burette reading panel. Shown when pH instrumentation is OFF, where it is
 * the only numeric evidence, mirroring the graduations on real glassware.
 */
function drawBurettePanel(x, y, w, h) {
    SimLib.Draw.panel(ctx, x, y, w, h, { theme: T });
    SimLib.Draw.text(ctx, 'Burette', x + w / 2, y + 16, {
        size: 10, weight: 'bold', color: T.muted, align: 'center', theme: T,
    });

    const cap = buretteCapacity();
    const reading = Math.min(volumeAdded, cap);
    const frac = cap > 0 ? reading / cap : 0;

    // Column showing the titrant level
    const colX = x + w / 2 - 11, colY = y + 28, colW = 22, colH = h - 46;
    ctx.fillStyle = T.surface2;
    ctx.strokeStyle = T.borderStrong;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(colX, colY, colW, colH, 4);
    ctx.fill();
    ctx.stroke();

    // Remaining titrant (empties as the titration proceeds)
    const fillH = colH * (1 - frac);
    ctx.fillStyle = SimLib.Color.parse(T.accent);
    ctx.fillStyle = T.accentSoft;
    ctx.beginPath();
    ctx.roundRect(colX + 1, colY + colH - fillH, colW - 2, Math.max(0, fillH), 3);
    ctx.fill();

    // Graduation marks every 10 %
    ctx.strokeStyle = T.faint;
    for (let i = 1; i < 10; i++) {
        const gy = colY + (colH / 10) * i;
        const major = i % 5 === 0;
        ctx.lineWidth = major ? 1.5 : 1;
        ctx.beginPath();
        ctx.moveTo(colX, gy);
        ctx.lineTo(colX + (major ? colW : colW * 0.5), gy);
        ctx.stroke();
    }

    SimLib.Draw.text(ctx, reading.toFixed(2) + ' mL', x + w / 2, y + h - 8, {
        size: 11, weight: 'bold', color: T.ink, align: 'center', theme: T,
    });
}

// ═══ Event Handling ═══
// Titrant can only ever be ADDED. addVolume() rejects non-positive amounts
// outright, so no code path (button, keyboard, or any UI added later) can
// withdraw titrant. The only way to lower the volume is "New Sample".
function addVolume(amt) {
    if (!(amt > 0)) return;
    volumeAdded = Math.min(buretteCapacity(), volumeAdded + amt);
    updateUI();
    draw();
}

document.getElementById('dripUp').addEventListener('click', () => addVolume(0.5));

document.querySelectorAll('.sim-chip').forEach(btn => {
    btn.addEventListener('click', () => addVolume(parseFloat(btn.dataset.value)));
});

document.getElementById('resetBtn').addEventListener('click', () => {
    volumeAdded = 0;
    showAnswer = false;
    document.getElementById('revealBtn').textContent = '? Reveal Answer';
    updateUI();
    draw();
});

document.getElementById('revealBtn').addEventListener('click', () => {
    showAnswer = !showAnswer;
    document.getElementById('revealBtn').textContent = showAnswer ? '\u2713 Answer Shown' : '? Reveal Answer';
    updateUI();
    draw();
});

document.getElementById('pHToggle').addEventListener('click', () => {
    showPH = !showPH;
    const btn = document.getElementById('pHToggle');
    btn.textContent = showPH ? 'Hide pH' : 'Show pH';
    btn.setAttribute('aria-pressed', String(showPH));
    btn.classList.toggle('is-active', showPH);
    document.getElementById('phReadouts').hidden = !showPH;
    updateUI();
    draw();
});

document.getElementById('indicatorPick').addEventListener('change', (e) => {
    indicator = e.target.value;
    updateUI();
    draw();
});

document.querySelectorAll('.sim-seg__btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.sim-seg__btn').forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        scenario = btn.dataset.value;
        volumeAdded = 0;
        acidConc = 0.1; baseConc = 0.1;

        // Default the indicator to one whose transition range actually sits in
        // the equivalence-point jump for this combination.
        const spec = currentSpec();
        const eqPH = computePH(computeEquivalenceVolume());
        if (spec.base === 'strong' && spec.acid === 'weak') {
            indicator = 'phenolphthalein';
        } else if (spec.base === 'weak' && spec.acid === 'strong') {
            indicator = 'methylorange';
        } else {
            indicator = eqPH > 8.4 ? 'phenolphthalein' : eqPH < 6 ? 'methylorange' : 'bromothymol';
        }
        document.getElementById('indicatorPick').value = indicator;

        updateUI();
        draw();
    });
});

// ═══ Keyboard ═══
document.addEventListener('keydown', (e) => {
    // Never hijack keys while the user is interacting with a control.
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
        addVolume(0.5);
        e.preventDefault(); // stop the page from scrolling
    } else if (e.key === 'r' || e.key === 'R') {
        volumeAdded = 0;
        updateUI();
        draw();
    }
});

// Guidance that never reveals how close you are. With pH instrumentation off
// it deliberately does NOT mention pH, the equivalence volume, or whether you
// have passed the endpoint — that information is exactly what you are meant to
// judge from the flask colour.
function phaseHint() {
    if (volumeAdded <= 0) {
        return { cls: '', text: 'Add titrant and watch the flask colour.' };
    }
    if (showPH) {
        return {
            cls: '',
            text: 'pH instrumentation is on, so the endpoint is visible — the curve marker shows the true equivalence volume.',
        };
    }
    return {
        cls: '',
        text: 'Watch the flask. Record the burette reading at the first permanent colour change.',
    };
}

function updateUI() {
    document.getElementById('volumeAdded').textContent = volumeAdded.toFixed(2);

    // Kept in sync even while hidden, so switching the toggle on shows
    // correct values immediately rather than a stale frame.
    document.getElementById('phReadout').textContent = computePH(volumeAdded).toFixed(2);
    document.getElementById('equivVol').textContent = computeEquivalenceVolume().toFixed(1);
    document.getElementById('equivPH').textContent = computePH(computeEquivalenceVolume()).toFixed(2);

    const hint = phaseHint();
    const hintEl = document.getElementById('phaseHint');
    hintEl.textContent = hint.text;
    hintEl.className = 'titr-hint ' + hint.cls;
}

// ═══ Animation (SimLib) ═══
// The scene is drawn in a fixed 700x480 logical space; SimLib maps it onto
// the responsive (HiDPI-aware) displayed canvas so nothing is clipped.

updateUI();

const app = SimLib.attach({
    canvas: canvas,
    logicalWidth: 700,
    logicalHeight: 480,
    SimulationClass: class TitrationSim extends SimLib.Simulation {
        onResize() { draw(); }
        onTick() { /* no physics required each tick */ }
        onDraw(ctx) { draw(); }
    }
});
app.sim.start();
    return { app };
}
