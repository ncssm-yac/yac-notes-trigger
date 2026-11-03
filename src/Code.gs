/**
 * YAC Notes Trigger -- starts Yakkety's "Meeting notes to tasks (per file)"
 * workflow soon after a Gemini notes Doc lands in a series' Notes and
 * Recordings folder, instead of waiting for GitHub's best-effort cron.
 *
 * Runs every 15 minutes (see setup()) as ncssm.yac.yakkety@gmail.com.
 * Plain code, no model. It reads file NAMES and IDs only (never the notes),
 * and the only thing it sends out is the series name to GitHub.
 *
 * Entry points: checkNotes (the trigger), setup (run once), testDispatch.
 *
 * Script Properties (Project Settings; never commit values):
 *   GITHUB_TOKEN  fine-grained token: ncssm-yac/yakkety only, Actions: write
 *   DRY_RUN       anything but 'false' = log only, dispatch nothing (default)
 *   SEEN_exec / SEEN_leadership   written by the script (file IDs already seen)
 *
 * Why this is safe to run often: the workflow remembers every file it has
 * processed and does nothing for a file it has already carded, so a repeat
 * or extra dispatch costs nothing. The workflow's own twice-a-day schedule
 * stays as a backup.
 */

var REPO = 'ncssm-yac/yakkety';
var WORKFLOW = 'meeting-notes-to-tasks.yml';
var REF = 'main';
var NOTES_SUFFIX = 'Notes by Gemini';
var LIST_SIZE = 50; // newest notes files remembered per series

// Folder IDs are not secrets (same as the relocator's ROUTES). Both are inside
// the YAC Young Alumni Engagement shared drive.
var SERIES = [
  { key: 'exec',       folderId: '1ncmPKzuyvnPR4Ie7AbclhLjrXT3Yne0w' }, // YAC Exec / YAC Exec Weekly / Notes and Recordings
  { key: 'leadership', folderId: '1RmXQQsILEHGsZGvTmz1ZKgNc843Nz-Gz' }  // YAC Leadership / YAC Leadership Meetings / Notes and Recordings
];

/** The trigger. */
function checkNotes() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) { Logger.log('Another run is in progress; skipping.'); return; }
  try {
    var props = PropertiesService.getScriptProperties();
    var live = props.getProperty('DRY_RUN') === 'false';
    var errors = [];
    SERIES.forEach(function (s) {
      try { checkSeries_(s, props, live); }
      catch (e) { errors.push(s.key + ': ' + e.message); Logger.log('FAILED ' + s.key + ': ' + e.message); }
    });
    // Throwing makes Apps Script email the failure to the account owner.
    if (errors.length) throw new Error('Notes trigger failed -- ' + errors.join('; '));
  } finally {
    lock.releaseLock();
  }
}

function checkSeries_(s, props, live) {
  var ids = listNotesIds_(s.folderId);
  var raw = props.getProperty('SEEN_' + s.key);
  if (raw === null) {
    // First run for this series: remember what is there, dispatch nothing.
    props.setProperty('SEEN_' + s.key, JSON.stringify(ids));
    Logger.log(s.key + ': first run, remembered ' + ids.length + ' existing notes; nothing dispatched.');
    return;
  }
  var fresh = newIds_(ids, JSON.parse(raw));
  if (!fresh.length) { Logger.log(s.key + ': no new notes.'); return; }
  if (!live) {
    Logger.log(s.key + ': ' + fresh.length + ' new notes. DRY_RUN is on: would dispatch series=' + s.key + '.');
    return; // do not remember them, so going live picks them up
  }
  dispatch_(s.key, props.getProperty('GITHUB_TOKEN'));
  props.setProperty('SEEN_' + s.key, JSON.stringify(ids)); // only after GitHub accepted it
  Logger.log(s.key + ': ' + fresh.length + ' new notes; workflow dispatched.');
}

/** IDs in `current` that are not in `seen`. */
function newIds_(current, seen) {
  var have = {};
  seen.forEach(function (id) { have[id] = true; });
  return current.filter(function (id) { return !have[id]; });
}

/** Newest Gemini notes Docs in a folder (IDs only), via the Drive REST API. */
function listNotesIds_(folderId) {
  var q = "'" + folderId + "' in parents and trashed = false and name contains '" + NOTES_SUFFIX + "'";
  var url = 'https://www.googleapis.com/drive/v3/files?fields=files(id,name)' +
    '&orderBy=createdTime%20desc&pageSize=' + LIST_SIZE +
    '&supportsAllDrives=true&includeItemsFromAllDrives=true&q=' + encodeURIComponent(q);
  var res = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('Drive list returned HTTP ' + res.getResponseCode());
  return (JSON.parse(res.getContentText()).files || [])
    .filter(function (f) { return f.name.indexOf(NOTES_SUFFIX) !== -1; })
    .map(function (f) { return f.id; });
}

/** Start the workflow live for one series. Throws unless GitHub answers 204. */
function dispatch_(seriesKey, token) {
  if (!token) throw new Error('GITHUB_TOKEN is not set');
  var url = 'https://api.github.com/repos/' + REPO + '/actions/workflows/' + WORKFLOW + '/dispatches';
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    payload: JSON.stringify({ ref: REF, inputs: { mode: 'live', series: seriesKey } }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 204) throw new Error('GitHub dispatch returned HTTP ' + res.getResponseCode());
}

/** Run once from the editor: replaces any old trigger with one every 15 minutes. */
function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkNotes') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkNotes').timeBased().everyMinutes(15).create();
  Logger.log('Trigger set: checkNotes every 15 minutes. DRY_RUN stays on until you set it to false.');
}

/** Check the token and the workflow from the editor (starts a real run for exec; harmless if nothing is new). */
function testDispatch() {
  dispatch_('exec', PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN'));
  Logger.log('GitHub accepted the dispatch.');
}
