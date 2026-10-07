// Contribution snake that plays Snake: it hunts the green days of the contribution calendar on its own route
// (new every day), never leaves the grid and never bites itself. Only stronger days (level 2–4) make it grow;
// pale days are eaten without growing. When the calendar is empty, food spawns at random spots.
// No dependencies, Node 18+.
//
//   GITHUB_TOKEN=… node .github/snake/snake.mjs <user> [outDir]
//   CALENDAR_JSON=weeks.json SEED=2026-10-07 node .github/snake/snake.mjs <user> [outDir]   (local test)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const user = process.argv[2]
const outDir = process.argv[3] ?? 'dist'
if (!user) throw new Error('usage: node snake.mjs <user> [outDir]')

const STEP = 0.1 // seconds per cell
const ROUND = 1200 // steps per round (2 minutes)
const START_LEN = 3
const GROW_FROM = 2 // contribution level that makes the snake grow
const FADE = 8 // steps to fade out before the round starts over
const PITCH = 14, CELL = 11, PAD = 6
const SNAKE = '#D77757', HEAD = '#C0603F'
const PALETTES = {
  'github-snake.svg': { empty: '#ebedf0', levels: ['#9be9a8', '#40c463', '#30a14e', '#216e39'] },
  'github-snake-dark.svg': { empty: '#161b22', levels: ['#0e4429', '#006d32', '#26a641', '#39d353'] },
}
const SPAWN_STRONG = 0.25 // share of random food that is strong (makes the snake grow); the rest is pale
const LEVEL = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 }

async function weeks() {
  if (process.env.CALENDAR_JSON) return JSON.parse(readFileSync(process.env.CALENDAR_JSON, 'utf8'))
  const query = `query($login: String!) { user(login: $login) { contributionsCollection { contributionCalendar {
    weeks { contributionDays { contributionLevel weekday } } } } } }`
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { authorization: `bearer ${process.env.GITHUB_TOKEN}`, 'content-type': 'application/json', 'user-agent': 'growing-snake' },
    body: JSON.stringify({ query, variables: { login: user } }),
  })
  const json = await res.json()
  if (!json.data?.user) throw new Error(`GitHub API: ${JSON.stringify(json.errors ?? json)}`)
  return json.data.user.contributionsCollection.contributionCalendar.weeks
}

// ---- seeded randomness: same day → same game, next day → new route
function rng(seedText) {
  let a = [...seedText].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261) | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const seed = process.env.SEED ?? new Date().toISOString().slice(0, 10)
const rand = rng(`${user}:${seed}`)
const shuffle = (arr) => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

// ---- grid: cells are indices x*7+y; days outside the calendar are walls
const cal = await weeks()
const cols = cal.length
const N = cols * 7
const level = new Array(N).fill(-1) // -1 = wall
cal.forEach((w, x) => w.contributionDays.forEach((d) => (level[x * 7 + d.weekday] = LEVEL[d.contributionLevel] ?? 0)))
const xy = (c) => [Math.floor(c / 7), c % 7]
const neighbours = (c) => {
  const [x, y] = xy(c)
  const out = []
  if (y > 0) out.push(c - 1)
  if (y < 6) out.push(c + 1)
  if (x > 0) out.push(c - 7)
  if (x < cols - 1) out.push(c + 7)
  return out.filter((n) => level[n] >= 0)
}

/** BFS from `from` over cells not in `blocked`; returns the path (without `from`) to the first cell matching `goal`. */
function bfs(from, blocked, goal) {
  const prev = new Map([[from, -1]])
  const queue = [from]
  for (let qi = 0; qi < queue.length; qi++) {
    const c = queue[qi]
    if (c !== from && goal(c)) {
      const p = []
      for (let k = c; k !== from; k = prev.get(k)) p.push(k)
      return p.reverse()
    }
    for (const n of shuffle(neighbours(c))) {
      if (prev.has(n) || blocked.has(n)) continue
      prev.set(n, c)
      queue.push(n)
    }
  }
  return null
}

// ---- play the game
const food = new Map() // cell → level of the food on it
for (let c = 0; c < N; c++) if (level[c] > 0) food.set(c, level[c])
const events = new Map() // cell → [[step, level]] colour changes (0 = empty)
const mark = (c, step, lv) => (events.get(c) ?? events.set(c, []).get(c)).push([step, lv])

// start: a random free row segment in the left half, heading right
let body // body[0] = head
for (;;) {
  const x = 2 + Math.floor(rand() * Math.max(1, Math.floor(cols / 2) - 2)), y = Math.floor(rand() * 7)
  const cells = Array.from({ length: START_LEN }, (_, i) => (x - i) * 7 + y)
  if (cells.every((c) => level[c] >= 0 && !food.has(c))) { body = cells; break }
}
const history = [...body].reverse() // head positions over time, oldest first (starts with the initial body)
const growAt = Array.from({ length: START_LEN }, () => 0) // growAt[i] = step from which segment i exists
let pendingGrow = 0
let steps = 0
let spawned = 0

function spawn(step) {
  const occupied = new Set(body)
  const free = []
  for (let c = 0; c < N; c++) if (level[c] >= 0 && !occupied.has(c) && !food.has(c)) free.push(c)
  if (!free.length) return
  const c = free[Math.floor(rand() * free.length)]
  const lv = rand() < SPAWN_STRONG ? 3 : 1
  food.set(c, lv)
  mark(c, step, lv)
  spawned++
}

