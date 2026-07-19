import {
  getLaunchAgentStatus,
  installLaunchAgent,
  removeLaunchAgent,
} from '../scheduler/launchd.js'
import type { LaunchAgentDefinition, LaunchdDependencies } from '../scheduler/launchd.js'
import type { LaunchAgentStatus } from '../scheduler/types.js'

export async function startDaemon(
  definition: LaunchAgentDefinition,
  dependencies: LaunchdDependencies = {},
): Promise<LaunchAgentStatus> {
  return installLaunchAgent(definition, dependencies)
}

export async function stopDaemon(
  dependencies: LaunchdDependencies = {},
): Promise<LaunchAgentStatus> {
  return removeLaunchAgent(dependencies)
}

export async function daemonStatus(
  dependencies: LaunchdDependencies = {},
): Promise<LaunchAgentStatus> {
  return getLaunchAgentStatus(dependencies)
}
