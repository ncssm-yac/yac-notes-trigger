// Runs the Apps Script code in Node with stubbed Google services. No dependencies.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'Code.gs'), 'utf8');

function world({ props = {}, drive = {}, githubStatus = 204, runs = [], runsStatus = 200 } = {}) {
  const logs = [], fetches = [];
  const store = Object.assign({}, props);
  const ctx = vm.createContext({
    console,
    Logger: { log: (m) => logs.push(m) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    ScriptApp: { getOAuthToken: () => 'oauth-token' },
    Date,
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (k in store ? store[k] : null),
      setProperty: (k, v) => { store[k] = v; }
    }) },
    UrlFetchApp: { fetch: (url, opts) => {
      fetches.push({ url, opts });
      if (url.startsWith('https://api.github.com/') && url.includes('/runs?')) return { getResponseCode: () => runsStatus, getContentText: () => JSON.stringify({ workflow_runs: runs }) };
      if (url.startsWith('https://api.github.com/')) return { getResponseCode: () => githubStatus, getContentText: () => '' };
      const folder = Object.keys(drive).find((id) => url.includes(encodeURIComponent("'" + id + "'")));
      if (!folder) return { getResponseCode: () => 404, getContentText: () => '' };
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ files: drive[folder] }) };
    } }
  });
  vm.runInContext(code, ctx, { filename: 'Code.gs' });
  return { ctx, logs, fetches, store };
}

const EXEC = '1ncmPKzuyvnPR4Ie7AbclhLjrXT3Yne0w';
const LEAD = '1RmXQQsILEHGsZGvTmz1ZKgNc843Nz-Gz';
const f = (id, n) => ({ id, name: 'YAC Exec - ' + n + ' - Notes by Gemini' });
const dispatches = (w) => w.fetches.filter((x) => x.url.startsWith('https://api.github.com/') && x.url.endsWith('/dispatches'));

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok - ' + name); }

test('first run remembers existing notes and dispatches nothing', () => {
  const w = world({ props: { DRY_RUN: 'false', GITHUB_TOKEN: 't' }, drive: { [EXEC]: [f('a', '1')], [LEAD]: [] } });
  w.ctx.checkNotes();
  assert.strictEqual(dispatches(w).length, 0);
  assert.deepStrictEqual(JSON.parse(w.store.SEEN_exec), ['a']);
  assert.deepStrictEqual(JSON.parse(w.store.SEEN_leadership), []);
});

test('a new notes Doc dispatches that series live, once', () => {
  const w = world({ props: { DRY_RUN: 'false', GITHUB_TOKEN: 't', SEEN_exec: '["a"]', SEEN_leadership: '[]' },
    drive: { [EXEC]: [f('b', '2'), f('a', '1')], [LEAD]: [] } });
  w.ctx.checkNotes();
  const d = dispatches(w);
  assert.strictEqual(d.length, 1);
  assert.ok(d[0].url.endsWith('/repos/ncssm-yac/yakkety/actions/workflows/meeting-notes-to-tasks.yml/dispatches'));
  assert.deepStrictEqual(JSON.parse(d[0].opts.payload), { ref: 'main', inputs: { mode: 'live', series: 'exec' } });
  assert.strictEqual(d[0].opts.headers.Authorization, 'Bearer t');
  assert.deepStrictEqual(JSON.parse(w.store.SEEN_exec), ['b', 'a']);
  w.ctx.checkNotes(); // nothing new now
  assert.strictEqual(dispatches(w).length, 1);
});

test('several new files in one series still make one dispatch', () => {
  const w = world({ props: { DRY_RUN: 'false', GITHUB_TOKEN: 't', SEEN_exec: '[]', SEEN_leadership: '[]' },
    drive: { [EXEC]: [f('c', '3'), f('b', '2')], [LEAD]: [] } });
  w.ctx.checkNotes();
  assert.strictEqual(dispatches(w).length, 1);
});

