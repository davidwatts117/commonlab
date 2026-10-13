// Physics, canvas drawing, and control bindings only. Page structure is owned by the shell.
export function mount(ui) {
    const document = ui;

    const canvas = document.getElementById('pendulumCanvas');
    const graphCanvas = document.getElementById('energyGraphCanvas');
    const T = SimLib.Theme.use('light');

    // Physics / graph constants
    const AIR_DENSITY = 1.225;      // kg/m^3 atmospheric air density
    const GRAPH_WINDOW_S = 20;      // time span shown on the graph's x-axis
    const GRAPH_TRIM_PAD_S = 1;     // extra seconds retained just off-screen

    class PendulumSim extends SimLib.Simulation {
        onInit() {
            // constants
            this.PIVOT_X = 350; this.PIVOT_Y = 80;
            this.PX_PER_METER = 130; this.BOBS_PER_KG = 16;

            // state
            this.length = 1.2; this.mass = 1.0; this.gravity = 9.8; this.cd = 0.47;
            this.angleDeg = 30; this.angle = this.angleDeg * Math.PI / 180; this.angularVel = 0;
            this.thermalEnergy = 0;
            this.paused = false; this.showTrace = true; this.tracePoints = [];
            this.periodTimer = 0; this.lastSign = null; this.measuredPeriod = null; this._crossingTimes = [];
            this.simTime = 0; this.energyHistory = [];
            this._uiAccum = 0;

            // DOM refs
            this.lengthSlider  = document.getElementById('lengthSlider');
            this.massSlider    = document.getElementById('massSlider');
            this.dragSlider    = document.getElementById('dragSlider');
            this.gravitySlider = document.getElementById('gravitySlider');
            this.angleSlider   = document.getElementById('angleSlider');
            this.lengthValue   = document.getElementById('lengthValue');
            this.massValue     = document.getElementById('massValue');
            this.dragValue     = document.getElementById('dragValue');
            this.gravityValue  = document.getElementById('gravityValue');
            this.angleValue    = document.getElementById('angleValue');
            this.pauseBtn      = document.getElementById('pauseBtn');
            this.resetBtn      = document.getElementById('resetBtn');
            this.traceBtn      = document.getElementById('traceBtn');
            this.periodReadout = document.getElementById('periodReadout');
            this.freqReadout   = document.getElementById('freqReadout');
            this.angleReadout  = document.getElementById('angleReadout');
            this.speedReadout  = document.getElementById('speedReadout');

            // canvas logical space (SimLib maps it onto the displayed size)
            this.ctx = this.app.ctx;
            this.W = this.logical.w;
            this.H = this.logical.h;
            this.graphCtx = graphCanvas.getContext('2d');

            // wire controls
            const resetPeriod = () => { this._crossingTimes = []; this.measuredPeriod = null; this.periodTimer = 0; this.lastSign = null; };
            SimLib.UI.bindSlider(this.lengthSlider, { output: this.lengthValue, format: v => v.toFixed(2) + ' m', oninput: v => { this.length = v; resetPeriod(); } });
            SimLib.UI.bindSlider(this.massSlider, { output: this.massValue, format: v => v.toFixed(1) + ' kg', oninput: v => { this.mass = v; } });
            SimLib.UI.bindSlider(this.dragSlider, { output: this.dragValue, format: v => v.toFixed(2), oninput: v => { this.cd = v; } });
            SimLib.UI.bindSlider(this.gravitySlider, { output: this.gravityValue, format: v => v.toFixed(1) + ' m/s²', oninput: v => { this.gravity = v; resetPeriod(); } });
            SimLib.UI.bindSlider(this.angleSlider, { output: this.angleValue, format: v => v + '°', oninput: v => { this.angle = v * Math.PI / 180; this.angularVel = 0; resetPeriod(); this.tracePoints = []; this._resetEnergy(); } });
            this.pauseBtn.addEventListener('click', () => { this.paused = !this.paused; this.pauseBtn.textContent = this.paused ? 'Resume' : 'Pause'; });
            this.resetBtn.addEventListener('click', () => { this.angularVel = 0; const deg = +this.angleSlider.value; this.angle = deg * Math.PI / 180; this._crossingTimes = []; this.measuredPeriod = null; this.periodTimer = 0; this.lastSign = null; this.tracePoints = []; this._resetEnergy(); });
            this.traceBtn.addEventListener('click', () => { this.showTrace = !this.showTrace; this.traceBtn.textContent = this.showTrace ? 'Show Trace' : 'Hide Trace'; this.traceBtn.classList.toggle('is-active', this.showTrace); if (!this.showTrace) this.tracePoints = []; });

            // pointer drag
            this.dragging = false;
            this.canvas.addEventListener('pointerdown', (e) => {
                const pos = this._getCanvasPos(e);
                if (this._isNearBob(pos.x, pos.y)) {
                    this.dragging = true; this.paused = true; this.pauseBtn.textContent = 'Resume'; this.canvas.style.cursor = 'grabbing'; this.canvas.setPointerCapture(e.pointerId); e.preventDefault();
                }
            });
            this.canvas.addEventListener('pointermove', (e) => {
                if (this.dragging) {
                    const pos = this._getCanvasPos(e);
                    const dx = pos.x - this.PIVOT_X; const dy = pos.y - this.PIVOT_Y;
                    const newAngle = Math.atan2(dx, dy); this.angle = -newAngle; const deg = this.angle * 180 / Math.PI;
                    this.angleSlider.value = Math.max(1, Math.min(85, Math.abs(Math.round(deg)))); this.angleValue.textContent = Math.abs(deg).toFixed(0) + '°'; this.angularVel = 0; this._crossingTimes = []; this.measuredPeriod = null; this.periodTimer = 0; this.lastSign = null; this.tracePoints = []; e.preventDefault();
                } else if (!this.paused) {
                    const pos = this._getCanvasPos(e); this.canvas.style.cursor = this._isNearBob(pos.x, pos.y) ? 'grab' : 'default';
                }
            });
            this.canvas.addEventListener('pointerup', () => { this.dragging = false; this.canvas.style.cursor = 'default'; });
            this.canvas.addEventListener('pointercancel', () => { this.dragging = false; this.canvas.style.cursor = 'default'; });
        }

        _getCanvasPos(e) {
            return SimLib.CanvasUtils.eventPos(this.canvas, e);
        }
        _isNearBob(cx, cy) { const bob = this._bobPos(); const dist = Math.hypot(cx - bob.x, cy - bob.y); return dist < this._bobPixelRadius() + 14; }

        _bobPos() { const px = this.PIVOT_X + Math.sin(this.angle) * this.length * this.PX_PER_METER; const py = this.PIVOT_Y + Math.cos(this.angle) * this.length * this.PX_PER_METER; return { x: px, y: py }; }
        _bobPixelRadius() { return 12 + this.mass * this.BOBS_PER_KG; }
        _bobRadiusMeters() { return this._bobPixelRadius() / this.PX_PER_METER; }

        /** Drop the energy history back to its initial state (angle changed / reset). */
        _resetEnergy() {
            this.thermalEnergy = 0;
            this.simTime = 0;
            this.energyHistory = [];
        }

        _computeEnergy() { const bob = this._bobPos(); const bobBaseY = this.PIVOT_Y + this.length * this.PX_PER_METER; const h = Math.max(0, (bobBaseY - bob.y) / this.PX_PER_METER); const speed = Math.abs(this.angularVel) * this.length; const ke = 0.5 * this.mass * speed * speed; const pe = this.mass * this.gravity * h; return { ke, pe, thermal: this.thermalEnergy, total: ke + pe + this.thermalEnergy }; }

        _trackPeriod(dt) {
            const sign = Math.sign(this.angle);
            if (this.lastSign !== null && sign !== 0 && sign !== this.lastSign) {
                this._crossingTimes.push(this.periodTimer);
                if (this._crossingTimes.length > 20) this._crossingTimes.shift();
                if (this._crossingTimes.length >= 3) {
                    const diffs = [];
                    for (let i = 1; i < this._crossingTimes.length; i += 2) {
                        if (i + 1 < this._crossingTimes.length) diffs.push((this._crossingTimes[i+1] - this._crossingTimes[i-1]));
                    }
                    if (diffs.length > 0) this.measuredPeriod = diffs.reduce((a,b) => a+b, 0) / diffs.length;
                }
            }
            if (sign !== 0) this.lastSign = sign;
            this.periodTimer += dt;
        }

        onTick(dt) {
            if (this.paused) return;
            const subSteps = 8; const subDt = dt / subSteps;
            const r = this._bobRadiusMeters();
            const area = Math.PI * r * r;

            for (let s = 0; s < subSteps; s++) {
                // Quadratic air drag: F = 0.5 * rho * v^2 * Cd * A
                const v = this.angularVel * this.length;
                const dragForce = 0.5 * AIR_DENSITY * v * Math.abs(v) * this.cd * area;
                const dragTorque = dragForce * this.length;
                const angularDampingAcc = dragTorque / (this.mass * this.length * this.length);

                const gravityAlpha = -(this.gravity / this.length) * Math.sin(this.angle);
                const alpha = gravityAlpha - angularDampingAcc;

                this.angularVel += alpha * subDt;
                this.angle += this.angularVel * subDt;

                // Dissipated power = drag force * velocity -> thermal
                this.thermalEnergy += Math.abs(dragForce * v) * subDt;
            }

            this._trackPeriod(dt);

            if (Math.abs(this.angularVel) > 15) this.angularVel = 15 * Math.sign(this.angularVel);

            // Record a sample for the energy graph
            const e = this._computeEnergy();
            this.simTime += dt;
            e.t = this.simTime;
            this.energyHistory.push(e);
            // Trim only what has scrolled off the left edge (plus a small pad)
            const cutoff = this.simTime - GRAPH_WINDOW_S - GRAPH_TRIM_PAD_S;
            while (this.energyHistory.length > 2 && this.energyHistory[0].t < cutoff) {
                this.energyHistory.shift();
            }

            // trace
            if (this.showTrace && !this.paused && Math.abs(this.angularVel) > 0.01) {
                const bob = this._bobPos(); this.tracePoints.push({ x: bob.x, y: bob.y });
                const MAX_TRACE = 250; if (this.tracePoints.length > MAX_TRACE) this.tracePoints = this.tracePoints.slice(-MAX_TRACE);
            }

            // Refresh the numeric readouts at ~10 Hz
            this._uiAccum += dt;
            if (this._uiAccum >= 0.1) { this._uiAccum = 0; this.updateUI(); }
        }

        onDraw(ctx) {
            const W = this.W, H = this.H;
            ctx.clearRect(0, 0, W, H);
            SimLib.Draw.background(ctx, W, H, T);
            SimLib.Draw.grid(ctx, W, H, { step: 40, color: 'rgba(26, 42, 78, 0.035)', lineWidth: 1, theme: T });
            SimLib.Draw.title(ctx, 'Pendulum', 14, 22, { size: 13, color: T.muted, theme: T });
            // ceiling
            ctx.fillStyle = T.text; ctx.fillRect(0, this.PIVOT_Y - 14, W, 18);
            ctx.fillStyle = T.muted; ctx.fillRect(0, this.PIVOT_Y - 14, W, 3);
            ctx.fillStyle = T.ink; ctx.fillRect(0, this.PIVOT_Y + 2, W, 2);
            // reference line
            ctx.setLineDash([4,6]); ctx.strokeStyle = T.gridStrong; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(this.PIVOT_X, this.PIVOT_Y); ctx.lineTo(this.PIVOT_X, this.PIVOT_Y + this.length * this.PX_PER_METER); ctx.stroke(); ctx.setLineDash([]);
            // angle arc
            if (Math.abs(this.angleDeg) > 1) {
                const arcR = 55; ctx.strokeStyle = T.faint; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(this.PIVOT_X, this.PIVOT_Y, arcR, -Math.PI/2, -Math.PI/2 - this.angle, this.angle < 0); ctx.stroke(); const midA = -Math.PI/2 - this.angle/2; ctx.fillStyle = T.muted; ctx.font = T.font(10, 'bold'); ctx.textAlign = 'center'; ctx.fillText(Math.abs(this.angleDeg).toFixed(0) + '\u00B0', this.PIVOT_X + (arcR + 20) * Math.cos(midA), this.PIVOT_Y + (arcR + 20) * Math.sin(midA));
            }
            // trace
            if (this.showTrace && this.tracePoints.length > 1) {
                const tc = SimLib.Color.parse(T.accent);
                ctx.strokeStyle = `rgba(${tc.r}, ${tc.g}, ${tc.b}, 0.25)`; ctx.lineWidth = 2; ctx.setLineDash([2,4]); ctx.beginPath(); for (let i = 0; i < this.tracePoints.length; i++) { if (i === 0) ctx.moveTo(this.tracePoints[i].x, this.tracePoints[i].y); else ctx.lineTo(this.tracePoints[i].x, this.tracePoints[i].y); } ctx.stroke(); ctx.setLineDash([]);
            }
            // string
            const bob = this._bobPos(); ctx.strokeStyle = T.ink; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(this.PIVOT_X, this.PIVOT_Y); ctx.lineTo(bob.x, bob.y); ctx.stroke();
            // pivot bolt
            const boltGrad = ctx.createRadialGradient(this.PIVOT_X - 2, this.PIVOT_Y - 1, 1, this.PIVOT_X, this.PIVOT_Y, 9);
            boltGrad.addColorStop(0, T.faint); boltGrad.addColorStop(0.6, T.muted); boltGrad.addColorStop(1, T.ink); ctx.fillStyle = boltGrad; ctx.beginPath(); ctx.arc(this.PIVOT_X, this.PIVOT_Y, 9, 0, Math.PI*2); ctx.fill();
            // bob
            const bobR = this._bobPixelRadius(); const bobGrad = ctx.createRadialGradient(bob.x - bobR*0.3, bob.y - bobR*0.35, bobR*0.05, bob.x, bob.y, bobR); bobGrad.addColorStop(0, SimLib.Color.lighten(T.accent, 0.55)); bobGrad.addColorStop(0.4, T.accent); bobGrad.addColorStop(0.7, T.accentDark); bobGrad.addColorStop(1, SimLib.Color.darken(T.accent, 0.35)); ctx.fillStyle = bobGrad; ctx.beginPath(); ctx.arc(bob.x, bob.y, bobR, 0, Math.PI*2); ctx.fill(); ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.beginPath(); ctx.arc(bob.x - bobR*0.25, bob.y - bobR*0.3, bobR*0.32, 0, Math.PI*2); ctx.fill();
            // speed indicator
            const speed = Math.abs(this.angularVel * this.length);
            if (speed > 0.02) { const vDir = Math.sign(this.angularVel); const dc = SimLib.Color.parse(T.danger); ctx.fillStyle = `rgba(${dc.r}, ${dc.g}, ${dc.b}, 0.75)`; ctx.font = T.font(9, 'bold'); ctx.textAlign = 'center'; ctx.fillText(speed.toFixed(1) + ' m/s', bob.x, bob.y + bobR + 16); ctx.strokeStyle = `rgba(${dc.r}, ${dc.g}, ${dc.b}, 0.6)`; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(bob.x - vDir * 10, bob.y); ctx.lineTo(bob.x, bob.y); ctx.stroke(); }
            if (this.paused) { ctx.fillStyle = 'rgba(0,0,0,0.05)'; ctx.fillRect(0,0,W,H); ctx.fillStyle = T.muted; ctx.font = T.font(24, 'bold'); ctx.textAlign = 'center'; ctx.fillText('PAUSED', W/2, H/2 + 30); }
            this.drawEnergyGraph();
        }

        /** Energy-vs-time line graph (K, P, Thermal, Total) on the rolling window. */
        drawEnergyGraph() {
            const g = this.graphCtx;
            if (!g) return;
            const gW = graphCanvas.width, gH = graphCanvas.height;
            g.clearRect(0, 0, gW, gH);
            g.fillStyle = '#f8f9fa';
            g.fillRect(0, 0, gW, gH);

            const padL = 42, padR = 10, padT = 10, padB = 20;
            const plotW = gW - padL - padR;
            const plotH = gH - padT - padB;
            const x0 = padL, y0 = gH - padB;

            // Y ceiling from the maximum possible potential energy
            const initialHeight = this.length * (1 - Math.cos(this.angle));
            const maxE = Math.max(0.1, this.mass * this.gravity * Math.max(initialHeight, this.length) * 1.15);

            const tNow = this.simTime;
            const tStart = Math.max(0, tNow - GRAPH_WINDOW_S);

            // Horizontal gridlines + Y labels
            g.font = T.font(10);
            g.textAlign = 'right';
            g.textBaseline = 'middle';
            for (let i = 0; i <= 4; i++) {
                const val = (maxE / 4) * i;
                const y = y0 - (val / maxE) * plotH;
                g.strokeStyle = '#e9ecef';
                g.lineWidth = 1;
                g.beginPath(); g.moveTo(x0, y); g.lineTo(x0 + plotW, y); g.stroke();
                g.fillStyle = '#868e96';
                g.fillText(val.toFixed(1), x0 - 6, y);
            }

            // Vertical time ticks every 5 s
            g.textAlign = 'center';
            g.textBaseline = 'top';
            for (let t = Math.ceil(tStart / 5) * 5; t <= tNow; t += 5) {
                const x = x0 + ((t - tStart) / GRAPH_WINDOW_S) * plotW;
                g.strokeStyle = '#f1f3f5';
                g.beginPath(); g.moveTo(x, padT); g.lineTo(x, y0); g.stroke();
                g.fillStyle = '#868e96';
                g.fillText(t + 's', x, y0 + 4);
            }

            // Y axis title
            g.save();
            g.translate(11, padT + plotH / 2);
            g.rotate(-Math.PI / 2);
            SimLib.Draw.axisLabel(g, 'Energy (J)', 0, 0, { theme: T });
            g.restore();

            if (this.energyHistory.length < 2) {
                g.fillStyle = '#adb5bd';
                g.font = T.font(11);
                g.textAlign = 'center';
                g.textBaseline = 'middle';
                g.fillText('Energy history will appear here once the pendulum is released', gW / 2, gH / 2);
                return;
            }

            const pts = this.energyHistory.filter(p => p.t >= tStart);
            if (pts.length < 2) return;

            const plotLine = (key, color, lineWidth, dash) => {
                g.strokeStyle = color;
                g.lineWidth = lineWidth;
                g.setLineDash(dash || []);
                g.beginPath();
                let started = false;
                for (const p of pts) {
                    const x = x0 + ((p.t - tStart) / GRAPH_WINDOW_S) * plotW;
                    const val = Math.max(0, Math.min(maxE, p[key]));
                    const y = y0 - (val / maxE) * plotH;
                    if (!started) { g.moveTo(x, y); started = true; } else { g.lineTo(x, y); }
                }
                g.stroke();
                g.setLineDash([]);
            };

            plotLine('pe', '#4a6fa5', 2);              // Potential
            plotLine('ke', '#e05252', 2);              // Kinetic
            plotLine('thermal', '#d97706', 2);         // Thermal dissipated by drag
            plotLine('total', '#22c55e', 1.5, [5, 4]); // Conserved total
        }

        updateUI() {
            const deg = this.angle * 180 / Math.PI; this.angleDeg = deg; const speed = Math.abs(this.angularVel * this.length);
            let period; if (this.measuredPeriod !== null) period = this.measuredPeriod; else period = 2 * Math.PI * Math.sqrt(this.length / this.gravity);
            const freq = 1 / period;
            this.periodReadout.textContent = period.toFixed(2); this.freqReadout.textContent = freq.toFixed(2); this.angleReadout.textContent = Math.abs(deg).toFixed(1); this.speedReadout.textContent = speed.toFixed(2);
        }
    }

    // attach and start
    const app = SimLib.attach({ canvas, logicalWidth: 700, logicalHeight: 480, SimulationClass: PendulumSim });
    app.sim.start();

    // ----------------------------------------------------------------
    // Guided experiments
    // ----------------------------------------------------------------
    const sim = app.sim;

    // Programmatic control setters mirror the slider handlers above so that
    // the UI stays in sync when a guided step drives the simulation.
    const setLength = (v) => {
        sim.length = v;
        sim.lengthSlider.value = v;
        sim.lengthValue.textContent = v.toFixed(2) + ' m';
        sim._crossingTimes = []; sim.measuredPeriod = null; sim.periodTimer = 0; sim.lastSign = null;
    };
    const setMass = (v) => {
        sim.mass = v; sim.massSlider.value = v; sim.massValue.textContent = v.toFixed(1) + ' kg';
    };
    const setDrag = (v) => {
        sim.cd = v; sim.dragSlider.value = v; sim.dragValue.textContent = v.toFixed(2);
    };
    const setGravity = (v) => {
        sim.gravity = v; sim.gravitySlider.value = v; sim.gravityValue.textContent = v.toFixed(1) + ' m/s²';
        sim._crossingTimes = []; sim.measuredPeriod = null; sim.periodTimer = 0; sim.lastSign = null;
    };
    const setAngle = (deg) => {
        sim.angle = deg * Math.PI / 180;
        sim.angleSlider.value = deg; sim.angleValue.textContent = Math.round(deg) + '°';
        sim.angularVel = 0; sim.tracePoints = []; sim._resetEnergy();
        sim._crossingTimes = []; sim.measuredPeriod = null; sim.periodTimer = 0; sim.lastSign = null;
    };
    const pauseSim = () => { sim.paused = true; sim.pauseBtn.textContent = 'Resume'; };
    const resumeSim = () => { sim.paused = false; sim.pauseBtn.textContent = 'Pause'; };

    const adapter = SimLib.Guided.adapter(sim, {
        id: 'pendulum',
        controls: {
            length:  { get: () => sim.length,  set: setLength,  el: () => sim.lengthSlider,  range: [0.3, 3.0], format: v => v.toFixed(2) + ' m' },
            mass:    { get: () => sim.mass,    set: setMass,    el: () => sim.massSlider,    range: [0.1, 5.0] },
            drag:    { get: () => sim.cd,      set: setDrag,    el: () => sim.dragSlider,    range: [0, 0.94] },
            gravity: { get: () => sim.gravity, set: setGravity, el: () => sim.gravitySlider, range: [0.5, 20.0] },
            angle:   { get: () => sim.angle * 180 / Math.PI, set: setAngle, el: () => sim.angleSlider, range: [1, 85] },
        },
        elements: {
            release: () => sim.pauseBtn,
            reset:   () => sim.resetBtn,
            trace:   () => sim.traceBtn,
        },
        state: {
            period:    () => sim.measuredPeriod != null ? sim.measuredPeriod : 2 * Math.PI * Math.sqrt(sim.length / sim.gravity),
            angle:     () => sim.angle * 180 / Math.PI,
            paused:    () => (sim.paused ? 1 : 0),
            amplitude: () => Math.abs(sim.angle * 180 / Math.PI),
        },
        actions: {
            pause:   pauseSim,
            resume:  resumeSim,
            reset:   () => { sim.angularVel = 0; sim.tracePoints = []; sim._resetEnergy(); },
            release: resumeSim,
        },
        targets: {
            bob:   () => ({ ...sim._bobPos(), r: sim._bobPixelRadius() }),
            pivot: () => ({ x: sim.PIVOT_X, y: sim.PIVOT_Y, r: 12 }),
        },
        isPaused: () => sim.paused,
        setLocked: (locked) => { sim.canvas.style.pointerEvents = locked ? 'none' : ''; },
    });

    return { app, adapter };
}
