export type PluginPrepareHook =
  | 'mac-apps-inventory'
  | 'homebrew-brewfile'
  | 'raycast-extensions'
  | 'vscode-extensions-list'

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
