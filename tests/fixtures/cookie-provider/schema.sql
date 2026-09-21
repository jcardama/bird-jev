CREATE TABLE cookies (
  name TEXT,
  value TEXT,
  host_key TEXT,
  path TEXT,
  expires_utc INTEGER,
  samesite INTEGER,
  encrypted_value BLOB,
  is_secure INTEGER,
  is_httponly INTEGER
);

CREATE TABLE meta (
  key TEXT,
  value TEXT
);

INSERT INTO meta (key, value) VALUES ('version', '10');
