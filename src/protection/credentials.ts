import type { MasterKey } from './secrets.js'

export interface CredentialProvider {
  storeMasterKey(repositoryId: string, masterKey: MasterKey): Promise<void>
  loadMasterKey(repositoryId: string): Promise<MasterKey>
  deleteMasterKey(repositoryId: string): Promise<void>
}
