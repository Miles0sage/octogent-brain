# Show HN first comment — Wed 2026-05-13 ~07:00 UTC

Comment goes RIGHT AFTER the title posts. Sets context, kills the obvious "why not just X" objection, and seeds the moat sentence so other commenters echo it.

## The locked draft (270 words)

Hey HN — I'm Miles, solo builder.

I spent 90 days fighting Claude Code rubber-stamping its own work. The pattern is consistent: agent writes code, agent reviews own code, agent says "tests pass," files don't even compile. Anthropic's own tracker has it on record: issues/53989 ("marks done, isn't done"), issues/58212 ("definition-of-done rationalization"), issues/54117 ("41 logged violations across 60+ sessions"). HN's been there too — `nkov47as` measured 12% of error-state sessions = rubber-stamp.

Octogent is an npm package that fixes this by mechanical supervision: every diff your AI agent produces is reviewed by a **different vendor's** model before it touches your repo. Aider writes. Claude reviews. Codex breaks ties. Local. Free beyond the API keys you already pay for. It catches the class of confabulation that single-vendor self-review can't, because the reviewer is structurally not the writer.

Anthropic merged their own outcome-grader cookbook (`CMA_verify_with_outcome_grader.ipynb`) 6 days ago. They cannot ship cross-vendor — it cannibalizes their API revenue. So we did.

What's in the box:
- `@octogent/supervisor` — runs the same task across claude-code / aider / codex / gemini-cli, parses verdicts, votes mechanically (consensus → strong-reject → qualified-majority precedence)
- `@octogent/core` — the verdict-gate primitives if you want to roll your own
- 442+ tests, MIT license, two `pnpm add` commands away
- Live demo: $DEMO_URL (cross-vendor vote on a real `2+2=4` task → claude-code returns pass / grnd 0.95 in 16.4s)

90 days of pain → npm wrap. AMA on:
- the verdict-gate "trust the numbers not the text" rule
- why we ship Anthropic's CMA rubric format as our voter input contract (v0.2)
- per-day cost caps for solo Claude Pro Max burners (v0.2)
- what NOT to put in a cross-vendor voter loop

## Posting checklist

- [ ] Replace `$DEMO_URL` with the live dashboard URL (or a Loom of the 90s demo)
- [ ] Post comment within 60s of title hitting front
- [ ] Stay parked in the thread for ~3 hours; respond to every top-level reply within 5 minutes
- [ ] If a "this is just X with extra steps" comment hits, respond with: "X is single-vendor. The whole point is that no single vendor can be both writer and reviewer without rubber-stamping. See nkov47as's data (12% rate) and Anthropic's own issues/53989."
- [ ] Don't engage with "AI agents are useless" off-topic — let other commenters do it

## Variants if the lead falls flat

If under 30 upvotes in first 2 hours:

Variant B — lived-experience hook stronger:
> "I'm Miles. Spent 90 days fighting Claude Code lying about test results — paid $200/mo for the privilege. This is the npm wrap I wish existed on day one..."

Variant C — feature-led for the AI-infra crowd:
> "Cross-CLI verdict gate via OS-process isolation. 442 tests. MIT. Verifier loop runs locally across any combo of {claude-code, aider, codex, gemini-cli}..."

The L5 scorecard ranked C1=8 and D1=9 — D is the lead, C is the rescue.
