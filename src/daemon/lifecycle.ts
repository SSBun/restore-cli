import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

const PID_DIR = resolve(homedir(), '.config', 'restore')
const PID_PATH = resolve(PID_DIR, 'restore.pid')

export function getPidPath(): string {
  return PID_PATH
}

export function writePidFile(): void {
  writeFileSync(PID_PATH, String(process.pid), 'utf-8')
}

export function removePidFile(): void {
  try {
    unlinkSync(PID_PATH)
  } catch {
    // ignore if already removed
  }
}

export function readPid(): number | null {
  try {
    return Number(readFileSync(PID_PATH, 'utf-8').trim())
  } catch {
    return null
  }
}

export function isDaemonRunning(): boolean {
  const pid = readPid()
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
