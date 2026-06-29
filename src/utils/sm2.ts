// SM-2 间隔重复算法
// quality: 0-5（0完全不会，5完美记住）

export interface Sm2State {
  easiness: number
  interval: number // 天
  reviewCount: number
  nextReviewAt: number
}

export function sm2Next(
  prev: { easiness: number; interval: number; reviewCount: number },
  quality: number,
): Sm2State {
  const q = Math.max(0, Math.min(5, quality))
  let { easiness, interval, reviewCount } = prev
  reviewCount += 1

  if (q < 3) {
    // 答错，重置
    interval = 1
    reviewCount = 1
  } else {
    if (reviewCount === 1) interval = 1
    else if (reviewCount === 2) interval = 6
    else interval = Math.round(interval * easiness)
  }

  easiness = Math.max(1.3, easiness + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)))

  const nextReviewAt = Date.now() + interval * 86400000
  return { easiness, interval, reviewCount, nextReviewAt }
}

/** 从是否正确 + 自评映射到 quality */
export function qualityFromResult(isCorrect: boolean, selfRating?: number): number {
  if (!isCorrect) return 2
  if (selfRating == null) return 4
  // selfRating 0-100 → quality 3-5
  if (selfRating >= 80) return 5
  if (selfRating >= 60) return 4
  return 3
}