test('payload carries only the series name, no file names or IDs', () => {
  const w = world({ props: { DRY_RUN: 'false', GITHUB_TOKEN: 't', SEEN_exec: '[]', SEEN_leadership: '[]' },
    drive: { [EXEC]: [f('secret-id', 'Private Topic')], [LEAD]: [] } });
  w.ctx.checkNotes();
  const p = dispatches(w)[0].opts.payload;
  assert.ok(!p.includes('secret-id') && !p.includes('Private'));
});

test('a failed dispatch is retried next run and the run throws', () => {
  const w = world({ props: { DRY_RUN: 'false', GITHUB_TOKEN: 't', SEEN_exec: '[]', SEEN_leadership: '[]' },
    drive: { [EXEC]: [f('b', '2')], [LEAD]: [] }, githubStatus: 401 });
  assert.throws(() => w.ctx.checkNotes(), /exec/);
  assert.strictEqual(w.store.SEEN_exec, '[]'); // not remembered, so it is tried again
});

test('one series failing does not stop the other', () => {
  const w = world({ props: { DRY_RUN: 'false', GITHUB_TOKEN: 't', SEEN_exec: '[]', SEEN_leadership: '[]' },
    drive: { [LEAD]: [f('x', '9')] } }); // Exec folder lookup 404s
  assert.throws(() => w.ctx.checkNotes(), /exec/);
  assert.strictEqual(dispatches(w).length, 1);
  assert.ok(dispatches(w)[0].opts.payload.includes('leadership'));
});

test('DRY_RUN (default) dispatches nothing and keeps the files unseen', () => {
  const w = world({ props: { GITHUB_TOKEN: 't', SEEN_exec: '[]', SEEN_leadership: '[]' },
    drive: { [EXEC]: [f('b', '2')], [LEAD]: [] } });
  w.ctx.checkNotes();
  assert.strictEqual(dispatches(w).length, 0);
  assert.strictEqual(w.store.SEEN_exec, '[]');
});

test('files not named like Gemini notes are ignored', () => {
  const w = world({ props: { DRY_RUN: 'false', GITHUB_TOKEN: 't', SEEN_exec: '[]', SEEN_leadership: '[]' },
    drive: { [EXEC]: [{ id: 'r', name: 'YAC Exec - Recording' }], [LEAD]: [] } });
  w.ctx.checkNotes();
  assert.strictEqual(dispatches(w).length, 0);
});

test('missing token fails loudly', () => {
  const w = world({ props: { DRY_RUN: 'false', SEEN_exec: '[]', SEEN_leadership: '[]' },
    drive: { [EXEC]: [f('b', '2')], [LEAD]: [] } });
  assert.throws(() => w.ctx.checkNotes(), /GITHUB_TOKEN/);
});

test('manifest asks only for the three narrow scopes', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'appsscript.json'), 'utf8'));
  assert.deepStrictEqual(m.oauthScopes.slice().sort(), [
    'https://www.googleapis.com/auth/drive.metadata.readonly',
    'https://www.googleapis.com/auth/script.external_request',
    'https://www.googleapis.com/auth/script.scriptapp'
  ]);
});

test('a Drive error shows Google\'s reason in the failure', () => {
  const w = world({ props: { DRY_RUN: 'false', GITHUB_TOKEN: 't', SEEN_exec: '[]', SEEN_leadership: '[]' }, drive: {} });
  w.ctx.UrlFetchApp.fetch = () => ({ getResponseCode: () => 403, getContentText: () => JSON.stringify({ error: { message: 'Google Drive API has not been used in project 1 before.' } }) });
  assert.throws(() => w.ctx.checkNotes(), /HTTP 403: Google Drive API has not been used/);
});

test('manifest enables the Drive advanced service', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'appsscript.json'), 'utf8'));
  assert.strictEqual(m.dependencies.enabledAdvancedServices[0].serviceId, 'drive');
});

// ---- checkMonitor: keeps Yakkety's monitor.yml running when GitHub skips its schedule
const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();
const LIVE = { DRY_RUN: 'false', GITHUB_TOKEN: 't' };

