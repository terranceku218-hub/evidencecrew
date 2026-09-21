'use strict';
/**
 * mini-yaml.js - a deliberately small YAML subset parser/serializer.
 *
 * WHY NOT A REAL YAML LIBRARY
 *   The whole point of this harness is that it runs from the DeepSeek Harness shell with
 *   nothing installed. The protected worker adapter holds that line by using only Node
 *   built-ins, and dragging in a dependency for the sake of a config file would break the
 *   property that makes the toolchain dependable offline.
 *
 * SUPPORTED
 *   - nested block mappings by indentation
 *   - scalars: string, number, boolean, null
 *   - quoted strings (single and double)
 *   - inline lists:  [a, b, c]
 *   - block lists:   - item
 *   - comments (#) and blank lines
 *
 * NOT SUPPORTED (and rejected loudly rather than mis-parsed)
 *   anchors, aliases, multi-document streams, flow mappings spanning lines, tags.
 *   A config language that silently mis-reads is worse than one that refuses.
 *
 * ASCII-ONLY source: see the encoding note in ../config.json.
 */

function stripComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) {
      // A '#' only starts a comment at the start of the value or after whitespace.
      if (i === 0 || /\s/.test(line[i - 1])) return line.slice(0, i);
    }
  }
  return line;
}

function parseScalar(raw) {
  const s = raw.trim();
  if (s === '') return '';
  if (s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;

  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    const inner = s.slice(1, -1);
    if (s[0] === "'") return inner; // single quotes are literal in YAML
    return unescapeDouble(inner);
  }

  if (s.startsWith('[') && s.endsWith(']')) {
    const body = s.slice(1, -1).trim();
    if (body === '') return [];
    return body.split(',').map((x) => parseScalar(x));
  }

  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d*\.\d+$/.test(s)) return Number(s);

  return s;
}

/**
 * Unescape the body of a double-quoted scalar in a SINGLE left-to-right pass.
 *
 * Order is the whole problem. A chain of `.replace()` calls re-processes text that an
 * earlier replacement produced, so `\\\\n` (an escaped backslash followed by an 'n') gets
 * turned into a backslash and then immediately into a newline. That corrupted every
 * Windows path containing the sequence `\n` -- `C:\...\novel-demo` came back with a real
 * line break in it. Consuming each escape exactly once, in one pass, makes the inverse of
 * the serializer exact.
 */
function unescapeDouble(inner) {
  let out = '';
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch !== '\\') { out += ch; continue; }
    const next = inner[i + 1];
    switch (next) {
      case '\\': out += '\\'; i += 1; break;
      case '"': out += '"'; i += 1; break;
      case 'n': out += '\n'; i += 1; break;
      case 't': out += '\t'; i += 1; break;
      case 'r': out += '\r'; i += 1; break;
      case undefined: out += '\\'; break;
      default: out += '\\' + next; i += 1; break;
    }
  }
  return out;
}

/**
 * Parse a YAML document into a plain object.
 * @param {string} text
 * @returns {object}
 */
function parse(text) {
  if (typeof text !== 'string') throw new TypeError('yaml.parse expects a string');

  // Refuse YAML features this subset does not implement, rather than half-parsing them.
  // An anchor/alias was previously only detected at the start of a line, so `a: &x 1`
  // slipped through and parsed as the literal string "&x 1" -- a config silently read
  // wrong is worse than one loudly refused.
  if (/(^|\s)[&*][A-Za-z0-9_-]/.test(text)) {
    throw new Error('unsupported YAML feature (anchor or alias)');
  }
  if (/^\s*---/m.test(text)) throw new Error('unsupported YAML feature (document marker)');
  if (/^\s*%\w+/m.test(text)) throw new Error('unsupported YAML feature (directive or tag)');

  const root = {};
  // Stack of {indent, container}. The root sits at indent -1 so any top-level key nests in.
  const stack = [{ indent: -1, container: root }];
  const lines = text.split(/\r?\n/);

  for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
    const original = lines[lineNo];
    if (/^\s*$/.test(original)) continue;

    const withoutComment = stripComment(original);
    if (/^\s*$/.test(withoutComment)) continue;

    const indent = withoutComment.match(/^\s*/)[0].replace(/\t/g, '  ').length;
    const content = withoutComment.trim();

    // Pop containers that this line is no longer inside.
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].container;

    // Block list item
    if (content.startsWith('- ')) {
      if (!Array.isArray(parent)) {
        throw new Error(`line ${lineNo + 1}: list item without a list context`);
      }
      parent.push(parseScalar(content.slice(2)));
      continue;
    }

    const colon = content.indexOf(':');
    if (colon <= 0) {
      throw new Error(`line ${lineNo + 1}: expected "key: value", got ${JSON.stringify(content)}`);
    }

    const key = content.slice(0, colon).trim();
    const rest = content.slice(colon + 1).trim();

    if (rest === '') {
      // Look ahead: a list item decides whether this key opens an array or an object.
      let nextContent = null;
      for (let j = lineNo + 1; j < lines.length; j += 1) {
        const t = stripComment(lines[j]);
        if (/^\s*$/.test(t)) continue;
        nextContent = t.trim();
        break;
      }
      const child = nextContent && nextContent.startsWith('- ') ? [] : {};
      parent[key] = child;
      stack.push({ indent, container: child });
    } else {
      parent[key] = parseScalar(rest);
    }
  }

  return root;
}

/**
 * Does this string need quoting when written as a double-quoted scalar?
 *
 * Backslashes matter even when nothing else does: Windows paths are full of them, and
 * `<project-root>\novel-demo` contains the sequence `\n`. Inside a double-quoted scalar that
 * is a newline escape, so an unescaped path would be silently corrupted on read-back.
 * The parser happily turned the registry root into a path containing a line break, and the
 * root-mismatch guard caught it - which is why that guard exists.
 */
function needsQuoting(s) {
  return s === '' || /^[\s]|[\s]$/.test(s) || /[:#\[\]{}",'&*!|>%@`\\]/.test(s) ||
         /^(true|false|null|~|-?\d+(\.\d+)?)$/.test(s);
}

function formatScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  if (needsQuoting(s)) {
    // Escape backslash FIRST, then the quote - reversing the order would double-escape
    // the backslash introduced by the quote escape.
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  return s;
}

/**
 * Serialize a plain object back to YAML.
 * Deterministic key order (insertion order) so a regenerated file diffs cleanly.
 */
function stringify(value, indent = 0) {
  const pad = ' '.repeat(indent);
  const lines = [];

  if (value === null || typeof value !== 'object') return pad + formatScalar(value) + '\n';
  if (Array.isArray(value)) {
    if (value.length === 0) return pad + '[]\n';
    for (const item of value) lines.push(pad + '- ' + formatScalar(item));
    return lines.join('\n') + '\n';
  }

  for (const [k, v] of Object.entries(value)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const inner = stringify(v, indent + 2).replace(/\n$/, '');
      lines.push(`${pad}${k}:`);
      lines.push(inner);
    } else if (Array.isArray(v)) {
      if (v.length === 0) lines.push(`${pad}${k}: []`);
      else {
        lines.push(`${pad}${k}:`);
        for (const item of v) lines.push(`${pad}  - ${formatScalar(item)}`);
      }
    } else {
      lines.push(`${pad}${k}: ${formatScalar(v)}`);
    }
  }
  return lines.join('\n') + '\n';
}

module.exports = { parse, stringify };
