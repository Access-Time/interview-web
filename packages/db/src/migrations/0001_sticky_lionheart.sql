CREATE TABLE `recording_segment` (
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`segment_index` integer NOT NULL,
	`session_id` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `recording_session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recording_segment_session_index_unique` ON `recording_segment` (`session_id`,`segment_index`);--> statement-breakpoint
CREATE TABLE `recording_session` (
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `recording_upload_part` (
	`byte_size` integer NOT NULL,
	`checksum` text NOT NULL,
	`created_at` integer NOT NULL,
	`etag` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`object_key` text NOT NULL,
	`segment_id` text NOT NULL,
	`sequence` integer NOT NULL,
	FOREIGN KEY (`segment_id`) REFERENCES `recording_segment`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recording_upload_part_segment_sequence_unique` ON `recording_upload_part` (`segment_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `recording_upload_part_object_key_unique` ON `recording_upload_part` (`object_key`);