import temml from './vendor/temml/temml.mjs';

/** Explicit delimiters keep prose, currency and legacy content unchanged. No HTML is parsed. */
export function renderMathText(element, text) {
  const doc = element.ownerDocument;
  const delimiters = /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$/g;
  let end = 0;
  element.replaceChildren();
  for (const match of text.matchAll(delimiters)) {
    element.append(doc.createTextNode(text.slice(end, match.index)));
    const math = doc.createElement('span');
    math.className = 'simulation-math';
    try {
      temml.render(match[1] ?? match[2] ?? match[3], math, {
        displayMode: match[1] === undefined,
        throwOnError: true,
        trust: false,
        maxExpand: 200,
        maxSize: [20, 20],
        annotate: true,
      });
      element.append(math);
    } catch {
      // An invalid or disallowed expression must not prevent the lab from mounting.
      element.append(doc.createTextNode(match[0]));
    }
    end = match.index + match[0].length;
  }
  element.append(doc.createTextNode(text.slice(end)));
  return element;
}
