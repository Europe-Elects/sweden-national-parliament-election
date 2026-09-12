'use strict';
/* Turns a PartiesData entry into the party table the page renders from.
   config.json carries only what upstream has no opinion about: the spellings
   the Sheet uses, and deliberate colour departures. */

const fs = require('fs');
const path = require('path');
const { parse } = require('./yaml');
const { fetchText } = require('./io');

function yamlPath(source) {
  return `${source.continent}/partiesdata.yaml`;
}

/* The Contents API, not raw.githubusercontent.com: PartiesData is private and
   raw URLs 404 anonymously. The same call works against a public repo, so there
   is one code path either way. */
function contentsUrl(source) {
  const { repo, ref } = source;
  /* Both land in the path of an authenticated request, so a stray ".." in a
     config file must not walk the URL somewhere the token was never meant to go. */
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repo)) || String(repo).includes('..')) {
    throw new Error(`parties.source.repo should be owner/name, got ${JSON.stringify(repo)}`);
  }
  if (!/^[A-Za-z0-9_./-]+$/.test(String(ref)) || String(ref).includes('..')) {
    throw new Error(`parties.source.ref should be a branch, tag or commit, got ${JSON.stringify(ref)}`);
  }
  return `https://api.github.com/repos/${repo}/contents/${yamlPath(source).split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`;
}

/* For log lines: the URL a person would open. */
function rawUrl(source) {
  return `https://github.com/${source.repo}/blob/${source.ref}/${yamlPath(source)}`;
}

function partiesToken() {
  return process.env.PARTIESDATA_TOKEN || process.env.GITHUB_PAT || null;
}

/* A local checkout wins over the API: that is how this runs offline and without
   a token. */
async function fetchPartiesYaml(source, { local, token = partiesToken() } = {}) {
  const localRoot = (local && local !== true) ? local : source.localPath;
  if (localRoot) {
    const file = path.join(localRoot, source.continent, 'partiesdata.yaml');
    if (!fs.existsSync(file)) throw new Error(`no such file: ${file}`);
    return { text: fs.readFileSync(file, 'utf8'), from: file };
  }

  const url = contentsUrl(source);
  const headers = { Accept: 'application/vnd.github.raw' };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    return { text: await fetchText(url, { headers }), from: rawUrl(source) };
  } catch (e) {
    if (/HTTP 40[34]/.test(e.message)) {
      throw new Error(
        `${e.message} reading ${rawUrl(source)}.\n` +
        (token
          ? `The token is set but cannot read ${source.repo}. It needs Contents: Read on that repository, and it must not be expired.`
          : `${source.repo} is a private repository, so this needs a token: set PARTIESDATA_TOKEN (a fine-grained PAT with Contents: Read on ${source.repo}). ` +
            `In the Action that is a repository secret of the same name. To work without one, clone PartiesData and set parties.source.localPath, or pass --local <path>.`)
      );
    }
    throw e;
  }
}

/* ~EPP is an approximation, →S&D a transition, ["EPP","S&D"] a composite.
   Colour follows the first real group. */
function groupBase(epGroup) {
  if (epGroup == null) return '*';
  const first = Array.isArray(epGroup) ? epGroup[0] : epGroup;
  let s = String(first).trim();
  const paren = s.match(/\(([^)]*)\)\s*$/);
  if (paren) s = paren[1];
  s = s.split('|')[0].trim();
  s = s.replace(/^[~→>-]+\s*/, '').trim();
  return s || '*';
}

function groupDisplay(epGroup) {
  if (epGroup == null) return '*';
  return Array.isArray(epGroup) ? epGroup.join('|') : String(epGroup).trim();
}

/* GRÜNE must yield GRUENE, which is what these datasets have always used, so
   the German expansions run before the generic accent strip. */
function expandDiacritics(s) {
  return s
    .replace(/ä/g, 'ae').replace(/Ä/g, 'AE')
    .replace(/ö/g, 'oe').replace(/Ö/g, 'OE')
    .replace(/ü/g, 'ue').replace(/Ü/g, 'UE')
    .replace(/ß/g, 'ss')
    .replace(/ø/g, 'oe').replace(/Ø/g, 'OE')
    .replace(/å/g, 'aa').replace(/Å/g, 'AA')
    .replace(/æ/g, 'ae').replace(/Æ/g, 'AE');
}
/* fromCharCode so the combining-mark range survives editors that would mangle
   raw U+0300..U+036F inside a character class. */
const COMBINING_MARKS = new RegExp('[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']', 'g');
function stripDiacritics(s) {
  return s.normalize('NFD').replace(COMBINING_MARKS, '');
}
function slugCode(key) {
  return stripDiacritics(expandDiacritics(String(key)))
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, 12) || 'PARTY';
}

/* Analysts spell umlauts inconsistently, so every label reduces to both
   plausible normal forms and either may match. */
function aliasKeys(label) {
  const base = String(label || '')
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) return [];
  return [...new Set([expandDiacritics(base), stripDiacritics(base)])];
}

function isDark(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  /* Relative luminance. Above ~0.6, white text on the swatch stops being
     readable — liberal yellow is the case that forces this to exist. */
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.6;
}

function paletteEntry(palette, base) {
  return (palette.groups && palette.groups[base])
      || (palette.families && palette.families[base])
      || palette.fallback;
}

/* Colours reach style attributes, where escaping cannot make an arbitrary CSS
   value safe. Only a plain hex passes; anything else falls back to the palette. */
const HEX = /^#[0-9a-fA-F]{6}$/;
function safeColor(value, where) {
  const first = Array.isArray(value) ? value[0] : value;
  if (first == null) return null;
  const s = String(first).trim();
  if (HEX.test(s)) return s;
  console.warn(`  note: ignoring colour ${JSON.stringify(s)} for ${where} — expected #rrggbb`);
  return null;
}

