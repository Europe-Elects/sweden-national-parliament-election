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

  /* A page whose election is over keeps running: the workflow still has its
     schedule, and nothing in it knows the night has been and gone. One such
     page republished seven charts every run for a week after polling day and
     reached version 248, which is roughly 1,700 API calls spent on figures that
     had stopped changing. The quota is shared across the organisation, so that
     is taken from whichever election is next.

     Republishing stops on its own once the result is final. */
  const iso = config.election && config.election.date && config.election.date.iso;
  const graceDays = (config.automation && config.automation.republishUntilDays) ?? 7;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) {
    const daysSince = (Date.now() - Date.parse(iso + 'T00:00:00Z')) / 86400000;
    if (daysSince > graceDays) {
      console.log(
        `the election was ${Math.floor(daysSince)} days ago, past the ${graceDays}-day window — skipping. ` +
        `Set automation.republishUntilDays higher if the charts genuinely still change.`
      );
      return;
    }
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
