import { TagIndexService } from './tag-index.service';
import { Injectable } from '@angular/core';
import { WikiStorage } from './wiki-storage';
import { LoggingService } from './logging-service';
import { DropboxFileService } from './dropbox-get-file.service';
import { IDropboxEntry } from './idropbox-entry';
import { IDropboxAuth } from './idropbox-auth';
import { DropboxListFilesService } from './dropbox-list-files.service';
import { SyncState } from './sync-state';
import { Storage } from '@ionic/storage';
import { StoredFile } from './stored-file';
import * as ignoreCase from 'ignore-case';
import * as mergeText from 'plus.merge-text';
import * as Throttle from 'promise-parallel-throttle';
import { Task } from 'promise-parallel-throttle';

@Injectable()
export class DropboxSyncService {

    private readonly syncInfoStorageKey: string = '.wiki-v3-sync-info';

    constructor(
        private dropboxList: DropboxListFilesService,
        private dropboxFile: DropboxFileService,
        private loggingService: LoggingService,
        private tagIndexService: TagIndexService,
        private wikiStorage: WikiStorage,
        private storage: Storage) {
    }

    syncFiles(auth: IDropboxAuth): SyncState {
        const state = new SyncState(this.loggingService);
        state.makingProgress('Initializing');

        // make sure the directory exists remotely
        state.promise = this.wait(2000)
            .then(() => this.dropboxList.initialize(auth))
            // get the previous list of files from the local directory
            .then(() => this.getLocalSyncInfo())
            // get list of files from dropbox
            .then((localList: IDropboxEntry[]) => {
                state.localSyncInfo = localList;
                state.makingProgress('Compare Dropbox with local...');
                return this.dropboxList.listFiles(auth, true);
            })
            .then((allRemoteFiles: IDropboxEntry[]) => {
                state.allRemoteFiles = allRemoteFiles;
                state.remoteChangedFiles = this.dropboxList.getChangedFiles(state.allRemoteFiles, state.localSyncInfo);
            })
            // get contents of all local files to compare with known checksum
            .then(() => this.wikiStorage.listFiles())
            .then((allLocalTextFiles: string[]) => {
                const promises = allLocalTextFiles.map(x => this.wikiStorage.getTextFileContents(x));
                return Promise.all(promises);
            })
            .then((allLocalFiles: StoredFile[]) => {
                state.allLocalFiles = allLocalFiles;
                state.localChangedFiles = state.allLocalFiles.filter(x => {
                    const fileInfoOnPreviousSync = state.localSyncInfo.find(y => ignoreCase.equals(y.name, x.fileName));
                    return !fileInfoOnPreviousSync || fileInfoOnPreviousSync.checksum !== x.checksum;
                });
                state.localDeletedFiles = state.localSyncInfo.filter(x =>
                    !allLocalFiles.find(y => ignoreCase.equals(x.name, y.fileName)));
            })
            // finally, process the gathered state
            .then(() => {
                state.makingProgress('Apply changes...');

                // files, not changed locally, but changed or deleted remotely, have to been downloaded/deleted
                const filesToDownload = state.remoteChangedFiles.filter(x => {
                    const wasChangedLocally = state.localChangedFiles.find(y => ignoreCase.equals(x.name, y.fileName));
                    const deletedLocally = state.localDeletedFiles.find(y => ignoreCase.equals(x.name, y.name));
                    return !wasChangedLocally && !deletedLocally;
                });

                // files changed locally, but unchanged remotely, can be uploaded safely
                const filesToUpload = state.localChangedFiles.filter(x => {
                    const remoteChange = state.remoteChangedFiles.find(y => ignoreCase.equals(y.name, x.fileName));
                    const wasChangedRemotely = !!remoteChange;
                    const wasDeletedRemotely = wasChangedRemotely && remoteChange.deleted;

                    return !wasChangedRemotely || wasDeletedRemotely; // ignore remote delete in case of local change
                });

                // files deleted locally, but unchanged remotely, can be deleted safely
                const filesToUploadDeletion = state.localDeletedFiles.filter(x => {
                    const wasChangedRemotely = state.remoteChangedFiles.find(y => ignoreCase.equals(y.name, x.name));
                    return !wasChangedRemotely;
                });

                // (files, deleted locally and changed remotely, will be re-downloaded to the local storage. So be it.)
                // files, changed on both sides, have to be merged
                const filesToMerge = state.remoteChangedFiles.filter(x => {
                    if (x.deleted) {
                        return false; // just re-upload it in case of deletion (deletions are already excluded in the "filesToUpload" check)
                    }
                    if (!x.name.endsWith('.txt')) {
                        return false; // merge can't be done on non-textfiles
                    }
                    const localChangedFile = state.localChangedFiles.find(y => ignoreCase.equals(x.name, y.fileName));
                    return !!localChangedFile;
                });

                // create the promises
                const downloadPromises: Promise<any>[] = filesToDownload.filter(x => !x.deleted && x.isFile).map(file =>
                    // map the list to a list of Promises that download the file: download it and save to storage
                    this.dropboxFile.download(file, auth)
                        .then((storedFile: StoredFile) => this.wikiStorage.save(storedFile.fileName, storedFile.contents))
                        .then(() => state.makingProgress())
                        .catch(err => {
                            this.loggingService.log('download failed for file ' + file.name, err);
                            state.failedFiles.push(file.name);
                        }));

                // and do delete the remote deleted files
                const deletePromises: Promise<any>[] = filesToDownload.filter(x => x.deleted).map(file =>
                    this.wikiStorage.delete(file.name)
                        .then(() => state.makingProgress())
                        .catch(err => {
                            this.loggingService.log('delete failed for file ' + file.name, err);
                            state.failedFiles.push(file.name);
                        }));

                // upload deletions to dropbox
                const deleteRemotePromises: Promise<any>[] = filesToUploadDeletion.map(file =>
                    this.dropboxFile.delete(file, auth)
                        .then(() => state.makingProgress())
                        .catch(err => {
                            this.loggingService.log('remote delete failed for file ' + file.name, err);
                            state.failedFiles.push(file.name);
                        }));

                // download + merge + upload files changed on both sides
                const mergePromises: Promise<any>[] = filesToMerge.map(file => this.mergeFile(file, auth, state));

                const uploadPromises: Promise<any>[] = filesToUpload.map(file => {
                    return this.dropboxFile.upload(file, auth)
                        .then(() => state.makingProgress())
                        .catch(err => {
                            this.loggingService.log('upload failed for file ' + file.fileName, err);
                            state.failedFiles.push(file.fileName);
                        });
                });

                this.loggingService.log('downloads: ' + downloadPromises.length
                    + '; delete local: ' + deletePromises.length
                    + '; delete remote: ' + deleteRemotePromises.length
                    + '; merges: ' + mergePromises.length
                    + '; uploads: ' + uploadPromises.length);

                // wait until all promises have been fulfilled
                const allPromises: Promise<any>[] = []
                    .concat(downloadPromises)
                    .concat(deletePromises)
                    .concat(deleteRemotePromises)
                    .concat(mergePromises)
                    .concat(uploadPromises);

                state.setTotalSteps(allPromises.length);

                const allTasks = allPromises.map((x) => () => x);

                // throttle the requests: max 1 concurrent request to dropbox.
                return Throttle.sync(allTasks);
            })
            // redownload current state from dropbox (after the uploads/deletions the last state has become stale)
            .then(() => {
                state.setTotalSteps(1); // make it 99%
                state.makingProgress('Save sync info...');
                return this.dropboxList.listFiles(auth);
            })
            .then((allRemoteFiles: IDropboxEntry[]) => {
                // remove failed files, it makes no sense to keep any state on that file
                const allSucceeded = allRemoteFiles.filter(x => state.failedFiles.indexOf(x.name) === -1);
                // calculate all checksums (= open all files to get contents to calc the checksum)
                const checksumPromises = allSucceeded.filter(x => x.isFile).map(x =>
                    this.wikiStorage.getTextFileContents(x.name).then(file => {
                        x.checksum = file.checksum;
                        return x;
                    }));
                return Promise.all(checksumPromises);
            })
            .then((newSyncState: IDropboxEntry[]) => {
                state.makingProgress('Sync finished');
                return this.saveLocalSyncInfo(newSyncState);
            })
            .then(() => this.tagIndexService.buildIndex());

        return state;
    }

