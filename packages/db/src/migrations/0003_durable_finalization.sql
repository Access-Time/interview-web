ALTER TABLE `recording_session` ADD `finalize_plan` text;--> statement-breakpoint
ALTER TABLE `recording_session` ADD `finalization_attempt` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `recording_session` ADD `failure_code` text;--> statement-breakpoint
ALTER TABLE `recording_session` ADD `lease_expires_at` integer;--> statement-breakpoint
ALTER TABLE `recording_session` ADD `manifest_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `recording_session` ADD `output_byte_size` integer;--> statement-breakpoint
ALTER TABLE `recording_session` ADD `output_media_type` text;--> statement-breakpoint
ALTER TABLE `recording_session` ADD `output_object_key` text;--> statement-breakpoint
ALTER TABLE `recording_session` ADD `status` text DEFAULT 'recording' NOT NULL;--> statement-breakpoint
ALTER TABLE `recording_session` ADD `output_checksum` text;--> statement-breakpoint
CREATE TRIGGER recording_session_status_guard BEFORE UPDATE OF status ON recording_session BEGIN SELECT CASE WHEN NEW.status NOT IN ('recording','queued','finalizing','ready','failed','deleting') THEN RAISE(ABORT,'invalid recording status') END; END;--> statement-breakpoint
CREATE TRIGGER recording_session_status_insert_guard BEFORE INSERT ON recording_session WHEN NEW.status NOT IN ('recording','queued','finalizing','ready','failed','deleting') BEGIN SELECT RAISE(ABORT,'invalid recording status'); END;--> statement-breakpoint
CREATE TRIGGER recording_session_failure_code_guard BEFORE UPDATE OF failure_code ON recording_session WHEN NEW.failure_code IS NOT NULL AND length(NEW.failure_code) > 128 BEGIN SELECT RAISE(ABORT,'failure code is too long'); END;--> statement-breakpoint
CREATE TRIGGER recording_upload_part_recording_guard BEFORE INSERT ON recording_upload_part WHEN (SELECT status FROM recording_session JOIN recording_segment ON recording_segment.session_id=recording_session.id WHERE recording_segment.id=NEW.segment_id) <> 'recording' AND NOT EXISTS (SELECT 1 FROM recording_upload_part WHERE segment_id=NEW.segment_id AND sequence=NEW.sequence AND object_key=NEW.object_key AND byte_size=NEW.byte_size AND checksum=NEW.checksum AND media_type IS NEW.media_type AND etag=NEW.etag) BEGIN SELECT RAISE(ABORT,'recording is not accepting parts'); END;--> statement-breakpoint
CREATE TRIGGER recording_upload_part_manifest_version AFTER INSERT ON recording_upload_part WHEN (SELECT status FROM recording_session JOIN recording_segment ON recording_segment.session_id=recording_session.id WHERE recording_segment.id=NEW.segment_id) = 'recording' BEGIN UPDATE recording_session SET manifest_version=manifest_version+1 WHERE id=(SELECT session_id FROM recording_segment WHERE id=NEW.segment_id); END;--> statement-breakpoint
CREATE TRIGGER recording_segment_manifest_version AFTER INSERT ON recording_segment WHEN (SELECT status FROM recording_session WHERE id=NEW.session_id) = 'recording' BEGIN UPDATE recording_session SET manifest_version=manifest_version+1 WHERE id=NEW.session_id; END;
