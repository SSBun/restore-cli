import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { LaunchAgentStatus } from './types.js'

export const LAUNCH_AGENT_LABEL = 'com.ssbun.restore-cli.scheduler'
export const LAUNCHCTL_PATH = '/bin/launchctl'
const MAX_COMMAND_OUTPUT = 64 * 1024
const MAX_PLIST_BYTES = 64 * 1024

export interface LaunchAgentPaths {
  directory: string
  plist: string
}

export interface LaunchAgentDefinition {
  executable: string
  arguments: readonly string[]
  intervalHours: number
}

export interface CommandRunResult {
  exitCode: number
  stdout: string
  stderr: string
  executionError: boolean
}

export type CommandRunner = (
  executable: string,
  args: readonly string[],
) => Promise<CommandRunResult>

export interface LaunchdDependencies {
  paths?: LaunchAgentPaths
  runner?: CommandRunner
  uid?: number
}

interface DirectoryIdentity {
  device: bigint
  inode: bigint
}

export function getLaunchAgentPaths(home = homedir()): LaunchAgentPaths {
  const directory = resolve(home, 'Library', 'LaunchAgents')
  return { directory, plist: join(directory, `${LAUNCH_AGENT_LABEL}.plist`) }
}

function validateDefinition(definition: LaunchAgentDefinition): number {
  if (
    !isAbsolute(definition.executable) ||
    definition.executable.includes('\0') ||
    /[\r\n]/.test(definition.executable) ||
    definition.arguments.length < 1 ||
    definition.arguments.length > 16 ||
    definition.arguments.some(
      (argument) =>
        typeof argument !== 'string' ||
        argument.length < 1 ||
        argument.length > 8192 ||
        argument.includes('\0') ||
        /[\r\n]/.test(argument),
    )
  ) {
    throw new Error('LaunchAgent program arguments are invalid')
  }
  const seconds = definition.intervalHours * 60 * 60
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 365 * 24 * 60 * 60) {
    throw new Error('LaunchAgent interval must resolve to 1 second through 1 year')
  }
  return seconds
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export function buildLaunchAgentPlist(definition: LaunchAgentDefinition): string {
  const intervalSeconds = validateDefinition(definition)
  const args = [definition.executable, ...definition.arguments]
    .map((value) => `      <string>${xml(value)}</string>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LAUNCH_AGENT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>ProcessType</key>
    <string>Background</string>
    <key>RunAtLoad</key>
    <true/>
    <key>StartInterval</key>
    <integer>${intervalSeconds}</integer>
  </dict>
</plist>
`
}

export const runLaunchctl: CommandRunner = async (executable, args) =>
  new Promise((resolveCommand) => {
    execFile(
      executable,
      [...args],
      {
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: MAX_COMMAND_OUTPUT,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const rawCode = (error as { code?: unknown } | null)?.code
        const exitCode = typeof rawCode === 'number' ? rawCode : error ? 1 : 0
        resolveCommand({
          exitCode,
          stdout,
          stderr,
          executionError: Boolean(error && typeof rawCode !== 'number'),
        })
      },
    )
  })

async function ensureDirectory(path: string): Promise<DirectoryIdentity> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const stat = await lstat(path, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('LaunchAgents directory is unsafe')
  }
  const verified = await lstat(path, { bigint: true })
  if (verified.dev !== stat.dev || verified.ino !== stat.ino) {
    throw new Error('LaunchAgents directory changed')
  }
  return { device: verified.dev, inode: verified.ino }
}

async function assertDirectory(path: string, identity: DirectoryIdentity): Promise<void> {
  const stat = await lstat(path, { bigint: true })
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.dev !== identity.device ||
    stat.ino !== identity.inode
  ) {
    throw new Error('LaunchAgents directory changed')
  }
}

