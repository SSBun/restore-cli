import type { CurrentMachineInventory, ExpectedInventory, ManualDependency } from './types.js'

const MAX_INVENTORY_BYTES = 4 * 1024 * 1024
const MAX_INVENTORY_LINES = 50_000
const MAX_JSON_ITEMS = 20_000
const TAP_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const PACKAGE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9@+._-]{0,99}$/
const VSCODE_EXTENSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]*\.[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._@+/-]{0,255}$/

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort(compare)
}

function boundedText(input: Uint8Array | string, label: string): string {
  let content: string
  try {
    content =
      typeof input === 'string'
        ? input
        : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input)
  } catch {
    throw new Error(`${label} inventory is not valid UTF-8`)
  }
  if (Buffer.byteLength(content) > MAX_INVENTORY_BYTES || content.includes('\0')) {
    throw new Error(`${label} inventory is invalid or exceeds the supported size`)
  }
  return content
}

function inventoryLines(input: Uint8Array | string, label: string): string[] {
  const lines = boundedText(input, label).split(/\r?\n/)
  if (lines.length > MAX_INVENTORY_LINES || lines.some((line) => line.length > 4096)) {
    throw new Error(`${label} inventory has too many or overly long lines`)
  }
  return lines
}

function manual(
  id: string,
  name: string,
  reason: string,
  kind: ManualDependency['kind'] = 'manual',
): ManualDependency {
  return { id, kind, name, reason }
}

export interface ParsedBrewfile {
  taps: string[]
  formulae: string[]
  casks: string[]
  manual: ManualDependency[]
}

function validBrewIdentifier(
  kind: 'homebrew-tap' | 'homebrew-formula' | 'homebrew-cask',
  value: string,
): boolean {
  if (
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('//') ||
    value.includes('\\')
  ) {
    return false
  }
  const segments = value.split('/')
  if (segments.some((segment) => segment === '.' || segment === '..')) return false
  if (kind === 'homebrew-tap') {
    return segments.length === 2 && segments.every((segment) => TAP_SEGMENT.test(segment))
  }
  return (
    (segments.length === 1 && PACKAGE_SEGMENT.test(segments[0] ?? '')) ||
    (segments.length === 3 &&
      TAP_SEGMENT.test(segments[0] ?? '') &&
      TAP_SEGMENT.test(segments[1] ?? '') &&
      PACKAGE_SEGMENT.test(segments[2] ?? ''))
  )
}

/**
 * Parse only the exact declarative subset accepted by the recovery installer.
 * Brewfiles are Ruby programs, so no source line is ever retained for execution.
 */
