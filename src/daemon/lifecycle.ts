import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'

const PID_DIR = resolve(homedir(), '.config', 'restore')
const PID_PATH = resolve(PID_DIR, 'restore.pid')
const PID_OWNER = 'restore-daemon'

interface PidFile {
  pid: number
  owner?: string
}

export function getPidPath(): string {
  return PID_PATH
}

export function writePidFile(pidPath = PID_PATH): void {
  mkdirSync(dirname(pidPath), { recursive: true })
  const content: PidFile = { pid: process.pid, owner: PID_OWNER }
  writeFileSync(pidPath, `${JSON.stringify(content)}\n`, 'utf-8')
}

export function removePidFile(pidPath = PID_PATH): void {
  try {
    unlinkSync(pidPath)
  } catch {
    // ignore if already removed
  }
}

export function parsePidContent(content: string): number | null {
  const trimmed = content.trim()
  if (!trimmed) return null

  const legacyPid = Number(trimmed)
  if (Number.isInteger(legacyPid) && legacyPid > 0) return legacyPid

  try {
    const parsed = JSON.parse(trimmed) as Partial<PidFile>
    const pid = parsed.pid
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

export function readPid(pidPath = PID_PATH): number | null {
  try {
    return parsePidContent(readFileSync(pidPath, 'utf-8'))
  } catch {
    return null
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function isRestoreWorkerCommand(command: string): boolean {
  return /(?:src|dist)\/daemon\/worker\.(?:ts|js)(?:\s|$)/.test(command)
}

export function isRestoreDaemonProcess(pid: number): boolean {
  try {
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return isRestoreWorkerCommand(command.trim())
  } catch {
    return false
  }
}

export function isDaemonRunning(pidPath = PID_PATH): boolean {
  const pid = readPid(pidPath)
  if (!pid) return false

  if (!processExists(pid) || !isRestoreDaemonProcess(pid)) {
    removePidFile(pidPath)
    return false
  }

  return true
}
