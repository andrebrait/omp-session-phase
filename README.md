# omp-session-phase

An [oh-my-pi](https://github.com/can1357/oh-my-pi) extension that lets the agent keep the
session name in step with the work. It registers one tool, `session_phase`, which renames the
session to `<emoji> <ref>: <slug>`, for example `🔬 #2725: HTTP 404`.

| Phase | Emoji | Meaning |
|-------|-------|---------|
| `triage` | 🔬 | First look |
| `investigate` | 🤔 | Finding the cause |
| `plan` | 📝 | Planning |
| `implement` | 🏗️ | Building |
| `fix` | 🛠️ | Fixing |
| `test` | 🧪 | Testing |
| `review` | 👀 | Under review |
| `ci` | ⏳ | Waiting for CI |
| `waiting` | ⏸️ | Blocked on something external |
| `question` | ❓ | Waiting for an answer from the user |
| `blocked` | 🚧 | Cannot continue |
| `landing` | 🏁 | Merging or releasing |
| `done` | ✅ | Finished |

`ref` and `slug` are optional after the first call: they are recovered from the current name,
so a phase change is a one-argument call.

Because the tool is called at the model's discretion, the extension also:

- reminds the model from the second settled turn on, until it has called the tool once;
- renames an unclaimed automatic title to `🔬 <title>` at the end of each settled turn. A name
  the user chose is never touched.

Inside Herdr (`HERDR_ENV=1`), every session rename is
mirrored onto the pane label, and onto the tab label when the pane is the tab's only one.

## Install

```bash
omp install github:andrebrait/omp-session-phase
```

## Test

```bash
bun test
```
