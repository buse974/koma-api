-- Contenu 100 % manuel : plus de catalogue importé, plus de calendrier.

-- Mangas : saisis à la main dans l'admin
ALTER TABLE mangas DROP COLUMN IF EXISTS anilist_id;
ALTER TABLE mangas DROP COLUMN IF EXISTS popularity;
ALTER TABLE mangas RENAME COLUMN anilist_url TO link;
ALTER TABLE mangas ADD COLUMN title_native text;
ALTER TABLE mangas ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

-- Puzzles : deux modes, ordre manuel, publication manuelle.
-- `date` reste en base (désactivée) pour le futur mode quotidien.
ALTER TABLE puzzles ALTER COLUMN date DROP NOT NULL;
ALTER TABLE puzzles ALTER COLUMN manga_id DROP NOT NULL;
ALTER TABLE puzzles ADD COLUMN mode text NOT NULL DEFAULT 'manga' CHECK (mode IN ('manga', 'character'));
ALTER TABLE puzzles ADD COLUMN position integer NOT NULL DEFAULT 0;
ALTER TABLE puzzles ADD COLUMN published boolean NOT NULL DEFAULT false;
ALTER TABLE puzzles ADD COLUMN answer_name text;                          -- mode personnage : nom attendu
ALTER TABLE puzzles ADD COLUMN answer_aliases text[] NOT NULL DEFAULT '{}'; -- variantes acceptées
ALTER TABLE puzzles ADD COLUMN answer_image text;                         -- image de l'écran de révélation
ALTER TABLE puzzles ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE puzzles ADD CONSTRAINT puzzles_answer_check CHECK (
  (mode = 'manga' AND manga_id IS NOT NULL) OR (mode = 'character' AND answer_name IS NOT NULL)
);

-- puzzles existants : ordre = ancienne date, publiés
UPDATE puzzles p SET position = x.rn, published = true
FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY date, id) AS rn FROM puzzles) x
WHERE x.id = p.id;

CREATE INDEX puzzles_order ON puzzles (mode, position, id);
