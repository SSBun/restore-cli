let verbose = false
let quiet = false

export function isQuiet(): boolean {
  return quiet
}

export function info(msg: string): void {
  if (!quiet) console.log(msg)
}

export function warn(msg: string): void {
  if (!quiet) console.warn(`⚠ ${msg}`)
}

export function error(msg: string): void {
  console.error(`✖ ${msg}`)
}

export function debug(msg: string): void {
  if (verbose) console.debug(`🔍 ${msg}`)
}

export function setVerbose(v: boolean): void {
  verbose = v
}

export function setQuiet(v: boolean): void {
  quiet = v
}
