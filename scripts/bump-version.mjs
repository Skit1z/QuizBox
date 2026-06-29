// 版本号自动递增脚本（语义化版本 MAJOR.MINOR.PATCH，如 1.6.0）
//
// 规则：遵循 https://semver.org/lang/zh-CN/
//   - MAJOR：不兼容的 API 变更
//   - MINOR：向下兼容的新功能
//   - PATCH：向下兼容的问题修复
//
// 用法：
//   node scripts/bump-version.mjs              # 默认 patch +1
//   node scripts/bump-version.mjs patch        # 1.6.0 → 1.6.1
//   node scripts/bump-version.mjs minor        # 1.6.0 → 1.7.0
//   node scripts/bump-version.mjs major        # 1.6.0 → 2.0.0
//   node scripts/bump-version.mjs 1.8.3        # 显式设为 1.8.3
//
// 同步更新的文件：
//   package.json              version
//   package-lock.json         packages[""].version
//   src-tauri/tauri.conf.json version
//   src-tauri/Cargo.toml      version
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

// ===== 版本号解析/格式化 =====
// 解析 "1.6.0" → { major:1, minor:6, patch:0 }
// 兼容旧的两位格式 "1.58"（视为 1.58.0）与 "1.5"（视为 1.5.0）
function parseVersion(v) {
  const s = String(v).trim()
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(s)
  if (!m) throw new Error(`版本号格式应为 MAJOR.MINOR.PATCH：${v}`)
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: m[3] !== undefined ? Number(m[3]) : 0,
  }
}

function formatVersion(ver) {
  return `${ver.major}.${ver.minor}.${ver.patch}`
}

// 按级别递增
function bump(ver, level) {
  const next = { ...ver }
  if (level === 'major') {
    next.major++
    next.minor = 0
    next.patch = 0
  } else if (level === 'minor') {
    next.minor++
    next.patch = 0
  } else {
    // patch（默认）
    next.patch++
  }
  return next
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

  // 命令行参数：显式版本号 or 级别（patch/minor/major），默认 patch
  const arg = process.argv[2] || 'patch'
  let next
  if (/^\d+\.\d+(\.\d+)?$/.test(arg)) {
    // 显式版本号
    next = parseVersion(arg)
  } else if (['patch', 'minor', 'major'].includes(arg)) {
    next = bump(current, arg)
  } else {
    throw new Error(`参数应为 patch | minor | major | 显式版本号，收到：${arg}`)
  }

  const nextStr = formatVersion(next)
  const curStr = formatVersion(current)
  if (nextStr === curStr) {
    console.log(`[version] 当前 ${curStr}，无需递增`)
    return
  }

  // package.json
  patchFile('package.json', (s) => s.replace(/"version":\s*"[^"]*"/, `"version": "${nextStr}"`))
  // package-lock.json（只同步根包版本，依赖树版本不动）
  patchFile('package-lock.json', (s) => {
    const lock = JSON.parse(s)
    lock.version = nextStr
    if (lock.packages?.['']) lock.packages[''].version = nextStr
    return `${JSON.stringify(lock, null, 2)}\n`
  })
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
