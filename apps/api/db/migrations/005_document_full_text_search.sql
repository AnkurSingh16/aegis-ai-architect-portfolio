ALTER TABLE aegis.document_chunks
  ADD COLUMN search_vector tsvector GENERATED ALWAYS AS
    (to_tsvector('english'::regconfig, content)) STORED;

CREATE INDEX document_chunks_search_vector_gin
  ON aegis.document_chunks USING gin (search_vector);