/** Is the tail still reachable from the head after following `path`? (keeps the snake from trapping itself) */
function safeAfter(path) {
  let b = [...body]
  for (const c of path) {
    const grows = food.has(c) && food.get(c) >= GROW_FROM
    b = [c, ...b]
    if (!grows) b.pop()
  }
  if (b.length < 4) return true
  const tail = b[b.length - 1]
  return bfs(b[0], new Set(b.slice(1, -1)), (c) => c === tail) !== null
}

while (steps < ROUND - FADE) {
  const blocked = new Set(body.slice(0, -1)) // the tail moves away this step
  let next = null
  const toFood = bfs(body[0], blocked, (c) => food.has(c))
  if (toFood && safeAfter(toFood)) next = toFood[0]
  if (next === null) {
    // no safe way to food: follow the tail, or any move that keeps the tail reachable
    const options = shuffle(neighbours(body[0]).filter((n) => !blocked.has(n)))
    next = options.find((n) => safeAfter([n])) ?? options[0] ?? null
  }
  if (next === null) break // trapped: end the round here
  steps++
  body.unshift(next)
  history.push(next)
  if (food.has(next)) {
    if (food.get(next) >= GROW_FROM) pendingGrow++
    food.delete(next)
    mark(next, steps, 0)
    if (!food.size) spawn(steps)
  }
  if (pendingGrow > 0) { pendingGrow--; growAt[body.length - 1] = steps } else body.pop()
}
const total = steps + FADE
const H = START_LEN - 1 // history entries before step 0 (the initial body behind the head)
// during the fade the head keeps going one more cell at most; pad the history so keyframes stay defined
while (history.length < total + H + 1) history.push(history[history.length - 1])
const dur = +(total * STEP).toFixed(2)
const len = body.length

// ---- render
const pct = (s) => +((s / total) * 100).toFixed(3)
const px = (c) => { const [x, y] = xy(c); return [PAD + x * PITCH, PAD + y * PITCH] }
// head keyframes over local time 0..total (local step k → history[k]); only corners, movement in between is linear
const keys = []
for (let k = 0; k <= total; k++) {
  const p = history[k], a = history[k - 1], b = history[k + 1]
  const corner = k === 0 || k === total || a === undefined || b === undefined || b - p !== p - a
  if (corner) { const [x, y] = px(p); keys.push(`${pct(k)}%{transform:translate(${x}px,${y}px)}`) }
}

function render({ empty, levels }) {
  const col = (lv) => (lv > 0 ? levels[lv - 1] : empty)
  let css = `@keyframes m{${keys.join('')}}
@keyframes f{0%{opacity:0}${pct(2)}%,${pct(total - FADE)}%{opacity:1}100%{opacity:0}}
.g{animation:f ${dur}s linear infinite}
.s{animation-name:m;animation-duration:${dur}s;animation-timing-function:linear,steps(1,end);animation-iteration-count:infinite;animation-fill-mode:both}
.c{animation-duration:${dur}s;animation-timing-function:steps(1,end);animation-iteration-count:infinite}`
  let cells = ''
  let n = 0
  for (let c = 0; c < N; c++) {
    if (level[c] < 0) continue
    const [x, y] = px(c)
    const ev = events.get(c)
    if (!ev) { cells += `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2" fill="${col(level[c])}"/>`; continue }
    const name = `e${n++}`
    css += `\n@keyframes ${name}{0%{fill:${col(level[c])}}${ev.map(([s, lv]) => `${pct(s)}%{fill:${col(lv)}}`).join('')}100%{fill:${col(level[c])}}}`
    cells += `<rect class="c" style="animation-name:${name}" x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2"/>`
  }
  // segment i shows the head position i steps ago: same keyframes, delayed by i steps (the head starts H steps in)
  let segs = ''
  for (let i = len - 1; i >= 0; i--) {
    const size = i === 0 ? CELL : Math.max(7, CELL - 1 - Math.floor((i / Math.max(len, 1)) * 4))
    const off = (CELL - size) / 2
    const delay = +((i - H) * STEP).toFixed(2)
    let anim = ''
    if (i > H) {
      // grown segment: visible from its growth step until the round wraps (local time runs i - H steps behind)
      const from = growAt[i] - (i - H), to = total - (i - H)
      css += `\n@keyframes v${i}{0%{opacity:0}${pct(from)}%{opacity:1}${pct(to)}%,100%{opacity:0}}`
      anim = `;animation-name:m,v${i}`
    }
    segs += `<rect class="s" style="animation-delay:${delay}s${anim}" x="${off}" y="${off}" width="${size}" height="${size}" rx="${i ? 3 : 4}" fill="${i ? SNAKE : HEAD}"/>`
  }
  const w = PAD * 2 + cols * PITCH - (PITCH - CELL), h = PAD * 2 + 7 * PITCH - (PITCH - CELL)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img"><title>A snake plays Snake on the contribution graph of ${user}: it hunts the green days and grows on the strong ones</title>
<style>${css}</style>
${cells}
<g class="g">${segs}</g>
</svg>
`
}

mkdirSync(outDir, { recursive: true })
for (const [file, pal] of Object.entries(PALETTES)) writeFileSync(`${outDir}/${file}`, render(pal))
console.log(`seed ${seed}: ${cols} weeks, ${steps} steps (${dur}s), ${spawned} random food, final length ${len}`)
