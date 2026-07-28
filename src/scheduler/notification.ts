import { execFile } from 'node:child_process'
import type { OperationResult } from '../repository/index.js'
import type { CommandRunResult, CommandRunner } from './launchd.js'

export const OSASCRIPT_PATH = '/usr/bin/osascript'
const NOTIFICATION_SCRIPT =
  'function run(argv) { const app = Application.currentApplication(); app.includeStandardAdditions = true; app.displayNotification(argv[1], { withTitle: argv[0] }); }'
const MAX_NOTIFICATION_LENGTH = 160

function safeNotificationText(value: string): string {
  const normalized = [...value]
    .map((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127 ? ' ' : character
    })
    .join('')
    .trim()
  if (normalized.length < 1) return 'Restore requires attention'
  return normalized.slice(0, MAX_NOTIFICATION_LENGTH)
}

export const runNotificationCommand: CommandRunner = async (executable, args) =>
  new Promise<CommandRunResult>((resolve) => {
    execFile(
      executable,
      [...args],
      { encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const rawCode = (error as { code?: unknown } | null)?.code
        const exitCode = typeof rawCode === 'number' ? rawCode : error ? 1 : 0
        resolve({
          exitCode,
          stdout,
          stderr,
          executionError: Boolean(error && typeof rawCode !== 'number'),
        })
      },
    )
  })

export interface NotificationInput {
  title: string
  message: string
}

export function formatBackupNotification(
  result: OperationResult,
  source: 'Manual' | 'Scheduled',
  issueCode: string | null | undefined = result.issues[0]?.code,
): NotificationInput {
  if (!issueCode && result.state === 'success') {
    return {
      title: 'Restore backup complete',
      message: `${source} backup completed successfully.`,
    }
  }
  return {
    title: 'Restore backup needs attention',
    message: `${source} backup reported ${issueCode ?? result.state}. Run restore-cli status for details.`,
  }
}

export async function sendLocalNotification(
  input: NotificationInput,
  runner: CommandRunner = runNotificationCommand,
): Promise<boolean> {
  const title = safeNotificationText(input.title)
  const message = safeNotificationText(input.message)
  const result = await runner(OSASCRIPT_PATH, [
    '-l',
    'JavaScript',
    '-e',
    NOTIFICATION_SCRIPT,
    '--',
    title,
    message,
  ])
  return !result.executionError && result.exitCode === 0
}
