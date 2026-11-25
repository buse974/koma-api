const json = (schema) => ({ 'application/json': { schema } });
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const ok = (schema, description = 'OK') => ({ description, content: json(schema) });
const err = (description) => ({ description, content: json(ref('Error')) });

const playerQuery = { name: 'playerId', in: 'query', schema: { type: 'string', format: 'uuid' }, description: 'UUID v4 du joueur' };
const numberParam = { name: 'number', in: 'path', required: true, schema: { type: 'integer' } };
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'integer' } };
const auth = [{ bearerAuth: [] }];
const body = (schema) => ({ required: true, content: json(schema) });
const arr = (items) => ({ type: 'array', items });

const gameResponses = { 200: ok(ref('GameState')), 400: err('Requête invalide'), 404: err('Puzzle introuvable') };

export default {
  openapi: '3.0.0',
  info: {
    title: 'Koma API',
    version: '1.0.0',
    description: "Koma : jeu quotidien où l'on devine un manga à partir de 6 cases révélées progressivement."
  },
  servers: [
    { url: 'http://localhost:3000', description: 'Local' },
    { url: 'https://api.koma.51.77.223.61.nip.io', description: 'Production' }
  ],
  paths: {
    '/health': { get: { summary: 'Health check', responses: { 200: { description: 'OK' } } } },
    '/api/puzzles/today': {
      get: { tags: ['Jeu'], summary: 'Puzzle du jour (Europe/Paris)', parameters: [playerQuery], responses: gameResponses }
    },
    '/api/puzzles': {
      get: {
        tags: ['Jeu'], summary: 'Puzzles jouables, du plus récent au plus ancien', parameters: [playerQuery],
        responses: { 200: ok(arr(ref('PuzzleListItem'))) }
      }
    },
    '/api/puzzles/{number}': {
      get: { tags: ['Jeu'], summary: "État d'une partie", parameters: [numberParam, playerQuery], responses: gameResponses }
    },
    '/api/puzzles/{number}/guess': {
      post: {
        tags: ['Jeu'], summary: 'Proposer un manga', parameters: [numberParam],
        requestBody: body({ type: 'object', required: ['playerId', 'mangaId'], properties: { playerId: { type: 'string', format: 'uuid' }, mangaId: { type: 'integer' } } }),
        responses: { ...gameResponses, 409: err('Partie terminée') }
      }
    },
    '/api/puzzles/{number}/skip': {
      post: {
        tags: ['Jeu'], summary: 'Passer (consomme un essai)', parameters: [numberParam],
        requestBody: body({ type: 'object', required: ['playerId'], properties: { playerId: { type: 'string', format: 'uuid' } } }),
        responses: { ...gameResponses, 409: err('Partie terminée') }
      }
    },
    '/api/puzzles/{number}/stats': {
      get: { tags: ['Jeu'], summary: 'Statistiques globales du puzzle', parameters: [numberParam], responses: { 200: ok(ref('Stats')), 404: err('Puzzle introuvable') } }
    },
    '/api/mangas/search': {
      get: {
        tags: ['Jeu'], summary: 'Recherche de manga (titres + alias)',
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 10, maximum: 50 } }
        ],
        responses: { 200: ok(arr(ref('Manga'))) }
      }
    },
    '/uploads/frames/{file}': {
      get: {
        tags: ['Jeu'], summary: 'Image de case (WebP, cache long)',
        parameters: [{ name: 'file', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'image/webp' }, 404: { description: 'Introuvable' } }
      }
    },
    '/api/admin/login': {
      post: {
        tags: ['Admin'], summary: 'Connexion admin (JWT 7 jours)',
        requestBody: body({ type: 'object', required: ['password'], properties: { password: { type: 'string' } } }),
        responses: { 200: ok({ type: 'object', properties: { token: { type: 'string' } } }), 401: err('Mot de passe incorrect') }
      }
    },
    '/api/admin/puzzles': {
      get: { tags: ['Admin'], summary: 'Tous les puzzles (futurs inclus)', security: auth, responses: { 200: ok(arr(ref('AdminPuzzle'))), 401: err('Non autorisé') } },
      post: {
        tags: ['Admin'], summary: 'Créer un puzzle (date >= aujourd\'hui)', security: auth,
        requestBody: body({ type: 'object', required: ['mangaId', 'date'], properties: { mangaId: { type: 'integer' }, date: { type: 'string', format: 'date' } } }),
        responses: { 201: ok(ref('AdminPuzzle')), 400: err('Date passée ou invalide'), 409: err('Date déjà prise') }
      }
    },
    '/api/admin/puzzles/{id}': {
      get: { tags: ['Admin'], summary: 'Un puzzle', security: auth, parameters: [idParam], responses: { 200: ok(ref('AdminPuzzle')), 404: err('Introuvable') } },
      put: {
        tags: ['Admin'], summary: 'Modifier / déplacer un puzzle', security: auth, parameters: [idParam],
        requestBody: body({ type: 'object', properties: { mangaId: { type: 'integer' }, date: { type: 'string', format: 'date' } } }),
        responses: { 200: ok(ref('AdminPuzzle')), 400: err('Date passée ou invalide'), 409: err('Date déjà prise') }
      },
      delete: { tags: ['Admin'], summary: 'Supprimer un puzzle et ses fichiers', security: auth, parameters: [idParam], responses: { 204: { description: 'Supprimé' } } }
    },
    '/api/admin/puzzles/{id}/frames': {
      post: {
        tags: ['Admin'], summary: 'Ajouter ou remplacer une case', security: auth, parameters: [idParam],
        requestBody: {
          required: true,
          content: { 'multipart/form-data': { schema: { type: 'object', required: ['image', 'position'], properties: { image: { type: 'string', format: 'binary' }, position: { type: 'integer', minimum: 1, maximum: 6 } } } } }
        },
        responses: { 201: ok(ref('Frame')), 400: err('Image ou position invalide') }
      }
    },
    '/api/admin/puzzles/{id}/frames/order': {
      put: {
        tags: ['Admin'], summary: 'Réordonner les 6 cases', security: auth, parameters: [idParam],
        requestBody: body({ type: 'object', required: ['frameIds'], properties: { frameIds: arr({ type: 'integer' }) } }),
        responses: { 200: ok(arr(ref('Frame'))), 400: err('frameIds invalide') }
      }
    },
    '/api/admin/puzzles/{id}/frames/{position}': {
      delete: {
        tags: ['Admin'], summary: 'Supprimer une case', security: auth,
        parameters: [idParam, { name: 'position', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 204: { description: 'Supprimée' }, 404: err('Introuvable') }
      }
    },
    '/api/admin/calendar': {
      get: {
        tags: ['Admin'], summary: 'Planification (alerte si moins de 7 jours complets)', security: auth,
        responses: { 200: ok({ type: 'object', properties: { today: { type: 'string', format: 'date' }, scheduledAhead: { type: 'integer' }, nextEmptyDate: { type: 'string', format: 'date' }, alert: { type: 'boolean' } } }) }
      }
    },
    '/api/admin/mangas/import': {
      post: {
        tags: ['Admin'], summary: 'Importer les mangas populaires depuis AniList (50 par page)', security: auth,
        requestBody: { content: json({ type: 'object', properties: { pages: { type: 'integer', default: 40 } } }) },
        responses: { 200: ok({ type: 'object', properties: { imported: { type: 'integer' } } }) }
      }
    }
  },
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas: {
      Error: { type: 'object', properties: { error: { type: 'string' } } },
      Manga: {
        type: 'object',
        properties: { id: { type: 'integer' }, title: { type: 'string' }, titleEnglish: { type: 'string', nullable: true }, year: { type: 'integer', nullable: true }, coverUrl: { type: 'string', nullable: true } }
      },
      Answer: {
        allOf: [ref('Manga'), { type: 'object', properties: { author: { type: 'string', nullable: true }, anilistUrl: { type: 'string' } } }]
      },
      Guess: { type: 'object', properties: { type: { type: 'string', enum: ['guess', 'skip'] }, manga: ref('Manga'), correct: { type: 'boolean' } } },
      PuzzleMeta: { type: 'object', properties: { id: { type: 'integer' }, number: { type: 'integer' }, date: { type: 'string', format: 'date' } } },
      PuzzleListItem: {
        allOf: [ref('PuzzleMeta'), { type: 'object', properties: { status: { type: 'string', enum: ['new', 'playing', 'won', 'lost'] } } }]
      },
      GameState: {
        allOf: [ref('PuzzleMeta'), {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['playing', 'won', 'lost'] },
            maxAttempts: { type: 'integer', example: 6 },
            guesses: arr(ref('Guess')),
            frames: { ...arr({ type: 'string' }), description: 'Cases débloquées, ex: /uploads/frames/<uuid>.webp' },
            answer: { ...ref('Answer'), nullable: true, description: 'Non null uniquement si la partie est terminée' }
          }
        }]
      },
      Stats: {
        type: 'object',
        properties: { plays: { type: 'integer' }, wins: { type: 'integer' }, distribution: { type: 'object', additionalProperties: { type: 'integer' }, example: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, lost: 0 } } }
      },
      Frame: { type: 'object', properties: { id: { type: 'integer' }, position: { type: 'integer' }, url: { type: 'string' } } },
      AdminPuzzle: {
        allOf: [ref('PuzzleMeta'), { type: 'object', properties: { manga: ref('Manga'), frames: arr(ref('Frame')) } }]
      }
    }
  }
};
