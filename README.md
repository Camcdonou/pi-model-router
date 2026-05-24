# pi-model-router

Auto-routing extension for [pi](https://pi.dev) that classifies prompts and routes them to the most cost-effective model.

## Tier Map

| Tier | Primary (Synthetic) | Fallback (OpenRouter) | When |
|------|---------------------|----------------------|------|
| 💚 Cheap | GLM-4.7-Flash | DeepSeek V4 Flash | Simple Q&A, one-liners, thanks |
| 🟡 Mid | MiMo v2.5 | GLM-5.1 (step up) | Coding, tool use, moderate edits |
| 🔴 Heavy | GLM-5.1 | MiMo v2.5 | Architecture, deep debugging, long-horizon |
| 👁️ Vision | Kimi-K2.6 | MiMo v2.5 | Images, screenshots, UI work |
| 📦 Overflow | DeepSeek V4 Flash | MiMo v2.5 | Context >180K or large outputs |

## How It Works

1. You type a prompt
2. **Before it hits the LLM**, the router classifies it and switches model if needed
3. A notification shows: `→ 💚 Cheap: hf:zai-org/GLM-4.7-Flash`
4. If Synthetic returns 429, next prompt auto-routes to OpenRouter fallback
5. If context exceeds 180K tokens, routes to overflow (DeepSeek V4 Flash, 1M context)

## Multi-turn Behavior

- On heavy models, short continuations ("also fix the tests") stay on the heavy model
- New topics re-evaluate from scratch
- Manual model selection via `/model` or Ctrl+P is respected for one turn, then auto-routing resumes

## Budget Tracking

- Tracks estimated spend per provider (Synthetic $36/wk, OpenRouter $24/wk)
- Warns at 75% and 90% of weekly budget
- Shows spend in `/router status`

## Commands

| Command | Description |
|---------|-------------|
| `/router` or `/router status` | Show current tier, budget, rate limit status |
| `/router cheap` | Force cheapest model |
| `/router mid` | Force mid-tier model |
| `/router heavy` | Force heavy model |
| `/router vision` | Force vision model |
| `/router auto` | Re-enable auto-routing |
| `/router disable` | Disable auto-routing |
| `/router reset` | Clear rate limit flag |

## Manual Override

If you select a model via `/model`, Ctrl+P, or `/router <tier>`, auto-routing pauses for that turn and resumes on the next prompt.

## Installation

Add to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["/path/to/pi-model-router"]
}
```

## Configuration

Edit the `TIERS` constant in `index.ts` to change model mappings. Edit `HEAVY_KEYWORDS`, `MID_KEYWORDS`, and `CHEAP_REGEX` to tune classification heuristics.
