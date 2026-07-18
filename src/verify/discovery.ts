import { constants } from 'node:fs'
import { lstat, open, opendir } from 'node:fs/promises'
import { join } from 'node:path'
import type { RepositoryHandle } from '../repository/index.js'
import { readBoundedRegularFile } from '../repository/io.js'
import type { DiscoveredPoint, PointDiscoveryDiagnostic, PointDiscoveryResult } from './types.js'
import { MAX_POINT_DESCRIPTOR_BYTES, POINT_ID_PATTERN } from './types.js'
import { parsePointDescriptorV1 } from './validation.js'

const MAX_POINT_DIRECTORY_ENTRIES = 10_000

function diagnostic(name: string, code: string): PointDiscoveryDiagnostic {
  return {
    pointId: POINT_ID_PATTERN.test(name) ? name : null,
    name,
    code,
    category: 'integrity',
    message: 'A published recovery point entry is malformed or unsafe',
  }
}

function isResidue(name: string): boolean {
  return (
    name.endsWith('.pending') ||
    name.includes('.quarantine-') ||
    name.includes('.retention-') ||
    name.includes('.cleanup-')
  )
}

async function directoryIdentity(path: string): Promise<{ device: bigint; inode: bigint }> {
  const metadata = await lstat(path, { bigint: true })
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('unsafe directory')
  return { device: metadata.dev, inode: metadata.ino }
}

async function assertDirectoryIdentity(
  path: string,
  expected: { device: bigint; inode: bigint },
): Promise<void> {
  const actual = await directoryIdentity(path)
  if (actual.device !== expected.device || actual.inode !== expected.inode) {
    throw new Error('directory identity changed')
  }
}

export function sortPointsNewestFirst(points: readonly DiscoveredPoint[]): DiscoveredPoint[] {
  return [...points].sort((left, right) => {
    const time = Date.parse(right.descriptor.completedAt) - Date.parse(left.descriptor.completedAt)
    return time || right.id.localeCompare(left.id)
  })
}

export async function discoverVisiblePoints(
  repository: RepositoryHandle,
): Promise<PointDiscoveryResult> {
  const identity = await directoryIdentity(repository.layout.points).catch(() => {
    throw new Error('Recovery point directory is invalid or unsafe')
  })
  const held = await open(
    repository.layout.points,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  const points: DiscoveredPoint[] = []
  const diagnostics: PointDiscoveryDiagnostic[] = []
  let ignoredResidue = 0
  let count = 0
  try {
    const heldMetadata = await held.stat({ bigint: true })
    if (heldMetadata.dev !== identity.device || heldMetadata.ino !== identity.inode) {
      throw new Error('Recovery point directory identity changed')
    }
    const directory = await opendir(repository.layout.points)
    try {
      for await (const entry of directory) {
        count++
        if (count > MAX_POINT_DIRECTORY_ENTRIES) {
          throw new Error('Recovery point directory exceeds the supported entry limit')
        }
        await assertDirectoryIdentity(repository.layout.points, identity)
        if (isResidue(entry.name)) {
          ignoredResidue++
          continue
        }
        if (!POINT_ID_PATTERN.test(entry.name)) {
          diagnostics.push(diagnostic(entry.name, 'INVALID_VISIBLE_POINT_NAME'))
          continue
        }

        const pointPath = join(repository.layout.points, entry.name)
        try {
          const pointMetadata = await lstat(pointPath, { bigint: true })
          if (!pointMetadata.isDirectory() || pointMetadata.isSymbolicLink()) {
            throw new Error('not a directory')
          }
          const descriptorBytes = await readBoundedRegularFile(
            join(pointPath, 'point.json'),
            MAX_POINT_DESCRIPTOR_BYTES,
          )
          let descriptor: ReturnType<typeof parsePointDescriptorV1>
          try {
            descriptor = parsePointDescriptorV1(JSON.parse(descriptorBytes.toString('utf8')))
          } finally {
            descriptorBytes.fill(0)
          }
          if (descriptor.pointId !== entry.name) throw new Error('descriptor mismatch')
          const current = await lstat(pointPath, { bigint: true })
          await assertDirectoryIdentity(repository.layout.points, identity)
          if (
            !current.isDirectory() ||
            current.dev !== pointMetadata.dev ||
            current.ino !== pointMetadata.ino
          ) {
            throw new Error('point identity changed')
          }
          points.push({
            id: entry.name,
            path: pointPath,
            descriptor,
            device: pointMetadata.dev,
            inode: pointMetadata.ino,
          })
        } catch {
          diagnostics.push(diagnostic(entry.name, 'INVALID_VISIBLE_POINT'))
        }
      }
    } finally {
      await directory.close().catch(() => undefined)
    }
    await assertDirectoryIdentity(repository.layout.points, identity)
    return { points: sortPointsNewestFirst(points), diagnostics, ignoredResidue }
  } finally {
    await held.close().catch(() => undefined)
  }
}
