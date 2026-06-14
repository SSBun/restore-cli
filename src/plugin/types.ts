export type PluginPrepareHook = 'mac-apps-inventory'

export interface PluginTool {
  name: string
  description: string
  /** Script filename under `src/plugin/scripts/<plugin-name>/`. */
  script: string
}

export interface PluginManifest {
  name: string
  description: string
  paths: string[]
  prepare?: PluginPrepareHook
  tools?: PluginTool[]
}
