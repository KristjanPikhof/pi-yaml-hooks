# Pre-tool developer guards

Use this pack when you want fast checks before PI runs tools that can mutate a project.

## Good use cases

| Hook | Use it when |
|---|---|
| `guard-risky-bash` | You want to block obviously dangerous shell commands before they run. |
| `guard-protected-write` | You want to stop direct writes to secrets, certificates, keys, and local environment files. |
| `guard-package-install` | You want package installs and dependency updates to be explicit human actions. |

## Install

Copy `hooks.yaml` into your global hook file or a trusted project hook file.

If you keep the script in this repository, run PI from the repository root or update this path in `hooks.yaml`:

```yaml
bash: 'node ./examples/pre-tool-developer-guards/pre-tool-policy.mjs'
```

For another project, copy `pre-tool-policy.mjs` into that project and point the YAML at the copied path.

## Behavior

- Exit code `2` blocks the matching pre-tool call.
- These hooks inspect the tool payload before execution; they do not run on `tool.after.*`.

## Quick test

1. Add the hooks.
2. Ask PI to run `git reset --hard`.
3. Confirm the bash tool call is blocked.
4. Ask PI to write `.env`.
5. Confirm the write tool call is blocked.
6. Ask PI to run a harmless command like `pwd`.
7. Confirm it still runs.
