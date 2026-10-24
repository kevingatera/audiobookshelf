# Postgres

Audiobookshelf can keep its data in Postgres. Use this page for the settings, the restore lock, and the connection budget when several instances share one database or when a backup is restored.

## Settings

- `DB_DIALECT=postgres`, or a `postgres://` `DATABASE_URL`, selects Postgres.
- `DATABASE_URL` is the app's connection. The app sets its own `application_name` after it parses the URL, so a name in the URL is replaced.
- `DATABASE_LOCK_URL` (optional) is the connection used for the restore lock. It must be direct or session-pooled. When it is unset, the lock uses `DATABASE_URL`.
- `PG_BIN_DIR` (optional) is the folder that holds `pg_dump` and `pg_restore`. Without it they are found on `PATH`. Their major version must match the server.

## Restore lock

Every running instance holds a shared advisory lock (key `7210733`) on its own session. A restore takes the lock exclusively, so:

- An instance refuses to start while a restore holds the lock.
- An instance that loses its lock session opens no new connections. It tries to rejoin every 5 seconds.
- A restore runs only when no other instance holds the lock and no other session is connected to the database.

### Pooling

The lock is safe only on a direct or session-pooled connection. A transaction-mode pooler, such as PgBouncer with `pool_mode = transaction`, can give the lock's server connection to another client. Then the lock is not held as expected.

The app probes for this. It asks a second session for the lock in the other mode, and refuses when that session gets it. The error is `PooledLockError`.

- Startup with a pooled lock connection fails with `PooledLockError`. Set `DATABASE_LOCK_URL` to a direct or session-pooled URL.
- A restore with a pooled lock connection answers 500 and leaves the data unchanged.

The probe can miss. With one transaction-mode backend it detects the pooler every time. With several backends, the probe can reach a backend that does not hold the lock, so a second instance can join. In 20 trials against a 4-backend pool, the probe refused the second instance every time. That is a measurement, not a guarantee. The only guarantee is a direct or session-pooled `DATABASE_LOCK_URL`.

The pooling mode is checked at the app's first join to the lock, and again before each restore. A rejoin after a dropped lock session is not checked again: a check there needs a third connection while the app pool is open, which a role at `CONNECTION LIMIT 2` does not have. So changing the pooler's mode requires restarting the app. Until a restore runs, a changed pooler can leave the app believing it holds the lock.

Not covered: a client that connects between the session check and the start of `pg_restore`, and instances from builds without this lock.

## Connection budget

Postgres returns SQLSTATE `53300` (`too many connections for role`) when a role has reached its `CONNECTION LIMIT`. Each instance needs:

- Startup: the lock session, plus one probe session that opens and closes before the app pool opens. A limit of 1 cannot start.
- Running: the lock session plus the app pool. The pool is Sequelize's default, which can open up to 5 connections. A lower limit gives `53300` when the pool needs another connection.
- Restore: the app pool closes first. The probe then opens while only the lock session is open. Then `pg_restore` runs with the lock session. The pool reconnects afterward.

Connections held by a transaction-mode pooler count as sessions on the server. A restore through such a pooler is refused until the pooler closes them.

To check a role's limit and current sessions:

```sql
SELECT rolname, rolconnlimit FROM pg_roles WHERE rolname = current_user;   -- -1 means no limit
SELECT count(*) FROM pg_stat_activity WHERE usename = current_user;
```
