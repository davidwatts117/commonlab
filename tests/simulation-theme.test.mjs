import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';

// Simulation scenes must draw from SimLib.Theme so every lab shares one look.
// Data-driven colours (indicator dyes, chart-of-nuclides encodings) may opt out
// with `// theme-exempt: <reason>` on the line, or a
// `// theme-exempt-start: <reason>` … `// theme-exempt-end` block.

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const simDir = new URL('../public/simulations/', import.meta.url);
const modules = readdirSync(simDir).filter(file => file.endsWith('.js'));

const FORBIDDEN = [
  { name: 'hex colour', pattern: /['"`]#[0-9a-fA-F]{3,8}\b/ },
  { name: 'colour function literal', pattern: /['"`](?:rgba?|hsla?)\(/ },
  { name: 'font string', pattern: /\d+px\s*['"]?\s*(?:['"]?[A-Z][\w ]*['"]?\s*,|ui-|system-ui|sans-serif|serif|monospace)/ },
];

/** Returns [{ line, rule, text }] for every unexempted style literal in `source`. */
function findStyleLiterals(source) {
  const violations = [];
  let block = null;
  source.split('\n').forEach((text, index) => {
    const line = index + 1;
    const start = text.match(/theme-exempt-start(?::\s*(.*))?/);
    if (start) {
      assert.ok(start[1]?.trim(), `line ${line}: theme-exempt-start needs a reason`);
      assert.equal(block, null, `line ${line}: nested theme-exempt-start`);
      block = line;
      return;
    }
    if (/theme-exempt-end/.test(text)) { block = null; return; }
    if (block !== null) return;
    const exempt = text.match(/theme-exempt(?::\s*(.*))?/);
    if (exempt) { assert.ok(exempt[1]?.trim(), `line ${line}: theme-exempt needs a reason`); return; }
    for (const rule of FORBIDDEN) if (rule.pattern.test(text)) violations.push({ line, rule: rule.name, text: text.trim().slice(0, 100) });
  });
  assert.equal(block, null, `theme-exempt-start on line ${block} is never closed`);
  return violations;
}

/** Custom properties declared in the first :root block of main.css, var() references resolved. */
function rootTokens() {
  const css = read('../public/main.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const body = css.match(/:root\s*\{([^}]*)\}/)[1];
  const raw = Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
  const resolve = (value, seen = new Set()) => value.replace(/var\((--[\w-]+)\)/g, (_, name) => {
    assert.ok(!seen.has(name), `circular custom property ${name}`);
    assert.ok(name in raw, `undefined custom property ${name}`);
    return resolve(raw[name], new Set([...seen, name]));
  });
  return Object.fromEntries(Object.keys(raw).map(name => [name, resolve(raw[name]).toLowerCase()]));
}

function loadTheme() {
  const sandbox = {};
  vm.runInNewContext(read('../public/library.js'), sandbox, { filename: 'library.js' });
  return sandbox.SimLib.Theme;
}

test('simulation modules draw with theme tokens, not colour or font literals', () => {
  const report = [];
  for (const file of modules) {
    for (const v of findStyleLiterals(readFileSync(new URL(file, simDir), 'utf8'))) report.push(`${file}:${v.line} ${v.rule}: ${v.text}`);
  }
  assert.deepEqual(report, [], 'Use SimLib.Theme tokens (T.accent, T.font(…), SimLib.Color.alpha(…)) or mark data colours theme-exempt:\n' + report.join('\n'));
});

test('every simulation module selects the shared canvas theme', () => {
  for (const file of modules) {
    assert.match(readFileSync(new URL(file, simDir), 'utf8'), /SimLib\.Theme\.use\(/, `${file} must call SimLib.Theme.use()`);
  }
});

test('the lint catches literals and honours exemptions', () => {
  const found = findStyleLiterals([
    "ctx.fillStyle = '#c14953';",
    "ctx.strokeStyle = 'rgba(0,0,0,0.5)';",
    "ctx.fillStyle = 'hsl(' + h + ',80%,40%)';",
    "ctx.font = 'bold 12px system-ui, sans-serif';",
    "ctx.font = \"10px 'IBM Plex Mono', monospace\";",
    "ctx.fillStyle = T.accent; ctx.font = T.font(12);",
    "const dye = '#ff00ff'; // theme-exempt: indicator dye colour",
    '// theme-exempt-start: decay-mode encoding',
    "A: '#28d756',",
    '// theme-exempt-end',
    "el.style.width = pct + 'px';",
  ].join('\n'));
  assert.deepEqual(found.map(v => v.line), [1, 2, 3, 4, 5]);
  assert.throws(() => findStyleLiterals("x = '#fff'; // theme-exempt"), /needs a reason/);
  assert.throws(() => findStyleLiterals('// theme-exempt-start: open'), /never closed/);
});

test('canvas palette fallbacks match the CSS custom properties they are read from', () => {
  const css = rootTokens();
  const theme = loadTheme();
  const light = theme.palettes.light;
  for (const [key, name] of Object.entries(theme.cssTokens)) {
    assert.ok(name in css, `main.css :root is missing ${name} (SimLib.Theme.${key})`);
    assert.equal(light[key].toLowerCase(), css[name], `SimLib.Theme fallback ${key} differs from ${name}`);
  }
  theme.seriesTokens.forEach((name, i) => assert.equal(light.series[i].toLowerCase(), css[name], `series[${i}] differs from ${name}`));
});

test('built-in graph legends use the shared series palette', () => {
  const series = new Set(loadTheme().seriesTokens.map(name => rootTokens()[name]));
  const catalog = JSON.parse(read('../public/simulations/catalog.json'));
  for (const sim of catalog.simulations) {
    for (const graph of sim.graphs) {
      for (const item of graph.legend ?? []) {
        assert.ok(series.has(item.color.toLowerCase()), `${sim.id}/${graph.id} legend "${item.label}" uses ${item.color}, not a --series-* colour`);
      }
    }
  }
});
