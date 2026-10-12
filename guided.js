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
  if (!SimLib) throw new Error('SimLib.Guided requires library.js to be loaded first');

  const Guided = {};
  Guided.version = '1.3.0';

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
      if (s.question && (!SimLib.CFU || !['lesson', 'both'].includes(s.question.use))) {
        throw new Error('Guided.define: checkpoint question requires CFU and a lesson/both tag');
      }
      if (s.question && s.type !== 'checkpoint') throw new Error('Guided.define: questions belong in checkpoints');
      const type = s.type || 'message';
      if (!STEP_TYPES.includes(type)) {
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
    if (typeof when.fn === 'function') return Boolean(when.fn(ctx));

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

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function button(text, cls, handler) {
    const node = el('button', cls, text);
    node.type = 'button';
    if (handler) node.addEventListener('click', handler);
    return node;
  }

  // Build restricted Markdown as DOM nodes, never interpreting content as HTML.
  function appendInline(parent, text) {
    const tokens = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
    let offset = 0;
    for (const match of String(text).matchAll(tokens)) {
      parent.append(document.createTextNode(text.slice(offset, match.index)));
      let node;
      if (match[1] !== undefined) node = el('strong', '', match[1]);
      else if (match[2] !== undefined) node = el('em', '', match[2]);
      else if (match[3] !== undefined) node = el('code', '', match[3]);
      else {
        // Allow web/mail links and relative URLs, but never executable schemes.
        const href = match[5];
        const safe = /^(https?:|mailto:)/i.test(href)
          || (!/[:\\\u0000-\u0020]/.test(href) && !href.startsWith('//'));
        node = el(safe ? 'a' : 'span', '', match[4]);
        if (safe) {
          node.setAttribute('href', href);
          node.setAttribute('target', '_blank');
          node.setAttribute('rel', 'noopener noreferrer');
        }
      }
      parent.append(node);
      offset = match.index + match[0].length;
    }
    parent.append(document.createTextNode(text.slice(offset)));
  }

  function richNode(tag, cls, text) {
    const node = el(tag, cls);
    let paragraph = null;
    let list = null;
    for (const line of String(text || '').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) { paragraph = null; list = null; continue; }
      const bullet = trimmed.match(/^[-*]\s+(.*)$/);
      if (bullet) {
        paragraph = null;
        if (!list) { list = el('ul'); node.append(list); }
        const item = el('li');
        appendInline(item, bullet[1]);
        list.append(item);
      } else {
        list = null;
        if (!paragraph) { paragraph = el('p'); node.append(paragraph); }
        else paragraph.append(el('br'));
        appendInline(paragraph, line);
      }
    }
    return node;
  }

  function setRichText(node, text) {
    const content = richNode('div', '', text);
    node.replaceChildren(...content.childNodes);
  }

  class Overlay {
    constructor(root, adapter) {
      this.root = root;
      this.adapter = adapter;
      this.root.classList.add('guided-layer');

      this.hud = el('div', 'guided-hud');
      this.hud.hidden = true;
      const left = el('div', 'guided-hud__left');
      const title = el('span', 'guided-hud__title');
      title.setAttribute('data-title', '');
      left.append(el('span', 'guided-hud__badge', 'Guided'), title);
      const dots = el('div', 'guided-hud__dots');
      dots.setAttribute('data-dots', '');
      dots.setAttribute('aria-hidden', 'true');
      const count = el('div', 'guided-hud__steps');
      count.setAttribute('data-count', '');
      const actions = el('div', 'guided-hud__actions');
      for (const name of ['back', 'restart', 'hint', 'next', 'skip', 'exit']) {
        let variant = 'ghost';
        if (name === 'next') variant = 'primary';
        else if (name === 'exit') variant = 'exit';
        const btn = button(name[0].toUpperCase() + name.slice(1), `guided-btn guided-btn--${variant}`);
        btn.setAttribute(`data-${name}`, '');
        btn.hidden = name === 'hint' || name === 'next';
        if (name === 'exit') btn.setAttribute('aria-label', 'Exit guided experiment');
        actions.append(btn);
      }
      this.hud.append(left, dots, count, actions);
      this.root.appendChild(this.hud);

      this.spotlight = el('div', 'guided-spotlight');
      this.spotlight.hidden = true;
      this.root.appendChild(this.spotlight);

      this.card = el('div', 'guided-card');
      this.card.hidden = true;
      this.root.appendChild(this.card);

      this.modalWrap = el('div', 'guided-modal-wrap');
      this.modalWrap.hidden = true;
      // HUD and panel share a dialog scope, so lesson navigation stays reachable.
      this.modalWrap.setAttribute('role', 'dialog');
      this.modalWrap.setAttribute('aria-modal', 'true');
      this.modalWrap.setAttribute('aria-labelledby', 'guided-modal-title');
      this.modalWrap.setAttribute('aria-describedby', 'guided-modal-desc');
      const backdrop = el('div', 'guided-backdrop');
      backdrop.setAttribute('data-backdrop', '');
      const modal = el('div', 'guided-modal');
      const body = el('div', 'guided-modal__body');
      body.setAttribute('data-body', '');
      const footer = el('div', 'guided-modal__footer');
      footer.setAttribute('data-footer', '');
      modal.append(body, footer);
      this.modalWrap.append(backdrop, modal);
      this.root.appendChild(this.modalWrap);

      this.toastEl = el('div', 'guided-toast');
      this.toastEl.hidden = true;
      this.root.appendChild(this.toastEl);

      // Region semantics + a polite live region that announces step changes.
      this.root.setAttribute('role', 'region');
      this.root.setAttribute('aria-label', 'Guided experiment');
      this.live = el('div', 'guided-sr-only');
      this.live.setAttribute('aria-live', 'polite');
      this.live.setAttribute('aria-atomic', 'true');
      this.root.appendChild(this.live);

      this._callouts = [];
      this._modalMode = null;
      this._preModalFocus = null;
      this.onEscape = null;

      this._listeners = [];
      this._reposition = () => this.reposition();
      global.addEventListener('resize', this._reposition);
      document.addEventListener('fullscreenchange', this._reposition);
      document.addEventListener('webkitfullscreenchange', this._reposition);

      // One document-level key handler: modal-aware Escape + focus trap.
      this._onKeydown = (e) => {
        if (this.modalWrap.hidden) {
          if (e.key === 'Escape' && this.onEscape) this.onEscape();
          return;
        }
        if (e.key === 'Escape') {
          if (this._modalMode === 'complete') {
            if (this.onEscape) this.onEscape();
            return;
          }
          const btn = (this._modalNextBtn && !this._modalNextBtn.disabled)
            ? this._modalNextBtn
            : this.modalWrap.querySelector('.guided-btn:not([disabled])');
          if (btn) btn.click();
          else if (this.onEscape) this.onEscape();
          return;
        }
        if (e.key === 'Tab') this._trapFocus(e);
      };
      document.addEventListener('keydown', this._onKeydown);
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
      dots.replaceChildren();
      for (let i = 0; i < state.total; i++) {
        const d = el('span', 'guided-dot');
        if (i < state.index) d.classList.add('is-done');
        else if (i === state.index) d.classList.add('is-current');
        dots.appendChild(d);
      }
      const back = this.hud.querySelector('[data-back]');
      back.hidden = false;
      back.disabled = state.index === 0;
      const hint = this.hud.querySelector('[data-hint]');
      hint.hidden = !state.hint;
      const nextBtn = this.hud.querySelector('[data-next]');
      nextBtn.hidden = !state.showNext;
      this.hud.querySelector('[data-skip]').hidden = !state.showSkip;
      this._hintText = state.hint || '';
      this.live.textContent =
        (state.title ? state.title + '. ' : '') + 'Step ' + (state.index + 1) + ' of ' + state.total;

      // bind once (idempotent: replace handlers each render)
      handlers = handlers || {};
      this._bindHud('data-back', handlers.onBack);
      this._bindHud('data-restart', handlers.onRestart);
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
      this._modalNextBtn = null;
      if (mode === 'modal') {
        this.card.hidden = true;
        if (this.modalWrap.hidden) this._preModalFocus = document.activeElement;
        this.modalWrap.hidden = false;
        this.modalWrap.append(this.hud);
        this._modalMode = 'step';
        const body = this.modalWrap.querySelector('[data-body]');
        const footer = this.modalWrap.querySelector('[data-footer]');
        body.replaceChildren(this._stepContent(step, 'modal'));
        footer.replaceChildren();
        if (step.question) {
          body.append(el('p', '', 'Practice check — not part of your standalone score.'));
          SimLib.CFU.renderQuestion(body, step.question, {
            answer: handlers.answer,
            onSubmit: handlers.onSubmit,
            onContinue: handlers.onNext,
          });
        } else {
          this._renderChoices(step, body, handlers);
          this._renderFooter(step, footer, handlers);
        }
        this._reserveHudSpace();
        const focusable = this.modalWrap.querySelector('.guided-choice, .cfu-choice input:not([disabled]), .cfu-button:not([disabled]), [data-footer] .guided-btn');
        if (focusable) focusable.focus();
      } else {
        const leavingDialog = !this.modalWrap.hidden;
        this.root.append(this.hud);
        this.modalWrap.hidden = true;
        this._modalMode = null;
        this.card.hidden = false;
        const body = el('div', 'guided-card__body');
        body.append(this._stepContent(step, 'card'));
        this.card.replaceChildren(body);
        if (step.advance === 'on-next') {
          const footer = el('div', 'guided-card__footer');
          const next = button('Next', 'guided-btn guided-btn--primary', handlers.onNext);
          next.setAttribute('data-card-next', '');
          footer.append(next);
          this.card.append(footer);
        } else {
          const status = el('div', 'guided-card__status', this._waitingLabel(step));
          status.setAttribute('data-card-status', '');
          this.card.append(status);
        }
        if (leavingDialog) {
          const allowed = this.adapter.elementFor((step.allow || step.highlight || [])[0]);
          const focus = allowed || this.hud.querySelector('[data-restart]');
          if (focus) focus.focus();
        }
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

    _stepContent(step, mode) {
      const content = el('div');
      const title = richNode('h3', 'guided-step__title', step.title || 'Guided experiment');
      const body = richNode('div', 'guided-step__body', step.body);
      if (mode === 'modal') {
        title.id = 'guided-modal-title';
        body.id = 'guided-modal-desc';
      }
      const hint = el('div', 'guided-step__hint');
      hint.setAttribute('data-hint-text', '');
      hint.hidden = true;
      content.append(title, body, hint);
      return content;
    }

    _reserveHudSpace() {
      if (this.modalWrap.hidden) return;
      this.modalWrap.style.paddingTop = `${this.hud.offsetHeight + 26}px`;
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
      setRichText(fb, text);
      fb.setAttribute('role', 'status');
      fb.className = 'guided-feedback is-' + (tone || 'info');
      fb.hidden = false;
    }

    revealHint() {
      const panel = this.modalWrap.hidden ? this.card : this.modalWrap;
      const node = panel.querySelector('[data-hint-text]');
      if (node && this._hintText) {
        setRichText(node, this._hintText);
        node.hidden = false;
        node.setAttribute('role', 'status');
      }
    }

    _renderFooter(step, footer, handlers) {
      const needsNext = step.advance === 'on-next' || step.advance === 'on-answer';
      if (!needsNext) return;
      const answered = this._answered;
      const btn = el('button', 'guided-btn guided-btn--primary');
      btn.type = 'button';
      btn.textContent = 'Next';
      if (step.advance === 'on-next' && step.type === 'conclusion') btn.textContent = 'Finish';
      else if (step.advance === 'on-answer' && step.type === 'checkpoint') btn.textContent = 'Continue';
      if (step.advance === 'on-answer' && !answered) btn.disabled = true;
      btn.addEventListener('click', handlers.onNext);
      footer.appendChild(btn);
      this._modalNextBtn = btn;
    }

    /** Enable the modal's Next button after a `predict`/`checkpoint` answer. */
    enableNext() {
      if (this._modalNextBtn) this._modalNextBtn.disabled = false;
    }

    /** Completion recap with a Restart action. */
    showComplete(experiment, answers, handlers) {
      this.hud.hidden = false;
      for (const name of ['back', 'next', 'skip', 'hint']) {
        this.hud.querySelector(`[data-${name}]`).hidden = true;
      }
      this._bindHud('data-restart', handlers.onRestart);
      this._bindHud('data-exit', handlers.onExit);
      this.hud.querySelector('[data-count]').textContent = 'Complete';
      this.card.hidden = true;
      this.spotlight.hidden = true;
      this._clearCallouts();
      if (this.modalWrap.hidden) this._preModalFocus = document.activeElement;
      this.modalWrap.hidden = false;
      this.modalWrap.append(this.hud);
      this._modalMode = 'complete';
      this._modalNextBtn = null;

      const body = this.modalWrap.querySelector('[data-body]');
      const footer = this.modalWrap.querySelector('[data-footer]');
      body.replaceChildren(this._stepContent({
        title: 'Experiment complete', body: experiment.title,
      }, 'modal'));
      const recap = el('ul', 'guided-recap');
      for (const step of experiment.steps) {
        if (step.question && answers[step.id] != null) {
          const item = el('li', 'guided-recap__item');
          item.append(el('div', 'guided-recap__q', step.question.prompt),
            el('span', 'guided-recap__result', 'Practice completed (not scored)'));
          recap.append(item);
          continue;
        }
        if (!step.choices || answers[step.id] == null) continue;
        const chosen = step.choices.find((c) => c.id === answers[step.id]);
        if (!chosen) continue;
        const item = el('li', 'guided-recap__item');
        if (chosen.correct === true) item.classList.add('is-correct');
        item.append(
          richNode('div', 'guided-recap__q', step.title || 'Your answer'),
          el('span', 'guided-recap__a', chosen.label),
          el('span', 'guided-recap__result', chosen.correct === true ? 'Correct prediction' : 'Your prediction'),
        );
        recap.append(item);
      }
      if (recap.children.length) body.append(recap);

      footer.replaceChildren();
      const restart = el('button', 'guided-btn guided-btn--ghost');
      restart.type = 'button';
      restart.textContent = 'Restart';
      restart.addEventListener('click', handlers.onRestart);
      const done = el('button', 'guided-btn guided-btn--primary');
      done.type = 'button';
      done.textContent = 'Done';
      done.addEventListener('click', handlers.onExit);
      footer.appendChild(restart);
      footer.appendChild(done);
      this._reserveHudSpace();
      done.focus();
      this.live.textContent = 'Experiment complete';
    }

    setCardStatus(text, done) {
      const status = this.card && this.card.querySelector('[data-card-status]');
      if (!status) return;
      status.textContent = text;
      status.classList.toggle('is-done', !!done);
    }

    toast(message, ms) {
      setRichText(this.toastEl, message);
      this.toastEl.hidden = false;
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => { this.toastEl.hidden = true; }, ms || 2200);
    }

    clearStep() {
      this.root.append(this.hud);
      this.hud.hidden = true;
      this.modalWrap.hidden = true;
      this.card.hidden = true;
      this.spotlight.hidden = true;
      this._modalMode = null;
      this._modalNextBtn = null;
      this._clearCallouts();
      if (this._preModalFocus && this._preModalFocus.focus) {
        try { this._preModalFocus.focus(); } catch { /* ignore */ }
      }
      this._preModalFocus = null;
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
        if (node._guidedPrevInert !== undefined && 'inert' in node) {
          node.inert = node._guidedPrevInert;
          delete node._guidedPrevInert;
        }
        if (allow && !allow.includes(this._nameOf(node))) {
          node.classList.add('guided-gated');
          if ('disabled' in node) {
            node._guidedPrevDisabled = node.disabled;
            node.disabled = true;
          }
          // `inert` removes gated controls from the tab order where supported.
          if ('inert' in node) {
            node._guidedPrevInert = node.inert;
            node.inert = true;
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
        this.spotlight.replaceChildren();
        const spot = el('div', 'guided-spot');
        this.spotlight.appendChild(spot);
        this._spotNode = spot;
      } else {
        this._spotNode = null;
      }

      // Auto-callouts: one anchored bubble per highlighted target, showing the
      // step's title/body. Purely additive; the step card still explains it.
      this._clearCallouts();
      if (step.title || step.body) {
        for (const anchor of this._spotTargets) {
          const callout = new Callout(step);
          this.root.appendChild(callout.el);
          this._callouts.push({ callout, anchor });
        }
      }

      this.reposition();
    }

    _clearCallouts() {
      if (!this._callouts) { this._callouts = []; return; }
      for (const item of this._callouts) item.callout.destroy();
      this._callouts = [];
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
        if (node._guidedPrevInert !== undefined && 'inert' in node) {
          node.inert = node._guidedPrevInert;
          delete node._guidedPrevInert;
        }
      }
      this.spotlight.hidden = true;
      this._spotNode = null;
      this._clearCallouts();
    }

    /** Reposition the spotlight and callouts after a resize / fullscreen change. */
    reposition() {
      this.positionCard();
      this._reserveHudSpace();
      const rootRect = this.root.getBoundingClientRect();
      if (this._spotNode && this._spotTargets && this._spotTargets.length) {
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
      if (this._callouts && this._callouts.length) {
        for (const item of this._callouts) {
          const rect = this._anchorRect(item.anchor);
          if (rect) item.callout.position(rect, rootRect);
        }
      }
    }

    /** Client-space rect for a spotlight/callout anchor ({kind, target|el}). */
    _anchorRect(anchor) {
      if (anchor.kind === 'dom') {
        const r = anchor.el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      }
      const canvas = this.adapter.sim.canvas;
      const t = anchor.target;
      if (!canvas || !t) return null;
      if (t.w != null && t.h != null) {
        const p1 = SimLib.CanvasUtils.logicalToCss(canvas, t.x, t.y);
        const p2 = SimLib.CanvasUtils.logicalToCss(canvas, t.x + t.w, t.y + t.h);
        return { left: p1.x, top: p1.y, right: p2.x, bottom: p2.y, width: p2.x - p1.x, height: p2.y - p1.y };
      }
      const p = SimLib.CanvasUtils.logicalToCss(canvas, t.x, t.y);
      const radius = this._canvasRadius(t.r || 16);
      return { left: p.x - radius, top: p.y - radius, right: p.x + radius, bottom: p.y + radius, width: radius * 2, height: radius * 2 };
    }

    /** Keep keyboard focus inside an open modal. */
    _trapFocus(e) {
      const nodes = this.modalWrap.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      const list = Array.prototype.filter.call(nodes, (n) => n.offsetParent !== null || n === document.activeElement);
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      const inside = this.modalWrap.contains(document.activeElement);
      if (e.shiftKey && (!inside || document.activeElement === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
        e.preventDefault();
        first.focus();
      }
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
      document.removeEventListener('keydown', this._onKeydown);
      this.clearGating();
      this.root.remove();
    }
  }
  /**
   * A small anchored bubble pointing at a highlighted control or canvas target.
   * Positioning is relative to the overlay root; `placement` may be
   * 'auto' | 'top' | 'bottom' | 'left' | 'right'.
   */
  class Callout {
    constructor(content, placement) {
      this.placement = placement || 'auto';
      this.el = el('div', 'guided-callout');
      const wrap = el('div', 'guided-callout__content');
      if (typeof content === 'string') wrap.append(richNode('div', 'guided-callout__body', content));
      else {
        if (content.title) wrap.append(richNode('div', 'guided-callout__title', content.title));
        if (content.body) wrap.append(richNode('div', 'guided-callout__body', content.body));
      }
      const arrow = el('span', 'guided-callout__arrow');
      arrow.setAttribute('aria-hidden', 'true');
      this.el.append(wrap, arrow);
    }

    /** anchorRect/rootRect are client rects ({left, top, right, bottom, width, height}). */
    position(anchorRect, rootRect) {
      const a = anchorRect;
      const cw = this.el.offsetWidth || 240;
      const ch = this.el.offsetHeight || 60;
      const gap = 12;
      const spaceAbove = a.top - rootRect.top;
      const spaceBelow = rootRect.bottom - a.bottom;
      const spaceRight = rootRect.right - a.right;

      let placement = this.placement;
      if (placement === 'auto') {
        if (spaceBelow >= ch + gap) placement = 'bottom';
        else if (spaceAbove >= ch + gap) placement = 'top';
        else if (spaceRight >= cw + gap) placement = 'right';
        else placement = 'left';
      }

      const anchorCenterX = a.left - rootRect.left + a.width / 2;
      const anchorCenterY = a.top - rootRect.top + a.height / 2;
      let left;
      let top;
      if (placement === 'top' || placement === 'bottom') {
        left = anchorCenterX - cw / 2;
        top = placement === 'top'
          ? (a.top - rootRect.top) - ch - gap
          : (a.bottom - rootRect.top) + gap;
      } else {
        top = anchorCenterY - ch / 2;
        left = placement === 'left'
          ? (a.left - rootRect.left) - cw - gap
          : (a.right - rootRect.left) + gap;
      }

      left = Math.max(6, Math.min(left, Math.max(6, rootRect.width - cw - 6)));
      top = Math.max(6, Math.min(top, Math.max(6, rootRect.height - ch - 6)));

      const arrowX = Math.max(14, Math.min(anchorCenterX - left, cw - 14));
      const arrowY = Math.max(14, Math.min(anchorCenterY - top, ch - 14));

      this.el.dataset.placement = placement;
      this.el.style.left = left + 'px';
      this.el.style.top = top + 'px';
      this.el.style.setProperty('--guided-arrow-x', arrowX + 'px');
      this.el.style.setProperty('--guided-arrow-y', arrowY + 'px');
    }

    destroy() {
      this.el.remove();
    }
  }
  Guided.Callout = Callout;

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

    /** Re-apply setup and return to the first step, keeping the lesson open. */
    restart() {
      if (!this.running) { this.start(0); return; }
      const step = this.step;
      if (step && step.freeze) this.restorePause();
      this.answers = {};
      this.applySetup();
      this.enter(0);
      this.emit('guided:restart', { experimentId: this.experiment.id });
    }

    /** Escape from the page: exit a running lesson, or dismiss the recap. */
    handleEscape() {
      if (!this.running) { this.dismiss(); return; }
      this.exit();
    }

    /** Tear down the completion recap without an active run. */
    dismiss() {
      this.overlay.clearStep();
      this.onExit(this.getProgress());
    }

    applySetup() {
      const setup = this.experiment.setup;
      this.baseline = {};
      for (const [name, c] of Object.entries(this.adapter.controls)) {
        try { this.baseline[name] = Number(c.get()); } catch { /* ignore */ }
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
        try { this.baseline[name] = Number(c.get()); } catch { /* ignore */ }
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
        try { this.baseline[name] = Number(c.get()); } catch { /* ignore */ }
      }

      if (step.freeze) {
        this._wasPaused = this.adapter.isPaused();
        if (this.adapter.actions.pause) this.adapter.actions.pause();
      }

      if (this.adapter.setLocked) {
        try { this.adapter.setLocked(Boolean(step.allow)); } catch { /* ignore */ }
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
        onRestart: () => this.restart(),
        onSkip: () => this.skip(),
        onExit: () => this.exit(),
        onHint: () => this.overlay.revealHint(),
        onAnswer: (choice) => this.answer(choice, step),
        answer: step.question ? this.answers[step.id] : null,
        onSubmit: selection => {
          if (this.answers[step.id] != null) return;
          this.answers[step.id] = [...selection];
          this._answered = true;
          this.updateProgress();
        },
      };
      const showNext = !step.question && (step.advance === 'on-next'
        || (step.advance === 'on-answer' && this.answers[step.id] != null));
      this.overlay.setHud({
        title: this.experiment.title,
        index: this.index,
        total: this.experiment.steps.length,
        hint: step.hint,
        showNext,
        showSkip: true,
        showRestart: true,
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
      if (step && step.question && this.answers[step.id] == null) return;
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
      if (this.step && this.step.question) {
        if (this.step.freeze) this.restorePause();
        this.enter(this.index + 1);
      } else this.next();
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
      this.emit('guided:complete', { experimentId: this.experiment.id, answers: this.answers });
      this.onComplete(this.getProgress());
      this.overlay.showComplete(this.experiment, this.answers, {
        onRestart: () => this.restart(),
        onExit: () => this.dismiss(),
      });
    }

    exit(silent) {
      if (!this.running) { this.dismiss(); return; }
      const step = this.step;
      if (step && step.freeze) this.restorePause();
      this.running = false;
      if (this.app) this.app.guidedTick = null;
      Guided._runner = null;
      if (this.adapter.setLocked) { try { this.adapter.setLocked(false); } catch { /* ignore */ } }
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
      const icon = el('span', 'guided-launcher__icon', '\u25B6');
      icon.setAttribute('aria-hidden', 'true');
      this.button.append(icon, document.createTextNode(' Guided Experiments'));
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
      card.append(el('span', 'guided-card-btn__title', exp.title));
      if (exp.summary) card.append(richNode('span', 'guided-card-btn__summary', exp.summary));
      card.append(el('span', 'guided-card-btn__meta', meta.join(' \u00b7 ')));
      card.addEventListener('click', () => {
        this.close();
        this.onStart(exp);
      });
      return card;
    }

    toggle() {
      if (this.panel.hidden) this.open();
      else this.close();
    }

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

    let launcherHost = document.querySelector('.sim-page-header .container') || overlayRoot;
    if (typeof opts.launcherMount === 'string') launcherHost = document.querySelector(opts.launcherMount);
    else if (opts.launcherMount) launcherHost = opts.launcherMount;

    const launcher = new Launcher(launcherHost, experiments, (exp) => start(exp));

    function start(exp) {
      if (opts.beforeStart) opts.beforeStart();
      if (runner) runner.exit(true);
      activeExp = exp;
      runner = new Runner({
        experiment: exp,
        adapter,
        app,
        overlay,
        onExit: () => { runner = null; activeExp = null; },
      });
      overlay.onEscape = () => { if (runner) runner.handleEscape(); };
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
