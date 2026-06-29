// 版本号自动递增脚本
// 规则：每次 +0.01，小数位递增并自动进位，显示固定为两位小数
//   1.10 → 1.11 → 1.12 → ... → 1.19 → 1.20 → 1.21 → 1.22 ...
// 实现：用「厘」整数计数避免浮点精度问题。
//   显示版本 X.YZ ↔ 厘 = X*100 + Y*10 + Z（Z 为 0-9，Y 为最后两位中的第二位）
// 为兼容「1.1」这类只有一位小数的形式，解析时把 1.1 当作 1.10（=110 厘）。
//
// 用法：
//   node scripts/bump-version.mjs          # 默认 +0.01
//   node scripts/bump-version.mjs 1.50     # 显式设为 1.50
//
// 同步更新的文件：
//   package.json            version
//   src-tauri/tauri.conf.json  version
//   src-tauri/Cargo.toml    version
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

// ===== 版本号解析/格式化 =====
// 解析 "1.1" → 110 厘（视为 1.10）；"1.23" → 123；"2.05" → 205
// 兼容旧语义化版本 "0.1.0"（取前两段 0.1）。
function parseVersion(v) {
  const s = String(v).trim()
  // 兼容 X.Y.Z 形式（取 X.Y）
  const m3 = /^(\d+)\.(\d+)\.\d+$/.exec(s)
  const target = m3 ? `${m3[1]}.${m3[2]}` : s
  const m = /^(\d+)\.(\d+)$/.exec(target)
  if (!m) throw new Error(`版本号格式应为 X.Y：${v}`)
  const major = Number(m[1])
  let minorRaw = m[2]
  // 归一化为两位小数："1"→"10"，"23"→"23"，"5"→"50"(两位以上原样)
  let minor2
  if (minorRaw.length === 1) minor2 = minorRaw + '0'
  else minor2 = minorRaw
  return major * 100 + Number(minor2)
}

// 厘 → 显示版本。110→"1.10", 111→"1.11", 120→"1.20", 205→"2.05"
function formatVersion(cents) {
  const major = Math.floor(cents / 100)
  const minor2 = cents % 100 // 0-99
  return `${major}.${String(minor2).padStart(2, '0')}`
}

// ===== 文件更新 =====
function patchFile(file, replacer) {
  const p = join(root, file)
  const src = readFileSync(p, 'utf8')
  const out = replacer(src)
  if (out === src) return false
  writeFileSync(p, out)
  return true
}

function main() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const current = parseVersion(pkg.version)

  // 命令行参数：显式设定 or 默认 +1
  const arg = process.argv[2]
  let next
  if (arg) {
    next = parseVersion(arg)
  } else {
    next = current + 1
  }

  const nextStr = formatVersion(next)
  const curStr = formatVersion(current)
  if (nextStr === curStr && !arg) {
    // 已是最新，无需 bump（理论上 +1 不会相等，兜底）
    console.log(`[version] 当前 ${curStr}，无需递增`)
    return
  }

  // package.json
  patchFile('package.json', (s) =>
    s.replace(/"version":\s*"[^"]*"/, `"version": "${nextStr}"`),
  )
  // tauri.conf.json
  patchFile('src-tauri/tauri.conf.json', (s) =>
    s.replace(/"version":\s*"[^"]*"/, `"version": "${nextStr}"`),
  )
  // Cargo.toml（仅顶层 version = "..."）
  patchFile('src-tauri/Cargo.toml', (s) =>
    s.replace(/^version\s*=\s*"[^"]*"/m, `version = "${nextStr}"`),
  )

  console.log(`[version] ${curStr} → ${nextStr}`)
}

main()
