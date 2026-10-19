# Windows CI child-process stalls — research memo

**Date:** 2026-10-17 (updated 2026-10-18: §4 rows revised and §4a added with measurements taken since the first draft)
**Trigger:** Issue #5473 — bounded children (`sh`, `bash`, `cmd.exe` → `npm`) on `windows-latest` (windows-2025-vs2026, Node 24, Git for Windows) intermittently run to exactly their `timeout`, and whole test chunks are killed at 600000 ms with zero failing tests.
**Status:** Research input for the #5473 diagnosis. No code changed by this memo. It does **not** name a root cause.
**Reading time:** ~12 min

---

## 1. Summary

- Node's `spawnSync`/`execFileSync` timeout is a libuv timer that calls `TerminateProcess` on the **direct child only**. It also fires if the child already exited but a descendant still holds a stdio pipe open. Both facts are in Node's own source (`src/spawn_sync.cc`, `deps/uv/src/win/process.c`), not in its docs.
- So "`ETIMEDOUT` at exactly the bound" does not prove the child was running. It can mean the pipe was never released. `status`/`signal` on the error cannot tell the two apart on Windows (the kill reports exit code 1).
- Git for Windows / msys-2.0.dll **fork failures are loud, not hangs**: the runtime returns `EAGAIN` ("Resource temporarily unavailable"). Documented triggers are antivirus/hook DLLs and forced relocation (Mandatory ASLR). Our Defender-off measurement makes the antivirus trigger unlikely.
- Upstream Git for Windows has its own **open, unexplained** intermittent CI failures in `sh`/MSYS pipelines (git-for-windows/git#5222, open since 2024-10-22). This is evidence the class exists. It is not a cause for us.
- Node 24 bundles libuv 1.52.1, which **lacks** `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` (added upstream 2026-05-13, libuv#5100). It closes a documented race where a handle meant for one child leaks into another. That only matters if one Node process creates processes from more than one thread.
- The runner's image script disables Defender and excludes `C:\` and `D:\` (`Configure-WindowsDefender.ps1`), which matches what we measured.
- Disk: GitHub staff said C: is slower than the old D: (runner-images#12647). The workspace moved back to D: on 2025-08-18 (runner-images#12744).
- Established workarounds, strongest first: do text filtering in Node instead of `sh` pipelines; give children `stdio: 'ignore'` or file-backed stdio when output is unused; add `taskkill /T /F` tree cleanup after a timeout; add a `close`-vs-`exit` timing probe. A retry is listed last and is **not** acceptable under the maintainers' diagnose-every-red rule.

Source labels: **[N]** Node, **[U]** libuv, **[M]** Microsoft, **[C]** Cygwin/MSYS2, **[G]** Git for Windows, **[R]** actions/runner-images. All GitHub file reads were of default branches on 2026-10-17, so line numbers drift. Node 24's own bundled libuv is older than `v1.x` HEAD.

---

## 2. Causes

### 2.1 Child exited, but a descendant holds a stdio pipe → `ETIMEDOUT`

**What the sources say**
- `SyncProcessRunner::Kill()` has a comment saying the child may have exited already, "when our child process spawned another process which inherited (one of) the stdio pipes." In that case no signal is sent, but the pipes are closed "so this situation won't make us hang." [N] `src/spawn_sync.cc` ~614-645.
- The timer callback `OnKillTimerTimeout()` unconditionally does `SetError(UV_ETIMEDOUT); Kill();` [N] `src/spawn_sync.cc` ~667-669. The loop runs `uv_run` until the process has exited **and** the stdio pipes have closed (~525-545). So a pipe-holding descendant makes the call run to the bound and report `ETIMEDOUT`.
- Node's `'close'` doc says it fires after the process ended *and* its stdio closed, and is distinct from `'exit'` "since multiple processes might share the same stdio streams." [N] `doc/api/child_process.md`, `### Event: 'close'`. The `'exit'` entry says stdio "might still be open."
- Node's `execFileSync` doc says only that it does not return until the child has "fully closed". [N] `doc/api/child_process.md`, `execFileSync`.

**Why it matters here:** the zero-failure 600000 ms chunk kills have the same shape one level up. If any long-lived descendant of a test file inherits that file's stdout/stderr pipe, the runner's `close` waits on it.

**Confirm / rule out in CI**
1. Run the suspect command with async `spawn` instead and log `Date.now()` at `'exit'` and at `'close'`. A gap near the bound means a pipe holder.
2. On timeout, before killing, list `Win32_Process` where `ParentProcessId` chains to the child PID (`Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,Name,CommandLine`). The existing watcher snapshot of node/sh/bash/cmd processes could be extended with the parent PID.
3. Log `err.pid` and the ETIMEDOUT-to-`exit` gap for every stall.

**Workarounds**
- `stdio: ['ignore', 'pipe', 'pipe']`, or file descriptors for stdout/stderr, so no pipe can be held (Node `stdio` doc, and the `{ stdio: 'ignore' }` advice at the top of `child_process.md`).
- Remove the descendant: avoid `&`, subshell daemons and tools that fork a background helper in test scripts.
- After a timeout, run `taskkill /pid <pid> /t /f` (§2.2).

### 2.2 `timeout`/`killSignal` on Windows kill only the direct child

**What the sources say**
- Node: on Windows `SIGKILL`, `SIGTERM`, `SIGINT` and `SIGQUIT` "terminate the process forcefully and abruptly." [N] `doc/api/child_process.md` (signal section).
- libuv's `uv__kill` calls `TerminateProcess(process_handle, 1)` on the single process handle. [U] `src/win/process.c` ~1241-1390. Killed processes "normally return 1", so `status` cannot distinguish a kill from a failure.
- Every non-detached child is assigned to a process-wide job object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` plus `SILENT_BREAKAWAY_OK`. [U] `src/win/process.c` ~62-110. The job only reaps children when **the Node process exits**. Descendants are explicitly not individually affected. A timeout does not kill the tree.
- `shell: true` runs `process.env.comspec || 'cmd.exe'` with `['/d','/s','/c', '"cmd"']`. [N] `lib/child_process.js` ~712-715. Killing `cmd.exe` leaves `npm`/`node` running, with whatever pipes they hold. Node docs mark `spawn` with `shell` as not recommended (DEP0190) and note `windowsVerbatimArguments` is set automatically for cmd.
- Git for Windows ships `git-wrapper.c`. For `sh.exe` it spawns BusyBox `ash` and `WaitForSingleObject(INFINITE)`s on it with `bInheritHandles=TRUE`. [G] `git-for-windows/MINGW-packages`, `mingw-w64-git/git-wrapper.c` ~795-900. **Whether `C:\Program Files\Git\bin\sh.exe` on our image is this wrapper is unverified.** If any `sh`/`bash` we resolve is a wrapper, a direct-child kill orphans the real shell.
- Microsoft: `taskkill /t` "ends the specified process and any child processes started by it." [M] https://learn.microsoft.com/windows-server/administration/windows-commands/taskkill

**Confirm / rule out:** at stall time log the resolved path of the command (`where sh`; `Get-Command sh`) and the parent chain. After the kill, list survivors of the child's subtree. If any survive, tree-kill semantics are in play.

**Workarounds:** `taskkill /pid <pid> /t /f` in a timeout handler; spawn `usr\bin\sh.exe` by absolute path to skip any wrapper; use async `spawn` with `detached: false` and a tree kill instead of `execFileSync` for long commands. `detached: true` is **not** a fix: libuv then adds `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` and skips the job object (`process.c` ~1118-1128), and the Node doc says a detached child gets "its own console window."

### 2.3 Inheritable-handle leakage between concurrent spawns

**What the sources say**
- libuv#1490 ("win process spawn: race condition in inheriting handles", opened 2017-08-18, closed). The fix is libuv#5100, merged 2026-05-13: it uses `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` "so that only the stdio handles prepared for each child process are inherited." [U] https://github.com/libuv/libuv/pull/5100 and `src/win/process.c` ~1046-1090.
- Before that, `CreateProcessW` was called with `bInheritHandles=1` and no list: every inheritable handle in the process was inherited. [U] `src/win/process.c` ~1132-1137 (current main still passes `1`, now with the list).
- Node's tree: `deps/uv/src/win/process.c` on `v24.x` has no `HANDLE_LIST` (0 matches); it bundles libuv 1.52.1. `v22.x` bundles 1.51.0. `main` is also still on 1.52.1. [N] `deps/uv/include/uv/version.h`. The runner's exact Node 24 patch is not in our measurements.
- Microsoft documents `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` as the way to restrict inheritance. [M] https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute (the page was not read in full; the rationale quoted above is libuv's).

**Applicability:** the race needs two `CreateProcess` calls overlapping inside one process. The libuv PR says "any concurrent CreateProcessW call anywhere in the process — from libuv or a third-party library". `spawnSync` blocks the main thread, so plain node:test files do not hit this. Worker threads or native addons spawning processes would.

**Confirm / rule out:** `grep` the test files for `worker_threads`, `Worker(`, native addons; check `process.versions.uv`. If none, rule out. If present, log pipe-holder PIDs per §2.1.

**Workarounds:** serialize spawns in the process that does them; upgrade to a Node whose libuv has #5100 (version not yet known to us).

### 2.4 MSYS2/Cygwin fork emulation, rebasing, ASLR, antivirus hooks

**What the sources say**
- Cygwin FAQ: antivirus "can cause fork() to fail"; BLODA lists tools that hook processes. `fork()` fails when hook DLLs load at different base addresses in parent and child; fixes include removing the software, 64-bit Cygwin and rebasing; the page warns package updates undo a rebase. [C] https://cygwin.com/faq/faq.html (`faq.using.bloda`, `faq.using.anti-virus`, `faq.using.fixing-fork-failures`; read via a fetch tool that truncated the page, so wording is paraphrased).
- The runtime reports fork failures as `EAGAIN`: `this_errno = EAGAIN` at several failure points. [C] `msys2/msys2-runtime` `winsup/cygwin/fork.cc` (tag `msys2-3.6.11`, ~415, 455). `proc_retry` is an env option that retries fork/exec on certain Windows errors. [C] `winsup/cygwin/environ.cc` ~130; Cygwin user guide https://cygwin.com/cygwin-ug-net/using-cygwinenv.html. `environ.cc` ~881 reads `MSYS` first and falls back to `CYGWIN`. `disable_pcon` is also in that table (~122).
- MSYS2 FAQ: the msys runtime uses a pinned shared-memory address; address randomization, mixed runtime versions, or forced rebasing cause "magic number mismatch." [C] `msys2.github.io` `web/docs/faq.md` ~66-78.
- Git for Windows#6349 (closed 2026-07-27): `fork` failed on a machine with system-wide mandatory ASLR; resetting to default fixed it. The maintainer pointed at an installer option for Mandatory ASLR exclusions. [G] https://github.com/git-for-windows/git/issues/6349. #5557 (open): "Could not fork child process" fixed-or-not by per-`.exe` security exclusions.
- None of these sources describes an intermittent, otherwise healthy runner stalling.

**Confirm / rule out:** `Get-ProcessMitigation -System` (the same command the #6349 thread used) and a `fltmc filters` listing for non-Defender filter drivers. Capture stderr of stalled children, since a fork failure prints `Resource temporarily unavailable`; our stalls show empty stdout and may have dropped stderr.

**Workarounds:** none needed if the checks are clean; otherwise remove the mitigation or add an exclusion for the Git `usr\bin` binaries. Do not set `MSYS`/`CYGWIN` options as a speculative fix.

### 2.5 MSYS2 runtime pipe regression (Git 2.50.0 era)

**What the sources say:** Git for Windows#5688 and #5682 (both closed 2025-06): `git clone`/`ssh.exe` hung intermittently after upgrading to Git for Windows 2.50.0; maintainers traced it to the MSYS2 runtime's emulated non-blocking pipe writes (`winsup/cygwin/fhandler/pipe.cc`) and posted a fixed `msys-2.0.dll` on 2025-06-24. The reporter confirmed it. [G] https://github.com/git-for-windows/git/issues/5682 and #5688. The runner image README lists Git 2.56.0.windows.2 (image 20261013.288.2). [R] `images/windows/Windows2025-Readme.md`. That is later than 2.50.0, but I did not verify the fix's version.

**Confirm / rule out:** log `git --version` and `sh --version` in the tier on every run so each stall is tied to an exact runtime.

**Workarounds:** avoid MSYS-to-MSYS pipes in tests (§3).

### 2.6 Runner disk, Defender, hardware

**What the sources say**
- `Configure-WindowsDefender.ps1` sets `DisableRealtimeMonitoring`, `DisableScriptScanning`, `DisableBehaviorMonitoring`, `DisableIOAVProtection`, and `ExclusionPath = @("D:\", "C:\")`, plus `ForceDefenderPassiveMode` when the ATP key exists. [R] `images/windows/scripts/build/Configure-WindowsDefender.ps1` (last edited 2026-04-15, #13903).
- Standard public-repo Windows runner: 4 vCPU, 16 GB RAM, 14 GB SSD. [R/GitHub] https://docs.github.com/actions/reference/runners/github-hosted-runners. The page does not describe drive layout or Defender.
- runner-images#12647: Windows Server 2025 tests got ~20% slower after D: was removed; GitHub staff replied that with no D: "All temporary files and workspaces are created on the C: drive" and performance is reduced. #12744: D: returned 2025-08-18 and the workspace moved back to D:. A commenter (not staff) called C: "probably network attached storage"; treat that as unverified.
- runner-images#14878 (open, 2026-10-07): request to put the runner folders on ReFS/Dev Drive; "We will take a look." Microsoft's Dev Drive page says Defender runs in "performance mode" on a trusted Dev Drive. [M] https://learn.microsoft.com/windows/dev-drive/ Dev Drive formats only at creation, needs 50 GB, and the C: drive cannot be one.
- I found no primary document on Windows handle/process/desktop-heap limits for these runners.

**Confirm / rule out:** `Get-MpPreference | Select Disable*,ExclusionPath` at job start (already done: RealTime off); `Get-Volume` and a 1-file-per-ms write probe on C: and D:; a 250 ms heartbeat timer logging max drift catches whole-VM pauses (your existing UTC watcher does the same job); log `Get-Counter '\Processor(_Total)\% Processor Time'` around stalls.

**Workarounds:** put TEMP and the checkout on the same drive (tried, no change); reduce `--test-concurrency`/file parallelism below the core count (4) so `CreateProcess` plus forks do not queue; a larger runner is a paid option.

### 2.7 Console allocation and handle inheritance

**What the sources say:** by default a console process inherits its parent's console; Microsoft notes there is no guarantee the intended process receives input. [M] https://learn.microsoft.com/windows/console/creation-of-a-console. `CREATE_NO_WINDOW` is ignored with `DETACHED_PROCESS`/`CREATE_NEW_CONSOLE`. [M] https://learn.microsoft.com/windows/win32/procthread/process-creation-flags. libuv sets `CREATE_NO_WINDOW` only when `windowsHide` is set and no stdio is inherited. [U] `src/win/process.c` ~1099-1107. Node's `windowsHide` defaults to `false`. A child only reads console input if stdin is the console; ours is a pipe or ignored.

**Confirm / rule out:** A/B the stalled call with `windowsHide: true`. It is one option and cheap, but no source links console sharing to stalls.

### 2.8 `stdin` as a pipe

**What the sources say:** `SyncProcessStdioPipe::Start()` writes `input` if present and then shuts the pipe down immediately (`uv_shutdown`), or shuts it down at once when no input is given. [N] `src/spawn_sync.cc` ~154-170. So a synchronous child sees EOF on stdin; "stdin never closed" is not a Node-side cause for `spawnSync`/`execFileSync`. For async `spawn`, the caller must `child.stdin.end()`. This does not cover our `bash`-reads-script-on-stdin case if bash itself blocks reading.

**Workaround:** pass the script via a temp file or `-c` rather than stdin, or `stdio[0] = 'ignore'` where no input is needed.

### 2.9 `cmd.exe` / `npm ls` cost

**What the sources say:** `npm ls` walks the installed tree (npm docs: it shows "the logical dependency tree"). npm's update notifier is skipped in CI: the file header says "not in CI." [npm/cli] `lib/cli/update-notifier.js` line 1, entry in `lib/cli/entry.js` ~63. Config default is `update-notifier: true`. [npm/cli] `workspaces/config/lib/definitions/definitions.js` ~2635. I did not read the CI-detection branch itself, so the claim rests on the header comment. A `.cmd`/`.bat` file needs `cmd.exe` or `shell:true` on Windows. [N] `doc/api/child_process.md` (~118-150).

**Confirm / rule out:** time `npm ls --json --all` in isolation on the same runner with `npm_config_update_notifier=false`; run it as `process.execPath` + npm's `bin/npm-cli.js` to drop `cmd.exe`.

**Workarounds:** do not shell out for `npm ls`: read `node_modules/<pkg>/package.json` in Node; or run npm without `shell:true`.

---

## 3. Workarounds, ranked

1. **Remove the child.** Do the `printf | sed | head` text filter in JavaScript; read package metadata with `fs`. No process, no stall. (Established practice; also the macOS sibling's fix was to change what the shell does.)
2. **Remove the pipe.** `stdio: 'ignore'` or file descriptors where output is unneeded; avoid stdin-script mode.
3. **Bound by tree, not by child.** On timeout, `taskkill /pid <pid> /t /f` (§2.2), then assert no survivors.
4. **Instrument to a cause.** Parent PID chain at stall time; `exit`-vs-`close` timestamps; `git --version`; mitigation and filter-driver listing; drift heartbeat.
5. **Lower concurrency** below the core count (4 on this runner). Only a mitigation; it does not diagnose.
6. **Retry (NOT acceptable here).** Listed only for completeness, last: the maintainers' rule is that every red is diagnosed to a cause. Do not use it as the fix.

---

## 4. Causes vs. our measurements

| Cause | Our measurements | Verdict |
|---|---|---|
| Descendant holds stdio pipe → `ETIMEDOUT` after child exit (§2.1) | Exact-bound timeouts, rarity and non-reproduction fit; the 600000 ms chunk kills with zero failures fit the same shape. The watcher snapshots (parent PID, age, CPU) flagged no `sh`/`bash`/`cmd` older than 30 s in runs 39094506294 and 39096299575, but no hang occurred in those runs, so this is not a test of the cause. `exit`-vs-`close` timing still not captured. | **Untested, consistent** |
| Direct-child-only kill / orphaned wrapper (§2.2) | Explains survivors and pipe holders; says nothing about why the first stall began. `sh` resolution (wrapper or not) not recorded. | **Untested** (aggravator, not a trigger) |
| Handle-inheritance race (§2.3) | Needs multi-threaded process creation; unknown whether any test uses worker threads or addons. Node 24's libuv lacks the fix. | **Untested** |
| Antivirus/Defender hooks (§2.4, §2.6) | Defender real-time off; image script excludes `C:\`/`D:\`. Third-party filter drivers not listed. | **Unlikely** (Defender); **untested** (other filters) |
| Fork failure/ASLR/rebase (§2.4) | Documented as loud `EAGAIN`, and ASLR is a persistent state, not rare. 2,407 pipelines never exceeded 2 s. Stderr of stalled children not captured. | **Unlikely as sole cause; stderr untested** |
| Steady-state fork-emulation cost / load (§2.4, §2.6) | Latency scales roughly linearly with forks (131/281/407 ms); 6-way concurrency never exceeded 2 s; bash start max ~270 ms. A 10 s outlier is ~75x warm. | **Inconsistent** |
| Slow C: I/O (§2.6) | TEMP/TMP moved to D: made no difference; no outlier in 2,407 calls. First-touch/cold-cache not separately measured. | **Mostly inconsistent** |
| Whole-VM pause or CPU starvation (§2.6) | The watcher recorded brief stalls on every shard of run 39094506294 (idle watcher timer up to 1.9 s late; a 3449 ms `sh` probe overlapping one; a 14.2 s process snapshot); none in run 39096299575 (§4a). No failing test has yet been lined up against a watcher event. | **Open, consistent so far** |
| MSYS2 pipe regression (§2.5) | Fix predates the image's Git per the version list, but the fix version is unverified and per-run Git version is not logged. | **Untested** |
| Console sharing (§2.7) | No source ties it to stalls. | **Untested, weak** |
| stdin pipe never closed (§2.8) | Node closes stdin for sync spawns. | **Unlikely** for `spawnSync` |
| npm update-notifier / cmd.exe startup (§2.9) | Skipped in CI per file header; `npm ls --all` cost vs a 30 s bound not measured. | **Unlikely** (notifier); **untested** (walk cost) |

What the sources do and do not support: they support that a timeout bound can be reached by a pipe holder or a killed-but-not-reaped tree (§2.1-2.2), and that Git for Windows has unexplained intermittent CI failures of its own (#5222). They do not show that either explains our stalls.

### 4a. Measurements taken since the first draft (facts, then one reading)

All inside the Windows conformance tier (`windows-latest`, Node 24). Run and job ids are from `open-gsd/gsd-core`.

**Observed stalls (each a bounded child that did not finish):**
- #4784 `sh -c 'printf|sed|head -1'`, 10 s bound: run 38984013970, job 117251215802.
- `nsegment-phase-grammar` bash `echo|grep|awk`, 5013 ms against a 5000 ms bound, and `lockfile-cve-audit` `npm ls` via cmd.exe at 30 s: run 39083981500 (shards 2/3 and 1/3).
- #5526, `nsegment-phase-grammar`, `spawnSync bash ETIMEDOUT`, 8443 ms against a 5000 ms bound: run 39078837680, job 117531515298, head 755bf26f01. Pre-watcher run, so there are no watcher lines. The bound was exceeded by about 3.4 s.
- #5498: `faulty-deps` (`npm --version` hit its 15 s bound) and `gate-consumer-exit-awareness` (a bash probe returned status `null`).

**Measured under the same conditions, no stall:**
- Warm `bash` start: median about 35 ms, max about 270 ms. Defender real-time protection already off. TEMP/TMP on the checkout drive made no difference (cold-bash probe, run 39081510215 and later).
- Fork stress, 6 concurrent chains, 30 s per phase, 2,407 `sh` calls (run 39086266395): median 131 / 281 / 407 ms for 0 / 2 / 5 forks in the pipeline; none over 2 s, none at the 10 s bound.
- Watcher, run 39094506294 (green, no hang): `sh` pipeline probe median 100-135 ms, p99 507-1108 ms, max 3449 / 1845 / 1385 ms across the three shards; on one shard the idle watcher's own timer fired up to 1.9 s late (three loop gaps of 1.1-1.9 s) and a 3449 ms probe overlapped one; a PowerShell process snapshot took 14.2 s on another shard.
- Watcher, run 39096299575 (green): no loop gaps, no slow probes; process snapshots took 4-9 s.
- No shell older than 30 s was flagged in either run.
- Every later `next` Tests run I checked (39099590460 through 39172721661) was green. Run 39179559870 failed on one test across Windows, macOS and ubuntu at once, a different failure.

**Reading, not a conclusion:** brief VM or process-scheduling stalls (1-14 s) occur on every shard, in a process that only waits on a timer. The 5-30 s hangs could be the tail of that same effect. This does not fit a descendant holding a pipe (nothing lingered), steady-state fork cost, Defender, or slow C: I/O. It is not shown: no hang occurred in a watched run, so no failing test has been lined up against a watcher event.

**An untested lead:** the failing spawn was the first child process started from its test file's node process in #5526, `lockfile-cve-audit` and the #4784 test, but not in the 5013 ms `nsegment` case, so at most 3 of 4. A cheap check: many fresh node processes, each doing one `sh` pipeline spawn first, versus later spawns in the same process.

**To line up the next recurrence:** take the failing test's end time minus its duration and compare it with that shard's `spawn-stall watcher` section in the job log (UTC): a loop gap or slow probe in that window means the VM stalled; none means only that child hung.

---

## 5. Unverified or not found

- **Whether our `sh`/`bash` resolves to a wrapper executable.** `git-wrapper.c` for `sh.exe` targets BusyBox/MinGit; I did not establish what `C:\Program Files\Git\bin\sh.exe` is on the image.
- **Fix version of the MSYS2 pipe regression** (#5682/#5688): the thread names the runtime fix but I recorded no release or commit.
- **What `error sending signal 11` means in git-for-windows/git#5222.** The thread links a Cygwin 3.3 commit and says root cause unknown; I read no commit diff.
- **libuv #1490 conclusion and which libuv ships in the runner's exact Node 24.x patch.** Only the `v24.x` branch head was read; the runner's installed patch version is not in this memo's inputs.
- **Windows desktop-heap/handle/process limits on hosted runners:** no primary document found.
- **`CreateProcess` throughput under high concurrency:** no primary document found.
- **Whether the runner-images "C: slower than D:" mechanism is network storage:** a community comment only; GitHub staff gave only the reduced-performance statement.
- **Whether `LC_ALL=C` helps MSYS `sh`:** the macOS bash-3.2 issue is real in our tree, but I found no primary source for Windows/MSYS locale cost.
- **Cygwin FAQ wording:** the page fetch truncated in the middle; sections were identified by anchor and paraphrased.
- **Microsoft pages quoted for `UpdateProcThreadAttribute` and Defender cmdlets** (`Add-MpPreference`) were referenced but not read in full.
- **No Dev Drive on hosted runners:** #14878 is only a request; any third-party action that creates one was not evaluated (no primary source).