function entryFor(doc, country, electionType) {
  const c = doc && doc[country];
  if (!c) return null;
  const e = c[electionType];
  return e && typeof e === 'object' ? e : null;
}


function listEntries(doc, country) {
  const out = [];
  for (const [ctry, chambers] of Object.entries(doc || {})) {
    if (!chambers || typeof chambers !== 'object') continue;
    if (country && ctry !== country) continue;
    for (const [chamber, entry] of Object.entries(chambers)) {
      if (entry && typeof entry === 'object' && entry.parties) {
        out.push({ country: ctry, electionType: chamber, parties: Object.keys(entry.parties).length });
      }
    }
  }
  return out;
}

/* Free of I/O so the tests can drive it with a fixture. */
function resolveParties({ config, palette, yamlText }) {
  const cfg = config.parties || {};
  const source = cfg.source || {};
  const doc = parse(yamlText);

  const primary = entryFor(doc, source.country, source.electionType);
  if (!primary && cfg.requireSource !== false) {
    const available = listEntries(doc, source.country);
    const hint = available.length
      ? `Available election types for "${source.country}": ${available.map(e => `"${e.electionType}"`).join(', ')}`
      : `No entry for "${source.country}" at all. Top-level keys look like "Germany", "Belgium (Flanders)", "United Kingdom (Scotland)" — a sub-national election is filed either way round.`;
    throw new Error(
      `PartiesData has no "${source.country}" / "${source.electionType}". ${hint}\n` +
      `If this territory genuinely has no entry, set parties.requireSource to false and supply the parties through parties.metadataFallback and parties.extra.`
    );
  }

  const fallbacks = (cfg.metadataFallback || [])
    .map(f => ({ ref: f, entry: entryFor(doc, f.country, f.electionType) }));

  const overrides = cfg.overrides || {};
  const extra = cfg.extra || {};
  const baselineFromData = (cfg.baselineSource || 'partiesdata') === 'partiesdata';

  const primaryParties = (primary && primary.parties) || {};
  /* Insertion order is the file's order, which is already roughly result order.
     Extras and override-only keys follow, unless parties.order overrules. */
  const keys = [...new Set([
    ...Object.keys(primaryParties),
    ...Object.keys(overrides),
    ...Object.keys(extra),
  ])];

  const parties = {};
  const seenCodes = new Set();

  for (const key of keys) {
    const own = primaryParties[key] || null;
    const fromFallback = fallbacks.find(f => f.entry && f.entry.parties && f.entry.parties[key]);
    const upstream = own || (fromFallback ? fromFallback.entry.parties[key] : null);
    const meta = { ...(extra[key] || {}), ...(overrides[key] || {}) };

    if (!upstream && !meta.name) {
      throw new Error(
        `Party "${key}" is not in PartiesData and parties.extra["${key}"] gives no name. ` +
        `Either fix the key so it matches PartiesData, or give the entry a name and a color.`
      );
    }

    const epGroup = meta.epGroup ?? (upstream ? upstream.ep_group : null);
    const base = groupBase(epGroup);
    const display = groupDisplay(epGroup);
    const pal = paletteEntry(palette, base);

    const code = meta.code || slugCode(key);
    if (seenCodes.has(code)) {
      throw new Error(`Two parties resolve to the same code "${code}". Give one of them an explicit \`code\` in parties.overrides.`);
    }
    seenCodes.add(code);

    const color = safeColor(meta.color, `config override "${key}"`)
      || safeColor(upstream && upstream.color, `PartiesData "${key}"`)
      || safeColor(pal && pal.color, `palette "${base}"`)
      || safeColor(palette.fallback && palette.fallback.color, 'palette fallback')
      || '#999999';

    const name = meta.name || (display && display !== '*' ? `${key} (${display})` : String(key));
    const euro = meta.euro || `${(pal && pal.europarty) || 'None'} (${display})`;

    let baseline = meta.baseline ?? null;
    if (baseline == null && baselineFromData && own && own.last_results != null) {
      baseline = own.last_results;
    }

    parties[code] = {
      code,
      key,
      name,
      full: meta.full || (upstream && upstream.full) || name,
      family: meta.family || (pal && pal.note) || null,
      epGroup: display,
      epGroupBase: base,
      euro,
      color,
      dark: isDark(color),
      baseline,
      gov: (own && own.gov) || null,
      inPrimary: !!own,
      via: own ? 'source' : (fromFallback ? `fallback:${fromFallback.ref.country}/${fromFallback.ref.electionType}` : 'config'),
      aliases: [...new Set([
        ...aliasKeys(key),
        ...aliasKeys(code),
        ...aliasKeys(name),
        ...(meta.aliases || []).flatMap(aliasKeys),
      ])],
    };
  }


  const configured = (cfg.order || []).filter(c => parties[c]);
  const order = [...configured, ...Object.keys(parties).filter(c => !configured.includes(c))];

  const others = palette.others || { code: 'OTHERS', name: 'Others', color: '#c7c4b8' };
  others.color = safeColor(others.color, 'palette others') || '#c7c4b8';

  return {
    updated: new Date().toISOString(),
    source: {
      ...source,
      url: rawUrl(source),
      resolved: !!primary,
      electionData: (primary && primary.election_data) || null,
    },
    baselineSource: cfg.baselineSource || 'partiesdata',
    order,
    others: { ...others, dark: isDark(others.color) },
    parties,
  };
}

module.exports = {
  rawUrl, contentsUrl, fetchPartiesYaml, partiesToken,
  groupBase, groupDisplay, slugCode, aliasKeys, isDark,
  listEntries, entryFor, resolveParties,
};
