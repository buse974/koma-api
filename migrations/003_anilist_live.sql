-- Recherche AniList en direct : chaque manga issu d'AniList garde son identifiant
ALTER TABLE mangas ADD COLUMN anilist_id integer UNIQUE;

-- catalogue restauré : identifiant tiré du lien AniList
UPDATE mangas SET anilist_id = substring(link FROM '^https://anilist\.co/manga/(\d+)')::int
WHERE anilist_id IS NULL AND link ~ '^https://anilist\.co/manga/\d+';

-- titre japonais : l'ancien import le rangeait dans les alias
UPDATE mangas m SET title_native = (
  SELECT a FROM unnest(m.aliases) a WHERE a ~ '[ぁ-んァ-ヶー一-龯]' LIMIT 1
)
WHERE title_native IS NULL;
