# Données de parcours de golf (à importer dans Supabase)

Données de référence pour l'app Ryder. **À ne pas coder en dur dans l'app** :
l'app doit lire ces tables depuis Supabase.

## Fichiers

| Fichier | Rôle |
|---|---|
| `data/courses.json` | **Source canonique** (lisible/éditable). On édite ICI. |
| `scripts/generate_seed.py` | Génère le SQL à partir du JSON. |
| `supabase/migrations/0001_golf_courses_schema.sql` | Schéma (tables `courses`, `tees`, `holes` + RLS lecture publique). |
| `supabase/seed.sql` | Données (auto-généré, idempotent). |

## Modèle

- **courses** : nom, ville, CP, région, site web, GPS (`lat`/`lng`), `par`, `holes_count`, `sources[]`, `confidence`, `notes`.
- **tees** (départs) : `name` (couleur), `gender`, `length_m`, `slope`, `course_rating`.
- **holes** (trous) : `hole_number`, `par`, `length_m`, `stroke_index` — 18 lignes par parcours, **`NULL` tant que non renseigné**.

## Import dans Supabase

Avec la CLI Supabase :
```bash
supabase db reset            # applique migrations + seed.sql
# ou, sur une base distante :
psql "$DATABASE_URL" -f supabase/migrations/0001_golf_courses_schema.sql
psql "$DATABASE_URL" -f supabase/seed.sql
```
Le seed est **réexécutable** (upserts sur `slug` / clés naturelles) : régénère après
chaque édition du JSON via `python3 scripts/generate_seed.py`.

## ⚠️ Fiabilité des données (à lire)

- **Vérifié** (sources multiples concordantes) : par total, longueurs par départ,
  slope, parfois course rating, GPS du club (approx.), site web, nb de trous.
- **Partiel / manquant** : le **détail par trou** (par, longueur, stroke index).
  L'environnement de recherche bloque l'accès direct aux scorecards (WebFetch 403),
  donc beaucoup de cellules `holes` sont à `NULL`. Aucune valeur n'a été inventée.
- **Cas complet** : **Saumane** a son par + stroke index des 18 trous (confiance moyenne).
- Le champ `confidence` (`haut`/`moyen`/`bas`) et `notes` signalent les incertitudes
  et divergences de sources parcours par parcours.

### Pour compléter le par/longueur/stroke index par trou
1. via l'**édition par/HCP trou par trou** dans l'app (recommandé, depuis la vraie carte),
2. ou en éditant `data/courses.json` puis en régénérant le seed,
3. les **scorecards officielles** (PDF) sont listées dans `sources` de chaque parcours.
