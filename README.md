# Election page template

A live election-night page for any European election — national, regional or
presidential. Standing a new one up means filling in `config.json` and the files
in `content/`. No code changes.

New page? Go straight to **[SETUP.md](SETUP.md)**.

---

## The two paths

Data reaches the page two ways, and which one a section uses is a property of
the section, not a setting.

**Path 1 — Datawrapper.** Projections, coalition options, turnout and electoral
history are Datawrapper charts wired directly to the Google Sheet. Datawrapper
holds the data connection; the pipeline's only job is to *republish* the chart,
which is what makes it re-fetch. These sections are configured as `charts` or
`chart` entries under a section, and the ones marked `"live": true` are
republished on every update.

**Path 2 — JSON in the repo.** The results table, both exit-poll charts and the
demographic breakdowns are drawn by the page itself. A GitHub Action reads the
Sheet, transforms and validates it, writes `data/*.json` and commits. The page
polls those files, which sit behind the Pages CDN.

The split is deliberate. Path 1 gets Datawrapper's rendering for free on the
charts that are visually complex and rarely need custom behaviour. Path 2 gets
validation, a fail-safe on bad data, and a CDN in front of the reads — which
matters, because the Sheet sends `no-store` and every reader polling it directly
reaches Google unbuffered.

The page falls back to reading the Sheet directly if the pipeline has never
produced figures, and rations those requests. Once the pipeline has served real
figures the Sheet is not consulted again: reverting to an older snapshot after a
blip would visibly rewind results mid-count.

---

## How an update travels

```
analyst edits the Sheet
   |
   v
Apps Script  on-edit trigger, 20s debounce, catch-up timer
   |  repository_dispatch: sheet-updated
   v
GitHub Action
   |-- fetch PartiesData -> data/parties.json
   |-- fetch each Sheet tab -> validate -> data/*.json -> commit
   +-- POST /charts/{id}/publish for every live chart
   |
   v
GitHub Pages           Datawrapper CDN
   |                        |
   +----------> the page <--+
```

A ten-minute cron runs the same job as a backstop. The Apps Script dispatch is
the primary trigger; the schedule exists so a broken trigger degrades to "late"
rather than "silent".

---

## Where things live

| Path | What it is |
| --- | --- |
| `config.json` | The whole page: titles, dates, Sheet tabs, chart IDs, party source, which sections exist. |
| `config.schema.json` | Schema for the above — editors autocomplete against it. |
| `europarty-palette.json` | EP group → europarty name and colour. Transcribed from the palette comment block in PartiesData. |
| `content/*.json` | Editorial content: prose, candidates, poll series, record lists. |
| `data/*.json` | Generated. Never edit by hand. |
| `index.html` | The whole front end. Contains no election-specific value. |
| `apps-script.gs` | Bound to the Sheet. Reads its settings from Script Properties, so it needs no per-page edit. |
| `scripts/lib/` | Shared: config loading, the PartiesData reader, the YAML subset parser. |

## Commands

```bash
node scripts/build-data.test.js                     # 62 tests, no dependencies
node scripts/fetch-parties.js                       # write data/parties.json
node scripts/fetch-parties.js --list                # what PartiesData has for this country
node scripts/fetch-parties.js --local ../PartiesData  # read a local checkout
node scripts/validate-config.js                     # check config and content
node scripts/check-embed.js                         # is the WordPress post actually cached?
node scripts/build-data.js --dry-run                # fetch and validate, write nothing
node scripts/build-data.js                          # the pipeline
node scripts/republish-charts.js                    # republish live charts
node scripts/copy-charts.js --source ../old/config.json --publish
```

No `package.json`, no lockfile, no install step — on purpose. This runs on a
bare Action runner on election night and the dependency that cannot break is the
one that is not there.

---

## Party data

Party names, European groups, colours and previous-election baselines come from
[PartiesData](https://github.com/Europe-Elects/PartiesData), read at build time
from `<continent>/partiesdata.yaml`. `config.json` carries only what upstream has
no opinion about: which spellings the Sheet uses, and deliberate colour
departures.

PartiesData is **private**, so it is read through the GitHub Contents API with a
`PARTIESDATA_TOKEN` — the Action's own `GITHUB_TOKEN` is scoped to this
repository and cannot see it. Locally, `--local ../PartiesData` reads a clone
instead. The browser never touches it: the resolved table is committed as
`data/parties.json`, which is what the page fetches. If the refresh fails and a
committed copy exists, the build warns and carries on with it.

Sub-national elections are filed upstream either under the country
(`Germany` → `"Saxony-Anhalt regional parliament"`) or as their own top-level key
(`United Kingdom (Scotland)`). Both work. Where a territory has no entry at all,
`metadataFallback`, `baselineSource: "content"` and `requireSource: false` cover
it — see SETUP.md.

`scripts/lib/yaml.js` is a small reader for the subset PartiesData uses rather
than a general YAML parser. That is a considered trade: pulling in `js-yaml`
would mean a `package.json`, a lockfile and an install step on the critical path
of an election-night pipeline. It is tested against the real file — 54
countries, 186 entries, 2,077 parties — and `validate-config.js` fails loudly if
upstream ever grows syntax it does not model.

---

## Design notes

Some choices in here look odd until the failure they exist for is named.

**The Apps Script watches a deny-list, not an allow-list.** An allow-list of
watched tabs fails silently and expensively: a tab wired into the pipeline but
never added dispatches nothing, so its figures only reach the page when someone
happens to touch a different tab. A deny-list fails the cheap way round — forget
a tab and the cost is one run that ends in "no data changes".

**A failed tab keeps its existing JSON.** Publishing stale data beats publishing
wrong data on election night.

**The Action pushes with a rebuild-and-retry, not a rebase.** `data/` is
generated, never authored, so a rejected push is not a merge problem — rebasing
two independently built copies of the same JSON just conflicts on the timestamp.

**The workflow requests a Pages build when the last one errored or has been
"building" for over five minutes.** A stalled Pages build serves the previous
commit indefinitely while GitHub reports Pages as operational, and nothing else
signals it.

**Files are only rewritten when something other than the timestamp changed**, so
a quiet poll does not commit and Pages does not rebuild.

**The page shows how old its data is.** Without that, a dead pipeline looks
exactly like a quiet one.

**`client_payload` is never read.** The dispatch PAT is attacker-controlled if it
leaks, and a payload that is never read cannot be injected into a run step.

**The page never calls back to the WordPress host.** After it loads, its only
requests go to GitHub Pages, Datawrapper, Google and a JS CDN. So the host sees
exactly one request per reader — the post itself — and whether that request is
served from a page cache decides whether poll close is free or fatal. When it is
not cached, every reader becomes a PHP execution and the host reports the result
as a CPU problem. `scripts/check-embed.js` tests for it; SETUP.md section 6 has
the detail.
