# Ship a HarmonyOS build to a real phone in one sentence

> For developers stuck in the loop: edit ArkTS → wait for the build → install on device → dig through hilog → edit again.

DevEco Studio is a good IDE, but it doesn't remove the loop itself. `dsh-harmony` is a plugin for DeepSeek Harness that folds the loop into one `harmony` tool with fifteen actions:

```
The login validation is wrong — fix it, run it on the phone, and show me the first error from the log.
```

What happens: `compile` type-checks the ArkTS (about half the time of a full build), then `run` builds, installs, stages any missing HSP modules, launches the ability, and captures six seconds of logs. If it crashes, it reads the newest `jscrash` and extracts the top frames. When something fails you get one line telling you what to do next — not a wall of hvigor output.

## Three modes, one session

- `/plan` — read-only investigation, with the tool layer refusing builds and installs until you approve.
- `/goal <objective>; done when: <observable>; verify with: <command>` — a persistent objective that keeps working across turns; missing acceptance criteria are rejected.
- build (default) — edit, build, install, verify.

## Also on the device

`screenshot`, tap/input/swipe with `ui`, assertions on text / count / UI fingerprint (`ui op=assert`, one table across devices), `crash` logs, `app op=query`, `file` pull/send, `doctor` with per-probe timeouts, and offline docs lookup that answers "which API level added this?" from your local SDK `.d.ts`.

Multiple devices: `device="all"`, or split the work per device:

```
matrix: "phoneA=install;phoneB=run"
```

One build, one table of device × action × result.

## Install

Windows, dsh `>=0.2.1-rc.5`, DevEco Studio 6.x, a device visible to `hdc`:

```powershell
dsh plugin --profile desktop add file:<this folder>
```

Restart Harness once, then pick the **HarmonyOS** preset in a new session.

Repo: <https://github.com/mobius-2046/dsh-harmonyos-agent> (MIT)

## What it does not do

No previewer, no debugger, no memory or performance profiling — DevEco does those better. No signing either: `hap-sign-tool` wants a plaintext password, and where that password lives is your call.
