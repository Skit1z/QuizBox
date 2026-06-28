// 主题色 token：三套预设，每套包含主色及配套语义色。
// 通过在 <html> 上设置 data-theme-color="indigo|green|orange" 切换。

export type ThemeColor = 'indigo' | 'green' | 'orange'

export interface ThemeColorDef {
  label: string
  /** CSS 变量注入（写入 :root[data-theme-color="x"]） */
  vars: Record<string, string>
}

export const THEME_COLORS: Record<ThemeColor, ThemeColorDef> = {
  indigo: {
    label: '克制蓝灰',
    vars: {
      '--brand': '#4f6bed',
      '--brand-soft': '#eef1fe',
      '--brand-rgb': '79, 107, 237',
    },
  },
  green: {
    label: '温和墨绿',
    vars: {
      '--brand': '#2d6a4f',
      '--brand-soft': '#e8f3ee',
      '--brand-rgb': '45, 106, 79',
    },
  },
  orange: {
    label: '活力橙',
    vars: {
      '--brand': '#ff6b35',
      '--brand-soft': '#fff0e8',
      '--brand-rgb': '255, 107, 53',
    },
  },
}

export const DEFAULT_THEME_COLOR: ThemeColor = 'indigo'
