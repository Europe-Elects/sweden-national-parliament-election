#!/usr/bin/env node
'use strict';
/* Run: node scripts/build-data.test.js
   No framework — the repo has no build step and this needs to stay runnable
   from a bare Action runner. */

const assert = require('assert');
const { parse } = require('./lib/yaml');
const { clean, isPlaceholder, findPlaceholders } = require('./lib/config');
const { collectCharts, liveCharts, datawrapperApiBase, assertChartId } = require('./lib/charts');
const { groupBase, groupDisplay, slugCode, aliasKeys, isDark, resolveParties, listEntries, contentsUrl } = require('./lib/parties');
const { parseCSV, parseNum, buildIndex, buildExit, buildResults, buildDemographic, targetsFor } = require('./build-data');
const { cacheVerdict, phpEvidence, cookieNames, TRACKING } = require('./check-embed');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n         ${e.message}`); }
}
const throws = (fn, re) => assert.throws(fn, re);

/* ------------------------------------------------------------------ */
console.log('\nYAML subset');

const YAML_FIXTURE = [
  '# Standard colour pallet:',
  '# Centre-right / EPP: #3399FF',
  '',
  'Germany:',
  '  national parliament:',
  '    parties:',
  '      CDU/CSU:',
  '        ep_group: "EPP"',
  '        gov: "Govt."',
  '        last_results: 28.52',
  '      GRÜNE:',
  '        ep_group: "Greens/EFA"',
  '        last_results: 11.61',
  '      CD&V:',
  '        ep_group: ["EPP", "S&D"]',
  '        color: "#3399FF"    # inline comment after a value',
  '      Odd:',
  '       ep_group: "~ECR"',       // deliberately 7 spaces, as upstream has
  '    v_index: "0.79"',
  '    election_data:',
  '      last_election_date: "2025"',
  '      next_election_date: "by 2029"',
  '  "Saxony-Anhalt regional parliament":',
  '    parties:',
  '      CDU:',
  '        ep_group: "EPP"',
  '        last_results: 37.1',
  '    election_data:',
  '      last_election_date: "2021"',
].join('\n');

const DOC = parse(YAML_FIXTURE);

test('nests country -> election type -> parties', () => {
  assert.ok(DOC.Germany['national parliament'].parties['CDU/CSU']);
  assert.strictEqual(DOC.Germany['national parliament'].parties['CDU/CSU'].ep_group, 'EPP');
});
test('a quoted key keeps its spaces and punctuation', () => {
  assert.ok(DOC.Germany['Saxony-Anhalt regional parliament']);
  assert.strictEqual(DOC.Germany['Saxony-Anhalt regional parliament'].parties.CDU.last_results, 37.1);
});
test('a bare key containing & is not truncated', () => {
  assert.ok(DOC.Germany['national parliament'].parties['CD&V']);
});
test('a hex colour survives comment stripping', () => {
  assert.strictEqual(DOC.Germany['national parliament'].parties['CD&V'].color, '#3399FF');
});
test('an inline flow array becomes a real array', () => {
  assert.deepStrictEqual(DOC.Germany['national parliament'].parties['CD&V'].ep_group, ['EPP', 'S&D']);
});
test('a comment after a value is dropped, the value is not', () => {
  assert.ok(!String(DOC.Germany['national parliament'].parties['CD&V'].color).includes('#'.repeat(2)));
});
test('numbers parse, quoted numbers stay strings', () => {
  assert.strictEqual(DOC.Germany['national parliament'].parties['CDU/CSU'].last_results, 28.52);
  assert.strictEqual(DOC.Germany['national parliament'].v_index, '0.79');
  assert.strictEqual(DOC.Germany['national parliament'].election_data.last_election_date, '2025');
});
test('an inconsistently indented child still lands under its parent', () => {
  assert.strictEqual(DOC.Germany['national parliament'].parties.Odd.ep_group, '~ECR');
});
test('listEntries finds every chamber for a country', () => {
  const entries = listEntries(DOC, 'Germany').map(e => e.electionType);
  assert.deepStrictEqual(entries.sort(), ['Saxony-Anhalt regional parliament', 'national parliament']);
});

/* ------------------------------------------------------------------ */
console.log('\nep_group normalisation');

test('strips approximation and transition markers', () => {
  assert.strictEqual(groupBase('~EPP'), 'EPP');
  assert.strictEqual(groupBase('→S&D'), 'S&D');
});
test('an array or a pipe composite uses its first group', () => {
  assert.strictEqual(groupBase(['EPP', 'S&D']), 'EPP');
  assert.strictEqual(groupBase('PSD/PNL (S&D|EPP)'), 'S&D');
});
test('missing or unknown becomes the wildcard', () => {
  assert.strictEqual(groupBase(null), '*');
  assert.strictEqual(groupBase('*'), '*');
});
test('display keeps the marker the data actually carries', () => {
  assert.strictEqual(groupDisplay('~EPP'), '~EPP');
  assert.strictEqual(groupDisplay(['EPP', 'S&D']), 'EPP|S&D');
});

/* ------------------------------------------------------------------ */
console.log('\nparty codes and aliases');

test('umlauts expand the way these datasets have always spelled them', () => {
  assert.strictEqual(slugCode('GRÜNE'), 'GRUENE');
  assert.strictEqual(slugCode('Bündnis'), 'BUENDNIS');
});
test('punctuation is dropped from a code', () => {
  assert.strictEqual(slugCode('CDU/CSU'), 'CDUCSU');
  assert.strictEqual(slugCode('CD&V'), 'CDV');
});
test('an alias matches with either umlaut convention', () => {
  const keys = aliasKeys('GRÜNE');
  assert.ok(keys.includes('gruene'));
  assert.ok(keys.includes('grune'));
});
test('a trailing EU group in the label is ignored when matching', () => {
  assert.deepStrictEqual(aliasKeys('CDU (EPP)'), aliasKeys('CDU'));
});
test('light fills are flagged so their text can be darkened', () => {
  assert.strictEqual(isDark('#FFD700'), true);   // liberal yellow
  assert.strictEqual(isDark('#990000'), false);  // left red
});

/* ------------------------------------------------------------------ */
console.log('\nparty resolution');

const PALETTE = {
  groups: {
    EPP: { europarty: 'EPP', color: '#3399FF' },
    'S&D': { europarty: 'PES', color: '#FF0000' },
    'Greens/EFA': { europarty: 'EGP', color: '#009900' },
    ECR: { europarty: 'ECR', color: '#0000FF' },
    '*': { europarty: 'None', color: '#999999' },
  },
  families: { 'Animal rights': { europarty: 'Animal Politics', color: '#009076' } },
  fallback: { europarty: 'None', color: '#999999' },
  others: { code: 'OTHERS', name: 'Others', color: '#c7c4b8' },
};

const baseConfig = over => ({
  parties: {
    source: { repo: 'x/y', ref: 'main', continent: 'Europe', country: 'Germany', electionType: 'national parliament' },
    ...over,
  },
});

test('colour comes from the ep_group palette when nothing overrides it', () => {
  const t = resolveParties({ config: baseConfig(), palette: PALETTE, yamlText: YAML_FIXTURE });
  assert.strictEqual(t.parties.GRUENE.color, '#009900');
  assert.strictEqual(t.parties.GRUENE.euro, 'EGP (Greens/EFA)');
});
test('a colour in PartiesData beats the palette', () => {
  const t = resolveParties({ config: baseConfig(), palette: PALETTE, yamlText: YAML_FIXTURE });
  assert.strictEqual(t.parties.CDV.color, '#3399FF');
});
test('a colour in config beats both', () => {
  const config = baseConfig({ overrides: { 'GRÜNE': { color: '#123456' } } });
  const t = resolveParties({ config, palette: PALETTE, yamlText: YAML_FIXTURE });
  assert.strictEqual(t.parties.GRUENE.color, '#123456');
});
test('last_results becomes the baseline', () => {
  const t = resolveParties({ config: baseConfig(), palette: PALETTE, yamlText: YAML_FIXTURE });
  assert.strictEqual(t.parties.CDUCSU.baseline, 28.52);
});
test('baselineSource "content" leaves the baseline for the content file', () => {
  const t = resolveParties({ config: baseConfig({ baselineSource: 'content' }), palette: PALETTE, yamlText: YAML_FIXTURE });
  assert.strictEqual(t.parties.CDUCSU.baseline, null);
});
test('a regional entry with no national parties can borrow their metadata', () => {
  const config = baseConfig({
    source: { repo: 'x/y', ref: 'main', continent: 'Europe', country: 'Germany', electionType: 'Saxony-Anhalt regional parliament' },
    metadataFallback: [{ country: 'Germany', electionType: 'national parliament' }],
    overrides: { 'GRÜNE': {} },
  });
  const t = resolveParties({ config, palette: PALETTE, yamlText: YAML_FIXTURE });
  assert.strictEqual(t.parties.GRUENE.color, '#009900');
  assert.strictEqual(t.parties.GRUENE.via, 'fallback:Germany/national parliament');
  /* A national result is not a regional baseline, so it is deliberately absent. */
  assert.strictEqual(t.parties.GRUENE.baseline, null);
});
test('a territory with no entry at all is an error unless requireSource is off', () => {
  const missing = baseConfig({
    source: { repo: 'x/y', ref: 'main', continent: 'Europe', country: 'Germany', electionType: 'Bavaria regional parliament' },
  });
  throws(() => resolveParties({ config: missing, palette: PALETTE, yamlText: YAML_FIXTURE }), /Available election types/);

  missing.parties.requireSource = false;
  missing.parties.extra = { Local: { code: 'LOC', name: 'Local List', color: '#112233' } };
  const t = resolveParties({ config: missing, palette: PALETTE, yamlText: YAML_FIXTURE });
  assert.deepStrictEqual(t.order, ['LOC']);
  assert.strictEqual(t.source.resolved, false);
});
test('an extra party with no name is refused rather than rendered blank', () => {
  const config = baseConfig({ extra: { Ghost: { code: 'GHOST' } } });
  throws(() => resolveParties({ config, palette: PALETTE, yamlText: YAML_FIXTURE }), /gives no name/);
});
test('two parties resolving to one code is refused', () => {
  const config = baseConfig({ overrides: { 'GRÜNE': { code: 'CDUCSU' } } });
  throws(() => resolveParties({ config, palette: PALETTE, yamlText: YAML_FIXTURE }), /same code/);
});
test('parties.order puts the named codes first', () => {
  const config = baseConfig({ order: ['GRUENE'] });
  const t = resolveParties({ config, palette: PALETTE, yamlText: YAML_FIXTURE });
  assert.strictEqual(t.order[0], 'GRUENE');
  assert.strictEqual(t.order.length, new Set(t.order).size);
});
test('every party carries the spellings a sheet might use', () => {
  const t = resolveParties({ config: baseConfig(), palette: PALETTE, yamlText: YAML_FIXTURE });
  assert.ok(t.parties.GRUENE.aliases.includes('gruene'));
  assert.ok(t.parties.GRUENE.aliases.includes('grune'));
});

/* ------------------------------------------------------------------ */
console.log('\nCSV parsing');

test('strips percent signs and handles decimal commas', () => {
  assert.strictEqual(parseNum('41.7%'), 41.7);
  assert.strictEqual(parseNum('41,7'), 41.7);
  assert.strictEqual(parseNum('0'), 0);
});
test('an empty cell is null, not zero', () => {
  assert.strictEqual(parseNum(''), null);
  assert.strictEqual(parseNum(null), null);
});
test('quoted commas inside a cell do not split it', () => {
  assert.deepStrictEqual(parseCSV('"a","b, c","d"')[0], ['a', 'b, c', 'd']);
});
test('a newline inside a quoted cell does not start a new row', () => {
  const NL = String.fromCharCode(10);
  const rows = parseCSV('"a","Forschungs-' + NL + 'gruppe","c"' + NL + '"d","e","f"');
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0][1], 'Forschungs-' + NL + 'gruppe');
});

/* ------------------------------------------------------------------ */
console.log('\ntransforms');

const TABLE = resolveParties({ config: baseConfig({ overrides: { 'CDU/CSU': { code: 'CDU', aliases: ['CDU'] } } }), palette: PALETTE, yamlText: YAML_FIXTURE });
const INDEX = buildIndex(TABLE);

const exitRows = (...rows) => parseCSV(['"","CDU","GRÜNE"', ...rows].join('\n'));

test('exit poll rows keep the sheet shape', () => {
  const out = buildExit(exitRows('"Pollster A","30","10"'), { max: 100, integer: false });
  assert.strictEqual(out.published, true);
  assert.deepStrictEqual(out.rows[0], ['Pollster A', '30', '10']);
});
test('an unpublished exit poll is flagged, not failed', () => {
  const out = buildExit(exitRows('"Pollster A","",""'), { max: 100, integer: false });
  assert.strictEqual(out.published, false);
});
test('a share outside 0..100 is refused', () => {
  throws(() => buildExit(exitRows('"Pollster A","130","10"'), { max: 100, integer: false }), /out of range/);
});
test('a fractional seat count is refused', () => {
  throws(() => buildExit(exitRows('"Pollster A","30.5","10"'), { max: 200, integer: true }), /non-integer/);
});
test('seats are bounded generously, to allow overhang and levelling', () => {
  const ok = () => buildExit(exitRows('"Pollster A","60","40"'), { max: 200, integer: true, seatsTotal: 100 });
  assert.strictEqual(ok().published, true);
  throws(() => buildExit(exitRows('"Pollster A","120","120"'), { max: 200, integer: true, seatsTotal: 100 }), /sum to/);
});

const RESULT_COLS = { votes: 1, share: 2, seats: 3, changeVotes: 4, changeSeats: 5 };
const resultRows = (...rows) => parseCSV(['"Party","Votes","Share","Seats","+/-","+/- seats"', ...rows].join('\n'));

test('a party that has reported gets figures, one that has not gets nulls', () => {
  const out = buildResults(resultRows('"CDU","1000","30.5","12","-6.6","-3"', '"GRÜNE","0","0","0","-11.6","-5"'), {
    index: INDEX, columns: RESULT_COLS, totalRowPattern: 'valid votes',
  });
  const cdu = out.parties.find(p => p.code === 'CDU');
  const gru = out.parties.find(p => p.code === 'GRUENE');
  assert.strictEqual(cdu.share, 30.5);
  assert.strictEqual(cdu.changeV, -6.6);
  /* The sheet serves a full negative swing while votes are still zero, so the
     change is suppressed until the party has actually reported. */
  assert.strictEqual(gru.share, null);
  assert.strictEqual(gru.changeV, null);
  assert.strictEqual(out.counting, true);
});
test('the totals row is read as an electorate figure, not a party', () => {
  const out = buildResults(resultRows('"CDU","1000","30.5","12","-6.6","-3"', '"Valid votes","3280","","","",""'), {
    index: INDEX, columns: RESULT_COLS, totalRowPattern: 'valid votes',
  });
  assert.strictEqual(out.validVotes, 3280);
  assert.strictEqual(out.parties.length, 1);
});
test('shares summing past 105 are refused', () => {
  throws(() => buildResults(resultRows('"CDU","10","80","1","0","0"', '"GRÜNE","10","40","1","0","0"'), {
    index: INDEX, columns: RESULT_COLS, totalRowPattern: 'valid votes',
  }), /sum to/);
});
test('a party the config does not know still parses, with no code', () => {
  const out = buildResults(resultRows('"Mystery List","10","1.0","0","0","0"'), {
    index: INDEX, columns: RESULT_COLS, totalRowPattern: 'valid votes',
  });
  assert.strictEqual(out.parties[0].code, null);
});
test('a results tab with no seat column still works', () => {
  const out = buildResults(resultRows('"CDU","1000","30.5","","",""'), {
    index: INDEX, columns: { votes: 1, share: 2, seats: null, changeVotes: null, changeSeats: null }, totalRowPattern: 'valid votes',
  });
  assert.strictEqual(out.parties[0].seats, null);
});

const demoRows = (...rows) => parseCSV(['"Group","Subgroup","Party","2016","2021"', ...rows].join('\n'));

test('long demographic rows become a nested object', () => {
  const out = buildDemographic(demoRows('"Age","18-29","CDU","20","25"'), { index: INDEX });
  assert.deepStrictEqual(out.years, ['2016', '2021']);
  assert.deepStrictEqual(out.data.Age['18-29'].CDU, { 2016: 20, 2021: 25 });
  assert.deepStrictEqual(out.order.Age, ['18-29']);
});
test('a subgroup with no figures yet is kept out of the dropdowns', () => {
  const out = buildDemographic(demoRows('"Age","18-29","CDU","20","25"', '"Age","30-44","CDU","",""'), { index: INDEX });
  assert.deepStrictEqual(out.order.Age, ['18-29']);
});
test('an unknown party names itself rather than failing silently', () => {
  throws(() => buildDemographic(demoRows('"Age","18-29","Mystery","20","25"'), { index: INDEX }), /Mystery/);
});
test('a tab with no year columns is refused', () => {
  throws(() => buildDemographic(parseCSV('"Group","Subgroup","Party","notayear"\n"Age","18-29","CDU","20"'), { index: INDEX }), /no year columns/);
});

/* ------------------------------------------------------------------ */
console.log('\nconfig handling');

test('notes and worked examples are stripped before anything reads the config', () => {
  const out = clean({ a: 1, _note: 'x', 'EXAMPLE — delete me': { b: 2 }, nested: { _n: 1, c: 3 } });
  assert.deepStrictEqual(out, { a: 1, nested: { c: 3 } });
});
test('a leftover TODO is detected wherever it is nested', () => {
  assert.strictEqual(isPlaceholder('TODO fill me in'), true);
  assert.strictEqual(isPlaceholder('to do later'), false);
  const found = findPlaceholders({ election: { title: 'TODO x' }, charts: [{ id: 'TODO1' }] });
  assert.deepStrictEqual(found.map(f => f.path).sort(), ['charts.0.id', 'election.title']);
});

const CHART_CONFIG = {
  sections: {
    off: null,
    turnout: { chart: { id: 'aaaaa', live: true } },
    projections: { charts: [{ id: 'bbbbb', live: true }, { id: 'ccccc', live: false }] },
    plain: { heading: 'no charts here' },
  },
};

test('charts are collected from both section shapes, and null sections skipped', () => {
  assert.deepStrictEqual(collectCharts(CHART_CONFIG).map(c => c.id), ['aaaaa', 'bbbbb', 'ccccc']);
});
test('only live charts are republished — static history is left alone', () => {
  assert.deepStrictEqual(liveCharts(CHART_CONFIG).map(c => c.id), ['aaaaa', 'bbbbb']);
});

/* ------------------------------------------------------------------ */
console.log('\nembed and cache checks');

const H = o => new Headers(o);

test('a cache hit is recognised whatever the stack calls its header', () => {
  assert.strictEqual(cacheVerdict(H({ 'x-cache-status': 'HIT' })).hit, true);
  assert.strictEqual(cacheVerdict(H({ 'cf-cache-status': 'hit' })).hit, true);
  assert.strictEqual(cacheVerdict(H({ 'x-litespeed-cache': 'hit' })).hit, true);
  assert.strictEqual(cacheVerdict(H({ 'x-cache': 'HIT from edge' })).hit, true);
});
test('a miss, and no cache header at all, both count as not cached', () => {
  assert.strictEqual(cacheVerdict(H({ 'x-cache-status': 'MISS' })).hit, false);
  assert.strictEqual(cacheVerdict(H({ 'x-cache-status': 'BYPASS' })).hit, false);
  assert.strictEqual(cacheVerdict(H({ 'x-cache-status': 'DYNAMIC' })).hit, false);
  assert.strictEqual(cacheVerdict(H({})).hit, false);
  assert.strictEqual(cacheVerdict(H({})).header, null);
});
test('a positive age betrays a cache even with no vendor header', () => {
  assert.strictEqual(cacheVerdict(H({ age: '120' })).hit, true);
  assert.strictEqual(cacheVerdict(H({ age: '0' })).hit, false);
});
test('PHP-generated headers are what prove WordPress booted for a response', () => {
  assert.deepStrictEqual(phpEvidence(H({ 'x-powered-by': 'PHP/8.3.33' })), ['PHP/8.3.33']);
  assert.deepStrictEqual(phpEvidence(H({ 'x-pingback': 'https://x/xmlrpc.php' })), ['X-Pingback']);
  assert.deepStrictEqual(phpEvidence(H({ link: '<https://x/wp-json/>; rel="https://api.w.org/"' })), ['Link: wp-json']);
  assert.deepStrictEqual(phpEvidence(H({ 'x-powered-by': 'Express' })), []);
  assert.deepStrictEqual(phpEvidence(H({})), []);
});
test('cookie names are reported, since Set-Cookie is what stops a response caching', () => {
  assert.deepStrictEqual(cookieNames(H({ 'set-cookie': 'wpautoterms_cache_detector=0; path=/; secure' })), ['wpautoterms_cache_detector']);
  assert.deepStrictEqual(cookieNames(H({})), []);
});
test('the tracking probe covers the params that actually arrive on election night', () => {
  for (const p of ['utm_source', 'utm_medium', 'utm_campaign', 'fbclid', 'mc_eid']) {
    assert.ok(TRACKING.includes(p), `${p} missing from the probe`);
  }
});

/* ------------------------------------------------------------------ */
console.log('\ninput guards');

test('the Datawrapper token is only ever sent to Datawrapper', () => {
  const at = host => ({ automation: { datawrapper: { apiBase: host } } });
  assert.strictEqual(datawrapperApiBase(at('https://api.datawrapper.de/v3')), 'https://api.datawrapper.de/v3');
  assert.strictEqual(datawrapperApiBase({}), 'https://api.datawrapper.de/v3');
  throws(() => datawrapperApiBase(at('https://evil.example.com/v3')), /not a known Datawrapper host/);
  throws(() => datawrapperApiBase(at('http://api.datawrapper.de/v3')), /must be https/);
  throws(() => datawrapperApiBase(at('not a url')), /not a URL/);
});
test('a chart id that would walk the API path is refused', () => {
  assert.strictEqual(assertChartId('abc12', 'test'), 'abc12');
  throws(() => assertChartId('../../users/me', 'test'), /not a Datawrapper chart ID/);
  throws(() => assertChartId('abc12/publish?x=1', 'test'), /not a Datawrapper chart ID/);
});
test('a repo or ref that would walk the token-bearing URL is refused', () => {
  const src = over => ({ repo: 'Europe-Elects/PartiesData', ref: 'main', continent: 'Europe', ...over });
  assert.ok(contentsUrl(src()).startsWith('https://api.github.com/repos/Europe-Elects/PartiesData/contents/'));
  throws(() => contentsUrl(src({ repo: 'a/../../b' })), /should be owner\/name/);
  throws(() => contentsUrl(src({ repo: 'evil.com/x/y' })), /should be owner\/name/);
  throws(() => contentsUrl(src({ ref: '../main' })), /should be a branch/);
});
test('a colour that is not a plain hex never reaches a style attribute', () => {
  const yaml = YAML_FIXTURE.replace('        color: "#3399FF"', '        color: "red;background:url(//evil)"');
  const t = resolveParties({ config: baseConfig(), palette: PALETTE, yamlText: yaml });
  assert.strictEqual(t.parties.CDV.color, '#3399FF');   // falls back to the EPP palette entry
  const t2 = resolveParties({ config: baseConfig({ overrides: { 'GRÜNE': { color: 'expression(alert(1))' } } }), palette: PALETTE, yamlText: YAML_FIXTURE });
  assert.strictEqual(t2.parties.GRUENE.color, '#009900');
});

test('a tab with no section, or a section with no tab, builds nothing', () => {
  const config = {
    election: { seatsTotal: 100 },
    sheet: { id: 'x', tabs: { exitVotes: 'exit', exitSeats: null, results: 'results', demographic: 'demo' } },
    sections: { exitVotes: { label: 'x' }, results: { label: 'y' }, demographics: null },
  };
  assert.deepStrictEqual(targetsFor(config, INDEX).map(t => t.file), ['exitVotes.json', 'results.json']);
});

/* ------------------------------------------------------------------ */
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
