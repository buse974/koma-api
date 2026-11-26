const json = (schema) => ({ 'application/json': { schema } });
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const ok = (schema, description = 'OK') => ({ description, content: json(schema) });
const err = (description) => ({ description, content: json(ref('Error')) });

const playerQuery = { name: 'playerId', in: 'query', schema: { type: 'string', format: 'uuid' }, description: 'UUID de la session de jeu' };
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'integer' } };
const auth = [{ bearerAuth: [] }];
const body = (schema) => ({ required: true, content: json(schema) });
const arr = (items) => ({ type: 'array', items });
const nullable = (type) => ({ type, nullable: true });
const imageBody = (extra = {}) => ({
  required: true,
  content: { 'multipart/form-data': { schema: { type: 'object', required: ['image'], properties: { image: { type: 'string', format: 'binary' }, ...extra } } } }
});

const gameResponses = { 200: ok(ref('GameState')), 400: err('Requête invalide'), 404: err('Puzzle introuvable') };
const adminPuzzle = { 200: ok(ref('AdminPuzzle')), 400: err('Requête invalide'), 401: err('Non autorisé'), 404: err('Introuvable') };
const adminManga = { 200: ok(ref('AdminManga')), 400: err('Requête invalide'), 401: err('Non autorisé'), 404: err('Introuvable') };

const mangaInput = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Titre principal (romaji)' },
    titleNative: nullable('string'),
    titleEnglish: nullable('string'),
    aliases: arr({ type: 'string' }),
    author: nullable('string'),
    year: nullable('integer'),
    link: nullable('string')
  }
};
const puzzleInput = {
  type: 'object',
  properties: {
    mangaId: nullable('integer'),
    answerName: nullable('string'),
    answerAliases: arr({ type: 'string' }),
    published: { type: 'boolean' }
  }
};

