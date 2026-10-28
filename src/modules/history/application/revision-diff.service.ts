import { Injectable, NotFoundException } from '@nestjs/common';
import { createTwoFilesPatch } from 'diff';
import { DataSource } from 'typeorm';
import type { UserActor } from '../../../common/actor/actor';
import { BlobStorage } from '../../files/infrastructure/blob-storage';
import { Blob } from '../../files/infrastructure/persistence/entities/blob.entity';
import { ProjectsService } from '../../projects/application/projects.service';
import type { DraftFile } from '../../projects/domain/text-changes';
import { readSnapshotFiles } from '../../projects/infrastructure/persistence/read-snapshot-files';
import { ProjectRevision } from '../../revisions/infrastructure/persistence/entities/project-revision.entity';
import { ProjectSnapshot } from '../../revisions/infrastructure/persistence/entities/project-snapshot.entity';
import type { ProjectFileDto } from '../../projects/http/projects.dto';
import { GitRevisionMapping } from '../infrastructure/persistence/entities/git-revision-mapping.entity';
import type { FileDiffDto, PatchOmittedReason, RevisionDiffDto } from '../http/history.dto';

const MAX_PATCH_INPUT = 128 * 1024;
const MAX_PATCH_BYTES = 256 * 1024;

@Injectable()
export class RevisionDiffService {
  constructor(
    private readonly database: DataSource,
    private readonly projects: ProjectsService,
    private readonly storage: BlobStorage,
  ) {}

