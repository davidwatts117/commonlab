// Small DOM double for Node unit tests, not a browser/layout emulator.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export function makeDocument() {
  const doc = {
    activeElement: null,
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      this.listeners[type] = (this.listeners[type] || []).filter(item => item !== fn);
    },
    createTextNode(text) { return makeNode(null, text); },
    createDocumentFragment() { const node = makeNode(null); node.nodeType = 11; return node; },
    createElement(tag) { return makeNode(tag); },
    createElementNS(namespace, tag) { const node = makeNode(tag); node.namespaceURI = namespace; return node; },
    querySelector() { return null; },
  };
  function makeNode(tag, text = '') {
    const node = {
      ownerDocument: doc,
      tagName: tag ? tag.toUpperCase() : null,
      className: '', attrs: {}, listeners: {}, childNodes: [], parentElement: null,
      hidden: false, disabled: false, inert: false, dataset: {},
      style: { setProperty(key, value) { this[key] = value; } },
      _text: String(text),
      get children() { return this.childNodes.filter(child => child.tagName); },
      get textContent() { return this._text + this.childNodes.map(child => child.textContent).join(''); },
      set textContent(value) { this.replaceChildren(); this._text = String(value); },
      // Fail immediately if rendering regresses to HTML assignment.
      set innerHTML(_value) { throw new Error('HTML assignment is forbidden'); },
      get classList() {
        const classes = () => new Set(this.className.split(/\s+/).filter(Boolean));
        return {
          add: (...names) => { this.className = [...new Set([...classes(), ...names])].join(' '); },
          remove: (...names) => { this.className = [...classes()].filter(c => !names.includes(c)).join(' '); },
          contains: name => classes().has(name),
          toggle: (name, force) => {
            const set = classes();
            const on = force === undefined ? !set.has(name) : force;
            if (on) set.add(name); else set.delete(name);
            this.className = [...set].join(' ');
          },
        };
      },
      append(...children) {
        for (const child of children) {
          if (child.nodeType === 11) { this.append(...child.childNodes); continue; }
          child.remove();
          this.childNodes.push(child);
          child.parentElement = this;
        }
      },
      appendChild(child) { this.append(child); return child; },
      replaceChildren(...children) {
        for (const child of [...this.childNodes]) child.remove();
        this._text = '';
        this.append(...children);
      },
      remove() {
        if (this.parentElement) {
          this.parentElement.childNodes = this.parentElement.childNodes.filter(child => child !== this);
        }
        this.parentElement = null;
      },
      contains(child) { return child === this || this.childNodes.some(item => item.contains(child)); },
      setAttribute(key, value) { this.attrs[key] = String(value); },
      getAttribute(key) { return this.attrs[key]; },
      addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
      removeEventListener(type, fn) {
        this.listeners[type] = (this.listeners[type] || []).filter(item => item !== fn);
      },
      click() { if (!this.disabled) for (const fn of this.listeners.click || []) fn(); },
      focus() { doc.activeElement = this; },
      get offsetParent() {
        let ancestor = this;
        while (ancestor) { if (ancestor.hidden) return null; ancestor = ancestor.parentElement; }
        return this.parentElement;
      },
      offsetWidth: 240, offsetHeight: 60,
      getBoundingClientRect() { return { left: 0, top: 0, right: 600, bottom: 700, width: 600, height: 700 }; },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      querySelectorAll(selector) {
        const results = [];
        function matches(item, simple) {
          if (!item.tagName) return false;
          if (simple.includes(':not([disabled])') && item.disabled) return false;
          simple = simple.replace(':not([disabled])', '');
          if (simple.includes(':not([tabindex="-1"])') && item.attrs.tabindex === '-1') return false;
          simple = simple.replace(':not([tabindex="-1"])', '');
          const tagMatch = simple.match(/^[a-z]+/i);
          if (tagMatch && item.tagName !== tagMatch[0].toUpperCase()) return false;
          for (const match of simple.matchAll(/\.([\w-]+)/g)) {
            if (!item.classList.contains(match[1])) return false;
          }
          for (const match of simple.matchAll(/\[([\w-]+)\]/g)) {
            if (!(match[1] in item.attrs)) return false;
          }
          return true;
        }
        function branch(item, part) {
          const chain = part.trim().split(/\s+/);
          if (!matches(item, chain.pop())) return false;
          let ancestor = item.parentElement;
          while (chain.length) {
            const target = chain.pop();
            while (ancestor && !matches(ancestor, target)) ancestor = ancestor.parentElement;
            if (!ancestor) return false;
            ancestor = ancestor.parentElement;
          }
          return true;
        }
        const walk = item => {
          if (selector.split(',').some(part => branch(item, part))) results.push(item);
          for (const child of item.childNodes) walk(child);
        };
        for (const child of this.childNodes) walk(child);
        return results;
      },
    };
    return node;
  }
  return doc;
}

export function loadGuided() {
  const document = makeDocument();
  const sandbox = {
    document, console, setTimeout, clearTimeout,
    addEventListener() {}, removeEventListener() {},
    SimLib: { CanvasUtils: {}, Simulation: class {}, Theme: { get: () => ({}) } },
  };
  vm.runInNewContext(readFileSync(new URL('../public/guided.js', import.meta.url), 'utf8'), sandbox);
  return { Guided: sandbox.SimLib.Guided, document };
}