test('monitor: a last run over 6.5 hours ago starts monitor.yml on main with no inputs', () => {
  const w = world({ props: LIVE, runs: [{ status: 'completed', created_at: hoursAgo(7) }, { status: 'completed', created_at: hoursAgo(20) }] });
  w.ctx.checkMonitor();
  const d = dispatches(w);
  assert.strictEqual(d.length, 1);
  assert.ok(d[0].url.endsWith('/repos/ncssm-yac/yakkety/actions/workflows/monitor.yml/dispatches'));
  assert.deepStrictEqual(JSON.parse(d[0].opts.payload), { ref: 'main' });
  assert.strictEqual(d[0].opts.headers.Authorization, 'Bearer t');
});

test('monitor: a recent run starts nothing', () => {
  const w = world({ props: LIVE, runs: [{ status: 'completed', created_at: hoursAgo(2) }] });
  w.ctx.checkMonitor();
  assert.strictEqual(dispatches(w).length, 0);
});

test('monitor: a queued or running run starts nothing, however old the last one', () => {
  for (const status of ['queued', 'in_progress', 'waiting']) {
    const w = world({ props: LIVE, runs: [{ status, created_at: hoursAgo(9) }] });
    w.ctx.checkMonitor();
    assert.strictEqual(dispatches(w).length, 0, status);
  }
});

test('monitor: the newest run counts, whatever order GitHub lists them in', () => {
  const w = world({ props: LIVE, runs: [{ status: 'completed', created_at: hoursAgo(10) }, { status: 'completed', created_at: hoursAgo(1) }] });
  w.ctx.checkMonitor();
  assert.strictEqual(dispatches(w).length, 0);
});

test('monitor: DRY_RUN (default) only logs', () => {
  const w = world({ props: { GITHUB_TOKEN: 't' }, runs: [{ status: 'completed', created_at: hoursAgo(9) }] });
  w.ctx.checkMonitor();
  assert.strictEqual(dispatches(w).length, 0);
  assert.ok(w.logs.some((l) => /DRY_RUN is on: would start monitor\.yml/.test(l)));
});

test('monitor: a failed runs lookup, a failed dispatch or a missing token throws (Apps Script emails it)', () => {
  assert.throws(() => world({ props: LIVE, runsStatus: 403 }).ctx.checkMonitor(), /Monitor trigger failed -- GitHub runs list returned HTTP 403/);
  assert.throws(() => world({ props: LIVE, runs: [], githubStatus: 401 }).ctx.checkMonitor(), /Monitor trigger failed -- GitHub dispatch returned HTTP 401/);
  assert.throws(() => world({ props: { DRY_RUN: 'false' } }).ctx.checkMonitor(), /GITHUB_TOKEN/);
});

test('monitor: reads only the run list and touches no Drive or notes state', () => {
  const w = world({ props: Object.assign({ SEEN_exec: '["a"]' }, LIVE), runs: [{ status: 'completed', created_at: hoursAgo(1) }] });
  w.ctx.checkMonitor();
  assert.ok(w.fetches.every((x) => x.url.startsWith('https://api.github.com/repos/ncssm-yac/yakkety/actions/workflows/monitor.yml/')));
  assert.strictEqual(w.store.SEEN_exec, '["a"]');
});

test('setup makes both triggers and replaces old ones', () => {
  const made = [], deleted = [];
  const w = world({});
  const builder = (h) => ({ timeBased: () => ({ everyMinutes: (n) => ({ create: () => made.push(h + ':m' + n) }), everyHours: (n) => ({ create: () => made.push(h + ':h' + n) }) }) });
  w.ctx.ScriptApp.getProjectTriggers = () => ['checkNotes', 'checkMonitor', 'other'].map((h) => ({ getHandlerFunction: () => h, h }));
  w.ctx.ScriptApp.deleteTrigger = (t) => deleted.push(t.h);
  w.ctx.ScriptApp.newTrigger = builder;
  w.ctx.setup();
  assert.deepStrictEqual(deleted, ['checkNotes', 'checkMonitor']);
  assert.deepStrictEqual(made, ['checkNotes:m15', 'checkMonitor:h1']);
});

console.log(passed + ' passed.');