  async diff(
    actor: UserActor,
    projectId: number,
    revisionId: number,
    against: number,
  ): Promise<RevisionDiffDto> {
    await this.projects.ownedProject(this.database.manager, actor, projectId);
    const load = async (id: number) => {
      const revision = await this.database.manager.findOneBy(ProjectRevision, { id, projectId });
      if (!revision) throw new NotFoundException('Revision not found');
      const snapshot = await this.database.manager.findOneByOrFail(ProjectSnapshot, {
        id: revision.snapshotId,
        projectId,
      });
      const files = await readSnapshotFiles(
        this.database.manager,
        projectId,
        snapshot.id,
        actor.userId,
      );
      const mapping = await this.database.manager.findOneBy(GitRevisionMapping, {
        revisionId: id,
        projectId,
      });
      return { snapshot, files, status: mapping?.status ?? 'pending' };
    };
    const [before, after] = await Promise.all([load(against), load(revisionId)]);
    const oldFiles = new Map(before.files.map((file) => [file.fileId, file]));
    const newFiles = new Map(after.files.map((file) => [file.fileId, file]));
    const changes: { before?: DraftFile; after?: DraftFile; result: FileDiffDto }[] = [];
    const metadata = (file: DraftFile | undefined): ProjectFileDto | null =>
      file
        ? {
            fileId: file.fileId,
            path: file.path,
            contentKind: file.contentKind,
            sha256: file.sha256,
            sizeBytes: file.sizeBytes,
            mediaType: file.mediaType,
          }
        : null;
    for (const fileId of new Set([...oldFiles.keys(), ...newFiles.keys()])) {
      const a = oldFiles.get(fileId);
      const b = newFiles.get(fileId);
      const flags: FileDiffDto['changes'] = [];
      if (!a) flags.push('added');
      else if (!b) flags.push('deleted');
      else {
        if (a.path !== b.path) flags.push('renamed');
        if (a.sha256 !== b.sha256 || a.contentKind !== b.contentKind || a.mediaType !== b.mediaType)
          flags.push('modified');
      }
      if (flags.length)
        changes.push({
          before: a,
          after: b,
          result: {
            fileId,
            changes: flags,
            before: metadata(a),
            after: metadata(b),
            patch: null,
            patchOmittedReason: null,
          },
        });
    }
    changes.sort((a, b) => a.result.fileId - b.result.fileId);
    let remaining = MAX_PATCH_BYTES;
    let count = 0;
    const deadline = Date.now() + 300;
    const patch = async (
      a: string,
      b: string,
      oldName: string,
      newName: string,
    ): Promise<{ patch: string | null; patchOmittedReason: PatchOmittedReason }> => {
      if (Buffer.byteLength(a) > MAX_PATCH_INPUT || Buffer.byteLength(b) > MAX_PATCH_INPUT)
        return { patch: null, patchOmittedReason: 'TEXT_TOO_LARGE' };
      if (count >= 20 || remaining <= 0 || Date.now() >= deadline)
        return { patch: null, patchOmittedReason: 'PATCH_LIMIT' };
      count++;
      const value = await new Promise<string | undefined>((done) => {
        createTwoFilesPatch(oldName, newName, a, b, undefined, undefined, {
          context: 3,
          timeout: Math.max(1, Math.min(40, deadline - Date.now())),
          maxEditLength: 2000,
          callback: done,
        });
      });
      if (value === undefined) return { patch: null, patchOmittedReason: 'COMPUTATION_LIMIT' };
      const size = Buffer.byteLength(value);
      if (size > remaining) return { patch: null, patchOmittedReason: 'PATCH_LIMIT' };
      remaining -= size;
      return { patch: value, patchOmittedReason: null };
    };
    const contextChanged = before.snapshot.contextText !== after.snapshot.contextText;
    const context = {
      changed: contextChanged,
      ...(contextChanged
        ? await patch(
            before.snapshot.contextText,
            after.snapshot.contextText,
            'a/context',
            'b/context',
          )
        : { patch: null, patchOmittedReason: null }),
    };
    const candidates = changes.filter((change) =>
      [change.before, change.after].every(
        (file) => !file || (file.contentKind === 'text' && file.sizeBytes <= MAX_PATCH_INPUT),
      ),
    );
    const ids = [
      ...new Set(
        candidates.flatMap((change) =>
          [change.before?.blobId, change.after?.blobId].filter(
            (id): id is number => typeof id === 'number',
          ),
        ),
      ),
    ];
    const blobs = ids.length
      ? await this.database.manager
          .createQueryBuilder(Blob, 'blob')
          .addSelect('blob.storageKey')
          .where('blob.ownerId = :ownerId AND blob.id IN (:...ids)', { ownerId: actor.userId, ids })
          .getMany()
      : [];
    const byId = new Map(blobs.map((blob) => [blob.id, blob]));
    const content = async (file?: DraftFile): Promise<string> =>
      file ? (await this.storage.read(actor.userId, byId.get(file.blobId!)!)).toString('utf8') : '';
    for (const change of changes) {
      const pair = [change.before, change.after];
      if (pair.some((file) => file?.contentKind === 'binary'))
        change.result.patchOmittedReason = 'BINARY';
      else if (pair.some((file) => file && file.sizeBytes > MAX_PATCH_INPUT))
        change.result.patchOmittedReason = 'TEXT_TOO_LARGE';
      else if (change.result.changes.length === 1 && change.result.changes[0] === 'renamed') {
        /* Metadata describes a rename with identical bytes. */
      } else if (count >= 20 || remaining <= 0 || Date.now() >= deadline)
        change.result.patchOmittedReason = 'PATCH_LIMIT';
      else
        Object.assign(
          change.result,
          await patch(
            await content(change.before),
            await content(change.after),
            change.before ? `a/${change.before.path}` : '/dev/null',
            change.after ? `b/${change.after.path}` : '/dev/null',
          ),
        );
    }
    return {
      fromRevisionId: against,
      toRevisionId: revisionId,
      fromHistorySyncStatus: before.status,
      toHistorySyncStatus: after.status,
      files: changes.map((change) => change.result),
      context,
      entrypoint: {
        changed: before.snapshot.mainFileId !== after.snapshot.mainFileId,
        beforeFileId: before.snapshot.mainFileId,
        afterFileId: after.snapshot.mainFileId,
      },
    };
  }
}