export function parseAllowlistedBrewfile(input: Uint8Array | string): ParsedBrewfile {
  const taps: string[] = []
  const formulae: string[] = []
  const casks: string[] = []
  const manualItems: ManualDependency[] = []
  const lines = inventoryLines(input, 'Homebrew')

  for (let index = 0; index < lines.length; index += 1) {
    const value = lines[index]?.trim() ?? ''
    if (!value || value.startsWith('#')) continue
    const matched = /^(tap|brew|cask)\s+(["'])([^"']+)\2$/.exec(value)
    const identifier = matched?.[3]
    const kind =
      matched?.[1] === 'tap'
        ? 'homebrew-tap'
        : matched?.[1] === 'brew'
          ? 'homebrew-formula'
          : 'homebrew-cask'
    if (matched && identifier && validBrewIdentifier(kind, identifier)) {
      if (matched[1] === 'tap') taps.push(identifier)
      else if (matched[1] === 'brew') formulae.push(identifier)
      else casks.push(identifier)
      continue
    }
    manualItems.push(
      manual(
        `homebrew-line-${index + 1}`,
        `Brewfile line ${index + 1}`,
        'Directive, option, or identifier is outside the supported declarative brew/cask subset',
      ),
    )
  }

  return {
    taps: sortedUnique(taps),
    formulae: sortedUnique(formulae),
    casks: sortedUnique(casks),
    manual: manualItems,
  }
}

export interface ParsedVSCodeInventory {
  extensions: string[]
  manual: ManualDependency[]
}

export function parseAllowlistedVSCodeInventory(input: Uint8Array | string): ParsedVSCodeInventory {
  const extensions: string[] = []
  const manualItems: ManualDependency[] = []
  const lines = inventoryLines(input, 'VS Code')
  for (let index = 0; index < lines.length; index += 1) {
    const value = lines[index]?.trim() ?? ''
    if (!value || value.startsWith('#')) continue
    if (VSCODE_EXTENSION_ID.test(value)) extensions.push(value)
    else {
      manualItems.push(
        manual(
          `vscode-line-${index + 1}`,
          `VS Code inventory line ${index + 1}`,
          'Extension identifier is outside the supported publisher.extension grammar',
        ),
      )
    }
  }
  return { extensions: sortedUnique(extensions), manual: manualItems }
}

function parseObject(
  input: Uint8Array | string,
  label: string,
  allowedKeys: ReadonlySet<string>,
): Record<string, unknown> {
  const parsed: unknown = JSON.parse(boundedText(input, label))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} inventory must be a JSON object`)
  }
  if (Object.keys(parsed).some((key) => !allowedKeys.has(key))) {
    throw new Error(`${label} inventory has unsupported fields`)
  }
  return parsed as Record<string, unknown>
}

function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key))
}

function safeString(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    !value.includes('\0')
    ? value
    : null
}

function nullableString(value: unknown, maxLength: number): string | null | undefined {
  if (value === null) return null
  return safeString(value, maxLength) ?? undefined
}

function validGeneratedAt(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 100) return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
}

export function parseMacAppsInventory(input: Uint8Array | string): ExpectedInventory['macApps'] {
  const parsed = parseObject(
    input,
    'Mac apps',
    new Set(['generatedAt', 'platform', 'appCount', 'apps']),
  )
  if (!Array.isArray(parsed.apps) || parsed.apps.length > MAX_JSON_ITEMS) {
    throw new Error('Mac apps inventory has an invalid apps list')
  }
  if (
    !validGeneratedAt(parsed.generatedAt) ||
    (parsed.platform !== 'darwin' && parsed.platform !== 'other') ||
    !Number.isSafeInteger(parsed.appCount) ||
    parsed.appCount !== parsed.apps.length
  ) {
    throw new Error('Mac apps inventory metadata is invalid')
  }
  const appSignatures: string[] = []
  const apps = parsed.apps.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Mac apps inventory entry ${index + 1} is invalid`)
    }
    const value = entry as Record<string, unknown>
    if (!hasOnlyKeys(value, new Set(['name', 'bundleId', 'version', 'build', 'path']))) {
      throw new Error(`Mac apps inventory entry ${index + 1} has unsupported fields`)
    }
    const name = safeString(value.name, 512)
    const path = safeString(value.path, 8192)
    const bundleId = nullableString(value.bundleId, 512)
    const version = nullableString(value.version, 512)
    const build = nullableString(value.build, 512)
    if (!name || !path || bundleId === undefined || version === undefined || build === undefined) {
      throw new Error(`Mac apps inventory entry ${index + 1} is invalid`)
    }
    appSignatures.push(JSON.stringify({ name, bundleId, version, build, path }))
    return { name, bundleId, path }
  })
  const byIdentity = new Map<string, { app: (typeof apps)[number]; signature: string }>()
  for (let index = 0; index < apps.length; index += 1) {
    const app = apps[index] as (typeof apps)[number]
    const identity = app.bundleId ?? app.path
    const existing = byIdentity.get(identity)
    const signature = appSignatures[index] as string
    if (existing && existing.signature !== signature) {
      throw new Error(`Mac apps inventory has conflicting duplicate ${identity}`)
    }
    byIdentity.set(identity, { app, signature })
  }
  return [...byIdentity.values()]
    .map((value) => value.app)
    .sort((left, right) => compare(left.bundleId ?? left.path, right.bundleId ?? right.path))
}

