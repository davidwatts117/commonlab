import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

// The original illustration is a damped cosine about the y=395 axis,
// with amplitude 28, period 115 and decay length 690 in SVG coordinates.
const wave = x => 395 - 28 * Math.exp(-(x - 40) / 690) * Math.cos(2 * Math.PI * (x - 40) / 115);
const cubic = (a, b, c, d, t) => (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t ** 2 * c + t ** 3 * d;

test('landing graph is a continuous smooth curve preserving the damped oscillation', () => {
  const path = html.match(/<path\b[^>]*class="hero-wave"[^>]*>/)?.[0];
  assert.ok(path, 'render the wave as a curved SVG path, not a segmented polyline');
  assert.match(path, /fill="none"/);
  assert.match(path, /stroke="#c14953"/);
  assert.match(path, /stroke-width="2"/);
  const data = path.match(/\bd="([^"]+)"/)[1];
  // Restrict this static artwork to a single move followed by cubic curves:
  // no line segments, gaps, or closing stroke across the graph.
  assert.match(data, /^M[\d.,\s]+(?:C[\d.,\s]+)+$/);
  const parts = data.split('C');
  let start = parts.shift().slice(1).trim().split(/[\s,]+/).map(Number);
  assert.deepEqual(start, [40, 367]);
  let previousTangent;
  for (const part of parts) {
    const numbers = part.trim().split(/[\s,]+/).map(Number);
    assert.equal(numbers.length, 6);
    const [x1, y1, x2, y2, x3, y3] = numbers;
    assert.ok(start[0] < x1 && x1 < x2 && x2 < x3, 'time must increase along each curve');
    const tangent = [x1 - start[0], y1 - start[1]];
    if (previousTangent) {
      assert.ok(tangent.every((value, i) => Math.abs(value - previousTangent[i]) < 0.003), 'adjacent curves must have matching tangents, not visible corners');
    }
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      const x = cubic(start[0], x1, x2, x3, t);
      const y = cubic(start[1], y1, y2, y3, t);
      assert.ok(Math.abs(y - wave(x)) < 0.3, `wave shape changed at x=${x}`);
    }
    previousTangent = [x3 - x2, y3 - y2];
    start = [x3, y3];
  }
  assert.equal(start[0], 500, 'keep the original graph width');
  assert.ok(Math.abs(start[1] - wave(500)) < 0.001);
});
