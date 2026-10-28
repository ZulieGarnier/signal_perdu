# Signal perdu — jeu façon Gartic Phone avec images IA (MJM Graphic Design)

Chaque joueur écrit un prompt de départ. Les albums tournent ensuite entre tous les joueurs en alternant :
**générer une image** à partir du prompt reçu, puis **décrire l'image reçue** par un nouveau prompt.
Les tours se terminent tout seuls à la fin du minuteur. À la fin, l'animateur dévoile chaque album étape par étape, puis la galerie s'ouvre.

## Tester en local (sans clé : images factices)
    npm install
    npm start        # http://localhost:3000

## Obtenir la clé Gemini
1. Aller sur https://aistudio.google.com/apikey et créer une clé.
2. Vérifier dans la doc Google que le modèle d'image choisi est disponible pour ton compte (quota gratuit ou facturation à activer).
   Modèle par défaut : `gemini-2.5-flash-image` (modifiable avec la variable `GEMINI_IMAGE_MODEL`).

## Déployer sur Render
1. Mettre ce dossier dans un dépôt GitHub.
2. Sur https://render.com : New > Blueprint (ou Web Service) > choisir le dépôt. `render.yaml` est déjà prêt.
3. Renseigner la variable secrète `GEMINI_API_KEY`.
4. Une fois déployé, ouvrir l'URL : c'est le lien à partager.

## Le jour J
- Ouvrir le lien 5 minutes avant : l'offre gratuite de Render s'endort après inactivité (premier chargement ~1 minute).
- Cliquer sur « Créer une salle », partager le lien ou le code à 4 lettres.
- Les parties vivent en mémoire : si le serveur redémarre, la partie est perdue.
- Réglages animateur : nombre de tours, durée de chaque type de tour, consigne de style ajoutée à chaque image.
- La clé API reste côté serveur ; chaque joueur a 3 essais de génération par tour (`MAX_ATTEMPTS`).
