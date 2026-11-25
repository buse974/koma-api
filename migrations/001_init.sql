CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE mangas (
  id             serial PRIMARY KEY,
  anilist_id     integer UNIQUE,
  title          text NOT NULL,
  title_english  text,
  aliases        text[] NOT NULL DEFAULT '{}',
  year           integer,
  cover_url      text,
  author         text,
  anilist_url    text,
  popularity     integer NOT NULL DEFAULT 0,
  search_text    text NOT NULL DEFAULT ''
);
CREATE INDEX mangas_search_trgm ON mangas USING gin (search_text gin_trgm_ops);

CREATE TABLE puzzles (
  id        serial PRIMARY KEY,
  date      date NOT NULL UNIQUE,
  manga_id  integer NOT NULL REFERENCES mangas(id)
);

CREATE TABLE frames (
  id         serial PRIMARY KEY,
  puzzle_id  integer NOT NULL REFERENCES puzzles(id) ON DELETE CASCADE,
  position   integer NOT NULL CHECK (position BETWEEN 1 AND 6),
  filename   text NOT NULL,
  UNIQUE (puzzle_id, position) DEFERRABLE INITIALLY IMMEDIATE
);

CREATE TABLE plays (
  id         serial PRIMARY KEY,
  puzzle_id  integer NOT NULL REFERENCES puzzles(id) ON DELETE CASCADE,
  player_id  uuid NOT NULL,
  guesses    jsonb NOT NULL DEFAULT '[]',
  status     text NOT NULL DEFAULT 'playing' CHECK (status IN ('playing','won','lost')),
  attempts   integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (puzzle_id, player_id)
);
