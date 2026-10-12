# claude-mods

Mods for Claude Code, published as one plugin marketplace.
Each mod is a plugin under `plugins/`, installed on its own.

## Mods

| Mod | What it does |
| --- | --- |
| [hud](plugins/hud) | Shows the plan, organization, model, effort, context usage and rate-limit quota on the status line. |

## Install

Type this at the prompt of a Claude Code terminal session:

```
/plugin install hud --marketplace benelog/claude-mods
```

Answer `y` to add the marketplace, then pick the user scope so the mod loads in every session.

## hud

The status line reads like this:

```
Max 20x · personal (admin) │ claude-opus-5-5 (high) │ ctx 42% │ 5h 23.5% · 7d 7%
```

- The plan and organization come from `oauthAccount` in `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`), read once when the session starts.
  A personal plan's organization, named after the account's email, shows as `personal`.
- The model and effort start from `/model` and the `effortLevel` settings (`modelSettings.<model>.effortLevel` first), then follow each model request.
- Context usage and the 5-hour and 7-day quota windows come from the engine's measurements after each turn; no extra API call is made.
  The quota windows appear only on a subscription.

## Development

```
claude plugin validate plugins/hud
claude plugin test plugins/hud
claude --plugin-dir plugins/hud
```
