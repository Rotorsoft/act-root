export const seed_store = (table: string): string => `
-- events
CREATE TABLE IF NOT EXISTS public."${table}"
(
	id serial PRIMARY KEY,
  name varchar(100) COLLATE pg_catalog."default" NOT NULL,
  data jsonb,
  stream varchar(100) COLLATE pg_catalog."default" NOT NULL,
  version int NOT NULL,
  created timestamptz NOT NULL DEFAULT now(),
  meta jsonb
) TABLESPACE pg_default;

CREATE UNIQUE INDEX IF NOT EXISTS "${table}_stream_ix"
  ON public."${table}" USING btree (stream COLLATE pg_catalog."default" ASC, version ASC)
  TABLESPACE pg_default;
	
CREATE INDEX IF NOT EXISTS "${table}_name_ix"
  ON public."${table}" USING btree (name COLLATE pg_catalog."default" ASC)
  TABLESPACE pg_default;
    
CREATE INDEX IF NOT EXISTS "${table}_created_id_ix"
  ON public."${table}" USING btree (created ASC, id ASC)
  TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS "${table}_correlation_ix"
  ON public."${table}" USING btree ((meta ->> 'correlation'::text) COLLATE pg_catalog."default" ASC NULLS LAST)
  TABLESPACE pg_default;

-- streams
CREATE TABLE IF NOT EXISTS public."${table}_streams"
(
  stream varchar(100) COLLATE pg_catalog."default" PRIMARY KEY,
  at int not null default(-1),
  retry smallint not null default(0),
  blocked boolean not null default(false),
  leased_at int,
  leased_by uuid,
  leased_until timestamptz
) TABLESPACE pg_default;

-- supports order by { blocked, at } when fetching
CREATE INDEX IF NOT EXISTS "${table}_streams_fetch_ix"
  ON public."${table}_streams" USING btree (blocked, at) TABLESPACE pg_default;
`;
