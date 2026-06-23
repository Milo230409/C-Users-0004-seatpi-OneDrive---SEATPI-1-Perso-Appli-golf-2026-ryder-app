# ⛳ Du Golf & des Amis — Prompt complet & Analyse business

> Document de référence : description exhaustive de l'application (utilisable
> comme prompt de recréation / pitch) + analyse de cible et de modèle économique.

---

# 📄 PARTIE 1 — Prompt complet de l'application

## Concept
**« Du Golf & des Amis »** — une web-app (PWA mobile-first) pour **organiser, scorer
en direct et classer** les parties de golf d'un groupe d'amis sur toute une saison.
Ambiance « club privé entre potes » : on joue, on partage, on se chambre via un
classement annuel.

## Stack technique
- **Front** : React + Vite, un seul gros composant `GolfApp.jsx`, styles inline
  (thème JS centralisé).
- **Cloud temps réel** : Supabase (Postgres + Realtime) — données partagées entre
  tous les téléphones (parties, joueurs, parcours). Synchro **à chaque trou validé**.
- **Repli** : `localStorage` (fonctionne hors-ligne / sans cloud).
- **PWA** : ajout à l'écran d'accueil iOS/Android, plein écran, thème sombre.
- **Données « en dur »** : 15 parcours réels (par/HCP/longueur par trou), 9 membres,
  clé API parcours, lien WhatsApp — toujours présents même sans cloud.
- **API externe** : GolfCourseAPI (recherche mondiale de parcours).

## Identité visuelle (DA)
Fond très sombre (`#0a0f0c`), **accent vert** fluo, or pour les distinctions,
bleu/rouge pour les équipes. Titres en **Anton / Archivo** (condensé, sportif).
Cartes arrondies à dégradés, animations légères.

## Authentification (sans friction)
- Écran **« Qui es-tu ? »** : on tape sur son prénom (membres affichés en haut,
  anciens invités masqués dans une liste déroulante).
- **1re fois** : on remplit sa fiche une fois (surnom, **index/niveau**, mobile, email).
- **Reconnexion en 2 temps** : on saisit son index de la dernière fois (petite
  sécurité), puis on confirme/ajuste son niveau du jour. ⚠️ L'index n'est **pas** un
  mot de passe : il sert **uniquement à calculer les coups rendus**.
- **Rôle admin** (organisateur) : seul à modifier les fiches des autres, supprimer
  des parcours, accéder aux réglages.

## Parties amicales (2 à 4 joueurs)
Création en 2 menus : **1) Formule** · **2) Décompte (Brut/Net + « différentiel »)**.
Nom **auto-généré** (formule + brut/net + date + heure). Désignation des **équipes**
pour les formats 2v2.

**Formules implémentées :**
- **1v1** : Match Play (statut *1 UP / All Square / 2&1*, mis à jour par trou),
  Stroke Play net, Stableford, Skins (report).
- **3 joueurs** : Chouette (6 pts/trou, 4/2/0…), 1v1v1.
- **2v2** : Fourball (meilleure balle), Fourball meilleure & moins bonne,
  Foursome/Greensome, Scramble, Chamble (drive d'équipe), Mexicaine (brut, points
  cumulés + inversions/bonus expliqués par des « Faits de jeu »).

## Scoring en direct
- **Un scoreur désigné par flight** ; lui seul saisit, les autres **suivent en
  lecture seule**.
- **Tableau RÉSULTATS LIVE** qui s'anime **à chaque trou validé** (synchro temps réel
  multi-téléphones).
- Coups rendus calculés par trou (index × slope/SSS, HCP du trou).

## Tournois (3 modes)
- **🏆 Ryder Cup** : 2 équipes, **tirage en chapeaux de 2** (par index → équipes
  équilibrées), confrontations proposées **chapeau contre chapeau**, **formules variées
  par manche**, **scoreboard façon EUR–USA** (totaux + statut de chaque match, jour par
  jour), **solidarité d'équipe** (on gagne/perd ensemble).
- **🥊 MiniCup** : **bracket à élimination directe** 1v1, tirage full aléatoire (byes
  gérés), avancement Quarts → Demies → Finale → **Champion**.
- **🏅 MiniChamp** : Intégral (cumul de points sur les manches, +5 au vainqueur) ·
  *Poules (à venir)*.

