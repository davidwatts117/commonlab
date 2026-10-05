/*
 SimLib.Guided — guided experiments (interactive lessons) for simulations

 A guided experiment is a curated, step-by-step layer over an existing
 simulation. It can present instructions, drive the simulation's controls,
 observe live state, and gate/highlight controls — all without the simulation
 knowing anything about lessons.

 Dependencies: library.js (SimLib, SimLib.Simulation, SimLib.CanvasUtils).

 Public API
 ----------
   SimLib.Guided.adapter(sim, spec)        bridge a sim to semantic names
   SimLib.Guided.define(def)               validate/normalize an experiment
   SimLib.Guided.mount({ app, adapter, experiments, ... })  wire launcher + engine
   SimLib.Guided.richText(str)             restricted inline markup -> HTML

 See docs/guided-experiments-plan.md for the design.
*/

(function (global) {
  'use strict';

  const SimLib = global.SimLib;
  if (!SimLib) {
    console.error('SimLib.Guided requires library.js to be loaded first');
    return;
  }

  const Guided = {};
  Guided.version = '1.1.0';

  /* ================================================================
   * Rich text (restricted, dependency-free)
   * ================================================================ */

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ESC[c]);
  }

  /** Inline markup on an already-escaped line. */
  function inlineMarkup(escaped) {
    return escaped
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }

  /**
   * Render a *trusted in-repo* string using a small Markdown subset:
   * **bold**, *italic*, `code`, [link](url), "- " bullet lists, blank-line
   * paragraphs, and single newlines as <br>. Input is escaped first.
   */
  function richText(str) {
    if (!str) return '';
    const lines = String(str).split('\n');
    let html = '';
    let paragraph = [];
    let inList = false;

    const flushParagraph = () => {
      if (paragraph.length) {
        html += '<p>' + paragraph.join('<br>') + '</p>';
        paragraph = [];
      }
    };
    const closeList = () => {
      if (inList) { html += '</ul>'; inList = false; }
    };

    for (const raw of lines) {
      const trimmed = raw.trim();
      if (!trimmed) { flushParagraph(); closeList(); continue; }
      const bullet = trimmed.match(/^[-*]\s+(.*)$/);
      if (bullet) {
        flushParagraph();
        if (!inList) { html += '<ul>'; inList = true; }
        html += '<li>' + inlineMarkup(escapeHtml(bullet[1])) + '</li>';
        continue;
      }
      closeList();
      paragraph.push(inlineMarkup(escapeHtml(raw)));
    }
    flushParagraph();
    closeList();
    return html;
  }
  Guided.richText = richText;

  /**
   * Lets a simulation notify the active runner that a semantic action occurred
   * (for `when: { action: 'release' }` conditions). Safe to call when no guided
   * experiment is running. Simulations that don't call this can instead express
   * completion with state-based conditions.
   */
  Guided.action = function action(name) {
    if (Guided._runner) Guided._runner.noteAction(name);
  };
  Guided._runner = null;

  /* ================================================================
   * Adapter — the per-simulation bridge
   * ================================================================ */

  /**
   * Normalize a simulation bridge into a uniform shape.
   *
   * @param {object} sim   Subclass instance of SimLib.Simulation
   * @param {object} spec
   * @param {string} [spec.id]
   * @param {object} [spec.controls]  name -> { get, set, el?, format?, range? }
   * @param {object} [spec.state]     name -> getter()
   * @param {object} [spec.actions]   name -> fn(...args)
   * @param {object} [spec.targets]   name -> { x, y, r } | { x, y, w, h }
   * @param {object} [spec.elements]  name -> HTMLElement | getter()   (gating-only)
   * @param {Function} [spec.isPaused]
   * @param {Function} [spec.setLocked]  optional lock(canvasInteraction: bool)
   */
  Guided.adapter = function adapter(sim, spec) {
    if (!spec) throw new Error('Guided.adapter requires a spec');
    const asGetter = v => (typeof v === 'function' ? v : () => v);

    const controls = {};
    for (const [name, c] of Object.entries(spec.controls || {})) {
      controls[name] = {
        name,
        get: c.get,
        set: c.set,
        el: asGetter(c.el),
        format: c.format || (v => String(v)),
        range: c.range || null,
      };
    }

    const elements = {};
    for (const [name, e] of Object.entries(spec.elements || {})) {
      elements[name] = asGetter(e);
    }

    const state = {};
    for (const [name, fn] of Object.entries(spec.state || {})) state[name] = fn;

    const actions = {};
    for (const [name, fn] of Object.entries(spec.actions || {})) actions[name] = fn;

    const targets = {};
    for (const [name, fn] of Object.entries(spec.targets || {})) targets[name] = fn;

    return {
      id: spec.id || 'sim',
      sim,
      controls,
      elements,
      state,
      actions,
      targets,
      isPaused: spec.isPaused || (() => !!sim.paused),
      setLocked: spec.setLocked || null,
      /** All DOM elements that gating may disable. */
      interactiveEls() {
        const out = new Set();
        for (const c of Object.values(controls)) {
          const el = c.el && c.el();
          if (el) out.add(el);
        }
        for (const e of Object.values(elements)) {
          const el = e();
          if (el) out.add(el);
        }
        return [...out];
      },
      /** Resolve any highlight/allow name to a DOM element, if any. */
      elementFor(name) {
        if (controls[name] && controls[name].el) return controls[name].el();
        if (elements[name]) return elements[name]();
        return null;
      },
      /** Resolve any highlight name to a canvas-space target, if any. */
      targetFor(name) {
        return targets[name] ? targets[name]() : null;
      },
    };
  };

  /* ================================================================
   * define() — normalize an experiment definition
   * ================================================================ */

  const STEP_TYPES = ['message', 'task', 'observe', 'predict', 'checkpoint', 'conclusion'];

  function defaultAdvance(type) {
    if (type === 'message' || type === 'conclusion') return 'on-next';
    if (type === 'predict' || type === 'checkpoint') return 'on-answer';
    return 'on-condition'; // task, observe
  }

  Guided.define = function define(def) {
    if (!def || !def.id) throw new Error('Guided.define requires an experiment id');
    if (!Array.isArray(def.steps) || def.steps.length === 0) {
      throw new Error('Guided.define requires a non-empty steps array');
    }
    const steps = def.steps.map((s, i) => {
      if (!s.id) throw new Error('Guided.define: step at index ' + i + ' needs an id');
      const type = s.type || 'message';
      if (STEP_TYPES.indexOf(type) === -1) {
        throw new Error('Guided.define: unknown step type "' + type + '"');
      }
      return Object.assign({
        type,
        title: '',
        body: '',
        choices: null,
        feedback: null,
        highlight: [],
        allow: null,
        when: null,
        hint: '',
        advance: defaultAdvance(type),
        freeze: false,
        optional: false,
      }, s, { index: i, type });
    });

    const ids = new Set();
    for (const s of steps) {
      if (ids.has(s.id)) throw new Error('Guided.define: duplicate step id "' + s.id + '"');
      ids.add(s.id);
    }

    return Object.assign({
      summary: '',
      subject: '',
      level: '',
      minutes: null,
      tags: [],
      setup: null,
    }, def, { steps });
  };

  /* ================================================================
   * Condition evaluation
   * ================================================================ */

  /** Names of state values referenced with `settles: true` in a condition. */
  function settleStates(when, out) {
    out = out || [];
    if (!when || typeof when !== 'object') return out;
    if (Array.isArray(when)) { when.forEach(w => settleStates(w, out)); return out; }
    for (const key of ['all', 'any']) {
      if (when[key]) when[key].forEach(w => settleStates(w, out));
    }
    if (when.not) settleStates(when.not, out);
    if (when.state !== undefined && when.settles) out.push(when.state);
    return out;
  }

  /**
   * Evaluate a `when` condition. `ctx` = { adapter, baseline, settle, lastAction }.
   */
  function evalWhen(when, ctx) {
    if (!when) return false;
    if (Array.isArray(when)) return when.every(w => evalWhen(w, ctx));
    if (when.all) return when.all.every(w => evalWhen(w, ctx));
    if (when.any) return when.any.some(w => evalWhen(w, ctx));
    if (when.not) return !evalWhen(when.not, ctx);
    if (typeof when.fn === 'function') return !!when.fn(ctx);

    const a = ctx.adapter;

    if (when.control !== undefined) {
      const c = a.controls[when.control];
      if (!c) return false;
      const value = Number(c.get());
      let checkedRange = false;
      if (when.near !== undefined) {
        checkedRange = true;
        if (Math.abs(value - when.near) > (when.tolerance != null ? when.tolerance : 0)) return false;
      }
      if (when.equals !== undefined) {
        checkedRange = true;
        if (value !== when.equals) return false;
      }
      if (when.min !== undefined) { checkedRange = true; if (value < when.min) return false; }
      if (when.max !== undefined) { checkedRange = true; if (value > when.max) return false; }
      if (when.changedBy !== undefined) {
        checkedRange = true;
        const base = ctx.baseline[when.control];
        if (base === undefined || Math.abs(value - base) < when.changedBy) return false;
      }
      if (when.changed) {
        checkedRange = true;
        const base = ctx.baseline[when.control];
        if (base === undefined || value === base) return false;
      }
      return checkedRange;
    }

    if (when.state !== undefined) {
      const fn = a.state[when.state];
      if (!fn) return false;
      const value = Number(fn());
      let checkedRange = false;
      if (when.min !== undefined) { checkedRange = true; if (!(value >= when.min)) return false; }
      if (when.max !== undefined) { checkedRange = true; if (!(value <= when.max)) return false; }
      if (when.equals !== undefined) { checkedRange = true; if (value !== when.equals) return false; }
      if (when.settles) {
        checkedRange = true;
        const s = ctx.settle[when.state];
        if (!s || !s.settled) return false;
      }
      return checkedRange;
    }

    if (when.action !== undefined) return ctx.lastAction === when.action;
    return false;
  }
  Guided.evalWhen = evalWhen;

  /* ================================================================
   * Overlay view
   * ================================================================ */

  function el(tag, cls, html) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (html != null) node.innerHTML = html;
    return node;
  }

  class Overlay {
    constructor(root, adapter) {
      this.root = root;
      this.adapter = adapter;
      this.root.classList.add('guided-layer');

      this.hud = el('div', 'guided-hud');
      this.hud.hidden = true;
      this.hud.innerHTML =
        '<div class="guided-hud__left">' +
          '<span class="guided-hud__badge">Guided</span>' +
          '<span class="guided-hud__title" data-title></span>' +
        '</div>' +
        '<div class="guided-hud__dots" data-dots aria-hidden="true"></div>' +
        '<div class="guided-hud__steps" data-count></div>' +
        '<div class="guided-hud__actions">' +
          '<button type="button" class="guided-btn guided-btn--ghost" data-back>Back</button>' +
          '<button type="button" class="guided-btn guided-btn--ghost" data-hint hidden>Hint</button>' +
          '<button type="button" class="guided-btn guided-btn--primary" data-next hidden>Next</button>' +
          '<button type="button" class="guided-btn guided-btn--ghost" data-skip>Skip</button>' +
          '<button type="button" class="guided-btn guided-btn--exit" data-exit aria-label="Exit guided experiment">Exit</button>' +
        '</div>';
      this.root.appendChild(this.hud);

      this.spotlight = el('div', 'guided-spotlight');
      this.spotlight.hidden = true;
      this.root.appendChild(this.spotlight);

      this.card = el('div', 'guided-card');
      this.card.hidden = true;
      this.root.appendChild(this.card);

      this.modalWrap = el('div', 'guided-modal-wrap');
      this.modalWrap.hidden = true;
      this.modalWrap.innerHTML =
        '<div class="guided-backdrop" data-backdrop></div>' +
        '<div class="guided-modal" role="dialog" aria-modal="true" aria-labelledby="guided-modal-title">' +
          '<div class="guided-modal__body" data-body></div>' +
          '<div class="guided-modal__footer" data-footer></div>' +
        '</div>';
      this.root.appendChild(this.modalWrap);

      this.toastEl = el('div', 'guided-toast');
      this.toastEl.hidden = true;
      this.root.appendChild(this.toastEl);

      this._listeners = [];
      this._reposition = () => this.reposition();
      global.addEventListener('resize', this._reposition);
      document.addEventListener('fullscreenchange', this._reposition);
      document.addEventListener('webkitfullscreenchange', this._reposition);
    }

    on(sel, type, fn) {
      const node = this.root.querySelector(sel);
      if (!node) return;
      node.addEventListener(type, fn);
      this._listeners.push([node, type, fn]);
      return node;
    }

    setHud(state, handlers) {
      this.hud.hidden = false;
      this.hud.querySelector('[data-title]').textContent = state.title || 'Guided Experiment';
      this.hud.querySelector('[data-count]').textContent =
        'Step ' + (state.index + 1) + ' of ' + state.total;
      const dots = this.hud.querySelector('[data-dots]');
      dots.innerHTML = '';
      for (let i = 0; i < state.total; i++) {
        const d = el('span', 'guided-dot');
        if (i < state.index) d.classList.add('is-done');
        else if (i === state.index) d.classList.add('is-current');
        dots.appendChild(d);
      }
      const back = this.hud.querySelector('[data-back]');
      back.disabled = state.index === 0;
      const hint = this.hud.querySelector('[data-hint]');
      hint.hidden = !state.hint;
      const nextBtn = this.hud.querySelector('[data-next]');
      nextBtn.hidden = !state.showNext;
      this.hud.querySelector('[data-skip]').hidden = !state.showSkip;
      this._hintText = state.hint || '';

      // bind once (idempotent: replace handlers each render)
      handlers = handlers || {};
      this._bindHud('data-back', handlers.onBack);
      this._bindHud('data-next', handlers.onNext);
      this._bindHud('data-skip', handlers.onSkip);
      this._bindHud('data-exit', handlers.onExit);
      this._bindHud('data-hint', handlers.onHint);
    }

    _bindHud(attr, fn) {
      const node = this.hud.querySelector('[' + attr + ']');
      if (!node) return;
      node._guidedHandler = fn;
      if (node._guidedBound) return;
      node._guidedBound = true;
      node.addEventListener('click', () => { if (node._guidedHandler) node._guidedHandler(); });
    }

    /** Render a step content panel. `mode` is 'modal' or 'card'. */
    showStep(step, mode, handlers) {
      if (mode === 'modal') {
        this.card.hidden = true;
        this.modalWrap.hidden = false;
        const body = this.modalWrap.querySelector('[data-body]');
        const footer = this.modalWrap.querySelector('[data-footer]');
        body.innerHTML = this._stepHtml(step, 'modal');
        footer.innerHTML = '';
        this._renderChoices(step, body, handlers);
        this._renderFooter(step, footer, handlers);
        const focusable = this.modalWrap.querySelector('.guided-choice, [data-footer] .guided-btn');
        if (focusable) focusable.focus();
      } else {
        this.modalWrap.hidden = true;
        this.card.hidden = false;
        this.card.innerHTML =
          '<div class="guided-card__body">' + this._stepHtml(step, 'card') + '</div>' +
          (step.advance === 'on-next'
            ? '<div class="guided-card__footer"><button type="button" class="guided-btn guided-btn--primary" data-card-next>Next</button></div>'
            : '<div class="guided-card__status" data-card-status>' + this._waitingLabel(step) + '</div>');
        const nextBtn = this.card.querySelector('[data-card-next]');
        if (nextBtn) nextBtn.addEventListener('click', handlers.onNext);
        this.positionCard();
      }
    }

    /**
     * Keep the task/observe card over the canvas rather than over the control
     * panel, so it never covers the control the student is being asked to use.
     */
    positionCard() {
      if (!this.card || this.card.hidden) return;
      const canvas = this.adapter.sim.canvas;
      if (!canvas || !canvas.getBoundingClientRect) return;
      const rootRect = this.root.getBoundingClientRect();
      const cr = canvas.getBoundingClientRect();
      const left = Math.max(6, cr.left - rootRect.left + 10);
      const bottom = Math.max(6, rootRect.bottom - cr.bottom + 10);
      this.card.style.left = left + 'px';
      this.card.style.bottom = bottom + 'px';
      this.card.style.top = 'auto';
      this.card.style.right = 'auto';
      this.card.style.width = Math.min(360, Math.max(180, cr.width - 20)) + 'px';
    }

    _stepHtml(step, mode) {
      let html = '';
      const idAttr = mode === 'modal' ? ' id="guided-modal-title"' : '';
      if (step.title) html += '<h3 class="guided-step__title"' + idAttr + '>' + richText(step.title) + '</h3>';
      if (step.body) html += '<div class="guided-step__body">' + richText(step.body) + '</div>';
      html += '<div class="guided-step__hint" data-hint-text hidden></div>';
      return html;
    }

    _waitingLabel(step) {
      if (step.type === 'observe') return 'Waiting for the simulation\u2026';
      return 'Complete the step to continue';
    }

    _renderChoices(step, body, handlers) {
      if (!step.choices || !step.choices.length) return;
      const wrap = el('div', 'guided-choices');
      step.choices.forEach((choice) => {
        const btn = el('button', 'guided-choice');
        btn.type = 'button';
        btn.textContent = choice.label;
        btn.addEventListener('click', () => {
          wrap.querySelectorAll('.guided-choice').forEach((b) => b.classList.remove('is-selected'));
          btn.classList.add('is-selected');
          if (handlers.onAnswer) handlers.onAnswer(choice, step);
        });
        wrap.appendChild(btn);
      });
      body.appendChild(wrap);
      const fb = el('div', 'guided-feedback');
      fb.hidden = true;
      body.appendChild(fb);
    }

    showFeedback(text, tone) {
      const fb = this.modalWrap.querySelector('.guided-feedback');
      if (!fb) return;
      fb.innerHTML = richText(text);
      fb.className = 'guided-feedback is-' + (tone || 'info');
      fb.hidden = false;
    }

    revealHint() {
      const node = this.modalWrap.querySelector('[data-hint-text]')
        || this.card.querySelector('[data-hint-text]');
      if (node && this._hintText) { node.innerHTML = richText(this._hintText); node.hidden = false; }
      const status = this.card && this.card.querySelector('[data-card-status]');
      void status;
    }

    _renderFooter(step, footer, handlers) {
      const needsNext = step.advance === 'on-next' || step.advance === 'on-answer';
      if (!needsNext) return;
      const answered = this._answered;
      const btn = el('button', 'guided-btn guided-btn--primary');
      btn.type = 'button';
      btn.textContent = step.advance === 'on-next'
        ? (step.type === 'conclusion' ? 'Finish' : 'Next')
        : (step.type === 'checkpoint' ? 'Continue' : 'Next');
      if (step.advance === 'on-answer' && !answered) btn.disabled = true;
      btn.addEventListener('click', handlers.onNext);
      footer.appendChild(btn);
      this._modalNextBtn = btn;
    }

    /** Enable the modal's Next button after a `predict`/`checkpoint` answer. */
    enableNext() {
      if (this._modalNextBtn) this._modalNextBtn.disabled = false;
    }

    setCardStatus(text, done) {
      const status = this.card && this.card.querySelector('[data-card-status]');
      if (!status) return;
      status.textContent = text;
      status.classList.toggle('is-done', !!done);
    }

    toast(message, ms) {
      this.toastEl.innerHTML = richText(message);
      this.toastEl.hidden = false;
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => { this.toastEl.hidden = true; }, ms || 2200);
    }

    clearStep() {
      this.hud.hidden = true;
      this.modalWrap.hidden = true;
      this.card.hidden = true;
      this.spotlight.hidden = true;
    }

    /* ----- highlighting / gating ----- */

    applyHighlightAndGating(step) {
      const a = this.adapter;
      const highlight = step.highlight || [];
      const allow = step.allow;
      const set = new Set(highlight);

      for (const node of a.interactiveEls()) {
        node.classList.remove('guided-highlight', 'guided-gated');
        if (node._guidedPrevDisabled !== undefined) {
          node.disabled = node._guidedPrevDisabled;
          delete node._guidedPrevDisabled;
        }
        if (allow && !allow.includes(this._nameOf(node))) {
          node.classList.add('guided-gated');
          if ('disabled' in node) {
            node._guidedPrevDisabled = node.disabled;
            node.disabled = true;
          }
        } else if (set.has(this._nameOf(node))) {
          node.classList.add('guided-highlight');
        }
      }

      // Spotlight cutout for the first canvas target or DOM element.
      this._spotTargets = [];
      for (const name of highlight) {
        const t = a.targetFor(name);
        if (t) { this._spotTargets.push({ kind: 'canvas', target: t }); continue; }
        const e = a.elementFor(name);
        if (e) { this._spotTargets.push({ kind: 'dom', el: e }); }
      }
      this.spotlight.hidden = this._spotTargets.length === 0;
      if (!this.spotlight.hidden) {
        this.spotlight.innerHTML = '';
        const spot = el('div', 'guided-spot');
        this.spotlight.appendChild(spot);
        this._spotNode = spot;
        this.reposition();
      }
    }

    _nameOf(node) {
      const a = this.adapter;
      for (const [name, c] of Object.entries(a.controls)) {
        if (c.el && c.el() === node) return name;
      }
      for (const [name, e] of Object.entries(a.elements)) {
        if (e() === node) return name;
      }
      return '';
    }

    clearGating() {
      for (const node of this.adapter.interactiveEls()) {
        node.classList.remove('guided-highlight', 'guided-gated');
        if (node._guidedPrevDisabled !== undefined) {
          node.disabled = node._guidedPrevDisabled;
          delete node._guidedPrevDisabled;
        }
      }
      this.spotlight.hidden = true;
    }

    /** Reposition the spotlight after a resize / fullscreen change. */
    reposition() {
      this.positionCard();
      if (!this._spotNode || !this._spotTargets || !this._spotTargets.length) return;
      const rootRect = this.root.getBoundingClientRect();
      const first = this._spotTargets[0];
      let x, y, w, h, radius;
      if (first.kind === 'canvas') {
        const p = SimLib.CanvasUtils.logicalToCss(this.adapter.sim.canvas, first.target.x, first.target.y);
        radius = this._canvasRadius(first.target.r || 16);
        x = p.x - rootRect.left - radius;
        y = p.y - rootRect.top - radius;
        w = h = radius * 2;
      } else {
        const r = first.el.getBoundingClientRect();
        x = r.left - rootRect.left - 4;
        y = r.top - rootRect.top - 4;
        w = r.width + 8;
        h = r.height + 8;
      }
      Object.assign(this._spotNode.style, {
        left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px',
        borderRadius: first.kind === 'canvas' ? '50%' : '10px',
      });
    }

    _canvasRadius(logicalR) {
      const canvas = this.adapter.sim.canvas;
      const dispW = canvas.getBoundingClientRect().width;
      const L = SimLib.CanvasUtils.logicalSize(canvas);
      return logicalR * (dispW / (L.w || dispW));
    }

    destroy() {
      this._listeners.forEach(([node, type, fn]) => node.removeEventListener(type, fn));
      this._listeners = [];
      global.removeEventListener('resize', this._reposition);
      document.removeEventListener('fullscreenchange', this._reposition);
      document.removeEventListener('webkitfullscreenchange', this._reposition);
      this.clearGating();
      this.root.remove();
    }
  }
  Guided.Overlay = Overlay;

  /* ================================================================
   * Runner — the step state machine
   * ================================================================ */

  class Runner {
    constructor(opts) {
      this.experiment = opts.experiment;
      this.adapter = opts.adapter;
      this.app = opts.app;
      this.overlay = opts.overlay;
      this.onUpdate = opts.onUpdate || (() => {});
      this.onComplete = opts.onComplete || (() => {});
      this.onExit = opts.onExit || (() => {});

      this.index = -1;
      this.answers = {};
      this.running = false;
      this.lastAction = null;
      this._samples = {};
      this.stepElapsed = 0;
      this.baseline = {};
      this._wasPaused = null;
      this._answered = false;
    }

    get step() { return this.index >= 0 ? this.experiment.steps[this.index] : null; }

    start(index) {
      if (this.running) this.exit(true);
      this.running = true;
      this.answers = {};
      this.applySetup();
      this.enter(index || 0);
      if (this.app) this.app.guidedTick = (dt) => this.tick(dt);
    }

    applySetup() {
      const setup = this.experiment.setup;
      this.baseline = {};
      for (const [name, c] of Object.entries(this.adapter.controls)) {
        try { this.baseline[name] = Number(c.get()); } catch (e) { /* ignore */ }
      }
      if (!setup) return;
      if (setup.controls) {
        for (const [name, value] of Object.entries(setup.controls)) {
          const c = this.adapter.controls[name];
          if (c && c.set) {
            try { c.set(value, { animate: false }); } catch (e) { console.error('Guided setup set error', e); }
          }
        }
      }
      if (setup.action && this.adapter.actions[setup.action]) {
        try { this.adapter.actions[setup.action](); } catch (e) { console.error('Guided setup action error', e); }
      }
      // Re-baseline after setup so `changedBy` measures student changes.
      for (const [name, c] of Object.entries(this.adapter.controls)) {
        try { this.baseline[name] = Number(c.get()); } catch (e) { /* ignore */ }
      }
    }

    enter(index) {
      if (index < 0 || index >= this.experiment.steps.length) return this.complete();
      this.index = index;
      this.stepElapsed = 0;
      this._samples = {};
      this._settle = {};
      this._answered = false;
      this.lastAction = null;
      Guided._runner = this;
      const step = this.step;

      // Stabilize a step's baseline for `changedBy` at step entry.
      for (const [name, c] of Object.entries(this.adapter.controls)) {
        try { this.baseline[name] = Number(c.get()); } catch (e) { /* ignore */ }
      }

      if (step.freeze) {
        this._wasPaused = this.adapter.isPaused();
        if (this.adapter.actions.pause) this.adapter.actions.pause();
      }

      if (this.adapter.setLocked) {
        try { this.adapter.setLocked(!!step.allow); } catch (e) { /* ignore */ }
      }

      this.overlay.applyHighlightAndGating(step);
      this.render(step);
      this.emit('guided:step', { experimentId: this.experiment.id, step, index });
    }

    render(step) {
      const isModal = step.type === 'message' || step.type === 'predict'
        || step.type === 'checkpoint' || step.type === 'conclusion';
      const handlers = {
        onBack: () => this.back(),
        onNext: () => this.next(),
        onSkip: () => this.skip(),
        onExit: () => this.exit(),
        onHint: () => this.overlay.revealHint(),
        onAnswer: (choice) => this.answer(choice, step),
      };
      const showNext = step.advance === 'on-next'
        || (step.advance === 'on-answer' && this.answers[step.id] != null);
      this.overlay.setHud({
        title: this.experiment.title,
        index: this.index,
        total: this.experiment.steps.length,
        hint: step.hint,
        showNext,
        showSkip: true,
      }, handlers);
      this.overlay.showStep(step, isModal ? 'modal' : 'card', handlers);
      this.updateProgress();
    }

    updateProgress() {
      this.onUpdate(this.getProgress());
    }

    answer(choice, step) {
      this.answers[step.id] = choice.id;
      this._answered = true;
      const correct = choice.correct === true;
      const feedback = step.feedback || {};
      const text = correct
        ? (feedback.correct || 'Correct.')
        : (feedback.any || 'Not quite \u2014 check the explanation.');
      this.overlay.showFeedback(text, correct ? 'correct' : 'info');
      if (step.advance === 'on-answer') {
        this.overlay.enableNext();
      } else if (step.advance === 'on-condition' && choice.correct) {
        setTimeout(() => { if (this.step === step) this.next(); }, 500);
      }
    }

    /** Called by the simulation loop via app.guidedTick. */
    tick(dt) {
      if (!this.running || !this.step) return;
      this.stepElapsed += dt;
      const step = this.step;
      this.updateSettles(step);
      if (step.advance === 'on-condition' && step.when) {
        if (this.checkWhen(step)) {
          this.overlay.setCardStatus('Done', true);
          this.next();
        }
      }
    }

    updateSettles(step) {
      const names = settleStates(step.when);
      if (!names.length) return;
      for (const name of names) {
        const fn = this.adapter.state[name];
        if (!fn) continue;
        const arr = this._samples[name] || (this._samples[name] = []);
        arr.push({ t: this.stepElapsed, v: Number(fn()) });
        const window = 1.2;
        while (arr.length > 2 && arr[0].t < this.stepElapsed - window) arr.shift();
        const span = arr.length ? arr[arr.length - 1].t - arr[0].t : 0;
        const values = arr.map(s => s.v);
        const min = Math.min(...values), max = Math.max(...values);
        const range = max - min;
        const tol = step.when && step.when.tolerance != null
          ? step.when.tolerance
          : Math.max(0.02, Math.abs((min + max) / 2) * 0.02);
        this._settle = this._settle || {};
        this._settle[name] = { settled: arr.length >= 6 && span >= 0.8 && range <= tol, range, span };
      }
    }

    checkWhen(step) {
      const when = step.when;
      if (!when) return false;
      if (when.minElapsed && this.stepElapsed < when.minElapsed) return false;
      return evalWhen(when, {
        adapter: this.adapter,
        baseline: this.baseline,
        settle: this._settle || {},
        lastAction: this.lastAction,
        elapsed: this.stepElapsed,
        answers: this.answers,
      });
    }

    /** Notify the runner that a semantic action was invoked. */
    noteAction(name) {
      this.lastAction = name;
      if (this.step && this.step.advance === 'on-condition' && this.step.when) {
        if (this.checkWhen(this.step)) this.next();
      }
    }

    next() {
      if (!this.running) return;
      const step = this.step;
      if (step && step.freeze) this.restorePause();
      if (this.index + 1 >= this.experiment.steps.length) return this.complete();
      this.enter(this.index + 1);
    }

    back() {
      if (!this.running || this.index <= 0) return;
      const step = this.step;
      if (step && step.freeze) this.restorePause();
      this.enter(this.index - 1);
    }

    skip() {
      if (!this.running) return;
      this.next();
    }

    goTo(id) {
      const idx = this.experiment.steps.findIndex(s => s.id === id);
      if (idx >= 0) this.enter(idx);
    }

    restorePause() {
      if (this._wasPaused === false && this.adapter.actions.resume) this.adapter.actions.resume();
      this._wasPaused = null;
    }

    complete() {
      this.running = false;
      if (this.app) this.app.guidedTick = null;
      Guided._runner = null;
      this.overlay.clearGating();
      this.overlay.clearStep();
      this.overlay.toast('Guided experiment complete');
      this.emit('guided:complete', { experimentId: this.experiment.id, answers: this.answers });
      this.onComplete(this.getProgress());
    }

    exit(silent) {
      if (!this.running) return;
      const step = this.step;
      if (step && step.freeze) this.restorePause();
      this.running = false;
      if (this.app) this.app.guidedTick = null;
      Guided._runner = null;
      if (this.adapter.setLocked) { try { this.adapter.setLocked(false); } catch (e) { /* ignore */ } }
      this.overlay.clearGating();
      this.overlay.clearStep();
      this.emit('guided:exit', { experimentId: this.experiment.id });
      if (!silent) this.onExit(this.getProgress());
    }

    getProgress() {
      return {
        experimentId: this.experiment.id,
        stepIndex: this.index,
        total: this.experiment.steps.length,
        answers: Object.assign({}, this.answers),
        completed: !this.running && this.index >= this.experiment.steps.length - 1,
      };
    }

    emit(type, payload) {
      if (this.app && this.app.bus) this.app.bus.emit(type, payload);
    }
  }
  Guided.Runner = Runner;

  /* ================================================================
   * Launcher
   * ================================================================ */

  class Launcher {
    constructor(host, experiments, onStart) {
      this.experiments = experiments;
      this.onStart = onStart;
      this.el = el('div', 'guided-launcher');

      this.button = el('button', 'guided-launcher__toggle');
      this.button.type = 'button';
      this.button.innerHTML = '<span class="guided-launcher__icon" aria-hidden="true">\u25B6</span> Guided Experiments';
      this.button.setAttribute('aria-expanded', 'false');

      this.panel = el('div', 'guided-launcher__panel');
      this.panel.hidden = true;
      this.panel.setAttribute('role', 'menu');

      this.panel.appendChild(el('div', 'guided-launcher__heading',
        'Choose a guided experiment'));

      const list = el('div', 'guided-launcher__list');
      this.experiments.forEach((exp) => list.appendChild(this._card(exp)));
      this.panel.appendChild(list);

      this.button.addEventListener('click', () => this.toggle());
      this.el.appendChild(this.button);
      this.el.appendChild(this.panel);
      host.appendChild(this.el);
    }

    _card(exp) {
      const card = el('button', 'guided-card-btn');
      card.type = 'button';
      card.setAttribute('role', 'menuitem');
      const meta = [];
      if (exp.subject) meta.push(exp.subject);
      if (exp.minutes) meta.push('~' + exp.minutes + ' min');
      meta.push(exp.steps.length + ' steps');
      card.innerHTML =
        '<span class="guided-card-btn__title">' + escapeHtml(exp.title) + '</span>' +
        (exp.summary ? '<span class="guided-card-btn__summary">' + richText(exp.summary) + '</span>' : '') +
        '<span class="guided-card-btn__meta">' + escapeHtml(meta.join(' \u00b7 ')) + '</span>';
      card.addEventListener('click', () => {
        this.close();
        this.onStart(exp);
      });
      return card;
    }

    toggle() { this.panel.hidden ? this.open() : this.close(); }

    open() {
      this.panel.hidden = false;
      this.button.setAttribute('aria-expanded', 'true');
      document.addEventListener('keydown', this._esc = (e) => { if (e.key === 'Escape') this.close(); });
    }

    close() {
      this.panel.hidden = true;
      this.button.setAttribute('aria-expanded', 'false');
      if (this._esc) document.removeEventListener('keydown', this._esc);
    }

    destroy() { this.close(); this.el.remove(); }
  }
  Guided.Launcher = Launcher;

  /* ================================================================
   * mount()
   * ================================================================ */

  /**
   * Wire a simulation page for guided experiments.
   *
   * @param {object} opts
   * @param {object} opts.app          SimLib app from SimLib.attach
   * @param {object} opts.adapter      from Guided.adapter
   * @param {Array}  opts.experiments  from Guided.define
   * @param {string|HTMLElement} [opts.launcherMount]  where the launcher lives
   * @param {HTMLElement} [opts.overlayRoot]           where the overlay lives
   * @returns {{launcher: Launcher, start: Function}}
   */
  Guided.mount = function mount(opts) {
    const app = opts.app;
    const adapter = opts.adapter;
    const experiments = opts.experiments || [];
    if (!app || !adapter) throw new Error('Guided.mount requires { app, adapter }');
    if (!experiments.length) return null;

    const overlayRoot = opts.overlayRoot
      || app.canvas.closest('.sim-main')
      || app.canvas.parentElement;
    if (getComputedStyle(overlayRoot).position === 'static') {
      overlayRoot.style.position = 'relative';
    }

    const overlay = new Overlay(overlayRoot, adapter);

    let runner = null;
    let activeExp = null;

    const launcherHost = opts.launcherMount
      ? (typeof opts.launcherMount === 'string'
        ? document.querySelector(opts.launcherMount)
        : opts.launcherMount)
      : (document.querySelector('.sim-page-header .container') || overlayRoot);

    const launcher = new Launcher(launcherHost, experiments, (exp) => start(exp));

    function start(exp) {
      if (runner) runner.exit(true);
      activeExp = exp;
      runner = new Runner({
        experiment: exp,
        adapter,
        app,
        overlay,
        onExit: () => { runner = null; activeExp = null; },
      });
      runner.start();
    }

    return {
      launcher,
      overlay,
      start,
      get runner() { return runner; },
      get activeExperiment() { return activeExp; },
    };
  };

  global.SimLib.Guided = Guided;
})(this);
