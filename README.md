# YAC Notes Trigger

A small Google Apps Script that starts Yakkety's **Meeting notes to tasks (per file)** workflow (`ncssm-yac/yakkety`) soon after Gemini's notes land in a series' Notes and Recordings folder, instead of waiting for GitHub's best-effort cron.

- Runs every 15 minutes as `ncssm.yac.yakkety@gmail.com`. Plain code, no model.
- Watches the **YAC Exec** and **YAC Leadership** folders (IDs in `src/Code.gs`, same as the relocator's routes).
- Reads file **names and IDs only**, never the notes. A new `... Notes by Gemini` Doc makes one `workflow_dispatch` call (`mode: live`, `series: exec|leadership`). That is the only thing sent out; no file names or IDs.
- The notes already arrive late on purpose: the relocator files a meeting only after 3 hours of quiet, which is how long Gemini takes. So this fires at the earliest moment finished notes exist.
- Safe to repeat: the workflow remembers every file it has processed, so an extra dispatch costs nothing. Its own twice-a-day schedule stays as a backup.

## Setup (one time, as ncssm.yac.yakkety@gmail.com)

1. Make sure the account can see the Exec and Leadership Notes and Recordings folders (Viewer on the shared drive is enough).
2. Create an Apps Script project. Paste `src/Code.gs` and, under Project Settings, show the manifest and paste `src/appsscript.json`. (Or use `clasp`: `clasp login`, `clasp create --type standalone`, `clasp push`. Not tested with this account yet.)
3. Create a fine-grained GitHub token for **`ncssm-yac/yakkety` only** with **Actions: Read and write**. Add it as Script Property `GITHUB_TOKEN`. Never put it in the repo or chat.
4. Run `setup` once (approve the consent screen). It creates the 15-minute trigger.
5. Run `checkNotes` once: it remembers the existing notes and dispatches nothing. `DRY_RUN` is on by default, so until you set the `DRY_RUN` Script Property to `false` the script only logs what it would do.
6. Optionally run `testDispatch` to prove the token works (starts one harmless exec run).
7. Set `DRY_RUN` to `false` to go live.

## Scopes

`drive.metadata.readonly` (list file names and IDs), `script.external_request` (Drive REST + GitHub), `script.scriptapp` (create the trigger). No scope can read or change a document's contents.

## Tests

```bash
npm test
```

No packages to install. The tests stub Drive, GitHub, properties and the lock, and cover: first run baseline, one dispatch per series, series-name-only payload, retry after a failed dispatch, one series failing without blocking the other, DRY_RUN, ignoring recordings, a missing token, and the manifest scopes.

## Changing it

The IDs, repo and workflow name are at the top of `Code.gs`. Adding Biweekly would need a workflow that handles it first. A change to the scopes or to what is sent to GitHub should be reviewed by the owner.
