'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data');

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/* Ignore the timestamp when comparing, so a quiet poll does not commit and
   Pages does not rebuild. */
function writeIfChanged(dest, payload) {
  const next = JSON.stringify(payload, null, 2);
  if (fs.existsSync(dest)) {
    const strip = s => s.replace(/^\s*"updated": "[^"]*",?$/m, '').trim();
    if (strip(fs.readFileSync(dest, 'utf8')) === strip(next)) return false;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, next + '\n');
  return true;
}

async function fetchText(url, { attempts = 3, headers = {} } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers: { 'Cache-Control': 'no-cache', ...headers } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

module.exports = { ROOT, DATA_DIR, readJSON, writeIfChanged, fetchText };
