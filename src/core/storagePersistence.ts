import { Track, Release, Work, StorageMount, AuditIssue } from './types'

const DB_NAME = 'CadenceCoreDB'
const DB_VERSION = 1
const STORE_NAME = 'libraryState'

export interface PersistedLibrary {
  tracks: Track[]
  releases: Release[]
  works: Work[]
  storageMounts?: StorageMount[]
  auditIssues?: AuditIssue[]
  isCustomLibrary: boolean
  lastImportedTimestamp: string
}

export class StoragePersistence {
  private openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (typeof window === 'undefined' || !window.indexedDB) {
        reject(new Error('IndexedDB not supported'))
        return
      }

      const request = window.indexedDB.open(DB_NAME, DB_VERSION)

      request.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        }
      }

      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  }

  public async saveLibrary(library: PersistedLibrary): Promise<void> {
    try {
      const db = await this.openDB()
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite')
        const store = tx.objectStore(STORE_NAME)
        store.put({ id: 'activeLibrary', ...library })

        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    } catch (e) {
      console.warn('Failed to persist library to IndexedDB:', e)
    }
  }

  public async loadLibrary(): Promise<PersistedLibrary | null> {
    try {
      const db = await this.openDB()
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly')
        const store = tx.objectStore(STORE_NAME)
        const request = store.get('activeLibrary')

        request.onsuccess = () => {
          if (request.result) {
            const { id, ...rest } = request.result
            resolve(rest as PersistedLibrary)
          } else {
            resolve(null)
          }
        }
        request.onerror = () => reject(request.error)
      })
    } catch (e) {
      console.warn('Failed to load library from IndexedDB:', e)
      return null
    }
  }

  public async clearLibrary(): Promise<void> {
    try {
      const db = await this.openDB()
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite')
        const store = tx.objectStore(STORE_NAME)
        store.delete('activeLibrary')

        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    } catch (e) {
      console.warn('Failed to clear IndexedDB:', e)
    }
  }
}

export const storagePersistence = new StoragePersistence()
