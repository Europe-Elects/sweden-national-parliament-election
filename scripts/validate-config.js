#!/usr/bin/env node
'use strict';
/* Checks config.json and the content files before anyone finds the problem on
   election night. Errors fail the run; warnings are printed and tolerated.

   Usage:
     node scripts/validate-config.js
     node scripts/validate-config.js --offline    skip the PartiesData lookup
     node scripts/validate-config.js --allow-todo treat leftover TODOs as warnings
*/

const fs = require('fs');
const path = require('path');
const { ROOT, DATA_DIR } = require('./lib/io');
const { loadConfig, loadPalette, findPlaceholders, sectionEnabled } = require('./lib/config');
const { collectCharts, isPlaceholderId } = require('./lib/charts');
const { fetchPartiesYaml, resolveParties, listEntries } = require('./lib/parties');
const { parse } = require('./lib/yaml');

const OFFLINE = process.argv.includes('--offline');
const ALLOW_TODO = process.argv.includes('--allow-todo');

const errors = [];
const warnings = [];
const err = m => errors.push(m);
const warn = m => warnings.push(m);

const CONTENT = {
  context: { file: 'content/context.json', required: true },
  candidates: { file: 'content/candidates.json', required: true },
  previousResult: { file: 'content/previous-result.json', required: true },
  polling: { file: 'content/polls.json', required: true },
  pollingHistory: { file: 'content/poll-history.json', required: true },
  headToHead: { file: 'content/head-to-head.json', required: true },
  records: { file: 'content/records.json', required: true },
  demographics: { file: 'content/demographic-seed.json', required: false },
};

function checkPlaceholders(config) {
  const todos = findPlaceholders(config);
  if (!todos.length) return;
  const lines = todos.map(t => `    ${t.path}`).join('\n');
  const msg = `${todos.length} value(s) in config.json still start with TODO:\n${lines}`;
  (ALLOW_TODO ? warn : err)(msg);
}

function checkElection(config) {
  const e = config.election || {};
  if (!e.title) err('election.title is missing');
  const iso = e.date && e.date.iso;
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    err(`election.date.iso should be YYYY-MM-DD, got ${JSON.stringify(iso)}`);
  } else if (Number.isNaN(Date.parse(iso))) {
    err(`election.date.iso is not a real date: ${iso}`);
  }
  if (!e.date || !e.date.display) warn('election.date.display is empty — the page will show a blank date');
  if (e.seatsTotal != null && (!Number.isInteger(e.seatsTotal) || e.seatsTotal <= 0)) {
    err(`election.seatsTotal should be a positive whole number or null, got ${JSON.stringify(e.seatsTotal)}`);
  }
  if (sectionEnabled(config, 'exitSeats') && e.seatsTotal == null) {
    warn('the exitSeats section is on but election.seatsTotal is null — seat figures will not be range-checked');
  }
}

function checkSheet(config) {
  const s = config.sheet || {};
  if (!s.id) return err('sheet.id is missing');
  if (!/^[A-Za-z0-9_-]{20,}$/.test(s.id)) {
    err(`sheet.id does not look like a Sheet ID: ${JSON.stringify(s.id)} — it is the long token between /d/ and /edit in the Sheet URL`);
  }

  const tabs = s.tabs || {};
  for (const [key, needs] of [['exitVotes', 'exitVotes'], ['exitSeats', 'exitSeats'], ['results', 'results'], ['demographic', 'demographics']]) {
    const on = sectionEnabled(config, needs);
    const tab = tabs[key];
    if (on && !tab) warn(`section "${needs}" is on but sheet.tabs.${key} is null — that section will have no data`);
    if (tab != null && typeof tab !== 'string') err(`sheet.tabs.${key} should be a tab name or null, got ${JSON.stringify(tab)}`);
    if (typeof tab === 'string' && /^\d+$/.test(tab)) {
      err(`sheet.tabs.${key} is "${tab}", which looks like a gid. Tabs are referenced by name — a gid changes every time the Sheet is duplicated.`);
    }
  }

  const cols = (s.results && s.results.columns) || {};
  for (const [k, v] of Object.entries(cols)) {
    if (v != null && (!Number.isInteger(v) || v < 1)) {
      err(`sheet.results.columns.${k} should be a column index of 1 or more (0 is the party name) or null, got ${JSON.stringify(v)}`);
    }
  }
}

