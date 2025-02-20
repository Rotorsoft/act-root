CREATE TABLE `tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`support_category_id` text NOT NULL,
	`escalation_id` text,
	`priority` text NOT NULL,
	`title` text NOT NULL,
	`messages` integer NOT NULL,
	`user_id` text NOT NULL,
	`agent_id` text,
	`resolved_by_id` text,
	`closed_by_id` text,
	`reassign_after` integer,
	`escalate_after` integer,
	`close_after` integer
);
