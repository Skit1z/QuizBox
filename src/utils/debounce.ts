/** 防抖（trailing-edge）。返回的函数附带 `.flush()` / `.cancel()`。 */
export function debounce<T extends (...args: any[]) => void>(fn: T, wait = 5000) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastArgs: Parameters<T> | null = null

  const debounced = (...args: Parameters<T>) => {
    lastArgs = args
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      lastArgs = null
      fn(...args)
    }, wait)
  }

  /** 立即执行待触发的调用（若有 pending timer），并取消定时器 */
  debounced.flush = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (lastArgs) {
      const args = lastArgs
      lastArgs = null
      fn(...args)
    }
  }

  /** 取消 pending 定时器，不执行 */
  debounced.cancel = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    lastArgs = null
  }

  return debounced
}