function checkCharts(config) {
  const charts = collectCharts(config);
  const seen = new Map();
  for (const c of charts) {
    const where = `${c.section} · ${c.label || ''}`.trim();
    if (isPlaceholderId(c.id)) { warn(`chart id still says TODO (${where})`); continue; }
    if (!/^[A-Za-z0-9]{4,6}$/.test(c.id)) warn(`chart id "${c.id}" does not look like a Datawrapper ID (${where})`);
    if (seen.has(c.id)) {
      err(`chart id "${c.id}" is used twice — ${seen.get(c.id)} and ${where}. Two cards pointing at one chart usually means a copy step was missed.`);
    }
    seen.set(c.id, where);
    if (c.version != null && (!Number.isInteger(c.version) || c.version < 1)) {
      err(`chart ${c.id} has version ${JSON.stringify(c.version)} — it should be the whole number from the embed URL`);
    }
  }
  if (!charts.some(c => c.live)) {
    warn('no chart is marked live — nothing will be republished when the Sheet changes');
  }
}

function checkContent(config) {
  for (const [section, spec] of Object.entries(CONTENT)) {
    if (!sectionEnabled(config, section)) continue;
    const file = path.join(ROOT, spec.file);
    if (!fs.existsSync(file)) {
      (spec.required ? err : warn)(`section "${section}" is on but ${spec.file} is missing`);
      continue;
    }
    try {
      const body = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (spec.required && (Array.isArray(body) ? !body.length : !Object.keys(body).length)) {
        warn(`${spec.file} is empty — section "${section}" will render as an empty card`);
      }
    } catch (e) {
      err(`${spec.file} is not valid JSON: ${e.message}`);
    }
  }
}

async function checkParties(config, palette) {
  const source = (config.parties && config.parties.source) || {};
  if (OFFLINE) { warn('--offline: PartiesData was not checked'); return; }

  let text;
  try {
    ({ text } = await fetchPartiesYaml(source));
  } catch (e) {
    /* build-data.js falls back to the committed table when upstream is
       unreachable, so with a copy on disk this is not worth failing a run over.
       On election night a PartiesData outage, or an expired token, must not stop
       results reaching the page — the party table changes rarely and an
       hours-old one is no worse than a current one. */
    const committed = path.join(DATA_DIR, 'parties.json');
    if (fs.existsSync(committed)) {
      return warn(`PartiesData could not be read, falling back to the committed data/parties.json: ${e.message}`);
    }
    return err(`cannot read PartiesData, and there is no committed data/parties.json to fall back on: ${e.message}`);
  }

  const doc = parse(text);
  if (!Object.keys(doc).length) {
    return err('PartiesData parsed to nothing — the file format may have changed in a way scripts/lib/yaml.js does not cover');
  }

  try {
    const table = resolveParties({ config, palette, yamlText: text });
    console.log(`  PartiesData: ${table.order.length} parties from "${source.country}" / "${source.electionType}"`);

    const noBaseline = table.order.filter(c => table.parties[c].baseline == null);
    if (table.baselineSource === 'partiesdata' && noBaseline.length === table.order.length) {
      warn('no party has a last_results value in PartiesData — the previous-result column will be empty. Consider parties.baselineSource "content".');
    }
    const borrowed = table.order.filter(c => table.parties[c].via.startsWith('fallback'));
    if (borrowed.length) console.log(`  via metadataFallback: ${borrowed.join(', ')}`);

    const unknownOrder = (config.parties.order || []).filter(c => !table.parties[c]);
    if (unknownOrder.length) err(`parties.order names codes that do not exist: ${unknownOrder.join(', ')}`);

    /* Two parties in one EP group get one colour. Fine in a table, unreadable
       in a chart, so it is worth saying while there is time to override. */
    const byColor = new Map();
    for (const code of table.order) {
      const c = table.parties[code].color.toLowerCase();
      (byColor.get(c) || byColor.set(c, []).get(c)).push(code);
    }
    for (const [color, codes] of byColor) {
      if (codes.length > 1) {
        warn(`${codes.join(' and ')} share the colour ${color} — they are in the same European group. Give one an explicit \`color\` in parties.overrides if both appear in the same chart.`);
      }
    }
  } catch (e) {
    err(e.message);
    const available = listEntries(doc, source.country);
    if (available.length) {
      console.log(`  entries available for "${source.country}":`);
      for (const a of available) console.log(`    "${a.electionType}"  (${a.parties} parties)`);
    }
  }
}

async function main() {
  const config = loadConfig();
  const palette = loadPalette();

  checkPlaceholders(config);
  checkElection(config);
  checkSheet(config);
  checkCharts(config);
  checkContent(config);
  await checkParties(config, palette);

  for (const w of warnings) console.log(`WARN   ${w}`);
  for (const e of errors) console.error(`ERROR  ${e}`);

  console.log(`\n${errors.length} error(s), ${warnings.length} warning(s)`);
  if (errors.length) process.exit(1);
  console.log('config looks usable');
}

if (require.main === module) {
  main().catch(e => { console.error(`validate-config failed: ${e.message}`); process.exit(1); });
}
