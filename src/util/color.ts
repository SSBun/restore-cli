const bold = '\x1b[1m'
const dim = '\x1b[2m'
const green = '\x1b[32m'
const yellow = '\x1b[33m'
const cyan = '\x1b[36m'
const red = '\x1b[31m'
const reset = '\x1b[0m'

export const color = {
  green: (s: string) => `${green}${s}${reset}`,
  yellow: (s: string) => `${yellow}${s}${reset}`,
  red: (s: string) => `${red}${s}${reset}`,
  cyan: (s: string) => `${cyan}${s}${reset}`,
  dim: (s: string) => `${dim}${s}${reset}`,
  bold: (s: string) => `${bold}${s}${reset}`,
  icon: {
    ok: `${green}✓${reset}`,
    modified: `${yellow}✏${reset}`,
    missing: `${red}✗${reset}`,
    added: `${green}+${reset}`,
  },
}