async function existingPlistIdentity(
  path: string,
): Promise<{ device: bigint; inode: bigint } | null> {
  try {
    const stat = await lstat(path, { bigint: true })
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PLIST_BYTES) {
      throw new Error('Existing LaunchAgent plist is unsafe')
    }
    return { device: stat.dev, inode: stat.ino }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function writePlist(paths: LaunchAgentPaths, content: string): Promise<void> {
  if (dirname(paths.plist) !== paths.directory) {
    throw new Error('LaunchAgent plist must be inside its configured directory')
  }
  const encoded = Buffer.from(content)
  if (encoded.length > MAX_PLIST_BYTES) throw new Error('LaunchAgent plist is too large')
  const directory = await ensureDirectory(paths.directory)
  const existing = await existingPlistIdentity(paths.plist)
  const temporary = join(paths.directory, `.${LAUNCH_AGENT_LABEL}.${randomUUID()}.pending`)
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      let offset = 0
      while (offset < encoded.length) {
        const { bytesWritten } = await handle.write(
          encoded,
          offset,
          encoded.length - offset,
          offset,
        )
        if (bytesWritten === 0) throw new Error('LaunchAgent plist write did not progress')
        offset += bytesWritten
      }
      await handle.sync()
    } finally {
      await handle.close()
    }
    await assertDirectory(paths.directory, directory)
    const current = await existingPlistIdentity(paths.plist)
    if (
      current?.device !== existing?.device ||
      current?.inode !== existing?.inode ||
      (current === null) !== (existing === null)
    ) {
      throw new Error('LaunchAgent plist changed before publication')
    }
    await rename(temporary, paths.plist)
    await assertDirectory(paths.directory, directory)
    const directoryHandle = await open(
      paths.directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    try {
      await directoryHandle.sync()
    } finally {
      await directoryHandle.close()
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  } finally {
    encoded.fill(0)
  }
}

function domain(uid: number): string {
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error('LaunchAgent user ID is invalid')
  return `gui/${uid}`
}

function service(uid: number): string {
  return `${domain(uid)}/${LAUNCH_AGENT_LABEL}`
}

export async function getLaunchAgentStatus(
  dependencies: LaunchdDependencies = {},
): Promise<LaunchAgentStatus> {
  const paths = dependencies.paths ?? getLaunchAgentPaths()
  const runner = dependencies.runner ?? runLaunchctl
  const uid = dependencies.uid ?? process.getuid?.()
  if (uid === undefined) throw new Error('LaunchAgent user ID is unavailable')
  const installed = (await existingPlistIdentity(paths.plist)) !== null
  const printed = await runner(LAUNCHCTL_PATH, ['print', service(uid)])
  if (printed.executionError) throw new Error('launchctl status could not be executed')
  return { installed, loaded: printed.exitCode === 0 }
}

export async function installLaunchAgent(
  definition: LaunchAgentDefinition,
  dependencies: LaunchdDependencies = {},
): Promise<LaunchAgentStatus> {
  const paths = dependencies.paths ?? getLaunchAgentPaths()
  const runner = dependencies.runner ?? runLaunchctl
  const uid = dependencies.uid ?? process.getuid?.()
  if (uid === undefined) throw new Error('LaunchAgent user ID is unavailable')
  await writePlist(paths, buildLaunchAgentPlist(definition))
  const bootout = await runner(LAUNCHCTL_PATH, ['bootout', service(uid)])
  if (bootout.executionError) throw new Error('launchctl bootout could not be executed')
  const bootstrapped = await runner(LAUNCHCTL_PATH, ['bootstrap', domain(uid), paths.plist])
  if (bootstrapped.executionError || bootstrapped.exitCode !== 0) {
    throw new Error('LaunchAgent could not be bootstrapped')
  }
  const status = await getLaunchAgentStatus({ paths, runner, uid })
  if (!status.installed || !status.loaded) throw new Error('LaunchAgent did not become active')
  return status
}

export async function removeLaunchAgent(
  dependencies: LaunchdDependencies = {},
): Promise<LaunchAgentStatus> {
  const paths = dependencies.paths ?? getLaunchAgentPaths()
  const runner = dependencies.runner ?? runLaunchctl
  const uid = dependencies.uid ?? process.getuid?.()
  if (uid === undefined) throw new Error('LaunchAgent user ID is unavailable')
  const bootout = await runner(LAUNCHCTL_PATH, ['bootout', service(uid)])
  if (bootout.executionError) throw new Error('launchctl bootout could not be executed')
  const current = await existingPlistIdentity(paths.plist)
  if (current) {
    const directory = await ensureDirectory(paths.directory)
    const confirmed = await existingPlistIdentity(paths.plist)
    if (confirmed?.device !== current.device || confirmed.inode !== current.inode) {
      throw new Error('LaunchAgent plist changed before removal')
    }
    await unlink(paths.plist)
    await assertDirectory(paths.directory, directory)
  }
  const status = await getLaunchAgentStatus({ paths, runner, uid })
  if (status.installed || status.loaded) throw new Error('LaunchAgent did not stop safely')
  return status
}

export async function readInstalledLaunchAgent(
  paths = getLaunchAgentPaths(),
): Promise<string | null> {
  const identity = await existingPlistIdentity(paths.plist)
  if (!identity) return null
  const handle = await open(paths.plist, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    if (
      !before.isFile() ||
      before.dev !== identity.device ||
      before.ino !== identity.inode ||
      before.size > BigInt(MAX_PLIST_BYTES)
    ) {
      throw new Error('LaunchAgent plist changed while reading')
    }
    const buffer = Buffer.alloc(Number(before.size))
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) throw new Error('LaunchAgent plist read did not progress')
      offset += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
      throw new Error('LaunchAgent plist changed while reading')
    }
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}
