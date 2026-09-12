/* Google Apps Script — bound to the election Sheet.

   Nothing in this file is election-specific: both settings come from Script
   Properties, which survive the Sheet being duplicated and mean this file never
   has to be edited per page.

   Setup (Extensions > Apps Script, paste this file, then):
     - Project Settings > Script Properties:
         GITHUB_PAT    a fine-grained PAT, this repo only, Contents: Read and write
         GITHUB_REPO   owner/repo of this page's repository
         IGNORED_TABS  optional, comma-separated tab names to ignore
     - Triggers > Add Trigger: handleSheetEdit, From spreadsheet, On edit
       (it must be an installable trigger — a simple onEdit cannot call UrlFetchApp)
     - Run testDispatch once to accept the OAuth consent screen, and check that
       the Action ran

   Saving the file is the deploy. Deploy > New deployment is for web apps and
   add-ons; an installable trigger always runs the current saved code, so that
   button does nothing here.

   Duplicating a Sheet copies this script but NOT its triggers or its script
   properties. Both have to be recreated by hand on the copy — see SETUP.md. */

const DEBOUNCE_MS = 20000;

function props() {
  return PropertiesService.getScriptProperties();
}

function repo() {
  const value = props().getProperty('GITHUB_REPO');
  if (!value) throw new Error('GITHUB_REPO missing from Script Properties (expected owner/repo)');
  return value.trim();
}

/* A deny-list on purpose. An allow-list of watched tabs fails silently and
   expensively: a tab wired into the pipeline but never added to the list
   dispatches nothing, so its figures only reach the page when someone happens to
   touch a different tab — hours late, with nothing anywhere reporting a fault.

   A deny-list fails the cheap way round. Forget to list a tab and the worst case
   is one extra run that ends in "no data changes"; the pipeline already no-ops
   when a tab is unchanged. List a tab here only if it is edited often AND feeds
   nothing on the page. Keep it in step with sheet.ignoredTabs in config.json. */
function ignoredTabs() {
  const raw = props().getProperty('IGNORED_TABS') || '';
  return raw.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s.length; });
}

function handleSheetEdit(e) {
  if (!e || !e.range) return;
  if (ignoredTabs().indexOf(e.range.getSheet().getName()) !== -1) return;

  /* Whether we are inside the debounce window is a read-modify-write over one
     shared property, so it has to hold the lock. Without it two edits landing
     together both read the old timestamp, both find the window clear, and both
     dispatch — twin runs in the same second. */
  const lock = LockService.getScriptLock();
  const locked = lock.tryLock(10000);

  let windowClear = false;
  if (locked) {
    try {
      const now = Date.now();
      const last = Number(props().getProperty('lastDispatch') || 0);
      windowClear = now - last >= DEBOUNCE_MS;
      if (windowClear) props().setProperty('lastDispatch', String(now));
    } finally {
      lock.releaseLock();
    }
  }

  /* Dispatch outside the lock. The HTTP call takes about a second and holding
     the lock across it would queue every concurrent edit behind it. */
  if (windowClear) { dispatch(); return; }

  /* Either inside the window, or another execution held the lock. Both mean this
     edit might be the last of a burst, so make sure something fires after it
     rather than assuming the earlier dispatch covered it. */
  scheduleCatchUp();
}

function scheduleCatchUp() {
  const lock = LockService.getScriptLock();
  /* Waits as long as handleSheetEdit does: under a burst every execution wants
     this lock at once, and a short timeout drops catch-ups on the floor. */
  if (!lock.tryLock(10000)) return;
  try {
    if (pendingCatchUps().length) return;
    ScriptApp.newTrigger('catchUpDispatch').timeBased().after(60000).create();
  } finally {
    lock.releaseLock();
  }
}

function pendingCatchUps() {
  return ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'catchUpDispatch';
  });
}

function catchUpDispatch() {
  pendingCatchUps().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  props().setProperty('lastDispatch', String(Date.now()));
  dispatch();
}

function dispatch() {
  const token = props().getProperty('GITHUB_PAT');
  if (!token) throw new Error('GITHUB_PAT missing from Script Properties');

  /* No client_payload. The workflow does not read one, and a payload that is
     never read cannot be injected into a run step if this token ever leaks. */
  const res = UrlFetchApp.fetch('https://api.github.com/repos/' + repo() + '/dispatches', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' },
    payload: JSON.stringify({ event_type: 'sheet-updated' }),
    muteHttpExceptions: true,
  });

  const code = res.getResponseCode();
  if (code !== 204) throw new Error('dispatch failed: HTTP ' + code + ' ' + res.getContentText());
  console.log('dispatched sheet-updated to ' + repo());
}

/* Run this once by hand after setting the properties. It both accepts the OAuth
   consent screen and proves the PAT and repo name are right. */
function testDispatch() {
  dispatch();
}
