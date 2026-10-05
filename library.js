/*
 SimLib - lightweight simulation + UI helper library

 Design goals:
 - Provide consistent canvas setup (HiDPI) and a responsive logical-space model
 - Drawing helpers (roundRect, glossy spheres) and color utilities
 - Simple UI primitives (panel, button, slider, readout) that wire to sim state
 - A small EventBus and Simulation base class to standardize lifecycle
 - A SimApp.attach helper to bootstrap simulations with minimal boilerplate

 Canvas model
 ------------
 Simulations author their scenes in a fixed "logical" coordinate space (the
 original design size, e.g. 700x480). `CanvasUtils.fit()` sizes the backing
 store for the device pixel ratio and installs a transform that maps the
 logical space onto whatever size the canvas is displayed at. As a result:
   - drawing code always uses logical coordinates (stable constants), and
   - pointer events are converted with `CanvasUtils.eventPos()`.

 Theming
 -------
 Every scene draws from a shared palette so the suite looks like one family.
   const T = SimLib.Theme.use('light');   // or 'dark'
   SimLib.Draw.background(ctx, W, H, T);
   SimLib.Draw.grid(ctx, W, H, { step: 20, theme: T });
   SimLib.Draw.title(ctx, 'My Scene', 14, 22, { theme: T });
   ctx.fillStyle = T.accent;
   ctx.font = T.font(11, 'bold');
 `SimLib.Draw` also provides `text`, `axisLabel`, `panel` and `legend`.

 Lifecycle
 ---------
 Subclass `SimLib.Simulation` and implement:
   onInit()        wire DOM / build state (called once by attach)
   onTick(dt)      advance physics (called each animation frame)
   onDraw(ctx)     render (called each animation frame and on resize)
   onReset()       optional: restore initial state (called by reset())
   onResize(w, h)  optional: react to a new displayed size

 Usage
 -----
   const app = SimLib.attach({
     canvas, SimulationClass: MySim,
     logicalWidth: 700, logicalHeight: 480,
   });
   app.sim.start();
*/

