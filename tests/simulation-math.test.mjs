import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMathText } from '../public/simulation-math.mjs';
import { makeDocument } from './dom-shim.mjs';

function render(text) {
  const document = makeDocument();
  globalThis.document = document;
  return renderMathText(document.createElement('p'), text);
}
test.after(() => { delete globalThis.document; });

test('explicit inline and display LaTeX creates semantic MathML, not HTML strings', () => {
  const element = render(String.raw`Compare \(P_1V_1\) with $$\frac{V_1}{T_1} = \frac{V_2}{T_2}$$ and \[\sqrt{x^2}\].`);
  assert.equal(element.querySelectorAll('math').length, 3);
  assert.equal(element.querySelectorAll('mfrac').length, 2);
  assert.equal(element.querySelectorAll('msub').length, 6);
  assert.equal(element.querySelectorAll('msqrt').length, 1);
  assert.equal(element.querySelectorAll('msup').length, 1);
  const maths = element.querySelectorAll('math');
  assert.equal(maths[0].namespaceURI, 'http://www.w3.org/1998/Math/MathML');
  assert.notEqual(maths[0].getAttribute('display'), 'block');
  assert.equal(maths[1].getAttribute('display'), 'block');
  assert.equal(maths[2].getAttribute('display'), 'block');
  assert.ok(element.textContent.startsWith('Compare '));
  assert.ok(element.textContent.endsWith('.'));
});

test('legacy prose, HTML-looking text, currency and unmatched delimiters stay literal', () => {
  const text = String.raw`Cost $5, P _1, <img src=x onerror=alert(1)> and \(unfinished`;
  const element = render(text);
  assert.equal(element.textContent, text);
  assert.equal(element.querySelectorAll('math, img').length, 0);
});

test('invalid math and unsafe commands fall back to literal text without breaking adjacent math', () => {
  for (const expression of [String.raw`\frac{`, String.raw`\href{javascript:alert(1)}{click}`, String.raw`\includegraphics{https://example.com/track}`, String.raw`\htmlClass{injected}{x}`, String.raw`\def\loop{\loop}\loop`]) {
    const input = `$$${expression}$$`;
    const element = render(`${input} then \\(x^2\\)`);
    assert.ok(element.textContent.startsWith(input), expression);
    assert.equal(element.querySelectorAll('math').length, 1);
    assert.equal(element.querySelectorAll('a, img, script').length, 0);
  }
  const element = render(String.raw`\(\text{<img src=x onerror=alert(1)>}\)`);
  assert.equal(element.querySelectorAll('img').length, 0);
});

test('macros do not leak between expressions or renders; rerender replaces existing math', () => {
  const element = render(String.raw`\(\gdef\custom{X}\custom\) \(\custom\)`);
  assert.equal(element.querySelectorAll('math').length, 1);
  assert.ok(element.textContent.endsWith(String.raw`\(\custom\)`));
  renderMathText(element, String.raw`\(y_2\)`);
  assert.equal(element.querySelectorAll('math').length, 1);
  assert.equal(element.querySelectorAll('msub').length, 1);
});
