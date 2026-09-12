# Setting up a new election page

Everything that can be automated is. What is left is the seven things below, which
all involve clicking around in someone else's product — Google, Datawrapper,
GitHub, WordPress — and none of which an API can do end to end.

Budget about an hour for a page whose charts you are copying from a previous
election, and rather more for the first one of a kind.

Work in this order. Steps 2 and 3 both feed values into step 4; step 6 is the
one that decides whether the page survives poll close.

---

## 0. Before you start

You need:

- **Write access** to a new GitHub repository under the organisation.
- **A Datawrapper API token** with `chart:read` and `chart:write`, from an
  account that can see the charts you intend to copy.
  Datawrapper → *Settings → API Tokens*.
- **A GitHub token that can read `Europe-Elects/PartiesData`.** That repository
  is **private**, so the party table cannot be fetched anonymously — a
  fine-grained PAT with *Contents: Read* on it. Alternatively, clone PartiesData
  next to this repo and skip the token locally (see step 4).
- **A Google account** that can copy the source Sheet.
- **Node 18 or newer** locally (`node --version`). Nothing to install — the
  scripts use no dependencies at all, deliberately, so an Action runner needs no
  install step on election night.

Clone this template into the new repository and confirm the tests pass before
changing anything:

```bash
node scripts/build-data.test.js
```

---

## 1. Turn on GitHub Pages and the Action

1. *Settings → Pages → Build and deployment → Deploy from a branch*, branch
   `main`, folder `/ (root)`.
2. *Settings → Secrets and variables → Actions → New repository secret*, twice:
   - `DATAWRAPPER_TOKEN` — the Datawrapper token from step 0.
   - `PARTIESDATA_TOKEN` — the PartiesData read token from step 0.

   The workflow's own `GITHUB_TOKEN` is scoped to *this* repository and cannot
   see PartiesData, which is why the second secret exists. Without it the build
   falls back to the committed `data/parties.json` and says so in the log — the
   page keeps working, but it stops picking up upstream corrections.

The workflow in `.github/workflows/update-data.yml` needs no editing. It reads
everything from `config.json`.

> `repository_dispatch` only fires for workflows **on the default branch**. The
> workflow file has to be on `main` before the Apps Script trigger in step 2
> does anything at all. If you are setting this up on a branch, the schedule
> will still run it every ten minutes, but the Sheet will not push.

---

## 2. Duplicate the Google Sheet

*File → Make a copy* on the previous election's Sheet.

**What comes along:** every tab, every formula, and the bound Apps Script
project — `apps-script.gs` in full.

**What does not, and has to be recreated by hand:**

- **The installable trigger.** Copying a Sheet never copies its triggers. Without
  this the page falls back to the ten-minute schedule, which on election night
  means results appearing up to ten minutes late.
- **The Script Properties.** A copy gets a *new* script project, so its property
  store starts empty — including the PAT.

So, on the copy:

1. *Extensions → Apps Script*. Confirm the code is there; if it is not, paste
   `apps-script.gs` in and save. **Saving the file is the deploy** — *Deploy →
   New deployment* is for web apps and add-ons and does nothing here.
2. *Project Settings → Script Properties → Add script property*, three times:

   | Property | Value |
   | --- | --- |
   | `GITHUB_PAT` | a fine-grained PAT, **this repository only**, *Contents: Read and write* |
   | `GITHUB_REPO` | `owner/repo` of the new page repository |
   | `IGNORED_TABS` | optional, comma-separated tab names — keep it in step with `sheet.ignoredTabs` in `config.json` |

3. *Triggers → Add Trigger*:
   - function `handleSheetEdit`
   - event source **From spreadsheet**
   - event type **On edit**

   It must be an **installable** trigger. A simple `onEdit` cannot call
   `UrlFetchApp`, so the dispatch would fail silently.
4. Run `testDispatch` once. This both accepts the OAuth consent screen and
   proves the PAT and repo name are right. Check the Actions tab: a run should
   appear within seconds.

**Then write down the tab names**, exactly as they appear on the tab strip,
including spaces and capitals. They go into `config.json` at `sheet.tabs`.

> Tabs are referenced by **name**, never by gid. A gid is regenerated every time
> a Sheet is duplicated, so a config full of gids is wrong the moment you copy
> the Sheet — and wrong in the quiet way, pointing at a tab that exists but
> holds something else. Names survive copying. `validate-config.js` rejects a
> tab name that is all digits for this reason.

