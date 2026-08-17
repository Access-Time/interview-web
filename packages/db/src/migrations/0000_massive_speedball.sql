CREATE TABLE `recording_session` (
	`created_at` integer NOT NULL,
	`failure_code` text,
	`finalization_attempt` integer DEFAULT 0 NOT NULL,
	`finalize_plan` text,
	`id` text PRIMARY KEY NOT NULL,
	`lease_expires_at` integer,
	`manifest_version` integer DEFAULT 0 NOT NULL,
	`output_byte_size` integer,
	`output_checksum` text,
	`output_media_type` text,
	`output_object_key` text,
	`status` text DEFAULT 'recording' NOT NULL,
	CONSTRAINT "recording_session_status_check" CHECK(status in ('recording','queued','finalizing','ready','failed','deleting')),
	CONSTRAINT "recording_session_failure_code_check" CHECK(failure_code is null or length(failure_code) <= 128)
);
--> statement-breakpoint
CREATE TABLE `recording_segment` (
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`segment_index` integer NOT NULL,
	`recorder_mime_type` text,
	`requested_mime_type` text,
	`session_id` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `recording_session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recording_segment_session_index_unique` ON `recording_segment` (`session_id`,`segment_index`);--> statement-breakpoint
CREATE TABLE `recording_upload_part` (
	`byte_size` integer NOT NULL,
	`checksum` text NOT NULL,
	`created_at` integer NOT NULL,
	`etag` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`media_type` text,
	`object_key` text NOT NULL,
	`segment_id` text NOT NULL,
	`sequence` integer NOT NULL,
	FOREIGN KEY (`segment_id`) REFERENCES `recording_segment`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recording_upload_part_segment_sequence_unique` ON `recording_upload_part` (`segment_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `recording_upload_part_object_key_unique` ON `recording_upload_part` (`object_key`);