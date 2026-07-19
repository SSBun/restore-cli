import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

export class SafeFileError extends Error {
  constructor() {
    super('File is missing, unsafe, not regular, or exceeds the permitted size')
    this.name = 'SafeFileError'
  }
}

export async function readBoundedRegularFile(path: string, maxBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new SafeFileError()

  let file: Awaited<ReturnType<typeof open>>
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    throw new SafeFileError()
  }

  let content: Buffer | undefined
  let transferred = false
  try {
    const fileStat = await file.stat()
    if (!fileStat.isFile() || fileStat.size > maxBytes) throw new SafeFileError()

    content = Buffer.alloc(maxBytes + 1)
    let length = 0
    while (length <= maxBytes) {
      const { bytesRead } = await file.read(content, length, maxBytes + 1 - length, null)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > maxBytes) throw new SafeFileError()
    const result = content.subarray(0, length)
    transferred = true
    return result
  } catch (error) {
    if (error instanceof SafeFileError) throw error
    throw new SafeFileError()
  } finally {
    if (!transferred) content?.fill(0)
    await file.close().catch(() => {})
  }
}

export async function syncDirectory(path: string): Promise<void> {
  const directory = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const directoryStat = await directory.stat()
    if (!directoryStat.isDirectory()) throw new SafeFileError()
    await directory.sync()
  } finally {
    await directory.close()
  }
}

export async function writeDurableExclusiveFile(
  path: string,
  content: Uint8Array | string,
  mode = 0o600,
): Promise<void> {
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode,
  )
  try {
    await file.writeFile(content)
    await file.sync()
    await file.close()
  } catch (error) {
    await file.close().catch(() => {})
    await unlink(path).catch(() => {})
    throw error
  }
}

export async function replaceDurableFile(
  path: string,
  content: Uint8Array | string,
): Promise<{
  committed: true
  directorySync: { status: 'synced' } | { status: 'failed'; code: 'DIRECTORY_SYNC_FAILED' }
}> {
  const temporaryPath = `${path}.${randomUUID()}.pending`
  try {
    await writeDurableExclusiveFile(temporaryPath, content)
    await rename(temporaryPath, path)
  } catch (error) {
    await unlink(temporaryPath).catch(() => {})
    throw error
  }
  try {
    await syncDirectory(dirname(path))
    return { committed: true, directorySync: { status: 'synced' } }
  } catch {
    return {
      committed: true,
      directorySync: { status: 'failed', code: 'DIRECTORY_SYNC_FAILED' },
    }
  }
}
