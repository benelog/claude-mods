# claude-mods

Mods for Claude Code, published as one plugin marketplace.
Each mod is a plugin under `plugins/`, installed on its own.

## Mods

| Mod | What it does |
| --- | --- |
| [hud](plugins/hud) | Shows the plan, organization, model, effort, context usage, prompt-cache state and rate-limit quota on the status line. |

## Install

Type this at the prompt of a Claude Code terminal session:

```
/plugin install hud --marketplace benelog/claude-mods
```

Answer `y` to add the marketplace, then pick the user scope so the mod loads in every session.

## hud

The status line reads like this:

```
Max 20x · personal (admin) │ claude-opus-5-5 (high) │ ctx 42% │ cache ✓ 96% · ttl 1h │ 5h 23.5% · 7d 7%
```

- The plan and organization come from `oauthAccount` in `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`), read once when the session starts.
  A personal plan's organization, named after the account's email, shows as `personal`.
- The model and effort start from `/model` and the `effortLevel` settings (`modelSettings.<model>.effortLevel` first), then follow each model request.
- Context usage and the 5-hour and 7-day quota windows come from the engine's measurements after each turn; no extra API call is made.
  The quota windows appear only on a subscription.
- The cache entry judges each main-thread request by its response's cache tokens; subagents keep caches of their own and are left out.
  `✓ 96%` is the share of the prompt read from the cache.
  `✗` marks a request that did not reuse the prefix the one before it cached, with the cause: `model changed`, `compacted`, `expired` (idle past the TTL) or `broken` (anything else, such as a changed system prompt or tool list).
  `⌛ expired` appears once the session has been idle past the TTL, before the next request pays for it.
- The engine does not report the cache TTL, so the mod works it out, from the strongest evidence it has:
  - A request: a hit after more than five idle minutes means `1h`, and a miss inside the hour after more than five idle minutes means `5m`.
  - Overage: on a subscription past a rate-limit window, requests drop to `5m`, shown as `5m (overage)`, until the window resets.
  - The GrowthBook flag `tengu_prompt_cache_1h_config` that Claude Code caches in `~/.claude.json` under `cachedGrowthBookFeatures`: its `allowlist` gives the one-hour TTL to the request sources it names, and `repl_main_thread*` covers an interactive session's main thread.
    The flag is internal to Claude Code and undocumented, so its name or shape may change; the mod then falls back to the plan.
  - The plan alone: `1h` on a subscription and `5m` otherwise, marked `?`.

## Development

```
claude plugin validate plugins/hud
claude plugin test plugins/hud
claude --plugin-dir plugins/hud
```
