import { execFileSync } from 'node:child_process'
import { readFileSync, unlinkSync } from 'node:fs'
import { LAUNCHCTL_PATH, LAUNCH_AGENT_LABEL } from '../scheduler/launchd.js'

interface PidFile {
  pid: number
}

export function parsePidContent(content: string): number | null {
  const trimmed = content.trim()
  if (!trimmed) return null
  const legacyPid = Number(trimmed)
  if (Number.isInteger(legacyPid) && legacyPid > 0) return legacyPid
  try {
    const parsed = JSON.parse(trimmed) as Partial<PidFile>
    return typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0
      ? parsed.pid
      : null
  } catch {
    return null
  }
}

function legacyPidIsRunning(pidPath: string): boolean {
  try {
    parsePidContent(readFileSync(pidPath, 'utf8'))
  } catch {}
  try {
    unlinkSync(pidPath)
  } catch {}
  return false
}

export function isDaemonRunning(legacyPidPath?: string): boolean {
  if (legacyPidPath) return legacyPidIsRunning(legacyPidPath)
  const uid = process.getuid?.()
  if (uid === undefined) return false
  try {
    execFileSync(LAUNCHCTL_PATH, ['print', `gui/${uid}/${LAUNCH_AGENT_LABEL}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 10_000,
    })
    return true
  } catch {
    return false
  }
}
