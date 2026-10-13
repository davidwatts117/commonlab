// Physics, canvas drawing, and control bindings only. Page structure is owned by the shell.
export function mount(ui) {
    const document = ui;
'use strict';

      const T = SimLib.Theme.use('light');

      class GasLawsSim extends SimLib.Simulation {
        onInit() {
          this.R = 0.082057; this.PARTICLE_RADIUS = 4; this.BASE_SPEED = 3.6;
          this.n = 1.5; this.T = 300; this.V = 5.0;
          this.isDraggingPiston = false; this.dragStartY = 0; this.dragStartV = 0;

          this.canvas = document.getElementById('gasCanvas');
          this.ctx = this.app.ctx;
          this.W = this.logical.w;
          this.H = this.logical.h;
          this.canvas.style.touchAction = 'none';

          this.molesSlider = document.getElementById('molesSlider'); this.tempSlider = document.getElementById('tempSlider'); this.volumeSlider = document.getElementById('volumeSlider');
          this.molesValue = document.getElementById('molesValue'); this.tempValue = document.getElementById('tempValue'); this.volumeValue = document.getElementById('volumeValue');
          this.pressureDisplay = document.getElementById('pressureDisplay'); this.pressureKpaDisplay = document.getElementById('pressureKpaDisplay'); this.particleCount = document.getElementById('particleCount'); this.nRTproduct = document.getElementById('nRTproduct');
          this.idealGasSub = document.getElementById('idealGasSub');

          this.particles = [];

          // wire sliders
          this.molesSlider.addEventListener('input', () => this.updateSimulation());
          this.tempSlider.addEventListener('input', () => this.updateSimulation());
          this.volumeSlider.addEventListener('input', () => this.updateSimulation());

          // pointer interaction (mouse, touch and pen share one code path)
          this.canvas.addEventListener('pointerdown', (e) => {
            const pos = this.getCanvasEventPos(e);
            if (!this.isNearPiston(pos)) return;
            this.isDraggingPiston = true;
            this.dragStartY = pos.y;
            this.dragStartV = this.V;
            this.canvas.style.cursor = 'ns-resize';
            this.canvas.setPointerCapture(e.pointerId);
            e.preventDefault();
          });
          this.canvas.addEventListener('pointermove', (e) => {
            const pos = this.getCanvasEventPos(e);
            if (this.isDraggingPiston) {
              const dy = pos.y - this.dragStartY;
              const newV = Math.max(0.5, Math.min(10.0, this.dragStartV - (dy / 360) * 9.5));
              this.volumeSlider.value = newV.toFixed(1);
              this.updateSimulation();
              e.preventDefault();
            } else {
              this.canvas.style.cursor = this.isNearPiston(pos) ? 'ns-resize' : 'default';
            }
          });
          const endPistonDrag = () => { this.isDraggingPiston = false; this.canvas.style.cursor = 'default'; };
          this.canvas.addEventListener('pointerup', endPistonDrag);
          this.canvas.addEventListener('pointercancel', endPistonDrag);
          this.canvas.addEventListener('pointerleave', () => { if (!this.isDraggingPiston) this.canvas.style.cursor = 'default'; });

          // initialize
          this.rebuildParticles(); this.updateSimulation();
        }

        // geometry & particles
        getParticleCount() { return Math.round(this.n * 35); }
        createParticle() { return { x: 300 + (Math.random() - 0.5) * 380, y: 250 + (Math.random() - 0.5) * 200, vx: (Math.random() - 0.5) * this.BASE_SPEED, vy: (Math.random() - 0.5) * this.BASE_SPEED }; }
        rebuildParticles() { const target = this.getParticleCount(); while (this.particles.length < target) this.particles.push(this.createParticle()); if (this.particles.length > target) this.particles.length = target; }
        getChamberBounds() { const left = 72; const right = 528; const bottom = 418; const top = 420 - (this.V / 10) * 360; return { left, right, top, bottom, width: right - left, height: bottom - top }; }
        vFromTop(top) { const clamped = Math.max(58, Math.min(370, top)); return ((420 - clamped) / 360) * 10; }
        updateParticles() { const bounds = this.getChamberBounds(); const pad = this.PARTICLE_RADIUS + 2; const speedFactor = Math.sqrt(this.T / 300); for (const p of this.particles) { p.x += p.vx * speedFactor; p.y += p.vy * speedFactor; if (p.x < bounds.left + pad) { p.x = bounds.left + pad; p.vx = Math.abs(p.vx); } if (p.x > bounds.right - pad) { p.x = bounds.right - pad; p.vx = -Math.abs(p.vx); } if (p.y < bounds.top + pad) { p.y = bounds.top + pad; p.vy = Math.abs(p.vy); } if (p.y > bounds.bottom - pad) { p.y = bounds.bottom - pad; p.vy = -Math.abs(p.vy); } } }

        // drawing
        onDraw(ctx) {
          const W = this.W; const H = this.H; const bounds = this.getChamberBounds(); ctx.clearRect(0,0,W,H);
          const tNorm = (this.T - 100) / 400; SimLib.Draw.background(ctx, W, H, T); SimLib.Draw.title(ctx, 'Gas Laws', W / 2, 24, { size: 13, color: T.muted, align: 'center', theme: T });
          this.drawThermometer(tNorm);
          ctx.fillStyle = T.surface; ctx.strokeStyle = T.ink; ctx.lineWidth = 2; const ch = bounds; ctx.beginPath(); this.roundRect(ctx, ch.left, ch.top, ch.width, ch.height, 6); ctx.fill(); ctx.stroke(); const pistonTop = ch.top - 18; ctx.fillStyle = T.accent; ctx.beginPath(); this.roundRect(ctx, ch.left - 4, pistonTop, ch.width + 8, 18, 4); ctx.fill(); ctx.fillStyle = T.accentDark; const hw = 40, hh = 12; const hx = ch.left + ch.width / 2 - hw / 2; const hy = pistonTop - hh; ctx.beginPath(); this.roundRect(ctx, hx, hy, hw, hh, [4,4,0,0]); ctx.fill(); ctx.strokeStyle = T.accentDark; ctx.lineWidth = 1; for (let i=0;i<3;i++){ const lx = hx + 8 + i*12; ctx.beginPath(); ctx.moveTo(lx, hy+3); ctx.lineTo(lx, hy+hh-3); ctx.stroke(); } ctx.strokeStyle = T.accentDark; ctx.lineWidth = 1; for (let i=0;i<3;i++){ const ry = pistonTop + 3 + i*5; ctx.beginPath(); ctx.moveTo(ch.left+4, ry); ctx.lineTo(ch.right-4, ry); ctx.stroke(); } ctx.fillStyle = T.border; ctx.beginPath(); this.roundRect(ctx, ch.left, ch.bottom, ch.width, 6, [0,0,4,4]); ctx.fill(); const speedFactor = Math.sqrt(this.T / 300); for (const p of this.particles) { const speed = Math.sqrt(p.vx*p.vx + p.vy*p.vy) * speedFactor; const norm = Math.min(speed / (this.BASE_SPEED * 2.0), 1); const hue = 220 - norm * 220; const lit = 50 + norm * 20; ctx.fillStyle = `hsl(${hue}, 80%, ${lit}%)`; ctx.beginPath(); ctx.arc(p.x, p.y, this.PARTICLE_RADIUS, 0, Math.PI*2); ctx.fill(); if (norm > 0.5) { ctx.beginPath(); ctx.arc(p.x,p.y,this.PARTICLE_RADIUS+2,0,Math.PI*2); ctx.fillStyle = `hsla(${hue}, 80%, ${lit}%, 0.12)`; ctx.fill(); } }
          this.drawPressureGauge(); ctx.strokeStyle = T.border; ctx.lineWidth = 1; ctx.setLineDash([3,4]); for (let i=1;i<4;i++){ const sy = ch.top + (ch.height/4)*i; ctx.beginPath(); ctx.moveTo(ch.right - 28, sy); ctx.lineTo(ch.right - 10, sy); ctx.stroke(); } ctx.setLineDash([]); ctx.fillStyle = T.muted; ctx.font = T.font(12); ctx.textAlign = 'center'; ctx.fillText(`V = ${this.V.toFixed(1)} L`, ch.left + ch.width/2, ch.bottom + 20); ctx.fillStyle = T.faint; ctx.font = T.font(10); ctx.textAlign = 'center'; ctx.fillText('drag the piston', ch.left + ch.width/2, ch.bottom + 36);
        }

        drawPressureGauge() { const ctx = this.ctx; const gx = 578, gy = 60, gw = 28, gh = 340; ctx.fillStyle = T.border; ctx.beginPath(); this.roundRect(ctx, gx, gy, gw, gh, 4); ctx.fill(); const P = this.n * this.R * this.T / this.V; const maxP = Math.max(P * 1.3, 2.0); const ratio = Math.min(P / maxP, 1); const fh = gh * ratio; const fy = gy + gh - fh; const grad = ctx.createLinearGradient(gx, gy + gh, gx, gy); grad.addColorStop(0, T.accent); grad.addColorStop(1, SimLib.Color.lighten(T.accent, 0.45)); ctx.fillStyle = grad; ctx.beginPath(); this.roundRect(ctx, gx + 2, fy, gw - 4, fh - 2, 2); ctx.fill(); ctx.strokeStyle = T.borderStrong; ctx.lineWidth = 1; ctx.beginPath(); this.roundRect(ctx, gx, gy, gw, gh, 4); ctx.stroke(); ctx.fillStyle = T.text; ctx.font = T.font(10); ctx.textAlign = 'center'; ctx.fillText('P', gx + gw/2, gy - 6); ctx.font = T.font(9); ctx.fillText(P.toFixed(1), gx + gw/2, gy + gh + 14); ctx.fillText('atm', gx + gw/2, gy + gh + 26); }

        drawThermometer(tNorm) { const ctx = this.ctx; const tx = 42, ty = 60, tw = 10, th = 340; ctx.fillStyle = T.surface2; ctx.beginPath(); this.roundRect(ctx, tx, ty, tw, th, 5); ctx.fill(); ctx.strokeStyle = T.borderStrong; ctx.lineWidth = 1; ctx.beginPath(); this.roundRect(ctx, tx, ty, tw, th, 5); ctx.stroke(); const fh = th * tNorm; const fy = ty + th - fh; const hue = 220 - tNorm * 220; ctx.fillStyle = `hsl(${hue}, 80%, 50%)`; ctx.beginPath(); this.roundRect(ctx, tx + 1, fy, tw - 2, fh - 1, 3); ctx.fill(); ctx.fillStyle = `hsl(${hue}, 80%, 50%)`; ctx.beginPath(); ctx.arc(tx + tw/2, ty + th + 6, 6, 0, Math.PI*2); ctx.fill(); ctx.strokeStyle = T.borderStrong; ctx.lineWidth = 1; ctx.stroke(); ctx.fillStyle = T.muted; ctx.font = T.font(9); ctx.textAlign = 'center'; ctx.fillText(this.T + 'K', tx + tw/2, ty - 6); ctx.fillText('T', tx + tw/2, ty + th + 26); }

        roundRect(ctx, x, y, w, h, r) { if (typeof r === 'number') r = [r, r, r, r]; if (!Array.isArray(r)) r = [r, r, r, r]; const [tl,tr,br,bl] = r.map(v => Math.min(v || 0, Math.min(w,h)/2)); ctx.moveTo(x + tl, y); ctx.lineTo(x + w - tr, y); ctx.quadraticCurveTo(x + w, y, x + w, y + tr); ctx.lineTo(x + w, y + h - br); ctx.quadraticCurveTo(x + w, y + h, x + w - br, y + h); ctx.lineTo(x + bl, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - bl); ctx.lineTo(x, y + tl); ctx.quadraticCurveTo(x, y, x + tl, y); }

        updateSimulation() {
          this.n = parseFloat(this.molesSlider.value); this.T = parseFloat(this.tempSlider.value); this.V = parseFloat(this.volumeSlider.value);
          const P = this.n * this.R * this.T / this.V; const P_kPa = P * 101.325; const nRT = this.n * this.R * this.T; const PV = P * this.V;
          this.molesValue.textContent = this.n.toFixed(1) + ' mol'; this.tempValue.textContent = this.T.toFixed(0) + ' K'; this.volumeValue.textContent = this.V.toFixed(1) + ' L'; this.pressureDisplay.textContent = P.toFixed(2); this.pressureKpaDisplay.textContent = P_kPa.toFixed(1); this.particleCount.textContent = this.particles.length; this.nRTproduct.textContent = nRT.toFixed(2);
          this.idealGasSub.textContent = `${P.toFixed(2)} × ${this.V.toFixed(1)} = ${this.n.toFixed(1)} × 0.0821 × ${this.T.toFixed(0)}; PV = ${PV.toFixed(2)}, nRT = ${nRT.toFixed(2)}`;
          this.rebuildParticles();
        }

        // input helpers
        getCanvasEventPos(e) { return SimLib.CanvasUtils.eventPos(this.canvas, e); }
        isNearPiston(pos) { const bounds = this.getChamberBounds(); const pistonTop = bounds.top - 18; const pistonBottom = bounds.top + 5; const areaLeft = bounds.left - 10; const areaRight = bounds.right + 10; return pos.x >= areaLeft && pos.x <= areaRight && pos.y >= pistonTop - 14 && pos.y <= pistonBottom; }

        // lifecycle: update particles each tick
        onTick() { this.updateParticles(); }

      }

      const app = SimLib.attach({ canvas: document.getElementById('gasCanvas'), logicalWidth: 700, logicalHeight: 450, SimulationClass: GasLawsSim });
      app.sim.start();
    return { app };
}
