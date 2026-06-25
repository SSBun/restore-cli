import { isQuiet } from './log.js'

const BAR_WIDTH = 28

export type ProgressPhase = 'Analyzing' | 'Syncing'

/// Render an inline progress bar to stderr (TTY only, hidden when --quiet).
export function renderPluginProgress(
  completed: number,
  total: number,
  pluginName: string,
  phase: ProgressPhase,
): void {
  if (isQuiet() || !process.stderr.isTTY || total === 0) return

  const ratio = Math.min(completed / total, 1)
  const filled = Math.round(ratio * BAR_WIDTH)
  const bar = '='.repeat(filled).padEnd(BAR_WIDTH, '-')
  const line = `${phase} [${bar}] ${completed}/${total} ${pluginName}`

  if (completed >= total) {
    process.stderr.write(`\r${line.padEnd(process.stderr.columns || 80)}\n`)
    return
  }

  process.stderr.write(`\r${line}`)
}

export function clearProgressLine(): void {
  if (isQuiet() || !process.stderr.isTTY) return
  process.stderr.write(`\r${' '.repeat(process.stderr.columns || 80)}\r`)
}

export function renderPluginDone(pluginName: string, linked: number, copied: number): void {
  if (isQuiet() || !process.stderr.isTTY) return
  process.stderr.write(`\r${' '.repeat(process.stderr.columns || 80)}\r`)
  process.stderr.write(`✓ ${pluginName} · ${linked} linked · ${copied} copied\n`)
}
