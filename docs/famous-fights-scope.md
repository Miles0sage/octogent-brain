# Famous Fights gallery — scope (v0.3 launch dependency)

NotebookLM elevated the Famous Fights gallery from "nice SEO surface" to **load-bearing Day 7 blocker**: it is the redirect target when a real user hits the 5/IP/day Turnstile cap. Without 10 seeded fights, the viral loop breaks on the second user.

## What counts as a Famous Fight

A Famous Fight is a real argued.dev run with a stable `/v/<id>` URL where the 4 CLIs **spectacularly disagree**. The 2026-05-13 dogfood run on `openai/openai-node#1837` is **Fight #1** — 3 APPROVE / 1 REJECT, codex caught a backward-compat regression the others approved. Consensus = SPLIT, gate accepts all 4. That's the shape we need 9 more of.

## Selection criteria

A candidate PR is a Famous Fight when **all five** hold:

1. **Public + permalink-stable** — recent enough that the GitHub diff URL still resolves; not a force-pushed branch.
2. **Real production code** — not docs, not lockfile bumps, not whitespace. Touches a function body or a security-relevant code path.
3. **Darwin-prior alignment** — the diff embeds within distance threshold of one of the 12 unique clusters in `apps/argue-api/db/argued.sqlite`. If no priors attach, the verdicts read as generic.
4. **Cross-CLI tension by design** — the diff exhibits at least one of:
   - a security or backward-compat trap (codex bait)
   - a refactor-touches-some-call-sites pattern (aider bait)
   - a cross-file consistency or architectural question (claude-code bait)
   - a design-system / a11y / UX call (gemini-cli bait)
5. **Famous-enough subject** — a popular OSS repo (>10k stars OR security-relevant), so the launch tweet has gravitas and journalists can grok the stakes.

## Source pools to scout (in roughly descending viral payload)

| Pool | Why | Cost to scout |
|---|---|---|
| **A. Recent CVE-bearing PRs** — log4j-class fixes, openssl backports, supply-chain patches | Maximum drama, security press picks up | High — need a CVE-feed scan + manual triage |
| **B. Anthropic/OpenAI/Google SDK monthly patches** with active reviewer comment threads | Self-referential (we use these CLIs), comment thread proves humans already split | Medium — `gh pr list --state merged --label bug` per repo |
| **C. Stripe / Plaid / GitHub SDK serialization or signing-secret patches** | Edge-case bait, codex-strong territory | Medium |
| **D. React / Vue / Svelte HMR + a11y regressions** | gemini-cli vs claude-code split shape, design-system tension | Medium |
| **E. Node.js / Bun / Deno security-team-merged patches** | Architecture + backward-compat doubled | Medium |
| **F. TensorFlow / PyTorch unsafe-tensor or pickle-loader fixes** | Quiet but devastating bug class, codex-strong | Low — easy to find via CVE pages |
| **G. Linux kernel + driver patches** (only if accessible diff renders cleanly) | Maximum technical credibility, extreme drama | Highest — kernel diffs are dense |
| **H. Past-self argued.dev runs** — replay against our own merged PRs | Closes the loop on the methodology doc | Lowest — internal |

## Vetting workflow

Cheaper than a real argued.dev run per candidate. Two-stage:

1. **Pre-flight screen** (5 min per candidate): fetch diff with `pr-fetcher`, run only **oracle.lookup()** to check Darwin prior attach. If 0 priors above similarity threshold, skip — verdicts will be hollow.
2. **Real argue() run** (~$0.30 + 130s per candidate): run only on the screened survivors. Keep `/v/<id>` if consensus is SPLIT or REJECT-dominant. Discard if 4/4 APPROVE — those aren't fights.

Budget: 30 candidates × $0.10 screen + 15 candidates × $0.30 real argue ≈ **$8 total**. Sub-marketing-cost.

## Acceptance for v0.3 launch

10 `/v/<id>` URLs that:

- Each have ≥1 REJECT and ≥1 APPROVE among the 4 verdicts (consensus ≠ unanimous).
- Each attach ≥1 Darwin prior so the page reads with citations, not generic verdicts.
- Cover ≥4 distinct source pools (don't ship 10 openai-node SDK patches — looks rigged).
- Each gate_pass=true for at least 3 of 4 CLIs (no rubber-stamps survive even in the gallery — quality bar holds).

Each entry needs:

- The PR URL + diff SHA at scrape time (so it's reproducible offline if upstream deletes the PR).
- A one-sentence "who said what" caption for the gallery index page.
- The OG image already generated and cached at `argued.dev/og/<id>.png`.

## What this is NOT

- Not synthetic. Real PRs only. Synthetic diffs were considered + rejected — they break the "audit our own corpus" credibility.
- Not curated for a specific CLI's reputation. We let real verdicts land. If codex is wrong in 3 of 10 fights, that goes on the gallery too. The honesty is the moat.
- Not gated behind login. The whole point is the 429 redirect target — no auth, no friction.

## Next concrete step (user-owned)

Pick the 9 candidate PRs. I can run the pre-flight oracle screen in batch as soon as you drop a list of candidate URLs in `dpo-pairs/famous-fights-candidates.txt` (one URL per line). The argue() run for survivors is then a single `pnpm release:gate` invocation per PR with `ARGUED_SMOKE_PR_URL=<url>` + `ARGUED_SMOKE_ARTIFACT_DIR=/tmp/fight-<n>`.
