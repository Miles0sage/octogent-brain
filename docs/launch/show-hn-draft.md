# Show HN — launch draft

> Status: draft v1. Built 2026-05-12 from L2 distribution-playbook research
> (research/2026-05-12-octogent-agency/lane-2-monetization-playbook.md) +
> NotebookLM round-3 synthesis. Ship Friday afternoon US time (per HN
> time-of-day analyses, that's the empirically best Show HN slot).
>
> Prerequisites before posting:
> 1. `pnpm publish --access public` from packages/core (then supervisor).
> 2. Repo public at github.com/Miles0sage/octogent-brain (or renamed).
> 3. 90-second screen recording embedded in README + as a tweet attachment.
> 4. Discord invite live in README + this post.

## Title (the headline matters most)

**Show HN: I lost 90 days to a rubber-stamping Claude — here's the npm wrap I wish existed**

Alternates if A/B testing:
- Show HN: Mechanical Supervision — an npm wrap that catches AI agents lying about their own work
- Show HN: Cross-vendor verifier for Claude / Aider / Codex / Gemini in 12 lines of TypeScript

Pick the lived-experience version. It opens a story; the others open a feature.

## Body

```
Last December I started building an agent stack on Claude Code. Every
day for 90 days I watched the same failure: agent says "all tests pass,"
agent didn't actually run the tests, I notice 20 minutes later when prod
breaks. I tried prompting harder. I tried adding a reviewer agent. The
reviewer rubber-stamped the writer's confidence framing every time.

Anthropic published the exact failure mode on 2026-03-24 in "Harness
design for long-running application development" — their evaluator
"talked itself into deciding bugs weren't a big deal" when it shared
context with the writer. So the fix is mechanical: keep the writer in
one OS process, the evaluator in another, and trust the numbers over
the prose.

@octogent/supervisor is the npm package I wish existed when I started.
~15 lines wraps your existing Claude / Aider / Codex / Gemini-CLI calls:

  import { createVerdictWatcher } from "@octogent/supervisor";

  const watcher = createVerdictWatcher();
  const child = spawn("claude", ["--print", "--permission-mode", "plan", task]);
  child.stdout.on("data", (chunk) => {
    const obs = watcher.observeChunk(chunk.toString("utf8"));
    if (obs.kind === "verdict-blocked") {
      // Reviewer claimed "pass" but its own scores < 0.85.
      // Force re-iteration with the gate's audit log.
      child.stdin?.write(obs.reinjectPrompt);
    }
  });

The load-bearing rule is "gate-trust-numbers": when the reviewer emits
`{"verdict": "pass", "scores": {"groundedness": 0.62}}`, the gate
overrides the textual "pass" because 0.62 is below the 0.85 threshold.
Demo recording embedded in the repo — writer says all-tests-pass,
gate catches the lie, trust score visibly drops to zero, runtime
auto-re-iterates until the numbers actually clear.

Plus a cross-vendor `tallyVotes()` for fan-out: same task to Claude +
Aider + Codex, pick the winner by consensus → strong-reject → qualified
majority. Anthropic structurally can't ship this because cross-vendor
routing cannibalizes their API revenue — so it's the moat.

MIT licensed. Node 22+. One workspace dep (@octogent/core, also MIT,
also published from this monorepo). 86 substrate tests (29 supervisor +
57 core); the full octogent-brain dashboard adds ~315 more for a 401
repo total. No hosted demo URL yet — the README has the 90-second
screen recording, install + run locally to follow along.

What I'd love to know:
1. Is the "verdict JSON tail" contract reasonable, or should I expose
   a callback-based parser instead?
2. The voting rules are precedent-based (consensus > strong-reject >
   qualified-majority). Anyone using a different ordering in production?
3. Cost-cap enforcement is on the v0.2 roadmap; would you want a hard
   $-ceiling per dispatch or a token-count one?

Discord: <invite>
Repo: github.com/Miles0sage/octogent-brain
npm: npm install @octogent/supervisor
```

## First reply (have this ready to drop within 10 min of posting)

```
Author here. Quick FAQ:

> "Why not just use Claude's --ultrareview?"
ultrareview is Claude-only and runs in Anthropic's cloud. This runs
locally, wraps any CLI agent, and the voting rule means one vendor
can't unilaterally pass its own work.

> "Why 0.85 as the gate threshold?"
Configurable per-call (`createVerdictWatcher({gate: {groundednessThreshold:
0.9}})`). 0.85 is the default because that's what Anthropic's own
"Harness design" post benchmarks against. Document at docs/concepts/
mechanical-supervision.md.

> "What if the agent doesn't emit JSON?"
Prompt the agent to emit `{verdict, scores}` as the final line — the
watcher walks the rolling 16kB scrollback so prose preamble is fine.
If no JSON ever lands, the loop treats it as implicit fail and forces
re-iteration up to the 5-iter cap.
```

## Companion 90-second screen recording

Storyboard (record at 1920×1080, 30fps, OBS / Loom):

| Time | Visual | Voiceover |
|---|---|---|
| 0:00-0:10 | Real Claude session: writer says "all tests pass!" → cut to ACTUAL test output showing failure | "Watch this. Claude says all tests pass." |
| 0:10-0:20 | Install: `npm install @octogent/supervisor` + the 12-line wrapper code | "Wrap your existing Claude call in 12 lines." |
| 0:20-0:40 | Same session repeated with supervisor wrapped. Verdict-watcher catches the lie, BLOCK badge appears in dashboard, trust score animates to zero | "Now the gate catches the lie. Trust drops to zero." |
| 0:40-0:55 | Cross-vendor: same prompt fans to Claude + Aider + Codex. Three voter rows appear. Consensus arrow renders | "Cross-vendor voting. Three CLIs vote. Pick the winner mechanically." |
| 0:55-1:20 | Show RolloutsGantt waterfall with multiple agent rollouts + a BLOCK node | "All visualized in real time. No other OSS dashboard ships this." |
| 1:20-1:30 | Pull-up: GitHub repo + npm + Discord links + "Mechanical Supervision" tagline | "Apache MIT. github.com/Miles0sage/octogent-brain. Join the Discord." |

## Cross-posts (D4 also fires)

| Channel | Adjusted title | Notes |
|---|---|---|
| **r/ClaudeAI** | Built an npm wrap that catches Claude rubber-stamping its own work | Single demo gif. Link npm + repo. |
| **r/LocalLLaMA** | Cross-vendor verifier loop (Aider/Claude/Codex/Gemini) — npm install, 12 lines | Lead with the cross-vendor angle, not the Claude one |
| **X thread (Miles)** | 1/ For 90 days... 2/ ...harness post... 3/ ...npm install... 4/ ...demo gif... 5/ ...repo link | 5-tweet thread, each with a screen capture |
| **LinkedIn** | Long-form repurpose of the HN body | One image, the consensus-arrow shot |
| **Hacker News Show subreddit syndication** | (Auto via lobste.rs?) | Optional |

## Discord pre-setup

- Channels: #announcements, #help, #show-and-tell, #contributing, #v2-feedback
- Welcome message linking the 90-sec demo + the GitHub Issues "good-first-issue" list
- Pin the FAQ from "First reply" above
- 3 staff role assignments (Miles + 2 trusted future contributors)

## Show HN posting checklist

- [ ] Repo is public + has README with screenshot/gif at top
- [ ] LICENSE file present + matches package.json (MIT)
- [ ] npm packages published + `npm install @octogent/supervisor` returns version 0.1.0
- [ ] Discord invite link valid for 7+ days
- [ ] X thread drafted + scheduled for same hour as HN post
- [ ] 90-sec demo embedded in README + uploaded unlisted to YouTube
- [ ] First-reply FAQ paste-ready in clipboard
- [ ] Phone notifications ON for the next 24 hours (HN front-page goes fast)
- [ ] Block the next 4 hours for replies — silence kills momentum
- [ ] Post Friday 09:00-11:00 PT (HN front-page best window per dang AMAs)

## Anti-launch

What I'm NOT including in the launch:
- "Built in 5 hours" — sounds throwaway
- $-pricing — confuses the OSS narrative
- Hackathon mention — separate story
- AI Engineer World's Fair plug — that's a D8 move
- Comparison to ulta-review by name — antagonizes Anthropic for no upside

## Hard gates

- **D7 gate (1 week post-launch):** npm installs ≥ 10, GitHub stars ≥ 20. If miss → pivot to wedge-fix, not productize.
- **D14 gate:** ≥ 1 external developer runs the cross-vendor loop end-to-end and posts about it. If miss → community-build mode, not monetize.
- **D21 gate:** ONE of {signed LOI / paid pilot / Google Cloud Marketplace approval}. Binary.
