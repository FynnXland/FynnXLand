// Growing contribution snake: the snake zigzags through the contribution calendar, column by column,
// and every contribution it eats makes it one segment longer. No dependencies, Node 18+.
//
//   GITHUB_TOKEN=… node .github/snake/snake.mjs <user> [outDir]
//   CALENDAR_JSON=weeks.json node .github/snake/snake.mjs <user> [outDir]   (local test with saved data)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const user = process.argv[2]
const outDir = process.argv[3] ?? 'dist'
if (!user) throw new Error('usage: node snake.mjs <user> [outDir]')

const STEP = 0.08 // seconds per cell
const START_LEN = 3
const PITCH = 14, CELL = 11, PAD = 6
const SNAKE = '#D77757'
const PALETTES = {
  'github-snake.svg': { empty: '#ebedf0', levels: ['#9be9a8', '#40c463', '#30a14e', '#216e39'] },
  'github-snake-dark.svg': { empty: '#161b22', levels: ['#0e4429', '#006d32', '#26a641', '#39d353'] },
}
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

// ---- grid: grid[x][y] = level (0–4) or undefined for days outside the calendar
const cal = await weeks()
const cols = cal.length
const grid = cal.map((w) => {
  const col = []
  for (const d of w.contributionDays) col[d.weekday] = LEVEL[d.contributionLevel] ?? 0
  return col
})

// ---- path: enter from the left; zigzag through weeks with contributions, cross empty weeks straight; leave to the right.
// The snake only ever moves down/up inside a column or one step right, so it can never bite itself.
const path = []
for (let k = START_LEN; k > 0; k--) path.push([-k, 0])
let y = 0
for (let x = 0; x < cols; x++) {
  if (!grid[x].some((lv) => lv > 0)) { path.push([x, y]); continue }
  for (let i = 0; i < 7; i++) path.push([x, y === 0 ? i : 6 - i])
  y = 6 - y
}
const lastY = path[path.length - 1][1]

// ---- simulate: eating grows the snake by one segment
let len = START_LEN
const eatenAt = new Map() // "x,y" → step
const growAt = [] // growAt[i] = first step at which segment i exists
for (let i = 0; i < START_LEN; i++) growAt[i] = 0
path.forEach(([x, y], s) => {
  if ((grid[x]?.[y] ?? 0) > 0) {
    eatenAt.set(`${x},${y}`, s)
    growAt[len++] = s
  }
})
for (let k = 1; k <= len + 1; k++) path.push([cols - 1 + k, lastY])
const total = path.length + 12 // short pause before the loop starts again
const dur = +(total * STEP).toFixed(2)

const pct = (s) => +((s / total) * 100).toFixed(3)
const px = (x, y) => [PAD + x * PITCH, PAD + y * PITCH]

// head keyframes: only corners, the movement in between is linear at constant speed
const corners = path.filter((p, s) => {
  if (s === 0 || s === path.length - 1) return true
  const [a, b] = [path[s - 1], path[s + 1]]
  return b[0] - p[0] !== p[0] - a[0] || b[1] - p[1] !== p[1] - a[1]
})
const headFrames = corners
  .map((p) => {
    const [x, y] = px(...p)
    return `${pct(path.indexOf(p))}%{transform:translate(${x}px,${y}px)}`
  })
  .join('')

function render({ empty, levels }) {
  let css = `@keyframes m{${headFrames}}
.s{animation-name:m;animation-duration:${dur}s;animation-timing-function:linear,steps(1,end);animation-iteration-count:infinite;animation-fill-mode:both}
.c{animation:${dur}s steps(1,end) infinite}`
  let cells = ''
  let n = 0
  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < 7; y++) {
      const lv = grid[x][y]
      if (lv === undefined) continue
      const [cx, cy] = px(x, y)
      const at = eatenAt.get(`${x},${y}`)
      if (at === undefined) {
        cells += `<rect x="${cx}" y="${cy}" width="${CELL}" height="${CELL}" rx="2" fill="${empty}"/>`
        continue
      }
      const name = `e${n++}`
      css += `\n@keyframes ${name}{0%{fill:${levels[lv - 1]}}${pct(at + 0.5)}%,100%{fill:${empty}}}`
      cells += `<rect class="c" style="animation-name:${name}" x="${cx}" y="${cy}" width="${CELL}" height="${CELL}" rx="2"/>`
    }
  }
  // segment i follows the head i steps later; it shows up once the snake has grown that long
  let segs = ''
  for (let i = len - 1; i >= 0; i--) {
    const size = Math.max(6, CELL - Math.floor((i / Math.max(len, 1)) * 5))
    const off = (CELL - size) / 2
    const from = Math.max(0, growAt[i] - i)
    const vis = from > 0 ? `;animation-name:m,v${i}` : ''
    if (from > 0) css += `\n@keyframes v${i}{0%{opacity:0}${pct(from)}%,100%{opacity:1}}`
    segs += `<rect class="s" style="animation-delay:${+(i * STEP).toFixed(2)}s${vis}" x="${off}" y="${off}" width="${size}" height="${size}" rx="${i ? 3 : 4}" fill="${SNAKE}"/>`
  }
  const w = PAD * 2 + cols * PITCH - (PITCH - CELL), h = PAD * 2 + 7 * PITCH - (PITCH - CELL)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img"><title>A snake eats the contribution graph of ${user} and grows with every contribution (${len - START_LEN} eaten)</title>
<style>${css}</style>
${cells}
${segs}
</svg>
`
}

mkdirSync(outDir, { recursive: true })
for (const [file, pal] of Object.entries(PALETTES)) writeFileSync(`${outDir}/${file}`, render(pal))
console.log(`${cols} weeks, ${len - START_LEN} contributions eaten, final length ${len}, loop ${dur}s`)
