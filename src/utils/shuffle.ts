/** Fisher-Yates 洗牌（原地打乱，返回新数组） */
export function shuffle<T>(arr: readonly T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** 从数组随机取 n 个（Fisher-Yates 洗牌后截取） */
export function sample<T>(arr: readonly T[], n: number): T[] {
  return shuffle(arr).slice(0, n)
}

/** 从 [min,max] 取随机整数 */
export function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}
