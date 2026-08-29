import { isQuiet } from './log.js'

const SPINNER_FRAMES = ['|', '/', '-', '\\'] as const

export interface ProgressIndicator {
  start(message: string): void
  update(message: string): void
  stop(): void
}

export function createProgressIndicator(): ProgressIndicator {
  const enabled = !isQuiet() && process.stderr.isTTY === true
  let frame = 0
  let message = ''
  let renderedLength = 0
  let timer: NodeJS.Timeout | undefined

  const render = () => {
    if (!enabled || !message) return
    const line = `${SPINNER_FRAMES[frame++ % SPINNER_FRAMES.length]} ${message}`
    process.stderr.write(`\r${line.padEnd(renderedLength)}`)
    renderedLength = line.length
  }

  return {
    start(value) {
      if (!enabled) return
      message = value
      render()
      timer = setInterval(render, 80)
      timer.unref()
    },
    update(value) {
      if (!enabled) return
      message = value
      render()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = undefined
      if (!enabled || renderedLength === 0) return
      process.stderr.write(`\r${' '.repeat(renderedLength)}\r`)
      message = ''
      renderedLength = 0
    },
  }
}