(function (global) {
  const SimLib = {};

  /* -------------------- roundRect polyfill (once) -------------------- */
  if (typeof CanvasRenderingContext2D !== 'undefined' &&
      !CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
      if (Array.isArray(r)) {
        // Minimal [tl, tr, br, bl] support for older browsers
        const [tl, tr, br, bl] = r.map(v => Math.min(v || 0, Math.min(w, h) / 2));
        this.moveTo(x + tl, y);
        this.lineTo(x + w - tr, y);
        this.quadraticCurveTo(x + w, y, x + w, y + tr);
        this.lineTo(x + w, y + h - br);
        this.quadraticCurveTo(x + w, y + h, x + w - br, y + h);
        this.lineTo(x + bl, y + h);
        this.quadraticCurveTo(x, y + h, x, y + h - bl);
        this.lineTo(x, y + tl);
        this.quadraticCurveTo(x, y, x + tl, y);
        return;
      }
      r = typeof r === 'number' ? r : 0;
      this.moveTo(x + r, y);
      this.lineTo(x + w - r, y);
      this.quadraticCurveTo(x + w, y, x + w, y + r);
      this.lineTo(x + w, y + h - r);
      this.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      this.lineTo(x + r, y + h);
      this.quadraticCurveTo(x, y + h, x, y + h - r);
      this.lineTo(x, y + r);
      this.quadraticCurveTo(x, y, x + r, y);
    };
  }

  /* -------------------- Canvas Utilities -------------------- */
  SimLib.CanvasUtils = {
    /** Size a canvas for the device pixel ratio, drawing in CSS pixels. */
    setSize(canvas, width, height) {
      const dpr = Math.max(global.devicePixelRatio || 1, 1);
      canvas.style.width = width + 'px';
      canvas.style.height = height + 'px';
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      canvas._simLogical = { w: width, h: height };
      return ctx;
    },

    /**
     * Size a canvas to its responsive CSS box and map a fixed logical
     * coordinate space onto it. Drawing then uses logical coordinates.
     * @returns {CanvasRenderingContext2D}
     */
    fit(canvas, logicalW, logicalH) {
      const dpr = Math.max(global.devicePixelRatio || 1, 1);
      const dispW = canvas.clientWidth || logicalW;
      const dispH = canvas.clientHeight || logicalH;
      canvas.width = Math.round(dispW * dpr);
      canvas.height = Math.round(dispH * dpr);
      const ctx = canvas.getContext('2d');
      ctx.setTransform((dispW / logicalW) * dpr, 0, 0, (dispH / logicalH) * dpr, 0, 0);
      canvas._simLogical = { w: logicalW, h: logicalH };
      return ctx;
    },

    /** The logical coordinate space a canvas was configured with. */
    logicalSize(canvas) {
      return canvas._simLogical || { w: canvas.clientWidth, h: canvas.clientHeight };
    },

    /** Convert client (page) coordinates into the canvas' logical space. */
    toLogical(canvas, clientX, clientY) {
      const r = canvas.getBoundingClientRect();
      const L = SimLib.CanvasUtils.logicalSize(canvas);
      return {
        x: (clientX - r.left) * (L.w / (r.width || 1)),
        y: (clientY - r.top) * (L.h / (r.height || 1)),
      };
    },

    /** Convert a pointer/mouse/touch event into logical coordinates. */
    eventPos(canvas, e) {
      const src = e.touches && e.touches[0] ? e.touches[0] : e;
      return SimLib.CanvasUtils.toLogical(canvas, src.clientX, src.clientY);
    },

    /**
     * Convert logical canvas coordinates into page (client) coordinates.
     * Inverse of `toLogical`; used by the guided overlay to anchor callouts
     * and spotlights to canvas-space targets. Multiply the result by the
     * canvas' displayed scale implicitly via the rect.
     */
    logicalToCss(canvas, x, y) {
      const r = canvas.getBoundingClientRect();
      const L = SimLib.CanvasUtils.logicalSize(canvas);
      return {
        x: r.left + (x / (L.w || 1)) * r.width,
        y: r.top + (y / (L.h || 1)) * r.height,
      };
    },

    clear(ctx, w, h) {
      if (!w || !h) {
        const L = SimLib.CanvasUtils.logicalSize(ctx.canvas);
        w = L.w; h = L.h;
      }
      ctx.clearRect(0, 0, w, h);
    },

    roundRect(ctx, x, y, w, h, r) {
      if (r === undefined) r = 6;
      const minDim = Math.min(w, h) / 2;
      if (r > minDim) r = minDim;
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    },

    drawGlossySphere(ctx, x, y, r, fillStyle) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.closePath();
      ctx.fillStyle = fillStyle || '#888';
      ctx.fill();
      const g = ctx.createRadialGradient(x - r * 0.4, y - r * 0.6, r * 0.1, x, y, r);
      g.addColorStop(0, 'rgba(255,255,255,0.9)');
      g.addColorStop(0.5, 'rgba(255,255,255,0.12)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.globalCompositeOperation = 'lighter';
      ctx.fill();
      ctx.restore();
    },
  };

  /* -------------------- Color helpers -------------------- */
  SimLib.Color = {
    rgb(r, g, b, a) {
      if (a === undefined) return `rgb(${r}, ${g}, ${b})`;
      return `rgba(${r}, ${g}, ${b}, ${a})`;
    },
    hexToRgb(hex) {
      if (hex[0] === '#') hex = hex.slice(1);
      if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
      const num = parseInt(hex, 16);
      return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
    },
    /** Parse '#rgb', '#rrggbb' or 'rgb()/rgba()' into {r,g,b}. */
    parse(color) {
      if (typeof color !== 'string') return { r: 128, g: 128, b: 128 };
      if (color[0] === '#') return SimLib.Color.hexToRgb(color);
      const m = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      if (m) return { r: +m[1], g: +m[2], b: +m[3] };
      return { r: 128, g: 128, b: 128 };
    },
    /** Blend toward white. `amt` is a 0..1 fraction (or 0..255). */
    lighten(color, amt) {
      const c = SimLib.Color.parse(color);
      const f = amt <= 1 ? amt : amt / 255;
      return `rgb(${Math.round(c.r + (255 - c.r) * f)}, ${Math.round(c.g + (255 - c.g) * f)}, ${Math.round(c.b + (255 - c.b) * f)})`;
    },
    /** Blend toward black. `amt` is a 0..1 fraction (or 0..255). */
    darken(color, amt) {
      const c = SimLib.Color.parse(color);
      const f = amt <= 1 ? amt : amt / 255;
      return `rgb(${Math.round(c.r * (1 - f))}, ${Math.round(c.g * (1 - f))}, ${Math.round(c.b * (1 - f))})`;
    },
  };

  /* -------------------- Theme -------------------- */
  /**
   * Shared canvas theme. Select the active palette with
   * `SimLib.Theme.use('light' | 'dark')`, then draw with the returned tokens
   * so every simulation shares one palette and one type scale.
   */
  SimLib.Theme = (function () {
    const FAMILY = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

    function palette(tokens) {
      tokens.fontFamily = FAMILY;
      tokens.font = (size, weight) => `${weight || 'normal'} ${size}px ${FAMILY}`;
      return tokens;
    }

    const light = palette({
      name: 'light',
      bg: '#fafbfc', surface: '#ffffff', surface2: '#f8f9fa',
      grid: '#e9ecef', gridStrong: '#d1d5db',
      ink: '#1a1a2e', text: '#495057', muted: '#6c757d', faint: '#adb5bd',
      border: '#e9ecef', borderStrong: '#d1d5db',
      accent: '#4a6fa5', accentDark: '#3b5d8f', accentSoft: '#eef3fa',
      danger: '#dc2626', success: '#2d7d46', warn: '#b45309',
      glow: '#ffcc00',
    });

    const dark = palette({
      name: 'dark',
      bg: '#0d1117', surface: '#161b22', surface2: '#1c2430',
      grid: '#21262d', gridStrong: '#30363d',
      ink: '#e8e8e8', text: '#c9d1d9', muted: '#8b949e', faint: '#484f58',
      border: '#30363d', borderStrong: '#3d444d',
      accent: '#7aa2d6', accentDark: '#5b87bf', accentSoft: '#1b2a3d',
      danger: '#f87171', success: '#34d399', warn: '#fbbf24',
      glow: '#ffdd57',
    });

    const palettes = { light, dark };
    let current = light;

    return {
      palettes,
      /** Select and return the active palette. */
      use(name) { current = palettes[name] || light; return current; },
      /** The active palette. */
      get() { return current; },
      /** Font shorthand using the active palette family. */
      font(size, weight) { return current.font(size, weight); },
      /** Semantic colour for a status level. */
      status(level) {
        return level === 'stable' ? current.success
          : level === 'unstable' ? current.warn
          : level === 'impossible' ? current.faint
          : current.danger;
      },
    };
  })();

  /* -------------------- Canvas drawing helpers -------------------- */
  SimLib.Draw = {
    /** Fill the whole logical canvas with the theme background. */
    background(ctx, w, h, theme) {
      const T = theme || SimLib.Theme.get();
      ctx.fillStyle = T.bg;
      ctx.fillRect(0, 0, w, h);
    },

    /** Faint graph-paper grid across the canvas (or a sub-rect). */
    grid(ctx, w, h, opts = {}) {
      const T = opts.theme || SimLib.Theme.get();
      const step = opts.step || 20;
      const x0 = opts.x || 0;
      const y0 = opts.y || 0;
      ctx.save();
      ctx.strokeStyle = opts.color || T.grid;
      ctx.lineWidth = opts.lineWidth || 1;
      ctx.beginPath();
      for (let x = x0; x <= w; x += step) { ctx.moveTo(x + 0.5, y0); ctx.lineTo(x + 0.5, h); }
      for (let y = y0; y <= h; y += step) { ctx.moveTo(x0, y + 0.5); ctx.lineTo(w, y + 0.5); }
      ctx.stroke();
      ctx.restore();
    },

    /** Themed text. */
    text(ctx, str, x, y, opts = {}) {
      const T = opts.theme || SimLib.Theme.get();
      ctx.save();
      ctx.fillStyle = opts.color || T.ink;
      ctx.font = T.font(opts.size || 11, opts.weight);
      ctx.textAlign = opts.align || 'left';
      ctx.textBaseline = opts.baseline || 'alphabetic';
      ctx.fillText(str, x, y);
      ctx.restore();
    },

    /** Scene title. */
    title(ctx, str, x, y, opts = {}) {
      const T = opts.theme || SimLib.Theme.get();
      SimLib.Draw.text(ctx, str, x, y, {
        size: opts.size || 15,
        weight: opts.weight || 'bold',
        color: opts.color || T.ink,
        align: opts.align || 'left',
        baseline: opts.baseline || 'alphabetic',
        theme: T,
      });
    },

    /** Axis label. */
    axisLabel(ctx, str, x, y, opts = {}) {
      const T = opts.theme || SimLib.Theme.get();
      SimLib.Draw.text(ctx, str, x, y, {
        size: opts.size || 10,
        weight: opts.weight || '600',
        color: opts.color || T.muted,
        align: opts.align || 'center',
        baseline: opts.baseline || 'middle',
        theme: T,
      });
    },

    /** Rounded panel/card. */
    panel(ctx, x, y, w, h, opts = {}) {
      const T = opts.theme || SimLib.Theme.get();
      ctx.save();
      SimLib.CanvasUtils.roundRect(ctx, x, y, w, h, opts.radius == null ? 8 : opts.radius);
      if (opts.fill !== false) { ctx.fillStyle = opts.fill || T.surface; ctx.fill(); }
      if (opts.stroke !== false) { ctx.strokeStyle = opts.stroke || T.border; ctx.lineWidth = opts.lineWidth || 1; ctx.stroke(); }
      ctx.restore();
    },

    /**
     * Legend. `items` = [{ color, label, shape: 'swatch'|'dot'|'line' }].
     * Returns the width consumed.
     */
    legend(ctx, items, x, y, opts = {}) {
      const T = opts.theme || SimLib.Theme.get();
      const size = opts.size || 11;
      const gap = opts.gap || 16;
      const sw = opts.swatch || 10;
      ctx.save();
      ctx.font = T.font(size, opts.weight || '600');
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      let cx = x;
      for (const it of items) {
        const shape = it.shape || 'swatch';
        ctx.fillStyle = it.color || T.accent;
        if (shape === 'dot') {
          ctx.beginPath(); ctx.arc(cx + sw / 2, y, sw / 2 - 1, 0, Math.PI * 2); ctx.fill();
        } else if (shape === 'line') {
          ctx.strokeStyle = it.color || T.accent; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.moveTo(cx, y); ctx.lineTo(cx + sw, y); ctx.stroke();
        } else {
          ctx.fillRect(cx, y - sw / 2, sw, sw);
        }
        ctx.fillStyle = it.labelColor || T.text;
        ctx.fillText(it.label, cx + sw + 6, y + 0.5);
        cx += sw + 6 + ctx.measureText(it.label).width + gap;
      }
      ctx.restore();
      return cx - x;
    },
  };

  /* -------------------- EventBus -------------------- */
  class EventBus {
    constructor() { this._map = Object.create(null); }
    on(type, fn) { (this._map[type] = this._map[type] || []).push(fn); return () => this.off(type, fn); }
    off(type, fn) { const a = this._map[type]; if (!a) return; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
    emit(type, payload) { const a = this._map[type]; if (!a) return; a.slice().forEach(fn => { try { fn(payload); } catch (e) { console.error('EventBus handler error', e); } }); }
  }
  SimLib.EventBus = EventBus;

  /* -------------------- UI primitives -------------------- */
  SimLib.UI = {
    _intervals: new Set(),

    createPanel(container) {
      const panel = document.createElement('div');
      panel.className = 'sim-panel';
      container.appendChild(panel);
      return {
        el: panel,
        addRow() { const r = document.createElement('div'); r.className = 'sim-row'; panel.appendChild(r); return r; },
        button(label, onClick) { const b = document.createElement('button'); b.className = 'sim-panel-btn'; b.textContent = label; b.addEventListener('click', onClick); panel.appendChild(b); return b; },
        slider(opts) {
          const wrap = document.createElement('label'); wrap.className = 'sim-panel-slider';
          const lbl = document.createElement('span'); lbl.textContent = opts.label || '';
          const input = document.createElement('input'); input.type = 'range'; input.min = opts.min; input.max = opts.max; input.step = opts.step || 1; input.value = opts.value;
          const val = document.createElement('output'); val.textContent = opts.value;
          input.addEventListener('input', e => { val.textContent = input.value; if (opts.oninput) opts.oninput(Number(input.value)); });
          wrap.appendChild(lbl); wrap.appendChild(input); wrap.appendChild(val); panel.appendChild(wrap);
          return input;
        },
        readout(label, getter, period = 200) {
          const wrap = document.createElement('div'); wrap.className = 'sim-panel-readout';
          const lbl = document.createElement('div'); lbl.className = 'sim-panel-readout__label'; lbl.textContent = label;
          const val = document.createElement('div'); val.className = 'sim-panel-readout__value'; val.textContent = '';
          wrap.appendChild(lbl); wrap.appendChild(val); panel.appendChild(wrap);
          const t = setInterval(() => { try { val.textContent = getter(); } catch (e) { val.textContent = '—'; } }, period);
          const handle = { el: wrap, stop() { clearInterval(t); } };
          SimLib.UI._intervals.add(handle);
          return handle;
        },
      };
    },

    /**
     * Wire an existing <input type="range"> to an optional <output>/span.
     * @returns a function that re-applies the current value.
     */
    bindSlider(input, opts = {}) {
      const { output, format, oninput } = opts;
      const apply = () => {
        const v = Number(input.value);
        if (output) output.textContent = format ? format(v) : String(v);
        if (oninput) oninput(v);
      };
      input.addEventListener('input', apply);
      apply();
      return apply;
    },

    bindButton(el, fn) {
      el.addEventListener('click', fn);
      return () => el.removeEventListener('click', fn);
    },

    /** Toggle a boolean and sync a button's label/class. */
    bindToggle(btn, state, opts = {}) {
      const { onLabel, offLabel, onClass = 'on' } = opts;
      let value = state;
      const sync = () => {
        if (onLabel && offLabel) btn.textContent = value ? onLabel : offLabel;
        if (onClass) btn.classList.toggle(onClass, value);
      };
      btn.addEventListener('click', () => { value = !value; sync(); if (opts.onChange) opts.onChange(value); });
      sync();
      return () => value;
    },
  };

  /* -------------------- Simulation base class -------------------- */
  class Simulation {
    constructor(app) {
      this.app = app;
      this.canvas = app.canvas;
      this.ctx = app.ctx;
      this.bus = app.bus;
      this.logical = app.logical;
      this.state = {};
      this.running = false;
      this._boundLoop = this._loop.bind(this);
      this.lastTs = null;
      this.speed = 1;
    }
    onInit() {}
    onStart() {}
    onPause() {}
    onReset() {}
    onTick(dt) {}
    onDraw(ctx) {}
    onResize(w, h) {}
    start() { if (this.running) return; this.running = true; this.lastTs = performance.now(); this.onStart(); requestAnimationFrame(this._boundLoop); }
    stop() { if (!this.running) return; this.running = false; this.onPause(); }
    setSpeed(s) { this.speed = s; }
    /** Stop, restore initial state, and repaint. Does not restart the loop. */
    reset() {
      const wasRunning = this.running;
      this.stop();
      try { this.onReset(); } catch (e) { console.error('Sim reset error', e); }
      try { this.onDraw(this.ctx); } catch (e) { console.error('Sim draw error', e); }
      if (wasRunning) this.start();
    }
    _loop(ts) {
      if (!this.running) return;
      const dt = ((ts - this.lastTs) / 1000) * this.speed;
      this.lastTs = ts;
      try { this.onTick(dt); } catch (e) { console.error('Sim tick error', e); }
      if (this.app && this.app.guidedTick) {
        try { this.app.guidedTick(dt); } catch (e) { console.error('Guided tick error', e); }
      }
      try { this.onDraw(this.ctx); } catch (e) { console.error('Sim draw error', e); }
      requestAnimationFrame(this._boundLoop);
    }
  }
  SimLib.Simulation = Simulation;

  /* -------------------- SimApp bootstrap helper -------------------- */
  /**
   * @param {object} opts
   * @param {HTMLCanvasElement} opts.canvas
   * @param {Function} opts.SimulationClass  Subclass of SimLib.Simulation
   * @param {number} [opts.logicalWidth]     Fixed scene width (responsive fit)
   * @param {number} [opts.logicalHeight]
   * @param {HTMLElement} [opts.panel]       Container for the optional default controls
   * @param {boolean} [opts.controls=false]  Inject default Play/Reset/Speed chrome
   * @param {boolean} [opts.autostart=false] Start the loop immediately
   * @param {object} [opts.options]          Arbitrary config for the simulation
   * @returns {object} app
   */
  SimLib.attach = function attach(opts) {
    const canvas = opts.canvas;
    if (!canvas) throw new Error('SimLib.attach requires a canvas element');

    const lw = opts.logicalWidth || canvas.clientWidth || 600;
    const lh = opts.logicalHeight || canvas.clientHeight || 400;
    const ctx = SimLib.CanvasUtils.fit(canvas, lw, lh);
    const bus = new EventBus();
    const app = {
      canvas, ctx, bus,
      logical: { w: lw, h: lh },
      options: opts.options || {},
      state: {},
      sim: null,
    };
    const sim = new opts.SimulationClass(app);
    app.sim = sim;

    // Optional default chrome (off by default: most sims ship their own).
    if (opts.controls) {
      const panel = opts.panel || canvas.parentElement;
      if (panel) {
        const ui = SimLib.UI.createPanel(panel);
        const playBtn = ui.button('Play', () => {
          if (sim.running) { sim.stop(); playBtn.textContent = 'Play'; }
          else { sim.start(); playBtn.textContent = 'Pause'; }
        });
        ui.button('Reset', () => sim.reset());
        ui.slider({ label: 'Speed', min: 0.1, max: 3, step: 0.1, value: 1, oninput(v) { sim.setSpeed(v); } });
      }
    }

    // Keep the transform in sync with the displayed size.
    function handleResize() {
      SimLib.CanvasUtils.fit(canvas, lw, lh);
      if (sim.onResize) sim.onResize(lw, lh);
      if (!sim.running) sim.onDraw(sim.ctx);
    }
    global.addEventListener('resize', handleResize);

    try { sim.onInit(); } catch (e) { console.error('Sim init error', e); }
    try { sim.onDraw(sim.ctx); } catch (e) { console.error('Sim draw error', e); }
    if (opts.autostart) sim.start();

    // Clean up polling readouts when the page goes away.
    global.addEventListener('beforeunload', () => {
      if (sim.running) sim.stop();
      SimLib.UI._intervals.forEach(h => h.stop());
      SimLib.UI._intervals.clear();
    });

    return app;
  };

  // Expose globally
  global.SimLib = SimLib;
})(this);