export default {
  openapi: '3.0.0',
  info: {
    title: 'Koma API',
    version: '2.0.0',
    description: 'Koma : puzzles manga créés à la main. Deux modes : deviner le manga (jusqu’à 6 cases), deviner le personnage (1 image, réponse libre).'
  },
  servers: [
    { url: 'http://localhost:3000', description: 'Local' },
    { url: 'https://api.koma.51.77.223.61.nip.io', description: 'Production' }
  ],
  paths: {
    '/health': { get: { summary: 'Health check', responses: { 200: { description: 'OK' } } } },
    '/api/puzzles/today': {
      get: { tags: ['Jeu'], summary: 'Puzzle du jour (désactivé tant que DAILY_ENABLED≠true)', parameters: [playerQuery], responses: gameResponses }
    },
    '/api/puzzles': {
      get: { tags: ['Jeu'], summary: 'Puzzles publiés, dans l’ordre choisi par l’admin', responses: { 200: ok(arr(ref('PuzzleMeta'))) } }
    },
    '/api/puzzles/{id}': {
      get: { tags: ['Jeu'], summary: "État d'une partie", parameters: [idParam, playerQuery], responses: gameResponses }
    },
    '/api/puzzles/{id}/guess': {
      post: {
        tags: ['Jeu'], summary: 'Proposer une réponse (mangaId en mode manga, text en mode personnage)', parameters: [idParam],
        requestBody: body({ type: 'object', required: ['playerId'], properties: { playerId: { type: 'string', format: 'uuid' }, mangaId: { type: 'integer' }, text: { type: 'string' } } }),
        responses: { ...gameResponses, 409: err('Partie terminée') }
      }
    },
    '/api/puzzles/{id}/skip': {
      post: {
        tags: ['Jeu'], summary: 'Passer (mode manga : consomme un essai ; mode personnage : abandonne)', parameters: [idParam],
        requestBody: body({ type: 'object', required: ['playerId'], properties: { playerId: { type: 'string', format: 'uuid' } } }),
        responses: { ...gameResponses, 409: err('Partie terminée') }
      }
    },
    '/api/puzzles/{id}/stats': {
      get: { tags: ['Jeu'], summary: 'Statistiques globales du puzzle', parameters: [idParam], responses: { 200: ok(ref('Stats')), 404: err('Puzzle introuvable') } }
    },
    '/api/mangas/search': {
      get: {
        tags: ['Jeu'], summary: 'Recherche de manga (titres + alias)',
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string', minLength: 2 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 10, maximum: 50 } }
        ],
        responses: { 200: ok(arr(ref('Manga'))) }
      }
    },

    '/api/admin/login': {
      post: {
        tags: ['Admin'], summary: 'Connexion admin',
        requestBody: body({ type: 'object', required: ['password'], properties: { password: { type: 'string' } } }),
        responses: { 200: ok({ type: 'object', properties: { token: { type: 'string' } } }), 401: err('Mot de passe incorrect') }
      }
    },
    '/api/admin/puzzles': {
      get: { tags: ['Admin'], security: auth, summary: 'Tous les puzzles (brouillons compris)', responses: { 200: ok(arr(ref('AdminPuzzle'))) } },
      post: {
        tags: ['Admin'], security: auth, summary: 'Créer un puzzle (brouillon, en fin de liste)',
        requestBody: body({ ...puzzleInput, required: ['mode'], properties: { mode: { type: 'string', enum: ['manga', 'character'] }, ...puzzleInput.properties } }),
        responses: { 201: ok(ref('AdminPuzzle')), 400: err('Requête invalide') }
      }
    },
    '/api/admin/puzzles/order': {
      put: {
        tags: ['Admin'], security: auth, summary: 'Ordonner les puzzles d’un mode',
        requestBody: body({ type: 'object', required: ['mode', 'ids'], properties: { mode: { type: 'string', enum: ['manga', 'character'] }, ids: arr({ type: 'integer' }) } }),
        responses: { 200: ok(arr(ref('AdminPuzzle'))), 400: err('Requête invalide') }
      }
    },
    '/api/admin/puzzles/{id}': {
      get: { tags: ['Admin'], security: auth, summary: 'Détail', parameters: [idParam], responses: adminPuzzle },
      put: { tags: ['Admin'], security: auth, summary: 'Modifier réponse / publication', parameters: [idParam], requestBody: body(puzzleInput), responses: adminPuzzle },
      delete: { tags: ['Admin'], security: auth, summary: 'Supprimer (et ses images)', parameters: [idParam], responses: { 204: { description: 'Supprimé' } } }
    },
    '/api/admin/puzzles/{id}/frames': {
      post: {
        tags: ['Admin'], security: auth, summary: 'Ajouter / remplacer une case', parameters: [idParam],
        requestBody: imageBody({ position: { type: 'integer', description: '1..6 (manga) ou 1 (personnage)' } }),
        responses: { 201: ok(ref('AdminFrame')), 400: err('Requête invalide') }
      }
    },
    '/api/admin/puzzles/{id}/frames/order': {
      put: {
        tags: ['Admin'], security: auth, summary: 'Réordonner les cases', parameters: [idParam],
        requestBody: body({ type: 'object', required: ['frameIds'], properties: { frameIds: arr({ type: 'integer' }) } }),
        responses: { 200: ok(arr(ref('AdminFrame'))), 400: err('Requête invalide') }
      }
    },
    '/api/admin/puzzles/{id}/frames/{position}': {
      delete: {
        tags: ['Admin'], security: auth, summary: 'Supprimer une case',
        parameters: [idParam, { name: 'position', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 204: { description: 'Supprimée' } }
      }
    },
    '/api/admin/puzzles/{id}/answer-image': {
      post: { tags: ['Admin'], security: auth, summary: 'Image de l’écran de révélation', parameters: [idParam], requestBody: imageBody(), responses: adminPuzzle },
      delete: { tags: ['Admin'], security: auth, summary: 'Retirer l’image de révélation', parameters: [idParam], responses: adminPuzzle }
    },
    '/api/admin/mangas': {
      get: { tags: ['Admin'], security: auth, summary: 'Catalogue de mangas', responses: { 200: ok(arr(ref('AdminManga'))) } },
      post: { tags: ['Admin'], security: auth, summary: 'Créer un manga', requestBody: body({ ...mangaInput, required: ['title'] }), responses: { 201: ok(ref('AdminManga')), 400: err('Requête invalide') } }
    },
    '/api/admin/mangas/{id}': {
      put: { tags: ['Admin'], security: auth, summary: 'Modifier un manga', parameters: [idParam], requestBody: body(mangaInput), responses: adminManga },
      delete: { tags: ['Admin'], security: auth, summary: 'Supprimer un manga (refusé s’il est utilisé)', parameters: [idParam], responses: { 204: { description: 'Supprimé' }, 409: err('Utilisé par des puzzles') } }
    },
    '/api/admin/mangas/{id}/cover': {
      post: { tags: ['Admin'], security: auth, summary: 'Couverture', parameters: [idParam], requestBody: imageBody(), responses: adminManga },
      delete: { tags: ['Admin'], security: auth, summary: 'Retirer la couverture', parameters: [idParam], responses: adminManga }
    }
  },
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas: {
      Error: { type: 'object', properties: { error: { type: 'string' } } },
      Manga: {
        type: 'object',
        properties: { id: { type: 'integer' }, title: { type: 'string' }, titleNative: nullable('string'), titleEnglish: nullable('string'), year: nullable('integer'), coverUrl: nullable('string') }
      },
      AdminManga: {
        allOf: [ref('Manga'), { type: 'object', properties: { aliases: arr({ type: 'string' }), author: nullable('string'), link: nullable('string'), puzzleCount: { type: 'integer' } } }]
      },
      PuzzleMeta: {
        type: 'object',
        properties: { id: { type: 'integer' }, number: { type: 'integer', description: 'Rang dans son mode' }, mode: { type: 'string', enum: ['manga', 'character'] } }
      },
      Answer: {
        type: 'object',
        properties: {
          name: nullable('string'), titleNative: nullable('string'), title: nullable('string'), titleEnglish: nullable('string'),
          author: nullable('string'), year: nullable('integer'), link: nullable('string'), imageUrl: nullable('string')
        }
      },
      Guess: {
        type: 'object',
        properties: { type: { type: 'string', enum: ['guess', 'skip'] }, manga: ref('Manga'), text: { type: 'string' }, correct: { type: 'boolean' } }
      },
      GameState: {
        allOf: [ref('PuzzleMeta'), {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['playing', 'won', 'lost'] },
            maxAttempts: { type: 'integer' },
            frameCount: { type: 'integer' },
            guesses: arr(ref('Guess')),
            frames: arr({ type: 'string' }),
            answer: { allOf: [ref('Answer')], nullable: true, description: 'null tant que la partie est en cours' }
          }
        }]
      },
      Stats: {
        type: 'object',
        properties: { plays: { type: 'integer' }, wins: { type: 'integer' }, distribution: { type: 'object', additionalProperties: { type: 'integer' } } }
      },
      AdminFrame: { type: 'object', properties: { id: { type: 'integer' }, position: { type: 'integer' }, url: { type: 'string' } } },
      AdminPuzzle: {
        type: 'object',
        properties: {
          id: { type: 'integer' }, mode: { type: 'string' }, position: { type: 'integer' }, published: { type: 'boolean' },
          ready: { type: 'boolean' }, maxFrames: { type: 'integer' }, manga: { allOf: [ref('AdminManga')], nullable: true },
          answerName: nullable('string'), answerAliases: arr({ type: 'string' }), answerImageUrl: nullable('string'),
          frames: arr(ref('AdminFrame'))
        }
      }
    }
  }
};
