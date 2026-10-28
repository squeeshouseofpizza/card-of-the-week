-- Card of the Week D1 tables. Run once in the D1 Console.
CREATE TABLE plays (week INTEGER NOT NULL, player TEXT NOT NULL, discord_id TEXT, started_at INTEGER NOT NULL, finished_at INTEGER, guesses TEXT NOT NULL DEFAULT '[]', won INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (week, player));
CREATE INDEX plays_week ON plays (week, done, won);
CREATE TABLE users (discord_id TEXT PRIMARY KEY, name TEXT NOT NULL, avatar TEXT, created_at INTEGER NOT NULL);
CREATE TABLE sessions (token TEXT PRIMARY KEY, discord_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE logins (nonce TEXT PRIMARY KEY, token TEXT, expires_at INTEGER NOT NULL);
