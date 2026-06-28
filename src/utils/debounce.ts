/** 防抖 */
export function debounce<T extends (...args: any[]) => void>(fn: T, wait = 5000) {
  let timer: ReturnType<typeof setTimeout> | null = null
  return (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => fn(...args), wait)
  }
}
