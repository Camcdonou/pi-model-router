import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ============================================================
// TIER CONFIGURATION
// ============================================================

interface ModelRef {
  provider: string;
  id: string;
  cost: number; // estimated cost per turn (USD)
}

interface TierConfig {
  primary: ModelRef;
  fallback: ModelRef;
  label: string;
}

const TIERS: Record<string, TierConfig> = {
  cheap: {
    primary: { provider: "synthetic", id: "hf:zai-org/GLM-4.7-Flash", cost: 0.05 },
    fallback: { provider: "openrouter", id: "deepseek/deepseek-v4-flash", cost: 0.03 },
    label: "💚 Cheap",
  },
  mid: {
    primary: { provider: "openrouter", id: "xiaomi/mimo-v2.5", cost: 0.30 },
    fallback: { provider: "synthetic", id: "hf:zai-org/GLM-5.1", cost: 0.50 },
    label: "🟡 Mid",
  },
  heavy: {
    primary: { provider: "synthetic", id: "hf:zai-org/GLM-5.1", cost: 0.50 },
    fallback: { provider: "openrouter", id: "xiaomi/mimo-v2.5", cost: 0.30 },
    label: "🔴 Heavy",
  },
  vision: {
    primary: { provider: "synthetic", id: "hf:moonshotai/Kimi-K2.6", cost: 0.60 },
    fallback: { provider: "openrouter", id: "xiaomi/mimo-v2.5", cost: 0.30 },
    label: "👁️ Vision",
  },
  overflow: {
    primary: { provider: "openrouter", id: "deepseek/deepseek-v4-flash", cost: 0.03 },
    fallback: { provider: "openrouter", id: "xiaomi/mimo-v2.5", cost: 0.30 },
    label: "📦 Overflow",
  },
};

type Tier = "cheap" | "mid" | "heavy" | "vision" | "overflow";

// ============================================================
// BUDGET & LIMITS
// ============================================================

const SYNTHETIC_WEEKLY = 36;
const OPENROUTER_WEEKLY = 24;
const SYNTHETIC_CTX_LIMIT = 180_000;
const RATE_LIMIT_COOLDOWN = 5 * 60 * 1000;

// ============================================================
// PROMPT CLASSIFICATION HEURISTICS
// ============================================================

const CHEAP_REGEX =
  /^(thanks?|ty|ok|okay|great|good|nice|yes|no|yep|nope|cool|right|got it|done|skip|next|continue|go ahead|sure|perfect|sounds good|agreed|👍|👌|✅|lg|lfg|lol|hmm|huh|what\??|why\??)\s*[!.?]*$/i;

const HEAVY_KEYWORDS = [
  "architect", "architecture", "redesign", "refactor entire", "rewrite the",
  "migrate", "overhaul", "restructure", "rebuild the",
  "design the", "design a", "plan the", "plan a",
  "entire codebase", "whole system", "comprehensive",
  "deep dive", "thorough", "end-to-end", "from scratch",
  "figure out why", "investigate", "trace through",
  "multiple files", "across files", "several files",
];

const MID_KEYWORDS = [
  "fix", "implement", "add ", "create a", "update ", "change ",
  "edit ", "modify", "write a", "build",
  "debug", "solve", "install", "configure", "set up",
  "test", "deploy", "script", "function", "method",
  "class ", "component", "file ", "module",
  "refactor", "rename", "move", "extract",
  "replace", "remove", "delete", "insert",
  "error", "bug", "issue", "problem",
  "how do i", "how to",
];

function classifyPrompt(text: string, hasImages: boolean, ctxTokens: number): Tier {
  // Images always route to vision tier
  if (hasImages) return "vision";

  // Context overflow — force to large-context model
  if (ctxTokens > SYNTHETIC_CTX_LIMIT) return "overflow";

  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // Very short + simple pattern → cheap
  if (trimmed.length < 60 && CHEAP_REGEX.test(trimmed)) return "cheap";

  // Heavy keywords → heavy
  if (HEAVY_KEYWORDS.some((kw) => lower.includes(kw))) return "heavy";

  // Short with no code indicators → cheap
  if (trimmed.length < 80 && !MID_KEYWORDS.some((kw) => lower.includes(kw)))
    return "cheap";

  // Code/edit keywords → mid
  if (MID_KEYWORDS.some((kw) => lower.includes(kw))) return "mid";

  // Longer prompts default to mid
  if (trimmed.length > 200) return "mid";

  // Short unknowns → cheap
  return "cheap";
}

