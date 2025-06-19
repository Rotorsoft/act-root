CREATE TABLE "poll_outcomes" (
	"poll_id" varchar(64) PRIMARY KEY NOT NULL,
	"outcome" varchar(64),
	"closed_at" timestamp,
	"resolver" varchar(64)
);
--> statement-breakpoint
CREATE TABLE "polls" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"creator" varchar(64),
	"question" text,
	"options" text,
	"close_time" timestamp,
	"resolution_criteria" text,
	"created_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "votes" (
	"poll_id" varchar(64),
	"voter" varchar(64),
	"option" varchar(64),
	"amount" varchar(64),
	"tx_hash" varchar(128),
	"cast_at" timestamp,
	CONSTRAINT "votes_poll_id_voter_pk" PRIMARY KEY("poll_id","voter")
);
--> statement-breakpoint
CREATE TABLE "winnings" (
	"poll_id" varchar(64),
	"voter" varchar(64),
	"amount" varchar(64),
	"claimed_at" timestamp,
	"tx_hash" varchar(128),
	CONSTRAINT "winnings_poll_id_voter_pk" PRIMARY KEY("poll_id","voter")
);
