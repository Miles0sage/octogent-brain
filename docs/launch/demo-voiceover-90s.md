# 90s demo voiceover — Wed 2026-05-13 recording

Storyboard derived from the Playwright headless smoke that ran 2026-05-12 against `http://152.53.55.207:8788`. Three panels prove the loop without slides.

## Setup

- Browser at 1920×1080, dashboard at `http://152.53.55.207:8788` (or local `localhost:8788`)
- Mute system audio, monotype font for the voiceover
- Pre-warm: nav-14 Verify panel pre-clicked once so the rubber-stamp chip is ready
- Pre-warm: clear any previous vote outcome from nav-12 Gantt
- Pre-warm: codex driver — leave as health-failed (transport-unsupported is a real artifact, not a flaw to hide)

## Voiceover (timestamps in mm:ss)

**0:00 → 0:08 — Open**
> "Three LLMs vote on every diff before it touches your repo. Local. Free."

[Cut: dashboard loaded, Octogent header visible, 15-button nav rail rendered]

**0:08 → 0:25 — The bug (Verify panel)**
> "Here's the bug. The reviewer claims pass — but its own scores fall below 0.85. Anthropic flagged this pattern in their March 24 harness post."

[Click: nav 14 Verify → click rubber-stamp chip → fixture text loads into textarea]

> "Run the gate."

[Click: Run gate button]

**0:25 → 0:38 — The catch**
> "BLOCK. The trust-numbers rule fires. Reviewer said pass, the numbers say groundedness 0.62 — under threshold. Loop re-iterates instead of merging the lie."

[Frame on: BLOCK badge red, reason text "gate-trust-numbers: claimed pass but groundedness=0.62 < threshold 0.85"]

**0:38 → 0:52 — The cross-vendor wedge (Drivers panel)**
> "Four drivers, four vendors. Aider writes. Claude reviews. Codex breaks ties. Gemini gives intel. Health probes live."

[Click: nav 15 Drivers → all four CLI cards render with health states]

**0:52 → 1:18 — Real vote (Gantt panel)**
> "Real cross-vendor vote. One task — evaluate 2 plus 2 equals 4. Three vendors, parallel. Mechanical consensus."

[Click: nav 12 Gantt → scroll to Cross-vendor vote card]
[Type into textarea: 'Reply YES to confirm 2+2=4. End with JSON {"verdict":"pass",...}']
[Uncheck Dry run → click Run cross-vendor vote]
[Wait ~16s while the bar fills]

> "Claude returns pass. Groundedness 0.95. Sixteen point four seconds. The bar is real subprocess time, not a fake timer."

[Frame on: PASS chip, claude-code row with grnd 0.95 / spec 0.90, duration 16.4s]

**1:18 → 1:30 — Pull-up**
> "Anthropic can't ship this. It cannibalizes their API revenue. We can. Two npm installs away. MIT license. Discord link below."

[Cut: GitHub URL + npm install command + Discord link overlay]

## Capture mechanics

- Use OBS or built-in Cmd+Shift+5 (Mac)
- Record at 60fps for the bar-fill smoothness during the 16.4s real vote
- Don't speed up the real-vote section — the 16.4s wall clock IS the proof, speeding it up reads as fake
- DO speed up dashboard nav clicks 1.5x (they're not the proof)
- Render at 1280×720 final for HN/Discord/Twitter sizing
- Caption track in burned-in subtitles (auto-play HN preview is muted)

## Frame highlights to keep

- 0:25 → BLOCK badge with reason text
- 0:38 → 4-driver grid w/ health states (showing codex's transport-unsupported is FINE — real artifact)
- 1:08 → live PASS chip + grnd 0.95 number
- 1:25 → GitHub URL + `npm install @octogent/supervisor`

## Mistakes to avoid

- Don't film a dry-run vote — must be real subprocess
- Don't hide the codex transport-unsupported row — proves the dashboard surfaces reality not theater
- Don't add a music bed — engineering audience reads it as marketing fluff
- Don't show Brain or Rollouts panels in the 90s window — they're claude-brain-fork artifacts, dilute the cross-vendor message
- Don't include a "thanks for watching" outro — wastes 5s the algorithm uses to gauge dropoff
