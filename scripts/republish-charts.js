#!/usr/bin/env node
'use strict';
/* Republishes every chart marked `live: true`. Those read the Sheet themselves,
   and republishing is what makes them re-fetch it; `live: false` is static
   history and republishing it would only churn version numbers.

   Without DATAWRAPPER_TOKEN it exits 0 with a warning, so a fork is not a
   failure. */

const { loadConfig } = require('./lib/config');
const { liveCharts, isPlaceholderId, datawrapperApiBase, assertChartId } = require('./lib/charts');

async function main() {
  const config = loadConfig();
  const token = process.env.DATAWRAPPER_TOKEN;
  const apiBase = datawrapperApiBase(config);

  if (config.automation && config.automation.datawrapper && config.automation.datawrapper.republishOnUpdate === false) {
    console.log('republishOnUpdate is false — skipping');
    return;
  }
  if (!token) {
    console.log('::warning::DATAWRAPPER_TOKEN not set — skipping chart republish');
    return;
  }

  const charts = liveCharts(config);
  const unfilled = charts.filter(c => isPlaceholderId(c.id));
  if (unfilled.length) {
    console.log(`::warning::${unfilled.length} chart id(s) still say TODO — skipping those: ${unfilled.map(c => c.section).join(', ')}`);
  }
  const targets = charts.filter(c => !isPlaceholderId(c.id));
  if (!targets.length) {
    console.log('no live charts configured — nothing to republish');
    return;
  }

  let failed = 0;
  for (const chart of targets) {
    try {
      assertChartId(chart.id, `sections.${chart.section}`);
      const res = await fetch(`${apiBase}/charts/${chart.id}/publish`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) console.log(`republished ${chart.id}  (${chart.section} · ${chart.label || ''})`.trimEnd());
      else { failed++; console.log(`::warning::${chart.id} republish returned HTTP ${res.status}`); }
    } catch (e) {
      failed++;
      console.log(`::warning::${chart.id} republish failed: ${e.message}`);
    }
  }

  /* One failure is a hiccup the next run catches. All of them is a bad token,
     which nothing fixes on its own. */
  if (failed === targets.length) {
    console.error('::error::every chart republish failed — check DATAWRAPPER_TOKEN');
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(e => { console.error(`republish-charts failed: ${e.message}`); process.exit(1); });
}
