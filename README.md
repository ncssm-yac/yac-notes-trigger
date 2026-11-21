# YAC Notes Trigger

A small Google Apps Script that starts Yakkety's **Meeting notes to tasks (per file)** workflow (`ncssm-yac/yakkety`) soon after Gemini's notes land in a series' Notes and Recordings folder, instead of waiting for GitHub's best-effort cron.

- Runs every 15 minutes as `ncssm.yac.yakkety@gmail.com`. Plain code, no model.
- Watches the **YAC Exec** and **YAC Leadership** folders (IDs in `src/Code.gs`, same as the relocator's routes).
- Reads file **names and IDs only**, never the notes. A new `... Notes by Gemini` Doc makes one `workflow_dispatch` call (`mode: live`, `series: exec|leadership`). That is the only thing sent out; no file names or IDs.
- The notes already arrive late on purpose: the relocator files a meeting only after 3 hours of quiet, which is how long Gemini takes. So this fires at the earliest moment finished notes exist.
- Safe to repeat: the workflow remembers every file it has processed, so an extra dispatch costs nothing. Its own twice-a-day schedule stays as a backup.

## Monitor keep-alive (`checkMonitor`)

GitHub starts only about half of the 6-hourly scheduled runs of Yakkety's ops monitor (`monitor.yml`), so its `meta:monitor-alive` check (12-hour limit) kept failing (yakkety #179). A second trigger, **`checkMonitor`, runs every hour**:

- It reads the newest `monitor.yml` runs (times and status only).
- If one is queued or running, or the newest started within **6.5 hours**, it does nothing.
- Otherwise it starts `monitor.yml` on `main`, with no inputs. That is all it sends.
- Same token, same `DRY_RUN` switch, same script lock as `checkNotes`. A failure throws, so Apps Script emails it.

GitHub's own schedule still runs; this only fills the gaps, so the monitor runs at least every ~7 hours.

## Deploying (GitHub is the source of truth)

Don't edit the code in the Apps Script editor. The **Apps Script** workflow (`.github/workflows/apps-script.yml`) calls YAC's shared deploy, `ncssm-yac/yac-apps-script-deploy`:

- on a pull request: `npm test`;
- on merge to `main` (or **Run workflow**): tests, `clasp push` to the **YAC Notes Trigger** project, then a check that the live code matches the repo;
- every day: the same check. It goes red if someone edited the live code in the editor, or if the clasp sign-in (the `CLASPRC_JSON` organization secret) stopped working. Renewal steps are in the shared repo's README.

A new timer needs no editor step: `checkNotes` adds any missing one (`ensureTriggers_`) on its next 15-minute run. Script Properties (the token, `DRY_RUN`) are not code and are never touched by a deploy.

## Setup (one time, as ncssm.yac.yakkety@gmail.com)

1. Make sure the account can see the Exec and Leadership Notes and Recordings folders (Viewer on the shared drive is enough).
2. Create an Apps Script project. Paste `src/Code.gs` and, under Project Settings, show the manifest and paste `src/appsscript.json`. (Done Oct 2026. Since Nov 21, 2026, later changes deploy from GitHub; see above.)
3. Create a fine-grained GitHub token for **`ncssm-yac/yakkety` only** with **Actions: Read and write** (read lets `checkMonitor` see the monitor's last run). Add it as Script Property `GITHUB_TOKEN`. Never put it in the repo or chat.
4. Run `setup` once (approve the consent screen). It creates both triggers: `checkNotes` every 15 minutes and `checkMonitor` every hour. Later deploys don't need `setup` again: `checkNotes` adds a missing timer itself.
5. Run `checkNotes` once: it remembers the existing notes and dispatches nothing. `DRY_RUN` is on by default, so until you set the `DRY_RUN` Script Property to `false` the script only logs what it would do.
6. Optionally run `testDispatch` to prove the token works (starts one harmless exec run).
7. Set `DRY_RUN` to `false` to go live.

If `checkNotes` fails with HTTP 403 from Drive, the Drive API isn't enabled for the script's Cloud project: in the editor click **Services (+)**, add **Drive API** (v3), and run again. The manifest in `src/appsscript.json` already includes it. The log shows Google's reason.

## Scopes

`drive.metadata.readonly` (list file names and IDs), `script.external_request` (Drive REST + GitHub), `script.scriptapp` (create the trigger). No scope can read or change a document's contents.

## Tests

```bash
npm test
```

No packages to install. The tests stub Drive, GitHub, properties and the lock, and cover: first run baseline, one dispatch per series, series-name-only payload, retry after a failed dispatch, one series failing without blocking the other, DRY_RUN, ignoring recordings, a missing token, the manifest scopes, and `checkMonitor` (starts only after 6.5 hours with nothing running, sends no inputs, DRY_RUN, errors throw, reads nothing else) and `setup` making both triggers.

## Changing it

The IDs, repo and workflow name are at the top of `Code.gs`. A change goes live when its PR merges (see Deploying). Adding Biweekly would need a workflow that handles it first. A change to the scopes or to what is sent to GitHub should be reviewed by the owner.
