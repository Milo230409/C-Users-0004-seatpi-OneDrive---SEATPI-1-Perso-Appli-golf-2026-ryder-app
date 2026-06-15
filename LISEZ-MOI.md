# Du Golf & des Amis — Déploiement

App React (Vite) avec connexion partagée via Supabase.

## 1. Supabase
- Projet : URL https://noqvppcuhejbpnhglezl.supabase.co
- Coller le contenu de `supabase/schema.sql` dans SQL Editor → Run (tables + sécurité).
- Authentication → Providers → Email : activé, "Confirm email" coché.
- Authentication → URL Configuration : mettre l'URL du site Vercel dans Site URL ET
  dans Redirect URLs (sinon lien magique / confirmation d'email ne reviennent pas).

## 2. Les clés (déjà dans .env)
VITE_SUPABASE_URL=https://noqvppcuhejbpnhglezl.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_...
La clé "publishable" est PUBLIQUE par conception (aucun risque à l'exposer).

## 3. Déploiement Vercel
1. Pousser le projet sur GitHub (glisser le contenu de ce dossier).
2. Vercel : New Project → Import le repo → framework Vite détecté.
3. IMPORTANT — Project Settings → Environment Variables, ajouter :
   VITE_SUPABASE_URL  = https://noqvppcuhejbpnhglezl.supabase.co
   VITE_SUPABASE_ANON_KEY = sb_publishable_SllLyU3Fnkds4dIh02Q1Xg_ba9iZFzk
4. Deploy. Puis recopier l'URL Vercel dans Supabase (étape 1, URL Configuration).

## 4. Premier test
- Crée ton compte (email + mot de passe), confirme via le mail, connecte-toi.
- Tes potes s'inscrivent librement, confirment leur email, partagent le même groupe.

## Mode local
Sans clés (ou en "invité"), l'app marche en local sur l'appareil, sans partage.