    private wait(ms: number): Promise<any> {
        return new Promise((resolve) =>
            setTimeout(() => resolve(), ms));
    }

    private mergeFile(remote: IDropboxEntry, auth: IDropboxAuth, state: SyncState): Promise<any> {

        const lastKnownLocalState = state.localSyncInfo.find(x => x.id === remote.id);

        const downloadCurrent = this.dropboxFile.download(remote, auth);
        let downloadParentRevision: Promise<StoredFile>;
        if (lastKnownLocalState) {
            downloadParentRevision = this.dropboxFile.download(lastKnownLocalState, auth, true);
        } else {
            // apparently both files are new, so make a random decision about which one to take
            downloadParentRevision = downloadCurrent;
        }
        const localFile = state.allLocalFiles.find(x => ignoreCase.equals(x.fileName, remote.name));

        return Promise.all([downloadCurrent, downloadParentRevision])
            .then((resolved: StoredFile[]) => {
                const latestRemoteState = resolved[0];
                const parentStateOfLocalChange = resolved[1];

                const remoteContents = latestRemoteState.contents as string;
                const localContents = localFile.contents as string;
                const commonParent = parentStateOfLocalChange.contents;
                let newContents = localContents;
                try {
                    if (remoteContents !== localContents) {
                        const merged = mergeText.merge(commonParent, remoteContents, localContents);
                        newContents = merged.toString();
                    }
                } catch (err) {
                    // take the local version, since the remote version is already present and uploaded
                    // and can always be rolled back
                }

                return this.wikiStorage.save(localFile.fileName, newContents);
            })
            // merge done, now upload result to dropbox
            .then(() => this.wikiStorage.getTextFileContents(localFile.fileName))
            .then((newLocalFile: StoredFile) => this.dropboxFile.upload(newLocalFile, auth))
            .then(() => state.makingProgress())
            .catch(err => {
                this.loggingService.log('merge failed for file ' + remote.name, err);
                state.failedFiles.push(remote.name);
            });
    }

    /**
     * get local file with sync info state from the last sync
     */
    private getLocalSyncInfo(): Promise<IDropboxEntry[]> {
        return this.storage.get(this.syncInfoStorageKey)
            .then(value => (value || []) as IDropboxEntry[]);
    }

    private saveLocalSyncInfo(value: IDropboxEntry[]): Promise<any> {
        return this.storage.set(this.syncInfoStorageKey, value);
    }

    clearLocalSyncState(): Promise<any> {
        return this.storage.remove(this.syncInfoStorageKey);
    }
}
