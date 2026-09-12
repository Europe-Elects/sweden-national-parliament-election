#!/usr/bin/env node
'use strict';
/* Resolves the party table out of PartiesData and writes data/parties.json.
   build-data.js refreshes it on every run too, so this is normally only needed
   when setting a page up.

   Usage:
     node scripts/fetch-parties.js                 write data/parties.json
     node scripts/fetch-parties.js --list          list every entry for the configured country
     node scripts/fetch-parties.js --list --all    list every country in the file
     node scripts/fetch-parties.js --local ../PartiesData
                                                   read a local checkout instead of GitHub
*/

const path = require('path');
const { DATA_DIR, writeIfChanged } = require('./lib/io');
const { loadConfig, loadPalette } = require('./lib/config');
const { fetchPartiesYaml, listEntries, resolveParties } = require('./lib/parties');
const { parse } = require('./lib/yaml');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true);
}

async function main() {
  const config = loadConfig();
  const palette = loadPalette();
  const source = (config.parties && config.parties.source) || {};

  const { text, from } = await fetchPartiesYaml(source, { local: arg('--local') });
  console.log(`read ${from}`);

  if (process.argv.includes('--list')) {
    const doc = parse(text);
    const country = process.argv.includes('--all') ? null : source.country;
    const entries = listEntries(doc, country);
    if (!entries.length) {
      console.log(country
        ? `no entries for "${country}" — check the spelling, and remember sub-national units are sometimes their own top-level key, e.g. "Belgium (Flanders)"`
        : 'no entries found at all');
      return;
    }
    for (const e of entries) {
      console.log(`  ${e.country}  ->  "${e.electionType}"  (${e.parties} parties)`);
    }
    return;
  }

  const resolved = resolveParties({ config, palette, yamlText: text });
  const dest = path.join(DATA_DIR, 'parties.json');
  const changed = writeIfChanged(dest, resolved);

  console.log(`${changed ? 'updated' : 'unchanged'}  data/parties.json  (${resolved.order.length} parties)`);
  if (!resolved.source.resolved) {
    console.log('note: the configured PartiesData entry does not exist; every party came from metadataFallback or parties.extra');
  }
  const derived = resolved.order.filter(c => resolved.parties[c].via !== 'source');
  if (derived.length) console.log(`note: not in the primary entry: ${derived.join(', ')}`);
}

if (require.main === module) {
  main().catch(e => { console.error(`fetch-parties failed: ${e.message}`); process.exit(1); });
}
