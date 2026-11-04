CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`support_category_id` text NOT NULL,
	`open` integer NOT NULL
);
