// Renders the two profile stat cards (activity, languages) in light and dark.
// Usage: GH_TOKEN=... node .github/scripts/stats.mjs
//        node .github/scripts/stats.mjs --fixture data.json   (render without the API)
import { mkdir, readFile, writeFile } from "node:fs/promises"

const OUT_DIR = "stats"
const LANGUAGE_ALIASES = { "Jupyter Notebook": "Python" } // notebooks are Python work
const LANGUAGE_IGNORED = new Set(["CSS", "SCSS", "CMake", "Makefile", "Dockerfile", "Procfile", "Batchfile"])
const LANGUAGES_SHOWN = 8

// ---------- data ----------

async function graphql(query, variables = {}) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { authorization: `bearer ${process.env.GH_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  })
  const body = await response.json()
  if (!response.ok || body.errors) throw new Error(`GraphQL: ${JSON.stringify(body.errors ?? body)}`)
  return body.data
}

async function ownedStars() {
  let stars = 0
  let cursor = null
  do {
    const { viewer: { repositories: page } } = await graphql(
      `query($cursor: String) { viewer { repositories(first: 100, after: $cursor, ownerAffiliations: OWNER, isFork: false) {
        pageInfo { hasNextPage endCursor } nodes { stargazerCount }
      } } }`,
      { cursor },
    )
    stars += page.nodes.reduce((sum, r) => sum + r.stargazerCount, 0)
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
  } while (cursor)
  return stars
}

async function fetchStats() {
  const { viewer } = await graphql(`{ viewer {
    contributionsCollection { contributionYears }
    pullRequests { totalCount }
    merged: pullRequests(states: MERGED) { totalCount }
    closed: pullRequests(states: CLOSED) { totalCount }
  } }`)

  const years = viewer.contributionsCollection.contributionYears
  const yearQuery = years.map(year => `y${year}: contributionsCollection(from: "${year}-01-01T00:00:00Z", to: "${year}-12-31T23:59:59Z") {
    totalCommitContributions restrictedContributionsCount totalPullRequestReviewContributions
    contributionCalendar { weeks { contributionDays { date contributionCount } } }
    commitContributionsByRepository(maxRepositories: 100) {
      contributions { totalCount }
      repository { nameWithOwner languages(first: 10, orderBy: {field: SIZE, direction: DESC}) { edges { size node { name color } } } }
    }
  }`).join("\n")
  const collections = Object.values((await graphql(`{ viewer { ${yearQuery} } }`)).viewer)

  const days = collections.flatMap(c => c.contributionCalendar.weeks.flatMap(w => w.contributionDays))
  return {
    commits: collections.reduce((sum, c) => sum + c.totalCommitContributions + c.restrictedContributionsCount, 0),
    reviews: collections.reduce((sum, c) => sum + c.totalPullRequestReviewContributions, 0),
    pullRequests: viewer.pullRequests.totalCount,
    merged: viewer.merged.totalCount,
    closed: viewer.closed.totalCount,
    stars: await ownedStars(),
    longestStreak: longestStreak(days),
    languages: languageShares(collections.flatMap(c => c.commitContributionsByRepository)),
  }
}

function longestStreak(days) {
  const active = new Set(days.filter(d => d.contributionCount > 0).map(d => d.date))
  let best = 0
  for (const date of active) {
    if (active.has(shiftDate(date, -1))) continue // only count from the start of a run
    let length = 1
    while (active.has(shiftDate(date, length))) length++
    best = Math.max(best, length)
  }
  return best
}

function shiftDate(date, days) {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// Each repo's languages count in proportion to the commits made there, so the card shows
// what is actually being written rather than which repos happen to be largest.
function languageShares(contributions) {
  const weight = new Map()
  const colors = new Map()
  for (const { contributions: { totalCount: commits }, repository } of contributions) {
    const edges = repository.languages.edges.filter(e => !LANGUAGE_IGNORED.has(e.node.name))
    const repoBytes = edges.reduce((sum, e) => sum + e.size, 0)
    for (const { size, node } of edges) {
      const name = LANGUAGE_ALIASES[node.name] ?? node.name
      weight.set(name, (weight.get(name) ?? 0) + commits * size / repoBytes)
      if (!colors.has(name) || name === node.name) colors.set(name, node.color)
    }
  }
  const total = [...weight.values()].reduce((a, b) => a + b, 0)
  const sorted = [...weight].sort((a, b) => b[1] - a[1]).map(([name, w]) => ({ name, share: w / total, color: colors.get(name) ?? "#8b949e" }))
  // Languages under 1% are noise; fold them (and anything past the limit) into "Other"
  const major = sorted.filter(l => l.share >= 0.01)
  const restAfter = shown => 1 - shown.reduce((sum, l) => sum + l.share, 0)
  if (restAfter(major.slice(0, LANGUAGES_SHOWN)) < 0.01) return major.slice(0, LANGUAGES_SHOWN)
  const shown = major.slice(0, LANGUAGES_SHOWN - 1) // leave the last slot for "Other"
  return [...shown, { name: "Other", share: restAfter(shown), color: null }]
}

// ---------- rendering ----------

const THEMES = {
  light: { text: "#1f2328", muted: "#59636e", border: "#d1d9e0", track: "#eff2f5", accent: "#8250df", other: "#d1d9e0" },
  dark: { text: "#f0f6fc", muted: "#9198a1", border: "#3d444d", track: "#262c36", accent: "#ab7df8", other: "#3d444d" },
}

const ICONS = { // Octicons 16px (MIT, github.com/primer/octicons)
  commit: "M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z",
  pullRequest: "M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z",
  review: "M1.75 1h12.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 13H8.061l-2.574 2.573A1.458 1.458 0 0 1 3 14.543V13H1.75A1.75 1.75 0 0 1 0 11.25v-8.5C0 1.784.784 1 1.75 1ZM1.5 2.75v8.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h6.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25H1.75a.25.25 0 0 0-.25.25Zm5.28 1.72a.75.75 0 0 1 0 1.06L5.31 7l1.47 1.47a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-2-2a.75.75 0 0 1 0-1.06l2-2a.75.75 0 0 1 1.06 0Zm2.44 0a.75.75 0 0 1 1.06 0l2 2a.75.75 0 0 1 0 1.06l-2 2a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L10.69 7 9.22 5.53a.75.75 0 0 1 0-1.06Z",
  star: "M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Zm0 2.445L6.615 5.5a.75.75 0 0 1-.564.41l-3.097.45 2.24 2.184a.75.75 0 0 1 .216.664l-.528 3.084 2.769-1.456a.75.75 0 0 1 .698 0l2.77 1.456-.53-3.084a.75.75 0 0 1 .216-.664l2.24-2.183-3.096-.45a.75.75 0 0 1-.564-.41L8 2.694Z",
  flame: "M9.533.753V.752c.217 2.385 1.463 3.626 2.653 4.81C13.37 6.74 14.498 7.863 14.498 10c0 3.5-3 6-6.5 6S1.5 13.512 1.5 10c0-1.298.536-2.56 1.425-3.286.376-.308.862 0 1.035.454C4.46 8.487 5.581 8.419 6 8c.282-.282.341-.811-.003-1.5C4.34 3.187 7.035.75 8.77.146c.39-.137.726.194.763.607ZM7.998 14.5c2.832 0 5-1.98 5-4.5 0-1.463-.68-2.19-1.879-3.383l-.036-.037c-1.013-1.008-2.3-2.29-2.834-4.434-.322.256-.63.579-.864.953-.432.696-.621 1.58-.046 2.73.473.947.67 2.284-.278 3.232-.61.61-1.545.84-2.403.633a2.79 2.79 0 0 1-1.436-.874A3.198 3.198 0 0 0 3 10c0 2.53 2.164 4.5 4.998 4.5Z",
}

const W = 400
const H = 204
const PAD = 24
const FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif`

const escape = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
const number = n => n.toLocaleString("en-US")
const percent = share => `${(share * 100).toFixed(1)}%`

function frame(t, label, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escape(label)}">
<title>${escape(label)}</title>
<style>
  text { font-family: ${FONT}; fill: ${t.text}; font-variant-numeric: tabular-nums; }
  .title { font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
  .label { font-size: 13px; fill: ${t.muted}; }
  .value { font-size: 13px; font-weight: 600; }
  .icon { fill: ${t.muted}; }
</style>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12" fill="none" stroke="${t.border}"/>
${body}
</svg>
`
}

function activityCard(s, t) {
  const rows = [
    ["commit", "Commits", number(s.commits)],
    ["pullRequest", "Pull requests", number(s.pullRequests)],
    ["review", "Code reviews", number(s.reviews)],
    ["star", "Stars earned", number(s.stars)],
    ["flame", "Longest streak", `${s.longestStreak} days`],
  ].map(([icon, label, value], i) => {
    const y = 76 + i * 26
    return `<path class="icon" transform="translate(${PAD} ${y - 12.5})" d="${ICONS[icon]}"/>
<text class="label" x="${PAD + 26}" y="${y}">${label}</text>
<text class="value" x="248" y="${y}" text-anchor="end">${value}</text>`
  }).join("\n")

  // The one accent: share of resolved pull requests that were merged
  const resolved = s.merged + s.closed
  const rate = resolved ? s.merged / resolved : 0
  const cx = 324, cy = 104, r = 44, circumference = 2 * Math.PI * r
  const ring = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${t.track}" stroke-width="8"/>
<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${t.accent}" stroke-width="8" stroke-linecap="round"
  stroke-dasharray="${(rate * circumference).toFixed(2)} ${circumference.toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>
<text x="${cx}" y="${cy + 8}" text-anchor="middle" style="font-size: 24px; font-weight: 600; letter-spacing: -0.02em">${Math.round(rate * 100)}%</text>
<text class="label" x="${cx}" y="180" text-anchor="middle">of PRs merged</text>`

  return frame(t, `GitHub activity: ${number(s.commits)} commits, ${number(s.pullRequests)} pull requests, ${Math.round(rate * 100)}% merged`,
    `<text class="title" x="${PAD}" y="40">Activity</text>\n${rows}\n${ring}`)
}

function languagesCard(s, t) {
  const barWidth = W - 2 * PAD, gap = 2
  let x = PAD
  const segments = s.languages.map(l => {
    const width = Math.max(l.share * barWidth - gap, 1)
    const rect = `<rect x="${x.toFixed(2)}" y="58" width="${width.toFixed(2)}" height="10" fill="${l.color ?? t.other}"/>`
    x += l.share * barWidth
    return rect
  }).join("\n")

  const columnWidth = (barWidth - 24) / 2
  const list = s.languages.map((l, i) => {
    const left = PAD + (i % 2) * (columnWidth + 24)
    const y = 102 + Math.floor(i / 2) * 26
    return `<circle cx="${left + 4.5}" cy="${y - 4.5}" r="4.5" fill="${l.color ?? t.other}"/>
<text class="label" x="${left + 16}" y="${y}" style="fill: ${t.text}">${escape(l.name)}</text>
<text class="label" x="${left + columnWidth}" y="${y}" text-anchor="end">${percent(l.share)}</text>`
  }).join("\n")

  return frame(t, `Most used languages: ${s.languages.slice(0, 3).map(l => `${l.name} ${percent(l.share)}`).join(", ")}`,
    `<text class="title" x="${PAD}" y="40">Languages</text>
<clipPath id="bar"><rect x="${PAD}" y="58" width="${barWidth}" height="10" rx="5"/></clipPath>
<g clip-path="url(#bar)">${segments}</g>
${list}`)
}

// ---------- main ----------

const fixture = process.argv.indexOf("--fixture")
const stats = fixture > -1 ? JSON.parse(await readFile(process.argv[fixture + 1], "utf8")) : await fetchStats()
await mkdir(OUT_DIR, { recursive: true })
for (const [name, theme] of Object.entries(THEMES)) {
  await writeFile(`${OUT_DIR}/activity-${name}.svg`, activityCard(stats, theme))
  await writeFile(`${OUT_DIR}/languages-${name}.svg`, languagesCard(stats, theme))
}
console.log(`commits ${stats.commits}, PRs ${stats.pullRequests} (${stats.merged} merged), reviews ${stats.reviews}, stars ${stats.stars}, streak ${stats.longestStreak}, languages ${stats.languages.length}`)
