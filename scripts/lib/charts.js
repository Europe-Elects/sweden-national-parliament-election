'use strict';
/* Sections hold charts as a `charts` array, a single `chart`, or neither, so
   callers go through here rather than each knowing the section layout. */

function collectCharts(config) {
  const out = [];
  const sections = config.sections || {};
  for (const [name, section] of Object.entries(sections)) {
    if (!section || typeof section !== 'object') continue;
    if (section.chart) out.push({ section: name, ...section.chart });
    if (Array.isArray(section.charts)) {
      section.charts.forEach(c => c && out.push({ section: name, ...c }));
    }
  }
  return out.filter(c => c.id);
}

const isPlaceholderId = id => /^TODO/i.test(String(id || ''));

/* config.json decides where the Datawrapper token is sent, so a bad edit could
   hand it to another host. Checked rather than trusted. Self-hosted installs add
   their host here — a visible code change, not a one-line config edit. */
const ALLOWED_API_HOSTS = ['api.datawrapper.de'];

function datawrapperApiBase(config) {
  const configured = (config.automation && config.automation.datawrapper && config.automation.datawrapper.apiBase)
    || 'https://api.datawrapper.de/v3';
  let url;
  try {
    url = new URL(configured);
  } catch (e) {
    throw new Error(`automation.datawrapper.apiBase is not a URL: ${JSON.stringify(configured)}`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`automation.datawrapper.apiBase must be https, got ${url.protocol}`);
  }
  if (!ALLOWED_API_HOSTS.includes(url.hostname)) {
    throw new Error(
      `automation.datawrapper.apiBase points at ${url.hostname}, which is not a known Datawrapper host. ` +
      `The API token would be sent there. Allowed: ${ALLOWED_API_HOSTS.join(', ')}.`
    );
  }
  return configured.replace(/\/+$/, '');
}

function liveCharts(config) {
  return collectCharts(config).filter(c => c.live);
}

function embedUrl(chart) {
  return `https://datawrapper.dwcdn.net/${encodeURIComponent(chart.id)}/${chart.version || 1}/`;
}

/* IDs go straight into an API path, and copy-charts.js reads them from another
   repository's config, so the shape is checked before use. */
function assertChartId(id, where) {
  if (!/^[A-Za-z0-9]{4,8}$/.test(String(id))) {
    throw new Error(`"${id}" is not a Datawrapper chart ID (${where}) — expected 4-8 letters and digits`);
  }
  return id;
}

module.exports = {
  collectCharts, liveCharts, embedUrl, isPlaceholderId,
  datawrapperApiBase, assertChartId, ALLOWED_API_HOSTS,
};
