# human-controlled

[![human-controlled](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/dhobi/human-controlled/badge/badge.json)](https://github.com/dhobi/human-controlled)

**Is this AI-built project under human control?**

Give it a repository, get a percentage and the evidence behind it. Every
number comes from the repository's own history: merged pull requests, reviews,
CI runs, the workflows and the file tree. Nothing is self-declared.

It is an indication, not proof. Everything it looks at can be faked. What it
can do is show whether the safeguards exist, and tell you when one drifts.

## Run it

Needs Node 18+ and either the [GitHub CLI](https://cli.github.com/), logged in,
or a token in `GITHUB_TOKEN`.

```sh
node human-controlled.mjs https://github.com/owner/repo
node human-controlled.mjs owner/repo --days 30 --json
```

A run takes 10–25 seconds. It looks at the last 90 days (at most 300 merged
PRs and 500 commits).

## In your repository: a badge

The repository's action scores a repository and writes a
[shields.io endpoint](https://shields.io/badges/endpoint-badge) file. This
workflow publishes it to a `badge` branch after every merge and once a week,
without touching `main`:

```yaml
name: Badge
on:
  push:
    branches: [main]
  schedule:
    - cron: "17 5 * * 1"
permissions:
  contents: write
  pull-requests: read
  checks: read
jobs:
  badge:
    runs-on: ubuntu-latest
    steps:
      - id: hc
        uses: dhobi/human-controlled@main
        with:
          badge: ${{ runner.temp }}/badge.json
      - env:
          GH_TOKEN: ${{ github.token }}
        run: |
          mkdir "$RUNNER_TEMP/site" && mv "$RUNNER_TEMP/badge.json" "$RUNNER_TEMP/site/" && cd "$RUNNER_TEMP/site"
          git init -q -b badge && git add badge.json
          git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" commit -q -m "Badge"
          git push -qf "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" badge
```

Then, in the README, with your own owner and repository:

```markdown
[![human-controlled](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/OWNER/REPO/badge/badge.json)](https://github.com/dhobi/human-controlled)
```

The badge shows the score (green from 75%, yellow from 50%, orange below),
"safeguards" for a repository that bans AI, and grey "no score yet" or
"mirror, no score" where there is nothing to judge. The run's summary page has
the full table.

## What it checks

| Pillar | Check | Weight |
|---|---|---|
| Transparency | An AI policy is written down: how to use AI, how to disclose it, or that it is not welcome. In the repo, on a page linked from a README or CONTRIBUTING sentence about how the project is made with AI, or on a policy page those link to | 5 |
| Transparency | AI-attributed work carries a machine-readable mark: a trailer (`Co-Authored-By:`, `Assisted-By:` …), a PR label (`ai-assisted`, `ai-generated` …) or an `AI:` field in the PR body | 5 |
| Human control | Changes land through pull requests (with no AI visible, small commits pushed straight to the branch count too) | 10 |
| Human control | Pull requests are approved by another human | 25 |
| Human control | Changes are small enough to review: under 400 changed lines of code and tests per PR; a commit pushed straight to the branch counts whole | 10 |
| Machine verification | The default branch is green (no CI at all scores 0) | 10 |
| Machine verification | Source changes come with tests | 10 |
| Machine verification | Coverage is measured (half) and enforced by a threshold (full) | 10 |
| Machine verification | Releases or deploys are automated | 5 |
| Outcome | Few reverts | 5 |
| Outcome | AI-attributed changes are reviewed and reverted like the rest | 5 |

A project does not have to use `Co-Authored-By:`. Many rule it out because
GitHub then lists the tool as a co-author; any of the other marks counts the
same. A label has to say what it discloses: a bare `ai` or `copilot` label is
as often a topic. When a PR carries no mark, the evidence lists it and names
the trailer or label the project's own policy asks for.

A review by an AI is not a review by another human, even from an account
GitHub does not mark as a bot. A reviewer whose login says review, bot or
agent, and that approves at least half of all merged PRs or has an account
younger than three months, is treated as a machine; the evidence names it.

Some projects review outside GitHub's pull requests and say so in the commit:
a merge bot's `Approved by:` (pytorch), `Reviewed-by:`, Gerrit's
`Reviewed-on:`, Phabricator's `Differential Revision:`, or Google's
`PiperOrigin-RevId:` on changes reviewed inside Google (tensorflow). Such a
commit counts as a reviewed change that landed through review, unless the
approval names its own author.

The 400-line limit comes from code review research: past roughly 200–400
changed lines, reviewers stop finding defects (SmartBear's study at Cisco).

A check with too little data to judge is left out and the other weights are
scaled up. A missing safeguard scores 0.

Generated files do not count towards a change's size: files marked
`linguist-generated` or `linguist-vendored` in `.gitattributes`, and big files
that say "do not edit" or "generated" at the top.

## The verdict

Before the score, the tool asks whether the project has said how it handles
AI, and whether its history agrees. Some answers cap the score, however good
the safeguards are:

| Policy | History | Verdict | Score |
|---|---|---|---|
| allows AI | anything | AI-aware | the safeguards |
| bans AI | no AI attributed | AI banned | the safeguards, labelled as such |
| bans AI | 3+ AI-attributed changes | ban broken | at most 25% |
| none | 3+ AI-attributed changes | AI used without a policy | at most 40% |
| none | 2+ AI-like bursts | possibly AI, undeclared | at most 40% |
| none | neither | no AI visible | the safeguards |

An **AI-like burst** is three or more large changes (over 400 lines) by one
author within an hour, none of them reviewed: a pace nobody types at. It is
counted whether or not anything says "AI", so deleting the footers does not
escape the cap. A human pasting in a library looks the same, which is why it
is "possibly".

With **no AI visible**, the code's author is the control: whoever wrote it
understands it. Tests and CI make such code better, not more controlled, so
they are left out, as are the AI policy and the revert rate. What remains is
whether changes arrive in steps a person can follow: through pull requests or
as commits under 400 lines, and other people's pull requests approved or
merged by someone other than their author.

Machine checks count where AI is involved, because they are how a human
controls code nobody on the team wrote. The tool asks about control, not
quality; quality is what tools like SonarQube are for.

A ban is something a repository says, not something the tool can check, so a
banned repository is still scored on its safeguards:

```
servo/servo: 84% safeguards (an indication, not proof)
verdict: AI banned by policy (https://book.servo.org/policy/ai-usage.html)
```

## No score: mirrors and thin history

A repository with fewer than 10 commits in the window gets no score: a
handful of commits says nothing about how a project is run.

### Mirrors

When the GitHub repository is a mirror, its review happens elsewhere, and
GitHub's data says nothing about it. The tool then prints why and gives no
score (exit code 3). A mirror is a repository whose description says so, or
one where many people commit (5 or more) and almost nothing (under 10%) lands
through a pull request. Gentoo, PostgreSQL and the Linux kernel are examples.

A solo developer pushing straight to the branch is not a mirror: that is
scored like any other repository.

## What it cannot see

- AI use nobody disclosed. A repository that hides it looks AI-free.
- Whether a solo maintainer read their AI's pull request before merging. Only
  a second person's approval leaves a trace.
- Whether the tests check anything. Coverage shows lines run, not lines
  verified.

## Status

GitHub only. Run by hand, or in a workflow with the action above.

## How it is made

This tool is written by an AI (an LLM) and directed by a human; how that
works is in [AI_POLICY.md](AI_POLICY.md).

## License

MIT