Finally, take the Sheet ID out of the URL — the long token between `/d/` and
`/edit` — for `sheet.id`.

---

## 3. Duplicate the Datawrapper charts

Datawrapper has a copy endpoint, so this does not have to be done by hand:

```
POST /v3/charts/{id}/copy
```

`scripts/copy-charts.js` drives it. Point it at the **previous election's
`config.json`** and it copies every chart listed there, then rewrites each
copy's linked-dataset URL so it reads the new Sheet instead of the old one:

```bash
export DATAWRAPPER_TOKEN=...                     # PowerShell: $env:DATAWRAPPER_TOKEN = '...'
node scripts/copy-charts.js --source ../previous-election/config.json --dry-run
node scripts/copy-charts.js --source ../previous-election/config.json --publish
```

Fill in `sheet.id` in your `config.json` first — the script needs it to know
what to repoint the charts at.

It writes `charts-copied.json`, shaped like the `sections` blocks in
`config.json`, so filling the new IDs in is a paste rather than a
transcription. Delete that file once you have.

**Check the copies before you trust them.** The repointing step rewrites the old
Sheet ID inside whatever external-data URL the copy inherited, which preserves
the tab and range the original pointed at. It reports `not needed` or asks you
to do it by hand for any chart whose source is not a linked URL containing the
old Sheet ID. Either way, open each chart in Datawrapper and confirm *Upload
data → Link external dataset* points where you expect. A chart still reading
last election's Sheet looks completely normal until the numbers are wrong.

New copies start at **version 1**, which is what `version` should say in
`config.json` for each of them.

Mark a chart `"live": true` if it reads the Sheet and needs republishing when
the data changes, and `false` if it is static history. Only the live ones are
touched by the Action — republishing a static chart just churns its version.

---

## 4. Fill in `config.json` and `content/`

Open `config.json`. Every value that must change starts with `TODO`. Anything
you set to `null` disappears from the page, so a presidential election simply
nulls `exitSeats`, `coalitions` and `history` rather than working around them.

Two parts are worth reading closely.

### `parties.source` — pointing at PartiesData

Party names, European groups, colours and the previous-election baseline all
come from **PartiesData**. Nothing about a party is stored in this repo that
upstream already knows.

PartiesData is a **private** repository, so reading it needs either a token or a
local clone:

```bash
export PARTIESDATA_TOKEN=...          # PowerShell: $env:PARTIESDATA_TOKEN = '...'
# or, with a clone sitting next to this repo:
node scripts/fetch-parties.js --local ../PartiesData
```

`--local` is per-command. To make every script read the clone, set
`parties.source.localPath` — but leave it `null` in the committed config, since
the Action has no clone to read.

Find the entry before guessing at it:

```bash
node scripts/fetch-parties.js --list
node scripts/fetch-parties.js --list --all       # every country in the file
```

PartiesData files sub-national elections **two different ways**, and both work:

- **Under the country**, as an election type —
  `country: "Germany"`, `electionType: "Saxony-Anhalt regional parliament"`.
  Also `"Berlin regional parliament"`, `"Mecklenburg-Vorpommern regional"`.
- **As its own top-level key** —
  `country: "Belgium (Flanders)"`, `electionType: "national parliament"`.
  Also `Belgium (Wallonia)`, `Belgium (Brussels)`, `United Kingdom (Scotland)`,
  `United Kingdom (Wales)`, `Greenland (Denmark)`.

Names are verbatim and are not always what you would guess — Scotland's chambers
are `"Scottish Parliament PR Vote"` and `"Scottish Parliament FPTP Vote"`, not
`"national parliament"`. `--list` prints them.

**If the territory has no entry at all** — most Länder, most Italian regions,
most Spanish autonomous communities — you have three levers:

| Setting | Use |
| --- | --- |
| `metadataFallback` | Borrow group, colour and name from another entry, typically the country's `national parliament`. Baselines are never borrowed: a national result is not a regional one. |
| `baselineSource: "content"` | Take the previous-result column from `content/previous-result.json` instead of `last_results`. Use this whenever the fallback is doing the work. |
| `requireSource: false` | The entry genuinely does not exist. Everything then comes from `metadataFallback` and `parties.extra`. |

Consider adding the missing entry to PartiesData instead. It is the better fix,
it helps every other page, and this template then needs none of the three.

### Colours

Resolution order, highest first:

