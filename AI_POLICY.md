# AI policy

This tool is built with AI, and it measures projects built with AI, so it
should say plainly how it is made.

## How this tool is made

An AI (a large language model) writes the code. The repository owners (human)
decide what the tool should measure and why, which rules are fair, and when a
change is good enough to merge. They judge a change by what it does to the
scores of real repositories, not by reading every line.

Every change is tried against a fixed set of repositories before it lands:
some run by humans, some that ban AI, some built by AI agents, and some that
are mirrors. A rule that moves one of them in a way nobody can explain is
wrong until it can be explained.

## Contributing with AI

AI tools are welcome. What counts is that a person stays in control:

- **Disclose it.** A commit an AI wrote or co-wrote carries a trailer such as
  `Co-Authored-By: <tool>` or `Assisted-By: <tool>`. This tool rewards that,
  and never penalises it.
- **Understand what you submit.** You should be able to explain the change and
  why the scores it moves are fairer afterwards.
- **No autonomous agents.** An agent may write a change; a person opens the
  pull request and answers for it.
- **Keep changes small.** Under 400 changed lines, the same limit the tool
  applies to everyone else.

## Issues and comments

Replies in issues and pull requests are often drafted by an LLM. The
repository owners (human) read and post them, and are responsible for what
they say.