export function parseRaycastInventory(
  input: Uint8Array | string,
): ExpectedInventory['raycastExtensions'] {
  const parsed = parseObject(
    input,
    'Raycast',
    new Set(['generatedAt', 'extensionCount', 'extensions']),
  )
  if (!Array.isArray(parsed.extensions) || parsed.extensions.length > MAX_JSON_ITEMS) {
    throw new Error('Raycast inventory has an invalid extensions list')
  }
  if (
    !validGeneratedAt(parsed.generatedAt) ||
    !Number.isSafeInteger(parsed.extensionCount) ||
    parsed.extensionCount !== parsed.extensions.length
  ) {
    throw new Error('Raycast inventory metadata is invalid')
  }
  const byId = new Map<
    string,
    { extension: { id: string; title: string | null }; signature: string }
  >()
  for (let index = 0; index < parsed.extensions.length; index += 1) {
    const entry = parsed.extensions[index]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Raycast inventory entry ${index + 1} is invalid`)
    }
    const value = entry as Record<string, unknown>
    if (
      !hasOnlyKeys(value, new Set(['id', 'path', 'packageName', 'title', 'version', 'description']))
    ) {
      throw new Error(`Raycast inventory entry ${index + 1} has unsupported fields`)
    }
    const id = safeString(value.id, 256)
    const path = safeString(value.path, 8192)
    const packageName = nullableString(value.packageName, 512)
    const title = nullableString(value.title, 512)
    const version = nullableString(value.version, 512)
    const description = nullableString(value.description, 4096)
    if (
      !id ||
      !SAFE_ID.test(id) ||
      !path ||
      packageName === undefined ||
      title === undefined ||
      version === undefined ||
      description === undefined
    ) {
      throw new Error(`Raycast inventory entry ${index + 1} is invalid`)
    }
    const normalized = { id, title }
    const existing = byId.get(id)
    const signature = JSON.stringify({ id, path, packageName, title, version, description })
    if (existing && existing.signature !== signature) {
      throw new Error(`Raycast inventory has conflicting duplicate ${id}`)
    }
    byId.set(id, { extension: normalized, signature })
  }
  return [...byId.values()]
    .map((value) => value.extension)
    .sort((left, right) => compare(left.id, right.id))
}

export function compareExpectedInventory(
  expected: ExpectedInventory,
  current: CurrentMachineInventory,
): {
  software: import('./types.js').SoftwareComparisonItem[]
  actions: import('./types.js').InstallerAction[]
  manual: ManualDependency[]
} {
  const software: import('./types.js').SoftwareComparisonItem[] = []
  const actions: import('./types.js').InstallerAction[] = []
  const manualItems = [...expected.manual]

  const addAllowlisted = (
    kind: 'homebrew-tap' | 'homebrew-formula' | 'homebrew-cask' | 'vscode-extension',
    phase: 'homebrew' | 'vscode',
    values: string[],
    installed: Set<string>,
    available = true,
  ): void => {
    for (const value of values) {
      const status = installed.has(value) ? 'installed' : 'missing'
      const id = `${kind}:${value}`
      software.push({
        id,
        kind,
        name: value,
        status,
        recovery: available ? 'allowlisted' : 'manual',
        ...(!available
          ? { reason: `${phase === 'homebrew' ? 'Homebrew' : 'VS Code'} CLI is unavailable` }
          : {}),
      })
      if (status === 'missing' && available) actions.push({ id, phase, kind, value })
    }
  }

  addAllowlisted(
    'homebrew-tap',
    'homebrew',
    expected.homebrew.taps,
    new Set(current.homebrew.taps),
    current.homebrew.available,
  )
  addAllowlisted(
    'homebrew-formula',
    'homebrew',
    expected.homebrew.formulae,
    new Set(current.homebrew.formulae),
    current.homebrew.available,
  )
  addAllowlisted(
    'homebrew-cask',
    'homebrew',
    expected.homebrew.casks,
    new Set(current.homebrew.casks),
    current.homebrew.available,
  )
  addAllowlisted(
    'vscode-extension',
    'vscode',
    expected.vscodeExtensions,
    new Set(current.vscode.extensions),
    current.vscode.available,
  )

  const currentApps = new Set(current.macApps.items.map((app) => app.bundleId ?? app.path))
  for (const app of expected.macApps) {
    const status = !current.macApps.complete
      ? 'unknown'
      : currentApps.has(app.bundleId ?? app.path)
        ? 'installed'
        : 'missing'
    software.push({
      id: `mac-app:${app.bundleId ?? app.path}`,
      kind: 'mac-app',
      name: app.name,
      status,
      recovery: 'manual',
      reason: current.macApps.complete
        ? 'Mac applications are reported but never installed automatically'
        : 'The bounded current Mac application scan was incomplete; presence is unknown',
    })
  }
  const currentRaycast = new Set(current.raycastExtensions.items.map((extension) => extension.id))
  for (const extension of expected.raycastExtensions) {
    const status = !current.raycastExtensions.complete
      ? 'unknown'
      : currentRaycast.has(extension.id)
        ? 'installed'
        : 'missing'
    software.push({
      id: `raycast-extension:${extension.id}`,
      kind: 'raycast-extension',
      name: extension.title ?? extension.id,
      status,
      recovery: 'manual',
      reason: current.raycastExtensions.complete
        ? 'Raycast extensions are reported but never installed automatically'
        : 'The bounded current Raycast extension scan was incomplete; presence is unknown',
    })
  }
  if (
    !current.homebrew.available &&
    (expected.homebrew.taps.length > 0 ||
      expected.homebrew.formulae.length > 0 ||
      expected.homebrew.casks.length > 0)
  ) {
    manualItems.push(
      manual(
        'homebrew-cli-missing',
        'Homebrew',
        'Install Homebrew manually before running the Homebrew phase',
      ),
    )
  }
  if (!current.vscode.available && expected.vscodeExtensions.length > 0) {
    manualItems.push(
      manual(
        'vscode-cli-missing',
        'Visual Studio Code',
        'Install Visual Studio Code manually before running the VS Code phase',
      ),
    )
  }
  if (!current.macApps.complete && expected.macApps.length > 0) {
    manualItems.push(
      manual(
        'mac-apps-current-scan-incomplete',
        'Mac applications',
        `Current application presence is unknown because the bounded scan was incomplete: ${current.macApps.issues.join(', ') || 'unspecified scan limit'}`,
        'mac-app',
      ),
    )
  }
  if (!current.raycastExtensions.complete && expected.raycastExtensions.length > 0) {
    manualItems.push(
      manual(
        'raycast-current-scan-incomplete',
        'Raycast extensions',
        `Current extension presence is unknown because the bounded scan was incomplete: ${current.raycastExtensions.issues.join(', ') || 'unspecified scan limit'}`,
        'raycast-extension',
      ),
    )
  }

  return {
    software: software.sort((left, right) => compare(left.id, right.id)),
    actions: actions.sort((left, right) => compare(left.id, right.id)),
    manual: manualItems.sort((left, right) => compare(left.id, right.id)),
  }
}

export function synthesizeBrewfile(
  actions: Array<Pick<import('./types.js').InstallerAction, 'kind' | 'value'>>,
): string {
  const taps = sortedUnique(
    actions.filter((action) => action.kind === 'homebrew-tap').map((action) => action.value),
  )
  const formulae = sortedUnique(
    actions.filter((action) => action.kind === 'homebrew-formula').map((action) => action.value),
  )
  const casks = sortedUnique(
    actions.filter((action) => action.kind === 'homebrew-cask').map((action) => action.value),
  )
  if (
    taps.some((value) => !validBrewIdentifier('homebrew-tap', value)) ||
    formulae.some((value) => !validBrewIdentifier('homebrew-formula', value)) ||
    casks.some((value) => !validBrewIdentifier('homebrew-cask', value))
  ) {
    throw new Error('Cannot synthesize a Brewfile from an invalid identifier')
  }
  const quote = (value: string): string => `"${value}"`
  return [
    '# Generated by restore-cli from authenticated allowlisted inventory.',
    ...taps.map((value) => `tap ${quote(value)}`),
    ...formulae.map((value) => `brew ${quote(value)}`),
    ...casks.map((value) => `cask ${quote(value)}`),
    '',
  ].join('\n')
}