1. `parties.overrides.<key>.color` in `config.json`
2. the party's own `color:` in PartiesData
3. `europarty-palette.json`, by EP group
4. the palette's grey fallback

`europarty-palette.json` is a machine-readable transcription of the *Standard
colour pallet* comment block at the top of `Europe/partiesdata.yaml`, which is a
YAML comment and so cannot be read programmatically.

Because colour follows the European group, **two parties in the same group get
the same colour** — a Green and a regionalist Green, two ECR parties after a
split. `validate-config.js` warns about every collision. Override one of them
when both appear in the same chart.

### `content/`

One file per section, each with a `_comment` describing its shape. Party colours
are never repeated here — content files reference a party `code` and the colour
follows. Delete the `EXAMPLE` entries.

`content/demographic-seed.json` is optional: it is only what the demographic
charts draw before the pipeline has run once, so they are never blank on a first
load.

### Check it

```bash
node scripts/fetch-parties.js          # writes data/parties.json
node scripts/validate-config.js        # errors fail, warnings are advisory
node scripts/build-data.js --dry-run   # fetches every tab, writes nothing
```

Commit `data/parties.json`. The page cannot render without it, and the Action
refreshes it on every run from then on.

To preview locally, serve the directory rather than opening the file — `fetch`
does not work over `file://`:

```bash
python -m http.server 8000     # then open http://localhost:8000
```

---

## 5. Duplicate the WordPress post

Copy the previous election's post and replace the embed. The page reports its
own height to the parent frame, so the iframe does not need a hardcoded guess:

```html
<iframe id="election-frame"
        src="https://<org>.github.io/<repo>/"
        style="width:100%;border:none;" height="2000" scrolling="no"></iframe>
<script>
window.addEventListener('message', function (e) {
  var h = e.data && e.data.electionFrameHeight;
  if (h) document.getElementById('election-frame').style.height = h + 'px';
});
</script>
```

`electionFrameHeight` in that snippet must match `page.frameMessageKey` in
`config.json`. The default matches what is written above; if you change one,
change both. **If you copied the snippet from an older post it may listen for a
key named after that election** — that is the usual cause of an embed stuck at
its initial height.

Set `page.postUrl` and `page.pagesUrl` in `config.json` once both exist, then
read the next section.

---

## 6. Election-night load

**The page is not the fragile part.** It is served from a CDN, executes nothing
on any server, and after it has loaded it never contacts the WordPress host
again — its only outbound requests go to GitHub Pages, Datawrapper, Google and
a JS CDN.

**The WordPress post is the fragile part.** It is one request per reader. If
that request is served from a page cache, fifty thousand readers cost almost
nothing. If it is not, every reader is a PHP execution — and at poll close,
which is the largest simultaneous arrival of the night, that saturates the PHP
workers. The host will report this as a CPU problem. Traffic and CPU are the
same event here; what separates them is whether the cache is working.

Check it:

```bash
node scripts/check-embed.js
```

It makes a handful of requests to the post and reports, per request, whether the
response came from cache, whether PHP generated it, and whether it set a cookie.
Then it repeats the test with `?utm_source=…&mc_eid=…` attached, checks that the
post really embeds `page.pagesUrl`, that it listens for the right
`frameMessageKey`, and that the published page's own files are reachable.

For a quick manual look, on Windows:

```powershell
$u = 'https://example.org/your-post/'
1..2 | % { $r = Invoke-WebRequest $u -UseBasicParsing
  "{0} | cache={1} | php={2} | cookie={3}" -f $r.StatusCode,
    $r.Headers['X-Cache-Status'], $r.Headers['X-Powered-By'], $r.Headers['Set-Cookie'] }
```

The second request has to come back as a cache hit, with no `X-Powered-By` and
no `Set-Cookie`. Anything else means every reader is running PHP.

### The three things that break it

**A `Set-Cookie` on every response.** Practically every HTTP cache refuses to
store a response that sets a cookie, because it looks reader-specific. One
plugin doing this on every page view is enough to disable page caching for the
whole site. Find it in the output of `check-embed.js`, then either turn that
behaviour off in the plugin or exclude the cookie from the cache key at the
edge.

**Tracking parameters bypassing the cache.** Election-night traffic is
overwhelmingly social and newsletter referrals, so nearly every reader arrives
on a URL carrying `utm_*`, `fbclid` or `gclid`. Strip those from the cache key
rather than caching each variant. Mailchimp's `mc_eid` is the sharp case: it is
unique per recipient, so a newsletter send misses on every single reader unless
the parameter is ignored.

