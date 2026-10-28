import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateProjects1792763555247 implements MigrationInterface {
  name = 'CreateProjects1792763555247';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "projects" ("id" SERIAL NOT NULL, "owner_id" integer NOT NULL, "title" character varying(200) NOT NULL, "current_revision_id" integer NOT NULL, "next_revision_number" integer NOT NULL DEFAULT '2', "metadata_version" integer NOT NULL DEFAULT '1', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "projects_id_owner_key" UNIQUE ("id", "owner_id"), CONSTRAINT "projects_versions_check" CHECK ("next_revision_number" >= 2 AND "metadata_version" >= 1), CONSTRAINT "projects_pkey" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "projects_owner_deleted_updated_idx" ON "projects"  ("owner_id", "deleted_at", "updated_at") `,
    );
    await queryRunner.query(
      `CREATE TABLE "project_creations" ("id" SERIAL NOT NULL, "session_id" integer NOT NULL, "key" character varying(128) NOT NULL, "payload_hash" character varying(64) NOT NULL, "project_id" integer NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "project_creations_session_key" UNIQUE ("session_id", "key"), CONSTRAINT "project_creations_pkey" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "blobs" ("id" SERIAL NOT NULL, "owner_id" integer NOT NULL, "storage_key" character varying(128) NOT NULL, "sha256" character varying(64) NOT NULL, "size_bytes" integer NOT NULL, "media_type" character varying(100) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "blobs_id_owner_key" UNIQUE ("id", "owner_id"), CONSTRAINT "blobs_owner_hash_key" UNIQUE ("owner_id", "sha256"), CONSTRAINT "blobs_size_check" CHECK ("size_bytes" >= 0), CONSTRAINT "blobs_pkey" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "file_identities" ("id" SERIAL NOT NULL, "project_id" integer NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "file_identities_id_project_key" UNIQUE ("id", "project_id"), CONSTRAINT "file_identities_pkey" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "project_snapshots" ("id" SERIAL NOT NULL, "project_id" integer NOT NULL, "main_file_id" integer NOT NULL, "context_text" text NOT NULL DEFAULT '', "manifest_hash" character varying(64) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "project_snapshots_id_project_key" UNIQUE ("id", "project_id"), CONSTRAINT "project_snapshots_pkey" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "snapshot_files" ("snapshot_id" integer NOT NULL, "file_id" integer NOT NULL, "project_id" integer NOT NULL, "owner_id" integer NOT NULL, "normalized_path" character varying(1024) NOT NULL, "blob_id" integer NOT NULL, "content_kind" character varying(16) NOT NULL, CONSTRAINT "snapshot_files_snapshot_path_key" UNIQUE ("snapshot_id", "normalized_path"), CONSTRAINT "snapshot_files_pkey" PRIMARY KEY ("snapshot_id", "file_id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "project_revisions" ("id" SERIAL NOT NULL, "project_id" integer NOT NULL, "number" integer NOT NULL, "parent_revision_id" integer, "snapshot_id" integer NOT NULL, "actor_id" integer NOT NULL, "channel" character varying(16) NOT NULL, "operation" character varying(32) NOT NULL, "summary" character varying(500) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "project_revisions_id_project_key" UNIQUE ("id", "project_id"), CONSTRAINT "project_revisions_project_number_key" UNIQUE ("project_id", "number"), CONSTRAINT "project_revisions_number_check" CHECK ("number" >= 1), CONSTRAINT "project_revisions_pkey" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "outbox_events" ("id" SERIAL NOT NULL, "event_id" uuid NOT NULL, "project_id" integer NOT NULL, "kind" character varying(64) NOT NULL, "payload" jsonb NOT NULL, "attempts" integer NOT NULL DEFAULT '0', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "available_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "published_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "outbox_events_event_id_key" UNIQUE ("event_id"), CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "outbox_events_pending_idx" ON "outbox_events"  ("published_at", "available_at") `,
    );
    await queryRunner.query(
      `CREATE TABLE "audit_events" ("id" SERIAL NOT NULL, "project_id" integer NOT NULL, "actor_id" integer NOT NULL, "credential_id" integer NOT NULL, "channel" character varying(16) NOT NULL, "action" character varying(64) NOT NULL, "request_id" character varying(128) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "audit_events_project_created_idx" ON "audit_events"  ("project_id", "created_at") `,
    );
    await queryRunner.query(
      `ALTER TABLE "projects" ADD CONSTRAINT "projects_current_revision_fkey" FOREIGN KEY ("current_revision_id", "id") REFERENCES "project_revisions"("id","project_id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED`,
    );
    await queryRunner.query(
      `ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "project_creations" ADD CONSTRAINT "project_creations_project_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "project_creations" ADD CONSTRAINT "project_creations_session_fkey" FOREIGN KEY ("session_id") REFERENCES "web_sessions"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "blobs" ADD CONSTRAINT "blobs_owner_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "file_identities" ADD CONSTRAINT "file_identities_project_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "project_snapshots" ADD CONSTRAINT "project_snapshots_main_file_fkey" FOREIGN KEY ("id", "main_file_id") REFERENCES "snapshot_files"("snapshot_id","file_id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED`,
    );
    await queryRunner.query(
      `ALTER TABLE "project_snapshots" ADD CONSTRAINT "project_snapshots_project_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "snapshot_files" ADD CONSTRAINT "snapshot_files_blob_fkey" FOREIGN KEY ("blob_id", "owner_id") REFERENCES "blobs"("id","owner_id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED`,
    );
    await queryRunner.query(
      `ALTER TABLE "snapshot_files" ADD CONSTRAINT "snapshot_files_owner_fkey" FOREIGN KEY ("project_id", "owner_id") REFERENCES "projects"("id","owner_id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED`,
    );
    await queryRunner.query(
      `ALTER TABLE "snapshot_files" ADD CONSTRAINT "snapshot_files_file_fkey" FOREIGN KEY ("file_id", "project_id") REFERENCES "file_identities"("id","project_id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED`,
    );
    await queryRunner.query(
      `ALTER TABLE "snapshot_files" ADD CONSTRAINT "snapshot_files_snapshot_fkey" FOREIGN KEY ("snapshot_id", "project_id") REFERENCES "project_snapshots"("id","project_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "project_revisions" ADD CONSTRAINT "project_revisions_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED`,
    );
    await queryRunner.query(
      `ALTER TABLE "project_revisions" ADD CONSTRAINT "project_revisions_parent_fkey" FOREIGN KEY ("parent_revision_id", "project_id") REFERENCES "project_revisions"("id","project_id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED`,
    );
    await queryRunner.query(
      `ALTER TABLE "project_revisions" ADD CONSTRAINT "project_revisions_snapshot_fkey" FOREIGN KEY ("snapshot_id", "project_id") REFERENCES "project_snapshots"("id","project_id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED`,
    );
    await queryRunner.query(
      `ALTER TABLE "project_revisions" ADD CONSTRAINT "project_revisions_project_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_project_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_project_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_project_fkey"`,
    );
    await queryRunner.query(`ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_actor_fkey"`);
    await queryRunner.query(
      `ALTER TABLE "outbox_events" DROP CONSTRAINT "outbox_events_project_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "project_revisions" DROP CONSTRAINT "project_revisions_project_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "project_revisions" DROP CONSTRAINT "project_revisions_snapshot_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "project_revisions" DROP CONSTRAINT "project_revisions_parent_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "project_revisions" DROP CONSTRAINT "project_revisions_actor_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "snapshot_files" DROP CONSTRAINT "snapshot_files_snapshot_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "snapshot_files" DROP CONSTRAINT "snapshot_files_file_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "snapshot_files" DROP CONSTRAINT "snapshot_files_owner_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "snapshot_files" DROP CONSTRAINT "snapshot_files_blob_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "project_snapshots" DROP CONSTRAINT "project_snapshots_project_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "project_snapshots" DROP CONSTRAINT "project_snapshots_main_file_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "file_identities" DROP CONSTRAINT "file_identities_project_fkey"`,
    );
    await queryRunner.query(`ALTER TABLE "blobs" DROP CONSTRAINT "blobs_owner_fkey"`);
    await queryRunner.query(
      `ALTER TABLE "project_creations" DROP CONSTRAINT "project_creations_session_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "project_creations" DROP CONSTRAINT "project_creations_project_fkey"`,
    );
    await queryRunner.query(`ALTER TABLE "projects" DROP CONSTRAINT "projects_owner_fkey"`);
    await queryRunner.query(
      `ALTER TABLE "projects" DROP CONSTRAINT "projects_current_revision_fkey"`,
    );
    await queryRunner.query(`DROP INDEX "audit_events_project_created_idx"`);
    await queryRunner.query(`DROP TABLE "audit_events"`);
    await queryRunner.query(`DROP INDEX "outbox_events_pending_idx"`);
    await queryRunner.query(`DROP TABLE "outbox_events"`);
    await queryRunner.query(`DROP TABLE "project_revisions"`);
    await queryRunner.query(`DROP TABLE "snapshot_files"`);
    await queryRunner.query(`DROP TABLE "project_snapshots"`);
    await queryRunner.query(`DROP TABLE "file_identities"`);
    await queryRunner.query(`DROP TABLE "blobs"`);
    await queryRunner.query(`DROP TABLE "project_creations"`);
    await queryRunner.query(`DROP INDEX "projects_owner_deleted_updated_idx"`);
    await queryRunner.query(`DROP TABLE "projects"`);
  }
}