## Classement de saison (annuel)
- **Système de DUELS** (qui bat qui), indépendant de la formule : 1v1 → V3/N1/D0 ;
  à 3 → 2 duels (V2) ; 2v2 → V3 par équipier.
- **+5 trophée** au vainqueur d'un tournoi.
- **Règle clé** : une confrontation ne compte que s'il y a **≥ 2 membres**, et **les
  invités ne marquent jamais** (seuls les duels membre-contre-membre comptent).
- **2 classements** : Cumulé + Moyenne/partie · + bilan des **confrontations directes**.

## Communication
À la validation du 18e trou : message **prêt à partager sur WhatsApp** = résultat de
la formule + **fiche par joueur (Stableford brut & net)** + **évolution au classement**
(points, rang, ▲/▼ places). Bouton vers le groupe du club.

## Robustesse / confort
- **Rejoindre une partie en cours** (proposé à la connexion).
- **Déconnexion auto** en quittant l'appli / après inactivité (sauf en partie).
- **Auto-suppression** des parties non clôturées > 1 semaine.
- **FAQ intégrée** (accordéon) : connexion, formules, points, tournois, partage…

---

# 💼 PARTIE 2 — À qui s'adresser + business

## 🎯 Cible prioritaire (par ordre)

**1. Les « sociétés de golf » / groupes récurrents (cœur de cible).**
Des amis/collègues qui jouent **ensemble toute l'année** et veulent un **classement de
saison** et des **Ryder maison**. C'est le cas d'usage fondateur, là où la valeur
(récurrence, attachement, viralité) est la plus forte. Les **golf societies** au
Royaume-Uni/Irlande = un marché énorme et structuré (des milliers de sociétés).

**2. Les sorties / séminaires d'entreprise & associations.**
Une journée golf à organiser (scramble, Ryder client/fournisseur) → l'app gère tirage,
formats, scoreboard live. Achat ponctuel mais **gros budget**.

**3. Les golfs / clubs (compétitions de membres).**
Le club fournit l'outil à ses membres pour leurs compétitions internes
(en **marque blanche**).

**4. Voyages de golf / EVG / stags.**
Trips à la semaine (Catalogne, Portugal…) avec mini-tournoi → usage intense sur
quelques jours.

## 💰 Sources de revenus possibles

| Modèle | Détail | Maturité |
|---|---|---|
| **Freemium / abonnement « Société »** | Gratuit jusqu'à X joueurs/parties ; payant par **groupe/an** pour classement illimité, tournois avancés, stats, archives. | ⭐ le plus naturel |
| **Marque blanche club** | Le golf paie une licence annuelle, app à ses couleurs pour ses membres. | ⭐ gros tickets B2B |
| **Pack « événement »** | Paiement à l'usage pour une sortie entreprise/asso (tirage + scoreboard + résultats brandés). | rapide à vendre |
| **Sponsoring / pub native** | Pro-shops, marques d'équipement, assurances golf sur le scoreboard et les messages de résultats. | dépend du volume |
| **Affiliation** | Réservation de parcours / voyages / matériel (commission). L'app connaît déjà les parcours. | complément |
| **Premium joueur** | Suivi d'index, stats perso (greens/putts), historique, photos de partie. | rétention |
| **Données agrégées** | Tendances de jeu, parcours populaires (anonymisé, B2B). | tardif |

## 🧭 Avis franc / recommandation
- **Priorité n°1 = les groupes/sociétés récurrents**, en **freemium + abonnement annuel
  par groupe** : c'est l'ADN du produit, la rétention y est forte (un classement annuel
  = on revient), et la **croissance est virale** (chaque nouvelle partie embarque des
  potes via le partage WhatsApp).
- **Différenciateur** vs les apps existantes (Golf GameBook, TheGrint, V1 Game…) : le
  **classement de SAISON entre amis** + les **formats « maison »** (Ryder à chapeaux,
  MiniCup, Chouette, Mexicaine) + le **partage WhatsApp ultra-fluide**. Positionnement
  « entre potes », moins « club officiel/handicap » que les leaders.
- **Quick win business** : packager le **mode événement** (sortie entreprise) — ce qui
  se vend le plus vite et le plus cher, et finance le développement du SaaS récurrent.

---

*Généré pour « Du Golf & des Amis ».*
