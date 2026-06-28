---
id: pii-encryption-at-rest
title: PII encryption at rest
description: Operator cookbook for encrypting the events.pii column at the DB layer — pgcrypto, RDS TDE, Cloud SQL TDE, SQLite SEE.
sidebar_position: 5
---

# PII encryption at rest

Act isolates personal data into a dedicated `events.pii` column (`jsonb` on Postgres, `TEXT` on SQLite, `Map` on the in-memory store) and gives you `app.forget(stream)` to wipe that column for a subject. What it deliberately does *not* ship is encryption-at-rest. That decision is for the operator: it depends on whether you're on RDS or Cloud SQL or a self-hosted box, which KMS your security team has standardised on, and which compliance regime you have to attest to. Baking one strategy into the framework would force every adopter to live with it. The deeper rationale — and the three crypto-port designs we tried first — is in the book essay on [why the Encryptor port was rejected](https://github.com/Rotorsoft/act-root/blob/master/book/act-566-pii-rejected-designs.md).

This page is the cookbook. Pick the deployment shape you're on, follow the recipe, and you'll have ciphertext on disk for the PII column without changing any application code.

## Pick a recipe

| Deployment | Recipe |
|---|---|
| Self-hosted Postgres, fine-grained column control, app-held key | [`pgcrypto`](#recipe-pgcrypto-postgres-column-encryption) |
| RDS Postgres on AWS, want disk-level encryption with KMS | [RDS TDE](#recipe-aws-rds-tde) |
| Cloud SQL Postgres on GCP, default or CMEK at rest | [Cloud SQL TDE](#recipe-gcp-cloud-sql-tde) |
| Embedded SQLite on a device or shared volume | [SEE or OS-level FDE](#recipe-sqlite-see-or-os-level-fde) |

The strategies compose. A common shape on AWS is RDS TDE *plus* `pgcrypto` on the `pii` column — disk-level for everything else, column-level for the regulated payload. Picking one doesn't preclude the other.

## Recipe: `pgcrypto` (Postgres column encryption)

Use this when you run Postgres yourself, your security team wants column-level control, and the encryption key lives in a secrets manager the application can reach. `pgcrypto` ships with mainstream Postgres distributions and gives you `pgp_sym_encrypt` / `pgp_sym_decrypt` as the workhorses.

Enable the extension once per database:

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

Act's seed already creates `pii jsonb`. You're not changing the column type — `pgp_sym_encrypt` returns `bytea`, but you can store the ciphertext inside the existing `jsonb` column by wrapping it as a JSON string at write time and unwrapping at read time. The cleanest pattern, though, is to leave Act's writes alone and let a `BEFORE INSERT / UPDATE` trigger rewrite the column transparently:

```sql
-- Trigger function: encrypt pii on write, decrypt on read via a view.
CREATE OR REPLACE FUNCTION encrypt_events_pii() RETURNS trigger AS $$
BEGIN
  IF NEW.pii IS NOT NULL THEN
    NEW.pii := jsonb_build_object(
      'c',
      encode(
        pgp_sym_encrypt(NEW.pii::text, current_setting('act.pii_key')),
        'base64'
      )
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER events_pii_encrypt
  BEFORE INSERT OR UPDATE OF pii ON events
  FOR EACH ROW EXECUTE FUNCTION encrypt_events_pii();

-- Reading side: a view that decrypts on the way out. Hand this to BI tools
-- and migration scripts; the application's `query`/`load` paths get the
-- ciphertext shape and never need the key.
CREATE OR REPLACE VIEW events_decrypted AS
SELECT
  id, stream, version, name, data, meta, created,
  CASE
    WHEN pii IS NULL THEN NULL
    ELSE pgp_sym_decrypt(
      decode(pii->>'c', 'base64'),
      current_setting('act.pii_key')
    )::jsonb
  END AS pii
FROM events;
```

`current_setting('act.pii_key')` reads the key from a Postgres session parameter, which the connection pool sets at checkout. The key itself comes from wherever you already store secrets:

- **HashiCorp Vault**: `vault read -field=key secret/act/pii-key`, then `SET act.pii_key = $1` on every connection acquire.
- **AWS Secrets Manager**: same shape, `aws secretsmanager get-secret-value` at pool warmup.
- **Environment variable**: `process.env.ACT_PII_KEY`, set from your deployment manifest. Simplest, weakest — the key sits in process memory and any operator with shell access can `printenv` it.

The tradeoff is who can read PII offline. If the key lives in the database (`pgcrypto`'s own `pgcrypto.key_id` table, for instance) then a DBA with a `pg_dump` can decrypt the dump. If the key lives in a separate Vault and the DB only sees it transiently per-session, a stolen backup is ciphertext-only.

`Store.forget_pii` keeps working unchanged. It runs `UPDATE events SET pii = NULL WHERE stream = $1`, the trigger sees `NEW.pii IS NULL` and skips encryption, and the column lands as `NULL`. There is no application-layer migration to do — the framework's erasure surface is column-agnostic.

Backup implications: a `pg_dump` of the database contains ciphertext for the `pii` column, plaintext for everything else. If the key isn't in the dump, the dump is safe to ship to a different region or a less-trusted backup target. If you `pg_dump --no-owner --no-acl` for development snapshots, strip the `pii` column entirely with a view-based dump rather than risking key leakage.

## Recipe: AWS RDS TDE

Use this when you're on RDS Postgres and you want every block on disk encrypted with minimal application change. RDS calls it "encryption at rest" rather than TDE; the mechanism is KMS-backed AES-256 applied to the underlying storage, automated snapshots, and read replicas.

The decision is made at instance creation — you cannot toggle storage encryption on an existing instance. The migration path is "create encrypted, restore snapshot, swap endpoints."

With the AWS CLI:

```bash
aws rds create-db-instance \
  --db-instance-identifier act-prod \
  --db-instance-class db.r6g.large \
  --engine postgres \
  --engine-version 16.3 \
  --master-username actadmin \
  --master-user-password "$(aws secretsmanager get-secret-value \
      --secret-id act/prod/db-master --query SecretString --output text)" \
  --allocated-storage 200 \
  --storage-encrypted \
  --kms-key-id arn:aws:kms:us-east-1:123456789012:key/abcd-1234 \
  --backup-retention-period 14 \
  --copy-tags-to-snapshot
```

Or with Terraform:

```hcl
resource "aws_db_instance" "act" {
  identifier              = "act-prod"
  engine                  = "postgres"
  engine_version          = "16.3"
  instance_class          = "db.r6g.large"
  allocated_storage       = 200
  storage_encrypted       = true
  kms_key_id              = aws_kms_key.act_db.arn
  backup_retention_period = 14
  copy_tags_to_snapshot   = true
  # ...
}
```

What this covers: every block written to EBS, every automated snapshot, every cross-region replica, and every point-in-time-recovery log. The application doesn't see any of it — connections are plain JDBC/PG-wire, the encryption happens below the storage layer.

What this does *not* cover:

1. **Manual exports to S3.** `aws rds start-export-task` writes to a bucket you specify. If the bucket isn't itself KMS-encrypted, your export sits in plaintext-on-disk in S3. Mirror the KMS key on the bucket: `--server-side-encryption-configuration KMSMasterKeyID=...`.
2. **Database logs.** RDS log files (`postgresql.log`) are stored separately. They're encrypted on the same EBS volume, but if you ship logs to CloudWatch you need CloudWatch Logs encryption with the same KMS key.
3. **Read replicas in other regions.** Cross-region encrypted replicas need a KMS key in the replica region; the source-region key isn't reachable.
4. **`pg_dump` from a client.** Once you've extracted ciphertext-on-disk into a `.sql` file on your laptop, the encryption is gone. Combine with `pgcrypto` (above) if you want the `pii` column to stay ciphertext through a dump.

Cost is negligible for typical workloads: KMS charges per API call, and RDS batches encryption operations so even high-throughput instances stay well under $5/month in KMS fees. The dominant cost is the KMS key itself ($1/month per CMK).

## Recipe: GCP Cloud SQL TDE

Use this when you're on Cloud SQL Postgres. The good news: Cloud SQL encrypts every instance at rest by default with Google-managed keys, and there's nothing to enable. The interesting case is when compliance requires customer-managed encryption keys (CMEK), which puts the KMS key in your project and lets you revoke it.

CMEK is set at instance creation, same constraint as RDS. With `gcloud`:

```bash
gcloud kms keyrings create act-prod \
  --location us-central1

gcloud kms keys create events-encryption \
  --keyring act-prod \
  --location us-central1 \
  --purpose encryption

# Grant the Cloud SQL service account access to the key.
gcloud kms keys add-iam-policy-binding events-encryption \
  --keyring act-prod \
  --location us-central1 \
  --member "serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-cloud-sql.iam.gserviceaccount.com" \
  --role roles/cloudkms.cryptoKeyEncrypterDecrypter

gcloud sql instances create act-prod \
  --database-version POSTGRES_16 \
  --tier db-custom-4-16384 \
  --region us-central1 \
  --disk-encryption-key projects/${PROJECT_ID}/locations/us-central1/keyRings/act-prod/cryptoKeys/events-encryption \
  --backup-start-time 02:00 \
  --enable-point-in-time-recovery
```

A few things to watch:

1. **Cross-region replicas need their own CMEK.** If you replicate `act-prod` (us-central1) to a us-east1 read replica, you need a separate key in us-east1 and a separate IAM binding for the Cloud SQL service account in that region.
2. **Point-in-time recovery uses the same key.** PITR restores ciphertext from WAL archives, decrypts with the CMEK at restore time. If you've revoked the key in an incident, PITR won't work — plan key-revocation drills carefully.
3. **Automated backups inherit the key.** You don't get to pick a separate "backup key"; backups encrypt with the instance key.

The Google-managed default is fine for most workloads; CMEK is the right answer when your auditor wants to see a key-rotation policy you control or a kill-switch you can pull.

## Recipe: SQLite SEE or OS-level FDE

`act-sqlite` runs on top of `@libsql/client`, which talks to either a local file or a remote libSQL server. Disk encryption on the *file* is what matters when the SQLite database lives on a device, an embedded controller, a shared NFS volume, or anywhere you don't fully control physical access.

Two options:

**SEE (SQLite Encryption Extension)** is the commercial SQLite-authored package. It encrypts pages as they're written and decrypts on read, with the key passed via the `PRAGMA key='...'` statement at connection open. The SQLite distribution shipped with most Linux package managers does *not* include SEE — you license it from the SQLite team and rebuild or link against their build. If you go this route, `act-sqlite` needs no changes: pass a connection that runs `PRAGMA key='...'` on open and the rest of the adapter works unchanged. See the [official SEE documentation](https://www.sqlite.org/see/doc/release/www/index.wiki) for licensing and integration.

**OS-level full-disk encryption** is the free fallback that's right for most embedded deployments:

- **macOS**: FileVault, enabled at install or via System Settings.
- **Linux**: LUKS on the partition holding the database file (`cryptsetup luksFormat /dev/sdb1`).
- **Windows**: BitLocker on the volume.

OS-level FDE encrypts the entire volume; once the system is booted and the volume is unlocked, the SQLite file is plaintext to any process with read access. SEE differs in that it keeps the file encrypted at all times — even a `cp` of the database file off a running system yields ciphertext. The right choice depends on your threat model: if the worry is stolen hardware, FDE is sufficient; if the worry is a hostile process on a running system, you need SEE.

`Store.forget_pii` on SQLite runs `UPDATE events SET pii = NULL WHERE stream = ?`. The encryption layer doesn't see anything different; the page that held the ciphertext gets rewritten with `NULL` for that row. Old page contents may linger until `VACUUM` rewrites the database file (see below).

## Encryption and forget

None of these recipes change what `app.forget(stream)` does. The orchestrator delegates to `Store.forget_pii`, which runs an `UPDATE events SET pii = NULL` on the target stream. The encryption layer is transparent to the SQL: ciphertext-in, `NULL`-out.

But "the column is `NULL`" is not the same as "the ciphertext is gone from disk." Postgres and SQLite both manage pages lazily — an `UPDATE` writes a new tuple version and marks the old one dead, leaving the dead tuple (with its ciphertext) on disk until vacuum reclaims it. If your compliance regime requires provable destruction of the bytes:

- **Postgres**: schedule `VACUUM FULL events` (or rely on aggressive autovacuum settings on the table). `VACUUM FULL` rewrites the table to a new file and unlinks the old one, returning the ciphertext-bearing pages to the OS. Combine with `pg_repack` if you can't afford the table lock.
- **SQLite**: run `VACUUM` after a forget burst. SQLite's `VACUUM` rewrites the entire database file; the old pages are returned to the OS, which (on encrypted volumes) overwrites them lazily. For high-assurance erasure, run on a filesystem that supports `discard` / TRIM on the underlying block device.

Either way, the operator step lives outside the framework. Act guarantees the column is `NULL` after `forget`; the DB and the storage layer determine when the ciphertext disappears.

## Recipe: adapter-layer envelope encryption

The four recipes above all sit at the DB or volume layer: the framework hands the `pii` JSON to the adapter, the adapter writes it as-is, encryption happens lower down. There is a fifth position — **adapter-layer encryption** ([#921](https://github.com/Rotorsoft/act-root/issues/921)). Both `@rotorsoft/act-pg` and `@rotorsoft/act-sqlite` accept an optional `pii_encryption` constructor option that wraps the `pii` column on commit and unwraps it on read, with an operator-controlled key. The cipher (AES-256-GCM, versioned envelope) lives in `@rotorsoft/act-crypto`; the framework core stays unaware.

When to reach for this instead of TDE or `pgcrypto`:

- **Self-hosted Postgres without `pgcrypto`** — for example, a managed PG service that doesn't expose extensions.
- **Edge SQLite** on devices you don't fully control, where OS-level FDE isn't guaranteed.
- **Container or serverless workloads** where the connection is yours but the volume is opaque.
- **KMS-required deployments** — `keyProvider` is a callback, so AWS KMS / GCP KMS / Vault drop in directly.

It composes with TDE — adapter-layer at the column, TDE at the volume — for defense in depth without coordination.

### Setup (Postgres)

```ts
import { PostgresStore } from "@rotorsoft/act-pg";

const store = new PostgresStore({
  host: "localhost",
  port: 5432,
  database: "app",
  user: "postgres",
  password: "secret",
  pii_encryption: {
    keyProvider: () =>
      Buffer.from(process.env.PII_KEY_BASE64 ?? "", "base64"),
    algorithm: "aes-256-gcm",
  },
});
```

`keyProvider` is called once on first use and the result is cached for the lifetime of the store instance. Rotation means restarting the store with a new provider. Sync and async providers both work — return `Buffer` or `Promise<Buffer>`. The key must be 32 bytes (256 bits); anything else throws at first use with a clear error.

### Setup (SQLite)

```ts no-check
import { SqliteStore } from "@rotorsoft/act-sqlite";

const store = new SqliteStore({
  url: "file:app.db",
  pii_encryption: {
    keyProvider: () => readFileSync("/etc/secrets/pii-key.bin"),
    algorithm: "aes-256-gcm",
  },
});
```

### On-disk shape

The `pii` column stays the same type (`jsonb` on PG, `TEXT` on SQLite). Encrypted writes land as JSON-stringified base64 ciphertext — `"AQAB...=="` rather than `{"email": "..."}`. The wire format carries a one-byte version header so a future algorithm can land without breaking existing rows:

```
[version: 1 byte = 0x01][iv: 12B][gcm tag: 16B][ciphertext: NB]
```

The read path discriminates by type after `JSON.parse`: strings get decrypted, objects pass through. This makes mixed-data rollouts transparent — events written before enabling encryption continue to read as plaintext, events written after read as ciphertext.

### What stays unchanged

- `Store.forget_pii(stream)` still issues `UPDATE events SET pii = NULL`. The encryption layer is invisible to that SQL — a `NULL` is a `NULL` whether the prior value was ciphertext or plaintext.
- `Capabilities.pii_isolation` still gates the *column itself*. Encryption is orthogonal — adapters declare `pii_isolation: true` regardless of whether the operator turned encryption on.
- The TCK is unchanged. Encryption is an adapter-internal concern; the conformance suite asserts column round-trip through the `Store` contract, not the on-disk bytes.

### Limitations and trade-offs

- **Rotation is restart-driven.** The resolver caches the operator's key for the store's lifetime. Multi-key reads-during-rollover, KMS rotation policies, and operator audit are out of scope. A future ticket may expose a key-versioned `keyProvider`; for now, the deployment cycles the secret and restarts.
- **Performance.** AES-256-GCM in `node:crypto` is hardware-accelerated on modern CPUs; the per-event cost is small but non-zero. Bench your workload before enabling encryption on a hot path that already runs near its budget.
- **No application-layer key management.** No master keys, no KEK/DEK split, no rotation tooling. The framework ships the cipher and the envelope; the operator's KMS owns the key.

### Composition with TDE / `pgcrypto`

Adapter-layer encryption stacks cleanly with the recipes above. Postgres with adapter-layer encryption + RDS TDE gives you encryption at two layers — column-level with an app-side key, and volume-level with a KMS-managed AWS key. SQLite with adapter-layer encryption + SEE or OS-level FDE has the same shape. The recipes don't conflict; the question is whether one layer is enough for your compliance regime.

## What this guide doesn't cover

Application-layer crypto (encrypting fields inside `events.data` before they reach the Store) is the wrong shape — that's what `events.pii` is for. Use `sensitive()` to declare which fields live in the PII column, then encrypt at the DB layer using one of the recipes above.

Key rotation tooling is your KMS's concern. AWS KMS, GCP KMS, and Vault each have rotation policies; the recipes above don't change them. `pgcrypto` with rotating keys needs a re-encrypt migration the operator runs out-of-band — the framework has no opinion on the schedule.

TLS-in-transit is a different layer entirely. Use the database driver's SSL options (`sslmode=verify-full` on `pg`, native TLS on libSQL).

Backup encryption is documented per DB vendor: [RDS snapshot KMS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Overview.Encryption.html), [Cloud SQL backups](https://cloud.google.com/sql/docs/postgres/backup-recovery/backups), [Postgres `pg_dump` plus age/gpg](https://www.postgresql.org/docs/current/backup-dump.html). Match the backup target's encryption posture to the instance's, or `pgcrypto` your `pii` column and stop worrying about which bucket the dump lands in.

For the framework-side surface — declaring sensitive fields, the `forget` contract, and what survives a wipe — see [sensitive data](./sensitive-data.md). For the design rationale on why this is operator-owned rather than a framework port, see [the book essay on rejected designs](https://github.com/Rotorsoft/act-root/blob/master/book/act-566-pii-rejected-designs.md).
