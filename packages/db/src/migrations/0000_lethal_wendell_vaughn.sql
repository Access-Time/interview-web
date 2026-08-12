CREATE TABLE `todo` (
	`completed` integer DEFAULT false NOT NULL,
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`text` text NOT NULL
);
