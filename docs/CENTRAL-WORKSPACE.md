# A central VS Code workspace

Use one Linux host for code-server and project repositories. Windows, macOS and
the host itself connect to that same authenticated browser editor over the
private Tailscale network. Files, terminals, builds and Linux dependencies remain
on the host. It must be awake and online; an encrypted system drive must be
unlocked after a cold boot before services can start.

## Daily use

1. Bookmark the private code-server origin as **Matrix — Code** and LaunchPad's
   separate private URL as **Matrix — LaunchPad** on each client.
2. In VS Code, use **File > Open Folder** to select a project under
   `/work/projects`. Work in one project at a time instead of starting tools from
   the temporary directory or the parent of every repository.
3. Use **Terminal > New Terminal**. `pwd` and `git status --short --branch` should
   identify the intended host checkout and branch before starting a coding tool.
4. Save changes and commit normally. Another client accesses these same files;
   it does not need to copy dependencies or create another clone.
5. For concurrent agent tasks, create separate branches and linked worktrees
   under `/work/worktrees`. Switching clients is fine; simultaneous independent
   edits to one working tree need coordination.

Browser VS Code extensions run on the Linux host. Verify coding-assistant
sign-ins there, using their supported sign-in controls. A working GitHub CLI or
Claude CLI does not establish LaunchPad API authentication. No API key needs to
be pasted into a terminal transcript or a Git repository.

## Browser workspace actions in LaunchPad

Set the following non-secret variable in LaunchPad's existing protected service
environment file, using your actual code-server origin:

```ini
BROWSER_EDITOR_ORIGIN=https://your-host.your-tailnet.ts.net
```

Use only an origin: HTTP(S), no embedded credentials, path, query or fragment.
Keep the existing `PUBLIC_ORIGIN` set to LaunchPad's own private origin,
including its external port. These two values describe different services.
Back up the environment file privately and preserve its mode `600` when editing.
Do not copy its other entries into Git or a chat.

After the patch's full `npm test` suite passes using the project's Mise Node 24,
restart `launchpad.service` and hard-refresh the dashboard. Project details show
**Open in VS Code**. The button opens the server-validated project folder in a
new browser tab. Choose **Terminal > New Terminal** there. The Claude action
instructs you to run `claude` manually; it does not execute a command in a URL.

Without `BROWSER_EDITOR_ORIGIN`, native desktop terminal behavior remains
available. LaunchPad now reports a process spawn failure as an error. A successful
native launcher process does not prove that a desktop window was visible.

Server-held `GITHUB_TOKEN` credentials are reported as configured without
returning any credential bytes. Bulk import can use that existing server
credential. Clearing a database override falls back to the service environment.

## Verification and remaining setup

Run `python scripts/audit-omarchy.py` as the normal host user. It performs a
read-only inventory and prints a private JSON report with service state, local
HTTP responses, project paths, Git state and credential-presence flags. It does
not fetch, pull, move repositories, change services or print secret values.

Complete these phases in order:

| Phase | Pass condition |
| --- | --- |
| Host and startup | `/work` has the expected UUID; system `code-server@USER.service` and user `launchpad.service` are active and enabled; lingering is enabled |
| Private browser access | Editor and LaunchPad work from Windows and macOS while connected to the intended tailnet; no Funnel/public route is introduced |
| Project locations | Clone base and scan roots are `/work/projects`; each tracked project points to its chosen canonical checkout, not a retained source copy |
| Editor workspace | Open a real project from LaunchPad, then confirm `pwd`, branch, file save and a project-appropriate check in browser VS Code |
| Authentication | Verify GitHub access and the chosen assistant independently; do not trigger paid AI Review as an authentication test |
| Browser patch | Full `npm test` passes on Node 24, then browser mode and failed native launch behavior are verified |
| Preservation | Private backup covers service definitions, protected environment/configuration, SQLite app data and uncommitted/ignored work; restore is checked before cleanup |
| Original checkouts | Compare both copies, all local branches/worktrees and ignored configuration; archive only after path references and active processes no longer depend on the originals |
| Concurrent agents | One task gets one branch and worktree; removal waits until its work is committed and reviewed |

Do not infer that changing scan roots rewrites existing database `local_path`
values. Use each project's existing edit/link controls and verify the resulting
path before retiring the old location. Recheck current Git state: earlier clean
inventories and ahead/behind counts are observations, not a present-day backup.

## Recovery

Preserve existing Tailscale Serve routes; never reset all routes as part of a
single-app repair. Confirm local HTTP first, then proxy configuration, then
remote HTTPS and application function. The editor's login redirect is normally
HTTP 302; LaunchPad normally returns HTTP 200 locally.

To roll back this feature, restore the prior service environment privately and
run the previously verified application revision, then restart only LaunchPad.
Keep backups outside the public repository, especially SQLite databases and
files containing passwords or API credentials. GitHub source history does not
back up these runtime files.
