CREATE TABLE project_embeddings (
  projectId TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL,
  embeddingModel TEXT NOT NULL,
  embeddedText TEXT NOT NULL,
  embeddedAt TEXT NOT NULL DEFAULT (datetime('now'))
);
