#!/usr/bin/env node
// human-controlled: is this AI-built project under human control? An indication
// from evidence only, not proof: everything here can be faked.
//
//   node human-controlled.mjs https://github.com/owner/repo [--days 90] [--json]
//
// Every number comes from the GitHub API (with the `gh` login, or $GITHUB_TOKEN
// in CI): merged PRs, their reviews, files, commits and checks, the default
// branch's history, the CI workflows and the file tree. Nothing is
// self-declared. A check with too little data to judge
// (e.g. AI parity in a repo with no AI-attributed PRs) is left out and the
// remaining weights are scaled up; a safeguard that is missing scores 0.

import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith("--"));
const DAYS = Number(args[args.indexOf("--days") + 1]) || 90;
const JSON_OUT = args.includes("--json");
const m = url?.match(/github\.com[/:]([^/]+)\/([^/.#?]+)/) ?? url?.match(/^([^/]+)\/([^/]+)$/);
if (!m) {
  console.error("usage: human-controlled <github repo url | owner/repo> [--days 90] [--json]");
  process.exit(2);
}
let [owner, repo] = [m[1], m[2]];
const since = new Date(Date.now() - DAYS * 864e5).toISOString();
const MAX_PRS = 300;
const MAX_COMMITS = 500;
const MIN_COMMITS = 10;
// An AI-like burst: this many large unreviewed changes by one author within the window
const BURST_SIZE = 3;
const BURST_WINDOW = 60 * 60e3;
const MIN_BURSTS = 2;

// Direct HTTP with the `gh` login's token (or $GITHUB_TOKEN in CI): one process,
// and independent requests run side by side
const TOKEN = process.env.GITHUB_TOKEN || execFileSync("gh", ["auth", "token"]).toString().trim();
const HEADERS = { authorization: `Bearer ${TOKEN}`, "user-agent": "human-controlled" };
async function rest(path) {
  try {
    const r = await fetch(`https://api.github.com/${path}`, { headers: HEADERS });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
// GitHub answers a heavy query on a big repo with a 502 page now and then; a
// retry usually gets through
async function graphql(query, variables, tries = 4) {
  const r = await fetch("https://api.github.com/graphql", { method: "POST", headers: HEADERS, body: JSON.stringify({ query, variables }) });
  const j = await r.json().catch(() => null);
  if (!j?.data && tries > 1) {
    await new Promise((ok) => setTimeout(ok, 2000));
    return graphql(query, variables, tries - 1);
  }
  if (!j) throw new Error(`GitHub GraphQL answered ${r.status}`);
  if (j.errors) throw new Error(j.errors.map((e) => e.message).join("; "));
  return j.data;
}
// the first bytes of a file, without downloading the rest
async function head(ref, path, bytes = 1500) {
  try {
    const r = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path.split("/").map(encodeURIComponent).join("/")}`, { headers: { ...HEADERS, range: `bytes=0-${bytes - 1}` } });
    return r.ok ? (await r.text()).slice(0, bytes) : "";
  } catch { return ""; }
}
const fileText = async (path) => {
  const f = await rest(`repos/${owner}/${repo}/contents/${path}`);
  return f?.content ? Buffer.from(f.content, "base64").toString() : null;
};
// map with at most `n` requests in flight
async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// ---- AI attribution ---------------------------------------------------------

const AI_TOOLS = "claude|anthropic|copilot|openai|chatgpt|gpt-?[0-9]|codex|cursor|devin|gemini|aider|windsurf|codeium|tabnine|amazon q|jules|sweep|cody";
const AI_TRAILER = new RegExp(`^(co-authored-by|assisted-by|generated-by|ai-assisted-by):.*\\b(${AI_TOOLS})`, "im");
const AI_PROSE = new RegExp(`(generated|written|created|co-?authored) (with|by|using) \\[?(${AI_TOOLS})`, "i");
const AI_BOT = new RegExp(`(${AI_TOOLS})`, "i");
const isBot = (a) => !a || a.__typename === "Bot" || /\[bot\]$|-bot$|^bot-/i.test(a.login ?? "");

// ---- data -------------------------------------------------------------------

const PR_QUERY = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 50, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      number title body mergedAt mergedBy { login }
      author { login __typename }
      reviews(states: APPROVED, first: 20) { nodes { author { login __typename } } }
      changedFiles
      files(first: 100) { nodes { path additions deletions } }
      commits(first: 100) { nodes { commit { message } } }
    } }
  }
}`;

async function mergedPRs() {
  const out = [];
  let after = null;
  do {
    const r = (await graphql(PR_QUERY, { q: `repo:${owner}/${repo} is:pr is:merged merged:>=${since.slice(0, 10)}`, after })).search;
    out.push(...r.nodes.filter((n) => n.number));
    after = r.pageInfo.hasNextPage ? r.pageInfo.endCursor : null;
  } while (after && out.length < MAX_PRS);
  return out.slice(0, MAX_PRS);
}

const HISTORY_QUERY = `query($owner: String!, $repo: String!, $since: GitTimestamp!, $after: String) {
  repository(owner: $owner, name: $repo) {
    defaultBranchRef { name target { ... on Commit {
      history(since: $since, first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { oid message committedDate additions deletions author { email user { login } } associatedPullRequests(first: 5) { nodes { number merged baseRefName } } statusCheckRollup { state } }
      }
    } } }
  }
}`;

async function defaultBranch() {
  const commits = [];
  let after = null, name = null;
  do {
    const ref = (await graphql(HISTORY_QUERY, { owner, repo, since, after })).repository.defaultBranchRef;
    if (!ref) return { name: null, commits: [] }; // an empty repository
    name = ref.name;
    const h = ref.target.history;
    commits.push(...h.nodes);
    after = h.pageInfo.hasNextPage ? h.pageInfo.endCursor : null;
  } while (after && commits.length < MAX_COMMITS);
  // a commit "landed through a PR" when a PR merged into this branch carries it
  for (const c of commits) c.viaPR = c.associatedPullRequests.nodes.find((p) => p.merged && p.baseRefName === name)?.number ?? null;
  return { name, commits: commits.slice(0, MAX_COMMITS) };
}

const TEST_PATH = /(^|\/)(tests?|specs?|__tests__|testing|e2e)(\/|$)|[._-](test|spec)s?\.[a-z0-9]+$|(^|\/)test_[^/]+$|_test\.[a-z0-9]+$/i;
const DOC_PATH = /\.(md|mdx|rst|txt|adoc)$|(^|\/)(docs?|\.github)\/|(^|\/)(license|changelog|readme)/i;
const CONFIG_PATH = /(^|\/)(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|cargo\.lock|go\.sum|poetry\.lock|\.[^/]*rc(\.[a-z]+)?|.*\.(ya?ml|toml|ini|cfg|lock))$/i;
const isSource = (p) => !TEST_PATH.test(p) && !DOC_PATH.test(p) && !CONFIG_PATH.test(p);

// An AI policy is any written rule about AI contributions: how to use it, how
// to disclose it, or that it is not welcome. It may live in the repo or on a
// page the README or CONTRIBUTING links to (followed two links deep).
const AI_WORD = new RegExp(`\\bAI\\b|\\b(LLMs?|generative|(large )?language models?|machine-generated|${AI_TOOLS})\\b`, "i");
const RULE_WORD = /\b(polic(y|ies)|guidelines?|rules?|disclos\w*|ban(ned|s)?|prohibit\w*|forbid\w*|(not )?(accept|allow|permit)\w*|must|reject\w*|usage)\b/i;
const isPolicyText = (text) => text.split(/(?<=[.!?])\s+|\n/).some((line) => AI_WORD.test(line.replace(/\bai\b/g, "")) && RULE_WORD.test(line));
const POLICY_PATH = /(^|\/)(ai|llm|genai)[-_ ]?(policy|usage|guidelines?|contributions?|assist\w*)\.(md|rst|txt|adoc)$|(^|\/)ai\.md$/i;
const POLICY_HOME = /^(\.github\/|docs\/)?(contributing|readme|code_of_conduct|governance)\.(md|rst|txt|adoc)$/i;

async function fetchPage(url) {
  try {
    const r = await fetch(url, { headers: { "user-agent": "human-controlled" }, signal: AbortSignal.timeout(8000) });
    if (!r.ok || !/text|html/.test(r.headers.get("content-type") ?? "")) return null;
    const html = await r.text();
    const links = [...html.matchAll(/href="([^"#]+)/g)].map((m) => { try { return new URL(m[1], r.url).href; } catch { return null; } }).filter(Boolean);
    return { url: r.url, text: html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " "), links };
  } catch { return null; }
}

// Where the policy is, and its text: the page itself, plus the AI-looking pages
// on the same site it links to, where a book or wiki keeps the actual rule
async function policy(tree) {
  const found = await findPolicy(tree);
  if (!found) return null;
  const sources = [found];
  if (/^https?:/.test(found.at)) {
    const page = await fetchPage(found.at);
    const deeper = (page?.links ?? []).filter((u) => new URL(u).host === new URL(found.at).host && /\bai\b|ai[-_.]|llm|polic/i.test(new URL(u).pathname)).slice(0, 6);
    sources.push(...(await mapLimit(deeper, 6, fetchPage)).filter(Boolean).map((pg) => ({ at: pg.url, text: pg.text })));
  }
  // name the page that carries the ban, when it is a deeper one
  const banning = isBan(sources.map((x) => x.text).join("\n")) && sources.find((x) => isBan(x.text));
  return banning ? { at: banning.at, ban: true } : { at: found.at, ban: false };
}

// A ban: a sentence that names AI and refuses it, and none that welcomes it
const BAN_WORD = /\b(ban(ned|s)?|prohibit\w*|forbid\w*|not (be )?(accept|allow|permit)\w*|(must|may|shall) not (include|contain|be|use|submit)|no (AI|LLM)[- ]?(generated|assisted|contributions?))\b/i;
const WELCOME_WORD = /\b(welcome\w*|encourag\w*|you may use|(is|are) (allowed|permitted|fine)|feel free)\b/i;
function isBan(text) {
  const lines = text.split(/(?<=[.!?])\s+|\n/).filter((l) => AI_WORD.test(l.replace(/\bai\b/g, "")));
  return lines.some((l) => BAN_WORD.test(l)) && !lines.some((l) => WELCOME_WORD.test(l) && !BAN_WORD.test(l));
}

async function findPolicy(tree) {
  const paths = tree?.paths ?? [];
  const repoFile = async (p) => ({ at: p, text: (await fileText(p)) ?? "" });
  const named = paths.find((p) => POLICY_PATH.test(p));
  if (named) return repoFile(named);
  const homes = paths.filter((p) => POLICY_HOME.test(p));
  const texts = await Promise.all(homes.map(async (p) => [p, (await fileText(p)) ?? ""]));
  for (const [p, t] of texts) if (isPolicyText(t)) return { at: p, text: t };
  // a sentence that names AI and links somewhere hands the AI story to that page
  // ("Built with Claude; how we work together is in [Collaboration](docs/…)")
  for (const [home, t] of texts) {
    for (const line of t.split(/(?<=[.!?])\s+|\n\s*\n/)) {
      if (!AI_WORD.test(line.replace(/\bai\b/g, ""))) continue;
      for (const [, target] of line.matchAll(/\]\(([^)\s#]+)/g)) {
        if (/^https?:/.test(target)) { const pg = await fetchPage(target); if (pg) return { at: target, text: pg.text }; continue; }
        const path = new URL(target, `file:///${home}`).pathname.slice(1);
        if (!paths.includes(path)) continue;
        const f = await repoFile(path);
        if (f.text.length > 500) return f;
      }
    }
  }
  // one level of links out of those files, then the policy-looking links on those pages
  const LINKY = /contribut|polic|guideline|\bai\b|llm|conduct|governance|book|docs/i;
  const first = [...new Set(texts.flatMap(([, t]) => [...t.matchAll(/https?:\/\/[^\s)>\]"']+/g)].map((m) => m[0])))].filter((u) => LINKY.test(u) && !/github\.com\/[^/]+\/[^/]+\/(issues|pulls|actions)|shields\.io|badge/i.test(u)).slice(0, 8);
  const pages = (await mapLimit(first, 8, fetchPage)).filter(Boolean);
  for (const pg of pages) if (isPolicyText(pg.text)) return { at: pg.url, text: pg.text };
  const second = [...new Set(pages.flatMap((pg) => pg.links.filter((u) => new URL(u).host === new URL(pg.url).host && /polic|guideline|\bai\b|ai[-_]|llm|contribut/i.test(u))))].slice(0, 12);
  for (const pg of (await mapLimit(second, 8, fetchPage)).filter(Boolean)) if (isPolicyText(pg.text)) return { at: pg.url, text: pg.text };
  return null;
}

// ---- CI configuration ---------------------------------------------------------

// a coverage tool being run or configured, not the word in prose
const COVERAGE = /--coverage\b|run [\w:-]*coverage\b|coverage run\b|\bcoverage["']?\s*[:=]\s*[{\[]|--cov\b|pytest-cov|\bc8 |\bnyc |\b(codecov|coveralls|jacoco|tarpaulin|llvm-cov|kover|simplecov)\b|-coverprofile/i;
// a build that fails when coverage drops: a threshold in the test config, or a
// service that reports coverage on every PR as a status
const COVERAGE_GATE = /thresholds?\s*[:=]|fail_under|--cov-fail-under|check-coverage|--fail-under|minimum_coverage|coverage-?threshold|CoverageVerification|codecov|coveralls/i;
const TEST_CONFIG = /^(vitest|jest|karma|playwright)\.config\.|^(\.nycrc|\.c8rc|\.coveragerc|codecov\.ya?ml|\.codecov\.ya?ml|pyproject\.toml|setup\.cfg|tox\.ini|package\.json|build\.gradle(\.kts)?|pom\.xml|Cargo\.toml)/i;
const RELEASE = /actions\/deploy-pages|softprops\/action-gh-release|gh release create|npm publish|twine upload|pypa\/gh-action-pypi-publish|cargo publish|docker\/build-push-action|goreleaser|semantic-release|changesets\/action|release-please|\bdeploy\b|\bpublish\b/i;

async function ciConfig(tree) {
  const paths = tree?.paths ?? [];
  const read = (list) => mapLimit(list, 10, async (p) => [p, (await fileText(p)) ?? ""]);
  const workflows = await read(paths.filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p)));
  const configs = await read(paths.filter((p) => !p.includes("/") && TEST_CONFIG.test(p)));
  const all = [...workflows, ...configs];
  const measured = all.filter(([, t]) => COVERAGE.test(t)).map(([p]) => p);
  const gated = all.filter(([, t]) => COVERAGE.test(t) && COVERAGE_GATE.test(t)).map(([p]) => p);
  const release = workflows.filter(([, t]) => RELEASE.test(t)).map(([p]) => p);
  return { workflows: workflows.length, measured, gated, release };
}

// ---- reviewable changes -------------------------------------------------------

// Hand-maintained code and tests only: no vendored, built or generated files
const CODE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rs|go|java|kt|kts|scala|c|cc|cpp|cxx|h|hpp|cs|rb|php|swift|m|mm|lua|dart|zig|vue|svelte|ex|exs|hs|ml|clj)$/i;
const NOT_OURS = /(^|\/)(node_modules|vendor|third[_-]?party|dist|build|out|target|generated|gen|\.yarn)\/|\.min\.|\.d\.ts$|\.gen\.|_pb2?\.|\.pb\.go$/i;
// Reviews stop finding defects somewhere past 200-400 changed lines (SmartBear's
// study of code review at Cisco); a change above this is not seriously reviewable
const REVIEWABLE_LINES = 400;
const BIG_FILE = 40_000; // bytes; only files this big are opened for a generated note

// A file the repo marks as generated is not hand-maintained: either through
// .gitattributes (linguist-generated / linguist-vendored, what GitHub itself
// honours) or with a "generated, do not edit" note at its top
const GENERATED_NOTE = /do not edit|auto-?generated|@generated|generated by|code generated/i;

function attributeRules(text) {
  const glob = (g) => new RegExp((g.includes("/") ? "^" : "(^|/)") + g.replace(/^\//, "").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*") + "(/|$)");
  return (text ?? "").split("\n").map((l) => l.trim().split(/\s+/)).filter(([g, ...a]) => g && !g.startsWith("#") && a.some((x) => /^linguist-(generated|vendored)(=true)?$/.test(x))).map(([g]) => glob(g));
}

// The default branch's files, and a test for "hand-maintained code or test"
async function tree(ref) {
  const t = await rest(`repos/${owner}/${repo}/git/trees/${ref}?recursive=1`);
  if (!t?.tree) return null;
  const blobs = t.tree.filter((e) => e.type === "blob");
  const attrs = attributeRules(blobs.some((e) => e.path === ".gitattributes") ? await head(ref, ".gitattributes", 64_000) : "");
  const ours = (path) => CODE_EXT.test(path) && !NOT_OURS.test(path) && !attrs.some((r) => r.test(path));
  const big = blobs.filter((e) => e.size > BIG_FILE && ours(e.path));
  const notes = await mapLimit(big, 16, async (e) => GENERATED_NOTE.test(await head(ref, e.path)));
  const generated = new Set(big.filter((_, i) => notes[i]).map((e) => e.path));
  return { paths: blobs.map((e) => e.path), handwritten: (path) => ours(path) && !generated.has(path) };
}

// ---- scoring ----------------------------------------------------------------

const pct = (n, d) => (d ? n / d : null);
const fmt = (x) => (x == null ? "n/a" : `${Math.round(x * 100)}%`);

async function score() {
  const repoInfo = await rest(`repos/${owner}/${repo}`);
  if (!repoInfo) throw new Error(`cannot read ${owner}/${repo}`);
  // a renamed or moved repo answers REST under its old name, but search does not
  [owner, repo] = repoInfo.full_name.split("/");
  const base = repoInfo.default_branch;
  // everything independent at once; the PR and history pages are sequential within themselves
  const nowTree = tree(base);
  const pending = Promise.all([mergedPRs(), nowTree, nowTree.then(ciConfig), nowTree.then(policy)]);
  pending.catch(() => {}); // a mirror returns before these settle
  const branch = await defaultBranch();
  const commits = branch.commits.filter((c) => !/^merge (pull request|branch)/i.test(c.message));

  // A mirror: the repo says so, or many people commit and almost nothing lands
  // through a PR, so the review happens somewhere else. A solo developer pushing
  // straight to the branch is not a mirror; that is scored, and scores low.
  const people = new Set(commits.map((c) => c.author?.user?.login ?? c.author?.email)).size;
  const viaPR = commits.length ? commits.filter((c) => c.viaPR).length / commits.length : 0;
  const mirror = /\bmirror\b/i.test(repoInfo.description ?? "") ? `its description says "${repoInfo.description}"`
    : commits.length >= 50 && people >= 5 && viaPR < 0.1 ? `${commits.length} commits by ${people} people, ${fmt(viaPR)} of them through GitHub PRs`
    : null;
  if (mirror) return { repo: `${owner}/${repo}`, days: DAYS, mirror };
  // a handful of commits says nothing about how a project is run
  if (commits.length < MIN_COMMITS) return { repo: `${owner}/${repo}`, days: DAYS, tooLittle: `${commits.length} commit${commits.length === 1 ? "" : "s"} in the last ${DAYS} days, fewer than ${MIN_COMMITS}` };

  const [prs, now, ci, policyAt] = await pending;

  const prInfo = prs.map((p) => {
    const msgs = p.commits.nodes.map((c) => c.commit.message);
    const trailer = msgs.some((s) => AI_TRAILER.test(s));
    const ai = trailer || AI_PROSE.test(p.body ?? "") || (isBot(p.author) && AI_BOT.test(p.author?.login ?? ""));
    const author = p.author?.login;
    const reviewed = p.reviews.nodes.some((r) => r.author && r.author.login !== author && !isBot(r.author));
    // merged by a human other than its author: someone else decided it goes in
    const mergedByOther = Boolean(p.mergedBy && p.mergedBy.login !== author && !/\[bot\]$/.test(p.mergedBy.login));
    const files = p.files.nodes.map((f) => f.path);
    const touchesSource = files.some(isSource);
    const touchesTests = files.some((f) => TEST_PATH.test(f));
    const revert = /^revert\b/i.test(p.title);
    // changed lines of hand-maintained code and tests; a PR past the file
    // listing's 100 is too big to review whatever its lines
    const code = p.files.nodes.filter((f) => now?.handwritten(f.path) ?? CODE_EXT.test(f.path));
    const lines = p.changedFiles > 100 ? Infinity : code.reduce((s, f) => s + f.additions + f.deletions, 0);
    return { number: p.number, ai, trailer, reviewed, mergedByOther, touchesSource, touchesTests, revert, touchesCode: code.length > 0, lines, at: Date.parse(p.mergedAt), who: author };
  });
  const aiPRs = prInfo.filter((p) => p.ai);
  const otherPRs = prInfo.filter((p) => !p.ai);
  const rate = (list, f) => pct(list.filter(f).length, list.length);

  const withChecks = commits.filter((c) => c.statusCheckRollup);
  const reverts = rate(prInfo, (p) => p.revert);

  // AI parity: AI-attributed PRs are reviewed at least as often and reverted no
  // more often than the rest. Needs both groups.
  let parity = null;
  // With no review on either side, "reviewed as often" compares nothing with nothing
  const anyReview = prInfo.some((p) => p.reviewed);
  if (aiPRs.length >= 5 && otherPRs.length >= 5 && anyReview) {
    const rev = Math.min(1, (rate(aiPRs, (p) => p.reviewed) + 0.001) / (rate(otherPRs, (p) => p.reviewed) + 0.001));
    const rvt = rate(aiPRs, (p) => p.revert) <= rate(otherPRs, (p) => p.revert) + 0.02 ? 1 : 0.5;
    parity = (rev + rvt) / 2;
  }

  const sourcePRs = prInfo.filter((p) => p.touchesSource);
  // a ban the history contradicts is not a policy anyone keeps
  const aiDirect = commits.filter((c) => !c.viaPR && AI_TRAILER.test(c.message)).length;
  const banBroken = policyAt?.ban && aiPRs.length + aiDirect >= 3;
  const policyScore = !policyAt || banBroken ? 0 : 1;
  const policyEvidence = !policyAt ? "none found in the repo or the pages it links to"
    : banBroken ? `bans AI (${policyAt.at}), but ${aiPRs.length + aiDirect} changes are AI-attributed`
    : `${policyAt.ban ? "bans AI" : "allows AI"}: ${policyAt.at}`;

  const coverage = ci.gated.length ? 1 : ci.measured.length ? 0.5 : 0;

  // Every change that reached the branch: a code PR, or a commit pushed straight
  // to it. A direct push is counted whole (its files are not listed), so a
  // generated file in it counts too.
  const direct = commits.filter((c) => !c.viaPR);
  const changes = [
    ...prInfo.filter((p) => p.touchesCode),
    ...direct.map((c) => ({ lines: c.additions + c.deletions, reviewed: false, at: Date.parse(c.committedDate), who: c.author?.user?.login ?? c.author?.email, direct: true })),
  ];
  const sizes = changes.map((c) => c.lines).sort((a, b) => a - b);
  const median = sizes.length ? sizes[Math.floor(sizes.length / 2)] : null;
  const small = changes.filter((c) => c.lines <= REVIEWABLE_LINES).length;

  // AI-like bursts: three or more large unreviewed changes by one author within
  // an hour, a pace nobody types at. Counted whether or not anything says "AI",
  // so deleting the footers does not hide them.
  const large = changes.filter((c) => c.lines > REVIEWABLE_LINES && !c.reviewed && c.at).sort((a, b) => a.at - b.at);
  let bursts = 0;
  const byWho = new Map();
  for (const c of large) byWho.set(c.who, [...(byWho.get(c.who) ?? []), c]);
  for (const list of byWho.values()) {
    for (let i = 0; i + BURST_SIZE - 1 < list.length; ) {
      if (list[i + BURST_SIZE - 1].at - list[i].at <= BURST_WINDOW) { bursts++; i += BURST_SIZE; } else i++;
    }
  }

  // AI anyone disclosed: AI-attributed PRs, and AI trailers on direct pushes
  const aiSeen = aiPRs.length + direct.filter((c) => AI_TRAILER.test(c.message)).length;
  // The verdict: has the project said how it handles AI, and does the history agree?
  const [verdict, cap] = policyAt && !policyAt.ban ? [`AI-aware: policy at ${policyAt.at}`, null]
    : banBroken ? [`ban broken: the policy bans AI, but ${aiSeen} changes are AI-attributed`, 0.25]
    : policyAt?.ban ? [`AI banned by policy (${policyAt.at})`, null]
    : aiSeen >= 3 ? [`AI used without a policy: ${aiSeen} changes are AI-attributed`, 0.4]
    : bursts >= MIN_BURSTS ? [`possibly AI, undeclared: ${bursts} bursts of large unreviewed changes`, 0.4]
    : ["no AI visible, and no policy", null];
  // Without visible AI a solo project has nobody to send a PR to: a small commit
  // straight to the branch is the human way of working, and an AI policy is a
  // question nobody needed to answer
  const noAI = !policyAt && aiSeen < 3 && bursts < MIN_BURSTS;
  const landed = noAI
    ? ["Human control", "changes land through PRs, or as small commits", 10, rate(commits, (c) => c.viaPR || c.additions + c.deletions <= REVIEWABLE_LINES), `${commits.filter((c) => c.viaPR || c.additions + c.deletions <= REVIEWABLE_LINES).length}/${commits.length} commits on ${branch.name} came through a PR or were under ${REVIEWABLE_LINES} lines`]
    : ["Human control", "changes land through PRs", 10, rate(commits, (c) => c.viaPR), `${commits.filter((c) => c.viaPR).length}/${commits.length} commits on ${branch.name}`];
  // Machine checks are how a human controls code nobody on the team wrote: they
  // are the lever over AI output. Human-written code is controlled by its
  // author's understanding; tests make it better, not more controlled, so
  // without visible AI they are left out, like the revert rate.
  const human = (check) => (noAI ? [check[0], check[1], check[2], null, "not needed: no AI visible, the author's understanding is the control"] : check);
  const decided = (p) => p.reviewed || (noAI && p.mergedByOther);
  const checks = [
    // pillar, name, weight, score 0..1 or null, evidence
    ["Transparency", "AI policy written down", 5, noAI ? null : policyScore, noAI ? "not needed: no AI visible" : policyEvidence],
    ["Transparency", "AI work carries a machine-readable trailer", 5, rate(aiPRs, (p) => p.trailer), `${aiPRs.filter((p) => p.trailer).length}/${aiPRs.length} AI-attributed PRs`],
    landed,
    ["Human control", "independent human review", 25, rate(prInfo, decided), `${prInfo.filter(decided).length}/${prInfo.length} merged PRs approved${noAI ? " or merged" : ""} by another human`],
    ["Human control", "changes small enough to review", 10, pct(small, changes.length), `${small}/${changes.length} changes under ${REVIEWABLE_LINES} changed lines${direct.length ? ` (${direct.length} of them direct pushes)` : ""}, median ${median === Infinity ? "100+ files" : median}`],
    human(["Machine verification", "default branch green", 10, withChecks.length ? rate(withChecks, (c) => c.statusCheckRollup.state === "SUCCESS") : 0, withChecks.length ? `${withChecks.filter((c) => c.statusCheckRollup.state === "SUCCESS").length}/${withChecks.length} checked commits` : "no CI checks on the branch"]),
    human(["Machine verification", "source changes come with tests", 10, rate(sourcePRs, (p) => p.touchesTests), `${sourcePRs.filter((p) => p.touchesTests).length}/${sourcePRs.length} PRs touching source`]),
    human(["Machine verification", "coverage measured, and enforced", 10, coverage, ci.gated.length ? `enforced: ${ci.gated.join(", ")}` : ci.measured.length ? `measured, no threshold: ${ci.measured.join(", ")}` : "not measured in CI"]),
    human(["Machine verification", "releases/deploys automated", 5, ci.release.length ? 1 : 0, ci.release.length ? ci.release.join(", ") : `none of ${ci.workflows} workflows publishes`]),
    human(["Outcome", "low revert rate", 5, reverts == null ? null : Math.max(0, 1 - 10 * reverts), `${prInfo.filter((p) => p.revert).length} reverts in ${prInfo.length} PRs`]),
    ["Outcome", "AI changes hold up like the rest", 5, parity, parity == null ? (!aiPRs.length ? "no AI-attributed PRs to compare" : anyReview ? `needs ≥5 AI and ≥5 other PRs (have ${aiPRs.length}/${otherPRs.length})` : "no PR is reviewed, so there is nothing to compare") : `review & revert rates compared`],
  ];

  const counted = checks.filter((c) => c[3] != null);
  const weight = counted.reduce((s, c) => s + c[2], 0);
  const total = weight ? counted.reduce((s, c) => s + c[2] * c[3], 0) / weight : 0;

  const raw = total;
  return { repo: `${owner}/${repo}`, days: DAYS, verdict, cap, raw, bursts, aiBan: policyAt?.ban && !banBroken ? policyAt.at : null, prs: prInfo.length, aiPRs: aiPRs.length, commits: commits.length, total: cap == null ? raw : Math.min(raw, cap), checks };
}

const r = await score();
if (r.tooLittle) {
  if (JSON_OUT) console.log(JSON.stringify({ ...r, total: null }, null, 2));
  else console.log(`\n${r.repo}: too little history to judge (${r.tooLittle}). No score.\n`);
  process.exit(3);
}
if (r.mirror) {
  if (JSON_OUT) console.log(JSON.stringify({ ...r, total: null }, null, 2));
  else console.log(`\n${r.repo} looks like a mirror: ${r.mirror}.\nIts review process lives elsewhere, so this tool cannot judge it. No score.\n`);
  process.exit(3);
}
if (JSON_OUT) {
  console.log(JSON.stringify({ ...r, checks: r.checks.map(([pillar, name, weight, s, evidence]) => ({ pillar, name, weight, score: s, evidence })) }, null, 2));
} else {
  const label = r.aiBan ? "safeguards" : "human-controlled";
  console.log(`\n${r.repo}: ${Math.round(r.total * 100)}% ${label} (an indication, not proof)`);
  console.log(`verdict: ${r.verdict}`);
  if (r.cap != null && r.raw > r.cap) console.log(`capped at ${fmt(r.cap)}; the safeguards alone score ${fmt(r.raw)}`);
  console.log(`last ${r.days} days: ${r.prs} merged PRs (${r.aiPRs} AI-attributed), ${r.commits} commits on the default branch, ${r.bursts} AI-like bursts\n`);
  let pillar = "";
  for (const [p, name, w, s, ev] of r.checks) {
    if (p !== pillar) console.log((pillar = p));
    console.log(`  ${fmt(s).padStart(4)}  ${name.padEnd(42)} w${String(w).padEnd(3)} ${ev}`);
  }
  console.log("");
}
