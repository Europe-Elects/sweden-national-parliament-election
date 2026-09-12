#!/usr/bin/env node
'use strict';
/* Fetches the Sheet tabs named in config.json and writes /data/*.json.
   Datawrapper-backed sections are refreshed by republishing the chart instead —
   see scripts/republish-charts.js.

   Fail-safe contract: a tab that fails to fetch, parse or validate leaves its
   existing JSON untouched. Stale data beats wrong data on election night.

   Usage:
     node scripts/build-data.js
     node scripts/build-data.js --dry-run     fetch and validate, write nothing
*/

const fs = require('fs');
const path = require('path');
const { DATA_DIR, writeIfChanged, fetchText } = require('./lib/io');
const { loadConfig, loadPalette, sectionEnabled } = require('./lib/config');
const { fetchPartiesYaml, resolveParties, aliasKeys } = require('./lib/parties');

const DRY_RUN = process.argv.includes('--dry-run');

/* ---------- sheet access ---------- */

/* gviz accepts sheet=<name>, which survives duplication; gid does not. */
const csvUrl = (sheetId, tab) =>
  `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;

function parseCSV(text) {
  const rows = [];
  let row = [], cur = '', inQ = false;
  const s = String(text).split('\r\n').join('\n');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.map(r => r.map(c => c.trim())).filter(r => r.some(c => c !== ''));
}

function parseNum(v) {
  const n = parseFloat(String(v == null ? '' : v).replace('%', '').replace(',', '.'));
  return isNaN(n) ? null : n;
}

async function fetchTab(sheetId, tab, { attempts = 3 } = {}) {
  const text = await fetchText(csvUrl(sheetId, tab), { attempts });
  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error('fewer than 2 rows');
  return rows;
}

/* ---------- party matching ---------- */

/* An unmatched Sheet label is reported by name, so the fix is always "add an
   alias" rather than a hunt. */
function buildIndex(table) {
  const index = new Map();
  for (const code of Object.keys(table.parties)) {
    for (const alias of table.parties[code].aliases) {
      if (!index.has(alias)) index.set(alias, code);
    }
  }
  return {
    lookup(label) {
      for (const key of aliasKeys(label)) {
        if (index.has(key)) return index.get(key);
      }
      return null;
    },
  };
}

/* ---------- transforms ---------- */

/* Kept in sheet shape so the page's renderer consumes `rows` unchanged.

   An exit poll covers the whole electorate, so each institute's row has a total
   it has to be near: shares add to about 100, and a seat projection allocates
   about the whole chamber. A row far from that is not a projection — it is a
   tab someone is still filling in. Checking the total is what separates the two,
   because the individual figures look perfectly ordinary either way. */
function buildExit(rows, { max, integer, seatsTotal, seatsFixed = true }) {
  const header = rows[0];
  const body = rows.slice(1).filter(r => r[0]);
  if (!body.length) throw new Error('no institute rows');

  const expected = integer ? seatsTotal : 100;
  /* A fixed-size chamber must come out at its size. Where overhang or levelling
     seats exist the total floats upward, so the ceiling is lifted rather than
     the check dropped. */
  const lo = expected ? expected * (integer && !seatsFixed ? 0.9 : 0.95) : null;
  const hi = expected ? expected * (integer && !seatsFixed ? 1.5 : 1.05) : null;

  const sums = new Map();
  for (const r of body) {
    let sum = 0, seen = 0;
    for (const cell of r.slice(1)) {
      const n = parseNum(cell);
      if (n == null) continue;
      if (n < 0 || n > max) throw new Error(`value ${n} out of range 0..${max} for "${r[0]}"`);
      if (integer && !Number.isInteger(n)) throw new Error(`non-integer seat ${n} for "${r[0]}"`);
      sum += n; seen++;
    }
    if (seen) sums.set(r[0], sum);
    if (!integer && sum > 105) throw new Error(`shares for "${r[0]}" sum to ${sum}`);
    if (integer && seatsTotal && sum > seatsTotal * 1.5) throw new Error(`seats for "${r[0]}" sum to ${sum}`);
  }

  const plausible = [...sums.entries()].filter(([, s]) => lo == null || (s >= lo && s <= hi));
  const published = plausible.length > 0;

  if (sums.size && !published) {
    const detail = [...sums.entries()].map(([k, s]) => `${k} sums to ${s}`).join('; ');
    console.warn(
      `  WARNING: no row totals anywhere near ${Math.round(expected)} (${detail}). ` +
      `${integer ? 'A seat projection allocates the whole chamber' : 'Vote shares add to about 100'}, so this tab ` +
      `holds placeholders. Reporting it as not yet published.`
    );
  } else if (plausible.length < sums.size) {
    const bad = [...sums.entries()].filter(([, s]) => s < lo || s > hi).map(([k, s]) => `${k} sums to ${s}`);
    console.warn(`  note: ${bad.join('; ')} — off the expected total of about ${Math.round(expected)}`);
  }

  return {
    updated: new Date().toISOString(),
    published,
    header,
    rows: body,
  };
}

/* A vote count is never a percentage. A `%` in the votes column means the cell
   is formatted as one, which in practice means it holds a placeholder rather
   than a count — and a placeholder above zero would otherwise mark the party as
   having reported, putting invented shares and a full negative swing on the
   page as though they were results. Treated as "not reported yet" instead. */
const isPercentFormatted = v => /%/.test(String(v == null ? '' : v));

function buildResults(rows, { index, columns, totalRowPattern, seatsTotal, votesAre = 'count', minValidVotes = null }) {
  const body = rows.slice(1).filter(r => r[0]);
  const totalRe = new RegExp(totalRowPattern, 'i');
  const totalRow = body.find(r => totalRe.test(r[0]));
  const asShare = votesAre === 'share';

  const placeholders = [];
  let validVotes = 0;
  if (totalRow) {
    const rawTotal = totalRow[columns.votes];
    /* A percent-formatted total is not an electorate figure, and in `share`
       mode a total is not expected at all. */
    if (!asShare && isPercentFormatted(rawTotal)) {
      placeholders.push(`the totals row holds ${JSON.stringify(rawTotal)}`);
    } else if (!asShare) {
      validVotes = parseNum(rawTotal) || 0;
    }
  }

  /* An election-specific floor on the totals row. The Sweden 2026 sheet summed
     to 8, which is a placeholder however it is formatted, and no formatting
     rule would have caught it. Set it to something no real count could fall
     below and a half-filled tab can never read as a result. */
  const belowFloor = !asShare && minValidVotes != null && validVotes > 0 && validVotes < minValidVotes;

  const parties = body.filter(r => r !== totalRow).map(r => {
    const label = r[0];
    const code = index.lookup(label);
    const rawVotes = r[columns.votes];
    const value = parseNum(rawVotes);
    const seats = columns.seats == null ? null : parseNum(r[columns.seats]);

    /* In `share` mode the votes column holds percentages on purpose — some
       returning officers publish no raw counts — so it is the share, and there
       is no vote count to report. */
    let votes = asShare ? null : value;
    let share = asShare ? value : parseNum(r[columns.share]);

    let reported = value != null && value > 0;
    if (reported && !asShare && isPercentFormatted(rawVotes)) {
      placeholders.push(`${label} holds ${JSON.stringify(rawVotes)}`);
      reported = false;
    }
    if (reported && belowFloor) reported = false;

    if (share != null && (share < 0 || share > 100)) throw new Error(`share ${share} out of range for "${label}"`);
    if (seats != null && seatsTotal && (seats < 0 || seats > seatsTotal * 1.5)) {
      throw new Error(`seats ${seats} implausible for "${label}"`);
    }

    return {
      code,
      label,
      votes: reported ? votes : null,
      share: reported ? share : null,
      seats: reported ? seats : null,
      /* The Sheet computes these against its own baseline, so it serves a full
         negative swing while votes are still zero. */
      changeV: reported && columns.changeVotes != null ? parseNum(r[columns.changeVotes]) : null,
      changeS: reported && columns.changeSeats != null ? parseNum(r[columns.changeSeats]) : null,
      reported,
    };
  });

  const totalShare = parties.reduce((a, p) => a + (p.share || 0), 0);
  if (totalShare > 105) throw new Error(`vote shares sum to ${totalShare}`);

  /* Structural checks, which hold whatever the cells are formatted as.

     They are deliberately split by how certain they are. Suppressing real
     figures on election night is worse than showing placeholder ones before it,
     so only a signal with essentially no false positives is allowed to
     suppress; the rest merely say something is off and leave the figures
     alone. */
  const counted = parties.filter(p => p.reported);

  /* Eight parties never poll the same number of votes. This is what a
     hand-typed placeholder looks like once formatting is stripped away, and it
     is the check that catches the case a percent sign would have hidden. */
  let allEqual = false;
  if (!asShare && counted.length >= 3) {
    const first = counted[0].votes;
    allEqual = counted.every(p => p.votes === first);
    if (allEqual) {
      for (const p of counted) { p.reported = false; p.votes = null; p.share = null; p.seats = null; p.changeV = null; p.changeS = null; }
      console.warn(
        `  WARNING: all ${counted.length} reporting parties hold the same vote figure (${first}), which is a placeholder, ` +
        `not a count. Treating the tab as not yet counting.`
      );
    }
  }

  /* Only advisory: a returning officer's valid-vote base does not always match
     the sum of party votes exactly, and early in a count the sheet's own
     arithmetic can lag. Worth saying, not worth acting on. */
  const stillCounted = parties.filter(p => p.reported);
  if (stillCounted.length && validVotes > 0) {
    const sum = stillCounted.reduce((a, p) => a + (p.votes || 0), 0);
    if (sum > 0 && Math.abs(sum - validVotes) / validVotes > 0.02) {
      console.warn(`  note: party votes sum to ${sum} but the totals row says ${validVotes} — a gap over 2%`);
    }
    const offenders = stillCounted.filter(p => {
      if (p.share == null || !p.votes) return false;
      return Math.abs(p.share - (p.votes / validVotes) * 100) > 5;
    });
    if (offenders.length > stillCounted.length / 2) {
      console.warn(
        `  note: the share column disagrees with votes/total for ${offenders.length} of ${stillCounted.length} parties ` +
        `by more than 5 points — check which of the two columns is authoritative`
      );
    }
  }

  const unmatched = parties.filter(p => !p.code).map(p => p.label);
  if (unmatched.length) {
    console.warn(`  note: no party matches ${unmatched.map(l => `"${l}"`).join(', ')} — they will show as Others. Add an alias in config.json under parties.overrides if that is wrong.`);
  }

  if (belowFloor) {
    console.warn(
      `  WARNING: the totals row sums to ${validVotes}, below sheet.results.minValidVotes (${minValidVotes}). ` +
      `Treating the tab as not yet counting, so placeholder figures stay off the page.`
    );
  }

  if (placeholders.length) {
    console.warn(
      `  WARNING: the votes column is percent-formatted in ${placeholders.length} row(s), so it holds placeholders, not counts: ` +
      `${placeholders.slice(0, 3).join('; ')}${placeholders.length > 3 ? '; …' : ''}. ` +
      `Those rows are reported as not yet counted, which keeps invented shares off the page. ` +
      `Clear the votes column in the Sheet, or format it as a number, before polls close.`
    );
  }

  return {
    updated: new Date().toISOString(),
    validVotes,
    counting: parties.some(p => p.reported),
    parties,
  };
}

/* Long format in, nested object out. Category and subgroup order follows the
   sheet, so reordering rows there reorders the dropdowns. */
function buildDemographic(rows, { index }) {
  const header = rows[0];
  const years = header.slice(3).filter(y => /^\d{4}$/.test(y));
  if (!years.length) throw new Error('no year columns — expected Category, Subgroup, Party, then one column per election year');

  const data = {}, order = {};
  for (const r of rows.slice(1)) {
    const [category, subgroup, party] = [r[0], r[1], r[2]];
    if (!category || !subgroup || !party) continue;
    const code = index.lookup(party);
    if (!code) throw new Error(`unknown party "${party}" in ${category}/${subgroup} — add it to parties.extra or give an existing party that alias`);

    (order[category] ||= []);
    if (!order[category].includes(subgroup)) order[category].push(subgroup);

    const bucket = ((data[category] ||= {})[subgroup] ||= {});
    const series = (bucket[code] ||= {});
    years.forEach((y, i) => {
      const v = parseNum(r[3 + i]);
      if (v == null) return;
      if (v < 0 || v > 100) throw new Error(`share ${v} out of range for ${category}/${subgroup}/${party} in ${y}`);
      series[y] = v;
    });
  }

  /* A subgroup prepared for figures nobody has published yet should not reach
     the dropdowns until it has something to show. */
  for (const [cat, subs] of Object.entries(data)) {
    for (const [sub, parties] of Object.entries(subs)) {
      for (const [code, series] of Object.entries(parties)) {
        if (!Object.keys(series).length) delete parties[code];
      }
      if (!Object.keys(parties).length) {
        delete subs[sub];
        order[cat] = order[cat].filter(s => s !== sub);
      }
    }
    if (!order[cat].length) { delete data[cat]; delete order[cat]; }
  }

  if (!Object.keys(data).length) throw new Error('no figures in any group');
  return { updated: new Date().toISOString(), years, order, data };
}

/* ---------- runner ---------- */

/* Refreshed here so an upstream correction lands without a second command.
   Survivable when it fails: the party table changes rarely. */
async function refreshParties(config, palette) {
  const dest = path.join(DATA_DIR, 'parties.json');
  const source = (config.parties && config.parties.source) || {};
  try {
    const { text } = await fetchPartiesYaml(source);
    const resolved = resolveParties({ config, palette, yamlText: text });
    if (!DRY_RUN) {
      const changed = writeIfChanged(dest, resolved);
      console.log(`${changed ? 'updated' : 'unchanged'}  data/parties.json  (${resolved.order.length} parties)`);
    }
    return resolved;
  } catch (e) {
    if (fs.existsSync(dest)) {
      console.warn(`WARNING  data/parties.json not refreshed (${e.message}) — using the committed copy`);
      return JSON.parse(fs.readFileSync(dest, 'utf8'));
    }
    throw new Error(`cannot resolve parties and no committed data/parties.json to fall back on: ${e.message}`);
  }
}

function targetsFor(config, index) {
  const tabs = (config.sheet && config.sheet.tabs) || {};
  const seatsTotal = config.election && config.election.seatsTotal;
  const resultsCfg = (config.sheet && config.sheet.results) || {};
  const columns = resultsCfg.columns || { votes: 1, share: 2, seats: 3, changeVotes: 4, changeSeats: 5 };
  const totalRowPattern = resultsCfg.totalRowPattern || 'valid votes';
  const votesAre = resultsCfg.votesAre || 'count';
  const minValidVotes = resultsCfg.minValidVotes == null ? null : Number(resultsCfg.minValidVotes);
  const exitSeatMax = seatsTotal ? seatsTotal * 1.5 : 1000;
  const seatsFixed = (config.election && config.election.seatsFixed) !== false;

  const all = [
    {
      file: 'exitVotes.json', tab: tabs.exitVotes, needs: 'exitVotes',
      build: r => buildExit(r, { max: 100, integer: false, seatsTotal, seatsFixed }),
    },
    {
      file: 'exitSeats.json', tab: tabs.exitSeats, needs: 'exitSeats',
      build: r => buildExit(r, { max: exitSeatMax, integer: true, seatsTotal, seatsFixed }),
    },
    {
      file: 'results.json', tab: tabs.results, needs: 'results',
      build: r => buildResults(r, { index, columns, totalRowPattern, seatsTotal, votesAre, minValidVotes }),
    },
    {
      file: 'demographic.json', tab: tabs.demographic, needs: 'demographics',
      build: r => buildDemographic(r, { index }),
    },
  ];

  return all.filter(t => t.tab && sectionEnabled(config, t.needs));
}

async function main() {
  const config = loadConfig();
  const palette = loadPalette();
  const sheetId = config.sheet && config.sheet.id;
  if (!sheetId || /^TODO\b/.test(sheetId)) throw new Error('config.json: sheet.id is not filled in');

  fs.mkdirSync(DATA_DIR, { recursive: true });

  const table = await refreshParties(config, palette);
  const index = buildIndex(table);

  const targets = targetsFor(config, index);
  if (!targets.length) {
    console.log('no Sheet-backed sections are enabled — nothing to build');
    return;
  }

  let failures = 0, changes = 0;
  for (const t of targets) {
    try {
      const rows = await fetchTab(sheetId, t.tab);
      const payload = t.build(rows);
      if (DRY_RUN) {
        console.log(`ok       ${t.file}  (${t.tab})  — dry run, not written`);
        continue;
      }
      const changed = writeIfChanged(path.join(DATA_DIR, t.file), payload);
      changes += changed ? 1 : 0;
      console.log(`${changed ? 'updated' : 'unchanged'}  ${t.file}  (${t.tab})`);
    } catch (e) {
      failures++;
      const kept = fs.existsSync(path.join(DATA_DIR, t.file));
      console.error(`FAILED   ${t.file}  (${t.tab}): ${e.message}${kept ? ' — keeping previous file' : ' — no previous file to keep'}`);
    }
  }

  console.log(`\n${changes} file(s) changed, ${failures} of ${targets.length} tab(s) failed`);
  if (failures === targets.length) {
    console.error('every tab failed — treating as an error');
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(e => { console.error(`build-data failed: ${e.message}`); process.exit(1); });
}

module.exports = { parseCSV, parseNum, buildIndex, buildExit, buildResults, buildDemographic, csvUrl, targetsFor };
