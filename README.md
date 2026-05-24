# ⚡ pi-model-router

An auto-routing extension for [Pi](https://github.com/badlogic/pi-mono) that classifies prompts and switches to the most cost-effective model before each request.

Stop burning GLM-5.1 on "thanks". Stop sending images to text-only models. Stop paying for heavy reasoning when cheap will do.

## Features

- **Heuristic prompt classification** — routes to the cheapest viable tier based on prompt content, length, and attachments
- **5-tier routing** with primary + fallback per tier:
  - **💚 Cheap** — simple Q&A, one-liners, config tweaks
  - **🟡 Mid** — coding, tool use, moderate edits
  - **🔴 Heavy** — architecture, deep debugging, long-horizon agent tasks
  - **👁️ Vision** — images, screenshots, UI work
  - **📦 Overflow** — context >180K or large outputs
- **Automatic rate-limit fallback** — detects 429 from Synthetic, switches to OpenRouter
- **Context overflow protection** — when session exceeds 180K tokens, routes to 1M-context models (DeepSeek V4 Flash, MiMo v2.5)
- **Multi-turn continuity** — short continuations on heavy models stay on the heavy model
- **Budget tracking** — estimated spend per provider with 75%/90% warnings
- **Manual override** — `/model`, Ctrl+P, or `/router <tier>` respected for one turn, then auto-routing resumes
- **`/router` command** — status, force tier, enable/disable, reset rate limits

## Tier Map

| Tier | Primary (Synthetic) | Fallback (OpenRouter) | When |
|------|---------------------|----------------------|------|
| 💚 Cheap | GLM-4.7-Flash ($0.10/$0.50) | DeepSeek V4 Flash ($0.14/$0.28) | Simple Q&A, one-liners, thanks |
| 🟡 Mid | MiMo v2.5 ($0.40/$2.00) | GLM-5.1 (step up) | Coding, tool use, moderate edits |
| 🔴 Heavy | GLM-5.1 ($1.00/$3.00) | MiMo v2.5 | Architecture, deep debugging, long-horizon |
| 👁️ Vision | Kimi-K2.6 ($0.95/$4.00) | MiMo v2.5 | Images, screenshots, UI work |
| 📦 Overflow | DeepSeek V4 Flash (1M ctx) | MiMo v2.5 (1M ctx) | Context >180K or large outputs |

## How It Works

1. You type a prompt
2. **Before it hits the LLM**, the `input` event fires — the router intercepts it
3. Classifies the prompt by complexity (heuristics: length, keywords, image attachments, context size)
4. Switches to the cheapest viable model via `pi.setModel()`
5. A notification shows: `→ 💚 Cheap: hf:zai-org/GLM-4.7-Flash`
6. If Synthetic returns 429, the next prompt auto-routes to OpenRouter fallback

### Classification Heuristics

| Signal | Route |
|--------|-------|
| Images attached | → Vision |
| Context >180K tokens | → Overflow |
| Very short + greeting/thanks pattern | → Cheap |
| Heavy keywords (architecture, redesign, from scratch…) | → Heavy |
| Code/edit keywords (fix, implement, debug…) | → Mid |
| Long prompt (>200 chars) with no heavy signals | → Mid |
| Short + no code indicators | → Cheap |

### Multi-turn Behavior

- Short continuations on heavy models ("also fix the tests") **stay on the heavy model** — context continuity matters
- New topics re-evaluate from scratch
- Manual model selection via `/model` or Ctrl+P is respected for one turn, then auto-routing resumes

## Commands

| Command | Description |
|---------|-------------|
| `/router` or `/router status` | Show current tier, budget, context size, rate limit status |
| `/router cheap` | Force cheapest model |
| `/router mid` | Force mid-tier model |
| `/router heavy` | Force heavy model |
| `/router vision` | Force vision model |
| `/router auto` | Re-enable auto-routing |
| `/router disable` | Disable auto-routing (keep current model) |
| `/router reset` | Clear Synthetic rate-limit flag |

## Budget Tracking

- Tracks estimated spend per provider (Synthetic $36/wk, OpenRouter $24/wk)
- Footer shows current tier: `⚡cheap` or `⏸manual`
- Warns at 75% (`🟡`) and 90% (`🔴`) of weekly budget
- After heavy tasks complete, suggests cheaper follow-ups

## Setup

### 1. Install the extension

**Option A — pi install (recommended)**

```bash
pi install git:github.com/Camcdonou/pi-model-router
```

Restart pi or run `/reload`. That's it.

**Option B — Clone and link locally**

```bash
git clone https://github.com/Camcdonou/pi-model-router.git ~/Sources/Repo/pi-model-router
```

Add to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["/Users/connormcdonough/Sources/Repo/pi-model-router"]
}
```

**Option C — One-off test**

```bash
pi -e git:github.com/Camcdonou/pi-model-router
```

### 2. Verify

Restart pi (or run `/reload`). You should see a `⚡` router status in the footer. Type `/router status` to confirm it's active.

## Configuration

Edit the constants at the top of `index.ts`:

- **`TIERS`** — change model mappings, costs, and labels per tier
- **`HEAVY_KEYWORDS`** / **`MID_KEYWORDS`** / **`CHEAP_REGEX`** — tune classification heuristics
- **`SYNTHETIC_WEEKLY`** / **`OPENROUTER_WEEKLY`** — adjust budget limits
- **`SYNTHETIC_CTX_LIMIT`** — context overflow threshold (default 180K)

## Requirements

- [Pi](https://github.com/badlogic/pi-mono) (`npm install -g @earendil-works/pi-coding-agent`)
- A [Synthetic](https://synthetic.new) subscription (for Synthetic models)
- An [OpenRouter](https://openrouter.ai) API key (for fallback models)

## License

MIT
