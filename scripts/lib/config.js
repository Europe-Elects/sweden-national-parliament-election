'use strict';
const path = require('path');
const { ROOT, readJSON } = require('./io');

const CONFIG_PATH = path.join(ROOT, 'config.json');
const PALETTE_PATH = path.join(ROOT, 'europarty-palette.json');

/* config.json documents itself with _-prefixed notes and EXAMPLE entries.
   Neither is data; both are stripped here so nothing downstream has to. */
function isNote(key) {
  return key.startsWith('_');
}
function isExample(key) {
  return /^EXAMPLE\b/i.test(key);
}

function clean(value) {
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (isNote(k) || isExample(k) || k === '$schema') continue;
      out[k] = clean(v);
    }
    return out;
  }
  return value;
}

/* Reported by validate-config.js rather than thrown on, so a half-filled config
   can still be previewed locally. */
function isPlaceholder(value) {
  /* Not \b: the shipped chart ids are TODO01, TODO02 … and there is no word
     boundary between TODO and a digit. A negative lookahead for a letter catches
     those while leaving a real word starting with those four letters alone. */
  return typeof value === 'string' && /^TODO(?![A-Za-z])/.test(value.trim());
}

function findPlaceholders(value, trail = []) {
  const out = [];
  if (isPlaceholder(value)) out.push({ path: trail.join('.'), value });
  else if (Array.isArray(value)) value.forEach((v, i) => out.push(...findPlaceholders(v, [...trail, i])));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) out.push(...findPlaceholders(v, [...trail, k]));
  }
  return out;
}

/* Only the scripts honour this — index.html always fetches ./config.json — so it
   is for checking a config before it goes live, not for two pages in one repo. */
function configPath() {
  const i = process.argv.indexOf('--config');
  if (i !== -1 && process.argv[i + 1]) return path.resolve(process.argv[i + 1]);
  if (process.env.ELECTION_CONFIG) return path.resolve(process.env.ELECTION_CONFIG);
  return CONFIG_PATH;
}

function loadConfig(file = configPath()) {
  return clean(readJSON(file));
}

function loadPalette(file = PALETTE_PATH) {
  return clean(readJSON(file));
}

/* An empty object counts as absent, so gutting a section removes it just as
   setting it to null does. */
function sectionEnabled(config, name) {
  const s = config.sections && config.sections[name];
  return !!(s && typeof s === 'object' && Object.keys(s).length);
}

module.exports = {
  CONFIG_PATH, PALETTE_PATH, configPath,
  loadConfig, loadPalette, clean, isPlaceholder, findPlaceholders, sectionEnabled,
};
