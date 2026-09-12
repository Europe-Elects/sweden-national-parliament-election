#!/usr/bin/env node
'use strict';
/* Duplicates a previous page's Datawrapper charts and repoints them at this
   page's Sheet. Doing it by hand is the slowest part of standing a page up, and
   the part where a mistake is least visible — a chart still reading last
   election's Sheet looks fine until the numbers are wrong.


     POST /v3/charts/{id}/copy     duplicate, keeping every visual setting
     GET  /v3/charts/{id}          read the copy's data source
     PATCH /v3/charts/{id}         point that source at the new Sheet

   Usage:
     node scripts/copy-charts.js --source ../previous-election/config.json
     node scripts/copy-charts.js --source ../previous-election/config.json --publish
     node scripts/copy-charts.js --source ../previous-election/config.json --dry-run

   Needs DATAWRAPPER_TOKEN with chart:read and chart:write scopes, and the token
   must belong to an account that can see the source charts.

   The repointing step rewrites the Sheet ID inside whatever external-data URL
   the copy inherited, which keeps the tab and range the original pointed at. It
   is skipped, with a note, for any chart whose data source is not an external
   URL containing the old Sheet ID — an uploaded CSV, say. Check the result in
   Datawrapper before trusting it: Upload data -> Link external dataset. */

const fs = require('fs');
const path = require('path');
const { ROOT } = require('./lib/io');
const { loadConfig, clean } = require('./lib/config');
const { collectCharts, isPlaceholderId, datawrapperApiBase, assertChartId } = require('./lib/charts');

const DRY_RUN = process.argv.includes('--dry-run');
const PUBLISH = process.argv.includes('--publish');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

async function api(apiBase, token, method, endpoint, body) {
  const res = await fetch(`${apiBase}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${endpoint} -> HTTP ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

function newIdOf(response) {
  return response.id || (response.data && response.data.id) || null;
}

/* Reads whichever of the two spellings metadata.data uses and writes back the
   same one, rather than assuming. */
function readExternalUrl(chart) {
  const d = (chart && chart.metadata && chart.metadata.data) || {};
  if (typeof d['external-data'] === 'string') return { key: 'external-data', url: d['external-data'] };
  if (typeof d.externalData === 'string') return { key: 'externalData', url: d.externalData };
  return null;
}

async function main() {
  const sourcePath = arg('--source');
  if (!sourcePath) throw new Error('pass --source <path to the previous page\'s config.json>');

  const target = loadConfig();
  const source = clean(JSON.parse(fs.readFileSync(sourcePath, 'utf8')));

  const token = process.env.DATAWRAPPER_TOKEN;
  if (!token && !DRY_RUN) throw new Error('DATAWRAPPER_TOKEN is not set');

  /* Allow-listed before any token is attached. */
  const apiBase = datawrapperApiBase(target);

  const oldSheetId = source.sheet && source.sheet.id;
  const newSheetId = target.sheet && target.sheet.id;
  if (!newSheetId || /^TODO\b/.test(newSheetId)) throw new Error('fill in sheet.id in this page\'s config.json first');

  const charts = collectCharts(source).filter(c => !isPlaceholderId(c.id));
  if (!charts.length) throw new Error(`no chart ids found in ${sourcePath}`);

  console.log(`copying ${charts.length} chart(s) from ${sourcePath}`);
  console.log(`repointing ${oldSheetId || '(no sheet id in source config)'} -> ${newSheetId}\n`);

  const mapping = [];
  for (const chart of charts) {
    const where = `${chart.section} · ${chart.label || ''}`.trim();
    if (DRY_RUN) {
      console.log(`would copy ${chart.id}  (${where})`);
      mapping.push({ ...chart, oldId: chart.id, id: 'DRYRUN' });
      continue;
    }

    try {
      assertChartId(chart.id, `${sourcePath} sections.${chart.section}`);
      const copy = await api(apiBase, token, 'POST', `/charts/${chart.id}/copy`);
      const id = newIdOf(copy);
      if (!id) throw new Error('copy succeeded but returned no chart id');
      /* Written into config.json and used in further calls, so same check. */
      assertChartId(id, 'the copy returned by Datawrapper');

      let repointed = 'not needed';
      const full = await api(apiBase, token, 'GET', `/charts/${id}`);
      const external = readExternalUrl(full);
      if (external && oldSheetId && external.url.includes(oldSheetId)) {
        const url = external.url.split(oldSheetId).join(newSheetId);
        await api(apiBase, token, 'PATCH', `/charts/${id}`, {
          metadata: { data: { [external.key]: url, 'upload-method': 'external-data' } },
        });
        repointed = 'repointed';
      } else if (external) {
        repointed = 'external URL does not contain the old Sheet ID — set it by hand';
      } else {
        repointed = 'no linked dataset — set the data source by hand';
      }

      if (PUBLISH) await api(apiBase, token, 'POST', `/charts/${id}/publish`);

      console.log(`${chart.id} -> ${id}  (${where})  ${repointed}${PUBLISH ? ', published' : ''}`);
      mapping.push({ ...chart, oldId: chart.id, id, version: 1 });
    } catch (e) {
      console.error(`FAILED ${chart.id} (${where}): ${e.message}`);
      mapping.push({ ...chart, oldId: chart.id, id: null, error: e.message });
    }
  }

  /* Shaped like config.json so filling in the ids is a paste. */
  const bySection = {};
  for (const m of mapping) {
    (bySection[m.section] ||= []).push({
      label: m.label, id: m.id, version: 1, height: m.height, ariaLabel: m.ariaLabel, live: m.live,
    });
  }
  const out = path.join(ROOT, 'charts-copied.json');
  fs.writeFileSync(out, JSON.stringify(bySection, null, 2) + '\n');
  console.log(`\nwrote ${path.relative(ROOT, out)} — paste each section's charts into config.json, then delete it`);
  if (!PUBLISH) console.log('the copies are unpublished; publish them in Datawrapper or re-run with --publish');
  console.log('verify each chart\'s data source in Datawrapper (Upload data -> Link external dataset) before election day');
}

if (require.main === module) {
  main().catch(e => { console.error(`copy-charts failed: ${e.message}`); process.exit(1); });
}
