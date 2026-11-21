/**
 * YAC Notes Trigger -- starts Yakkety's "Meeting notes to tasks (per file)"
 * workflow soon after a Gemini notes Doc lands in a series' Notes and
 * Recordings folder, instead of waiting for GitHub's best-effort cron.
 *
 * Runs every 15 minutes (see setup()) as ncssm.yac.yakkety@gmail.com.
 * Plain code, no model. It reads file NAMES and IDs only (never the notes),
 * and the only thing it sends out is the series name to GitHub.
 *
 * It also keeps Yakkety's ops monitor (monitor.yml) running: GitHub skips
 * about half of its 6-hourly scheduled runs, so checkMonitor (hourly) starts
 * one when the newest run is more than MONITOR_MAX_GAP_HOURS old. It reads
 * only that workflow's run times and sends no inputs at all.
 *
 * Entry points: checkNotes and checkMonitor (the triggers), setup (run once),
 * testDispatch.
 *
 * Script Properties (Project Settings; never commit values):
 *   GITHUB_TOKEN  fine-grained token: ncssm-yac/yakkety only, Actions: write
 *   DRY_RUN       anything but 'false' = log only, dispatch nothing (default);
 *                 covers both triggers
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
var MONITOR_WORKFLOW = 'monitor.yml';
// monitor.yml is scheduled every 6 hours; GitHub usually starts it a few
// minutes late, so wait a little past that before starting one ourselves.
// The monitor's own meta:monitor-alive check fails only past 12 hours.
var MONITOR_MAX_GAP_HOURS = 6.5;

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
  if (res.getResponseCode() !== 200) {
    throw new Error('Drive list returned HTTP ' + res.getResponseCode() + googleReason_(res));
  }
  return (JSON.parse(res.getContentText()).files || [])
    .filter(function (f) { return f.name.indexOf(NOTES_SUFFIX) !== -1; })
    .map(function (f) { return f.id; });
}

/** Google's own error reason (never note text), shortened, for the log and failure email. */
function googleReason_(res) {
  try {
    var e = JSON.parse(res.getContentText()).error;
    return ': ' + String(e.message || e.status || '').slice(0, 200);
  } catch (err) {
    return '';
  }
}

/** Start the workflow live for one series. Throws unless GitHub answers 204. */
function dispatch_(seriesKey, token) {
  dispatchWorkflow_(WORKFLOW, { mode: 'live', series: seriesKey }, token);
}

function githubHeaders_(token) {
  return {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

/** workflow_dispatch on REF. `inputs` may be null. Throws unless GitHub answers 204. */
function dispatchWorkflow_(workflow, inputs, token) {
  if (!token) throw new Error('GITHUB_TOKEN is not set');
  var url = 'https://api.github.com/repos/' + REPO + '/actions/workflows/' + workflow + '/dispatches';
  var body = { ref: REF };
  if (inputs) body.inputs = inputs;
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: githubHeaders_(token),
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 204) throw new Error('GitHub dispatch returned HTTP ' + res.getResponseCode());
}

/**
 * The second trigger (hourly): start Yakkety's monitor when GitHub has let it
 * lapse. Does nothing while a monitor run is queued or running, or when the
 * newest run started less than MONITOR_MAX_GAP_HOURS ago.
 */
function checkMonitor() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) { Logger.log('Another run is in progress; skipping.'); return; }
  try {
    var props = PropertiesService.getScriptProperties();
    var live = props.getProperty('DRY_RUN') === 'false';
    var token = props.getProperty('GITHUB_TOKEN');
    if (!token) throw new Error('GITHUB_TOKEN is not set');
    var decision = monitorDecision_(latestMonitorRuns_(token), Date.now());
    if (!decision.start) { Logger.log('monitor: ' + decision.why + '; nothing started.'); return; }
    if (!live) { Logger.log('monitor: ' + decision.why + '. DRY_RUN is on: would start ' + MONITOR_WORKFLOW + '.'); return; }
    dispatchWorkflow_(MONITOR_WORKFLOW, null, token);
    Logger.log('monitor: ' + decision.why + '; started ' + MONITOR_WORKFLOW + '.');
  } catch (e) {
    // Throwing makes Apps Script email the failure to the account owner.
    throw new Error('Monitor trigger failed -- ' + e.message);
  } finally {
    lock.releaseLock();
  }
}

/** The newest runs of monitor.yml (any event, any status): [{ status, created_at }]. */
function latestMonitorRuns_(token) {
  var url = 'https://api.github.com/repos/' + REPO + '/actions/workflows/' + MONITOR_WORKFLOW + '/runs?per_page=5';
  var res = UrlFetchApp.fetch(url, { headers: githubHeaders_(token), muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('GitHub runs list returned HTTP ' + res.getResponseCode());
  return (JSON.parse(res.getContentText()).workflow_runs || []).map(function (r) {
    return { status: r.status, created_at: r.created_at };
  });
}

/** Whether to start the monitor now: { start, why }. Pure, for the tests. */
function monitorDecision_(runs, now) {
  var active = runs.filter(function (r) { return r.status !== 'completed'; });
  if (active.length) return { start: false, why: 'a run is already ' + active[0].status };
  var newest = runs.reduce(function (t, r) { return Math.max(t, Date.parse(r.created_at) || 0); }, 0);
  if (!newest) return { start: true, why: 'no earlier run found' };
  var hours = (now - newest) / 3600000;
  if (hours <= MONITOR_MAX_GAP_HOURS) return { start: false, why: 'last run ' + hours.toFixed(1) + 'h ago' };
  return { start: true, why: 'last run ' + hours.toFixed(1) + 'h ago (over ' + MONITOR_MAX_GAP_HOURS + 'h)' };
}

/** Run once from the editor: replaces any old triggers with checkNotes every 15 minutes and checkMonitor every hour. */
function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var h = t.getHandlerFunction();
    if (h === 'checkNotes' || h === 'checkMonitor') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkNotes').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('checkMonitor').timeBased().everyHours(1).create();
  Logger.log('Triggers set: checkNotes every 15 minutes, checkMonitor every hour. DRY_RUN stays on until you set it to false.');
}

/** Check the token and the workflow from the editor (starts a real run for exec; harmless if nothing is new). */
function testDispatch() {
  dispatch_('exec', PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN'));
  Logger.log('GitHub accepted the dispatch.');
}
