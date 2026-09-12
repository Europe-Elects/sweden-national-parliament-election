'use strict';
/* Minimal YAML reader for the subset PartiesData uses: nested maps, inline flow
   arrays, quoted keys. No block sequences, anchors or block scalars — the file
   has none. A dependency here would mean a package.json and an install step on
   the critical path of an election-night pipeline.

   Indentation in the real file is not reliably 2-space (some lines sit at 7 or
   10), so nesting is decided by "deeper than the parent", never by dividing.
   Anything outside the subset is skipped; validate-config catches the resulting
   empty parse rather than letting it become a half-empty party list. */

/* # only opens a comment at line start or after whitespace, and never inside
   quotes — otherwise every hex colour would be truncated away. */
function stripComment(line) {
  let inSingle = false, inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === '#' && !inSingle && !inDouble) {
      if (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t') return line.slice(0, i);
    }
  }
  return line;
}

/* First colon outside quotes and followed by whitespace or end-of-line. Both
   conditions matter: quoted keys hold colons and commas, and a bare key can end
   the line with no value. */
function splitKeyValue(s) {
  let inSingle = false, inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === ':' && !inSingle && !inDouble) {
      const next = s[i + 1];
      if (next === undefined || next === ' ' || next === '\t') {
        return [s.slice(0, i).trim(), s.slice(i + 1).trim()];
      }
    }
  }
  return null;
}

function unquote(s) {
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

function splitFlow(body) {
  const out = [];
  let cur = '', inSingle = false, inDouble = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "'" && !inDouble) { inSingle = !inSingle; cur += c; }
    else if (c === '"' && !inSingle) { inDouble = !inDouble; cur += c; }
    else if (c === ',' && !inSingle && !inDouble) { out.push(cur); cur = ''; }
    else cur += c;
  }
  if (cur.trim() !== '') out.push(cur);
  return out.map(s => s.trim());
}

function parseScalar(raw) {
  const s = raw.trim();
  if (s === '') return null;

  if (s[0] === '[' && s[s.length - 1] === ']') {
    return splitFlow(s.slice(1, -1)).map(parseScalar);
  }
  if (s[0] === '"' || s[0] === "'") return unquote(s);

  if (s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  /* Full-shape match so "1.2.3" does not become 1.2. */
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function parse(text) {
  const root = {};
  const stack = [{ indent: -1, node: root }];

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (!line.trim()) continue;

    const indent = line.length - line.replace(/^\s*/, '').length;
    const kv = splitKeyValue(line.trim());
    if (!kv) continue;  // not a mapping line — outside the supported subset

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].node;
    const key = unquote(kv[0]);

    if (kv[1] === '') {
      const node = {};
      parent[key] = node;
      stack.push({ indent, node });
    } else {
      parent[key] = parseScalar(kv[1]);
    }
  }

  return root;
}

module.exports = { parse, parseScalar, stripComment, splitKeyValue };