// ============================================================
// CONTINUATION DETECTION
// ============================================================

const CONTINUATION_RE =
  /^(and|also|then|now|next|but|actually|wait|oh|plus|additionally|moreover|ok,|okay,|sure,|great,|also,)\b/i;

const HEAVY_MODEL_IDS = ["hf:zai-org/GLM-5.1", "hf:moonshotai/Kimi-K2.6"];

function isContinuation(text: string, currentModelId: string): boolean {
  if (!HEAVY_MODEL_IDS.includes(currentModelId)) return false;
  const trimmed = text.trim();
  return trimmed.length < 150 && CONTINUATION_RE.test(trimmed);
}

// ============================================================
// CONTEXT ESTIMATION
// ============================================================

function estimateSessionTokens(ctx: any): number {
  let chars = 0;
  try {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message?.content) {
        const content = entry.message.content;
        if (typeof content === "string") {
          chars += content.length;
        } else if (Array.isArray(content)) {
          for (const part of content) {
            if (typeof part === "object" && part?.text) chars += part.text.length;
          }
        }
      }
    }
  } catch {
    // Best effort
  }
  return Math.round(chars / 4); // ~4 chars per token
}

// ============================================================
// MAIN EXTENSION
// ============================================================

export default function (pi: ExtensionAPI) {
  // --- State ---
  let autoRouting = true;
  let manualOverride = false;
  let syntheticRateLimitedUntil = 0;
  let syntheticSpend = 0;
  let openrouterSpend = 0;
  let estimatedCtxTokens = 0;
  let currentTier: Tier | "manual" = "cheap";
  let warnedBudget75 = false;
  let warnedBudget90 = false;
  let turnCount = 0;

  // --- Helpers ---

  function getTierModel(tier: Tier): ModelRef {
    const config = TIERS[tier];
    // Use primary unless Synthetic is rate-limited AND primary is Synthetic
    const synthDown =
      Date.now() < syntheticRateLimitedUntil &&
      config.primary.provider === "synthetic";
    return synthDown ? config.fallback : config.primary;
  }

  function getModelCost(modelId: string): number {
    for (const tier of Object.values(TIERS)) {
      if (tier.primary.id === modelId) return tier.primary.cost;
      if (tier.fallback.id === modelId) return tier.fallback.cost;
    }
    return 0.10;
  }

  function providerForModel(modelId: string): "synthetic" | "openrouter" {
    return modelId.startsWith("hf:") ? "synthetic" : "openrouter";
  }

  function formatStatus(): string {
    let s = autoRouting ? `⚡${currentTier}` : "⏸manual";
    if (Date.now() < syntheticRateLimitedUntil) s += " 🚫synth";
    return s;
  }

  function formatBudget(): string {
    return `Syn $${syntheticSpend.toFixed(2)}/$${SYNTHETIC_WEEKLY} | OR $${openrouterSpend.toFixed(2)}/$${OPENROUTER_WEEKLY}`;
  }

  // --- Session Start: Restore State ---

  pi.on("session_start", async (_event, ctx) => {
    estimatedCtxTokens = estimateSessionTokens(ctx);
    syntheticSpend = 0;
    openrouterSpend = 0;
    turnCount = 0;

    try {
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type === "custom" && entry.customType === "router-spend") {
          const d = entry.data;
          syntheticSpend += d?.syntheticSpend ?? 0;
          openrouterSpend += d?.openrouterSpend ?? 0;
        }
      }
    } catch {
      // Best effort
    }

    warnedBudget75 =
      syntheticSpend > SYNTHETIC_WEEKLY * 0.75 ||
      openrouterSpend > OPENROUTER_WEEKLY * 0.75;
    warnedBudget90 =
      syntheticSpend > SYNTHETIC_WEEKLY * 0.90 ||
      openrouterSpend > OPENROUTER_WEEKLY * 0.90;

    ctx.ui.setStatus("router", formatStatus());
  });

  // --- Model Select: Detect Manual Override ---

  pi.on("model_select", async (event, _ctx) => {
    if (event.source === "set" || event.source === "cycle") {
      manualOverride = true;
      currentTier = "manual";
    }
    // "restore" = session restore, not a user override — ignore
  });

  // --- Input: THE CORE ROUTER ---

  pi.on("input", async (event, ctx) => {
    if (!autoRouting) return;

    // If user manually selected a model, skip routing for this prompt
    if (manualOverride) {
      manualOverride = false;
      pi.appendEntry("router-routing", {
        tier: "manual",
        reason: "user-selected",
      });
      ctx.ui.setStatus("router", formatStatus());
      return;
    }

    const hasImages = !!(event.images && event.images.length > 0);
    const tier = classifyPrompt(event.text, hasImages, estimatedCtxTokens);

    // Check if this is a continuation on a heavy model
    const currentModel = ctx.model;
    const currentId = currentModel?.id ?? "";
    if (isContinuation(event.text, currentId)) {
      pi.appendEntry("router-routing", {
        tier: currentTier as string,
        reason: "continuation",
      });
      return;
    }

    const modelRef = getTierModel(tier);
    const model = ctx.modelRegistry.find(modelRef.provider, modelRef.id);

    if (model && model.id !== currentId) {
      const success = await pi.setModel(model);
      if (success) {
        currentTier = tier;
        ctx.ui.notify(`→ ${TIERS[tier].label}: ${modelRef.id}`, "info");
      }
    } else if (model && model.id === currentId) {
      // Already on the right model, just update tier
      currentTier = tier;
    } else {
      // Model not found in registry — try fallback
      const fallbackRef = TIERS[tier].fallback;
      const fallback = ctx.modelRegistry.find(
        fallbackRef.provider,
        fallbackRef.id,
      );
      if (fallback && fallback.id !== currentId) {
        const success = await pi.setModel(fallback);
        if (success) {
          currentTier = tier;
          ctx.ui.notify(
            `→ ${TIERS[tier].label} (fallback): ${fallbackRef.id}`,
            "info",
          );
        }
      } else {
        currentTier = tier;
      }
    }

    pi.appendEntry("router-routing", {
      tier,
      provider: modelRef.provider,
      modelId: modelRef.id,
      estimatedCtx: estimatedCtxTokens,
    });
    ctx.ui.setStatus("router", formatStatus());
  });

  // --- After Provider Response: Rate Limit Detection ---

  pi.on("after_provider_response", async (event, ctx) => {
    if (event.status === 429) {
      const currentId = ctx.model?.id ?? "";
      if (providerForModel(currentId) === "synthetic") {
        const retryAfter = event.headers?.["retry-after"];
        const cooldown = retryAfter
          ? parseInt(retryAfter) * 1000
          : RATE_LIMIT_COOLDOWN;
        syntheticRateLimitedUntil = Date.now() + cooldown;
        ctx.ui.notify(
          `🚫 Synthetic rate-limited. Falling back to OpenRouter.`,
          "warning",
        );
        ctx.ui.setStatus("router", formatStatus());
      }
    }
  });

  // --- Turn End: Budget Tracking + Heavy Task Suggestion ---

  pi.on("turn_end", async (event, ctx) => {
    const modelId = ctx.model?.id ?? "";
    const cost = getModelCost(modelId);
    const provider = providerForModel(modelId);
    turnCount++;

    if (provider === "synthetic") syntheticSpend += cost;
    else openrouterSpend += cost;

    pi.appendEntry("router-spend", {
      syntheticSpend: provider === "synthetic" ? cost : 0,
      openrouterSpend: provider === "openrouter" ? cost : 0,
      turn: turnCount,
    });

    // Rough context growth estimate
    let turnChars = 0;
    try {
      if (event.message?.content) {
        const content = event.message.content;
        if (typeof content === "string") {
          turnChars += content.length;
        } else if (Array.isArray(content)) {
          for (const part of content) {
            if (typeof part === "object" && part?.text)
              turnChars += part.text.length;
          }
        }
      }
      // Also estimate user message from tool results
      if (event.toolResults) {
        for (const result of event.toolResults) {
          if (result?.content) {
            if (typeof result.content === "string")
              turnChars += result.content.length;
            else if (Array.isArray(result.content)) {
              for (const part of result.content) {
                if (typeof part === "object" && part?.text)
                  turnChars += part.text.length;
              }
            }
          }
        }
      }
    } catch {
      // Best effort
    }
    estimatedCtxTokens += Math.round(turnChars / 4);

    // Budget warnings
    const synthPct = syntheticSpend / SYNTHETIC_WEEKLY;
    const orPct = openrouterSpend / OPENROUTER_WEEKLY;

    if (!warnedBudget90 && (synthPct > 0.9 || orPct > 0.9)) {
      warnedBudget90 = true;
      ctx.ui.notify(
        `🔴 Budget critical! ${formatBudget()}`,
        "error",
      );
    } else if (!warnedBudget75 && (synthPct > 0.75 || orPct > 0.75)) {
      warnedBudget75 = true;
      ctx.ui.notify(
        `🟡 Budget warning: ${formatBudget()}`,
        "warning",
      );
    }

    // After heavy task with no more tools, suggest downgrading
    if (
      HEAVY_MODEL_IDS.includes(modelId) &&
      (!event.toolResults || event.toolResults.length === 0)
    ) {
      ctx.ui.notify(
        `💡 Heavy task done. Simple follow-ups will auto-route to cheap tier.`,
        "info",
      );
    }

    ctx.ui.setStatus("router", formatStatus());
  });

  // --- /router Command ---

  pi.registerCommand("router", {
    description:
      "Model router: status / cheap / mid / heavy / vision / auto / disable / reset",
    getArgumentCompletions(prefix: string) {
      const cmds = [
        "status",
        "cheap",
        "mid",
        "heavy",
        "vision",
        "auto",
        "disable",
        "reset",
      ];
      return cmds
        .filter((c) => c.startsWith(prefix))
        .map((c) => ({ value: c, label: c }));
    },
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();

      // Status display
      if (!sub || sub === "status") {
        const lines = [
          `Auto-routing: ${autoRouting ? "ON ⚡" : "OFF ⏸"}`,
          `Current tier: ${currentTier}`,
          `Budget: ${formatBudget()}`,
          `Context: ~${estimatedCtxTokens.toLocaleString()} tokens`,
          `Rate limit: ${Date.now() < syntheticRateLimitedUntil ? "🚫 Synthetic rate-limited" : "✅ Clear"}`,
          ``,
          `Tier map:`,
          `  cheap  → ${TIERS.cheap.primary.id} / ${TIERS.cheap.fallback.id}`,
          `  mid    → ${TIERS.mid.primary.id} / ${TIERS.mid.fallback.id}`,
          `  heavy  → ${TIERS.heavy.primary.id} / ${TIERS.heavy.fallback.id}`,
          `  vision → ${TIERS.vision.primary.id} / ${TIERS.vision.fallback.id}`,
          `  overflow → ${TIERS.overflow.primary.id} / ${TIERS.overflow.fallback.id}`,
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      // Re-enable auto-routing
      if (sub === "auto") {
        autoRouting = true;
        manualOverride = false;
        ctx.ui.notify("⚡ Auto-routing enabled", "info");
        ctx.ui.setStatus("router", formatStatus());
        return;
      }

      // Disable auto-routing
      if (sub === "disable") {
        autoRouting = false;
        ctx.ui.notify("⏸ Auto-routing disabled", "info");
        ctx.ui.setStatus("router", formatStatus());
        return;
      }

      // Clear rate limit flag
      if (sub === "reset") {
        syntheticRateLimitedUntil = 0;
        ctx.ui.notify("✅ Rate limit flag cleared", "info");
        ctx.ui.setStatus("router", formatStatus());
        return;
      }

      // Force a specific tier
      const tierMap: Record<string, Tier> = {
        cheap: "cheap",
        mid: "mid",
        heavy: "heavy",
        vision: "vision",
      };
      const tier = tierMap[sub];
      if (tier) {
        const modelRef = getTierModel(tier);
        const model = ctx.modelRegistry.find(
          modelRef.provider,
          modelRef.id,
        );
        if (model) {
          await pi.setModel(model);
          currentTier = tier;
          ctx.ui.notify(
            `→ ${TIERS[tier].label}: ${modelRef.id}`,
            "info",
          );
        } else {
          // Try fallback
          const fallbackRef = TIERS[tier].fallback;
          const fallback = ctx.modelRegistry.find(
            fallbackRef.provider,
            fallbackRef.id,
          );
          if (fallback) {
            await pi.setModel(fallback);
            currentTier = tier;
            ctx.ui.notify(
              `→ ${TIERS[tier].label} (fallback): ${fallbackRef.id}`,
              "info",
            );
          } else {
            ctx.ui.notify(
              `❌ No model found for tier "${tier}"`,
              "error",
            );
          }
        }
        ctx.ui.setStatus("router", formatStatus());
        return;
      }

      ctx.ui.notify(
        `Unknown: /router ${sub}\nUse: status|cheap|mid|heavy|vision|auto|disable|reset`,
        "warning",
      );
    },
  });
}
