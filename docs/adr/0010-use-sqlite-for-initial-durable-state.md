# Use SQLite for initial durable state

The single-user Personal Prototype will use SQLite in WAL mode for durable tasks, session state, policies, sanitized transcripts, and Evidence Record metadata. This favors transactional simplicity and deployment velocity over PostgreSQL's greater concurrency, while requiring transactional job claiming, integrity checks, bounded retention, disk monitoring, daily encrypted off-host backups, and a tested restore procedure. The storage interface must preserve a later PostgreSQL migration path if measured concurrency or contention makes SQLite unsuitable.