**Editing the post at poll close.** An edit purges the cache, and every reader
arriving at that instant then hits PHP at once. This template is built so the
edit is never necessary — every part of the page that changes during the evening
lives inside the iframe, in the Sheet or in `content/`. So freeze the post
before polls open, and if you do edit it, request the URL once afterwards to
refill the cache before readers do.

### If the host's cache cannot be trusted

Put a CDN in front and cache that one URL at the edge: Cache Everything, ignore
query string, edge TTL of a few minutes. The edge then serves the HTML without
PHP starting at all, which removes the host from the critical path and handles
the tracking parameters in the same move.

Independently of all of it, **publish `page.pagesUrl` alongside the article**,
in the newsletter and in social posts. That turns a host outage from "we are
dark" into "the article is down, the live data is fine".

One caveat if you lean on that fallback: GitHub Pages has a soft limit of around
ten builds an hour, and this pipeline triggers a Pages build per commit. On a
fast-moving night that can throttle — the site stays up, but the data goes
stale. The stalled-build recovery step in the workflow covers the common case.

---

## 7. Before election day

- [ ] Edit any watched tab in the Sheet and confirm a run appears in Actions
      within about 20 seconds.
- [ ] Confirm the run committed to `data/` and that Pages redeployed.
- [ ] Open the page and check the freshness line under the results table reads
      *Updated N seconds ago*, not *Reading the spreadsheet directly*. The
      second means the pipeline is not running and every reader is hitting
      Google directly.
- [ ] Put a test figure in the exit-poll tab, confirm it reaches the page, then
      clear it. Confirm the charts return to their empty state.
- [ ] Open every Datawrapper chart and confirm its data source is the **new**
      Sheet.
- [ ] `node scripts/validate-config.js` reports zero errors.
- [ ] `node scripts/check-embed.js` reports zero errors — in particular that the
      post is served from cache and does not set a cookie.
- [ ] The `page.pagesUrl` link is in the newsletter and the social posts, not
      only the article link.
- [ ] Check the page at phone width.

On the day:

- [ ] Make the last WordPress edit well before polls close, then request the URL
      once to refill the cache.
- [ ] **Freeze the post.** Everything that changes during the evening lives in
      the Sheet, in `content/` or in `config.json` — none of it needs WordPress.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Page shows *This page could not be built* | `config.json` or `data/parties.json` is missing or malformed. The message names which. |
| A section is missing entirely | It is `null` in `config.sections`, or its content file is missing or empty, or every chart ID in it still says `TODO`. |
| Party names appear as *Others* | The Sheet spells them differently from PartiesData. Add the spelling to `aliases` in `parties.overrides`. |
| Previous-result column is empty | `last_results` is absent from the PartiesData entry. Either add it upstream or switch to `baselineSource: "content"`. |
| Editing the Sheet does not trigger a run | The trigger was not recreated after copying (step 2), or `GITHUB_PAT` / `GITHUB_REPO` are unset, or the workflow is not on the default branch. |
| `cannot read PartiesData: HTTP 404` | PartiesData is private. Set `PARTIESDATA_TOKEN`, or pass `--local ../PartiesData`. A 404 rather than a 403 is what GitHub returns for a private repo you cannot see. |
| Action log says *not refreshed — using the committed copy* | `PARTIESDATA_TOKEN` is unset or expired. Not urgent: the party table changes rarely, and the committed copy is used. |
| Charts never update, everything else does | `DATAWRAPPER_TOKEN` is unset or expired, or the charts are marked `live: false`. |
| Charts update with the wrong numbers | A copied chart is still linked to the previous election's Sheet. |
| Embed is the wrong height | `page.frameMessageKey` and the WordPress listener disagree. `check-embed.js` tests for exactly this. |
| The host went down at poll close, and blames CPU | The post is almost certainly not being served from cache, so every reader is a PHP execution. Run `check-embed.js`. Traffic and CPU are the same event when the cache is bypassed. |
| `check-embed.js` shows `set-cookie` on every response | A plugin is setting a cookie site-wide, which stops caches storing the response. This alone can disable page caching for the whole site. |
| Blank page, console shows a TODO warning | Values that still start with `TODO` render as empty rather than printing "TODO" on a live page. The console lists them. |
