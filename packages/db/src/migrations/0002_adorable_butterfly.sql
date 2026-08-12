ALTER TABLE `recording_segment` ADD `recorder_mime_type` text;--> statement-breakpoint
ALTER TABLE `recording_segment` ADD `requested_mime_type` text;--> statement-breakpoint
ALTER TABLE `recording_upload_part` ADD `media_type` text;